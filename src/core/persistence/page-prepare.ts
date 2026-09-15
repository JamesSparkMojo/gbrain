import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page, PageVersion } from '../types.ts';
import { importFromContent } from '../import-file.ts';
import { parseMarkdown, serializePageToMarkdown, resolveSourceLocalFilePath } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { assertPageRevision, type PageSnapshot } from '../page-state/types.ts';
import { isWriteTargetContained } from '../path-confine.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { authorizeWrite } from './authority.ts';
import { digest, sha256 } from './digest.ts';
import { getWorktreeBinding } from './ownership.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';

function canonical(page: Pick<Page, 'type' | 'title' | 'compiled_truth' | 'timeline' | 'frontmatter'>, tags: string[]) {
  return { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: page.frontmatter, tags: [...new Set(tags)].sort() };
}
export async function prepareFileTarget(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot | null,
  content: string | null): Promise<PreparedMutation['file']> {
  if (!row.worktree_id) return undefined;
  const binding = await getWorktreeBinding(engine, row.source_id);
  if (!binding?.local_path) throw new OperationError('owner_unavailable', 'The canonical worktree is unavailable on this host.');
  const root = join(binding.local_path, binding.relative_path);
  const path = resolveSourceLocalFilePath(root, snapshot?.page.source_path, row.slug) ?? join(root, `${row.slug}.md`);
  if (!isWriteTargetContained(path, root)) throw new OperationError('source_changed', 'The canonical file target is outside its registered source.');
  const before = existsSync(path) ? readFileSync(path) : null;
  // A normal edit may replace only the bytes represented by its read snapshot.
  // Unknown local edits require explicit import/recovery, even for force writes.
  if (before && snapshot && !snapshot.page.deleted_at) {
    const parsed = parseMarkdown(before.toString('utf8'), row.slug);
    const expected = canonical(snapshot.page, snapshot.tags);
    const actual = canonical({ ...parsed, ...await overlayCanonicalBodies(engine.executeRaw.bind(engine),
      parsed.compiled_truth, parsed.timeline ?? '', snapshot.withdrawals) }, parsed.tags);
    // Withdrawal overlays intentionally precede physical mirroring. The ledger
    // is applied by the import preparation and cannot be undone by this check.
    if (digest(actual) !== digest(expected)) {
      throw new OperationError('source_changed', 'The canonical file contains an uncoordinated local edit.', 'Import or recover the local edit before replacing this page.');
    }
  } else if (before && !snapshot && content !== null && sha256(before) !== sha256(content)) {
    throw new OperationError('source_changed', 'An unindexed file already occupies the canonical page path.', 'Import the file before replacing it.');
  }
  return { path, root, content, expectedBeforeHash: before ? sha256(before) : null };
}

/** Providers and parsing run before the OS lock and before any publication transaction. */
export async function preparePageMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig,
  preparedIntent?: { content: string; expectedRevision: string; tags?: string[] }): Promise<PreparedMutation> {
  if (!row.intent) throw new OperationError('storage_error', 'A pending write lost its normalized intent.');
  const p = row.intent;
  const source = { sourceId: row.source_id };
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  assertPageRevision(snapshot, preparedIntent ? { expectedRevision: preparedIntent.expectedRevision } : engineMutationPrecondition(parseMutationPrecondition(p)));
  if ((snapshot?.page.id ?? null) !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page identity changed.');
  const observedRevision = snapshot?.revision ?? null;
  if (row.operation === 'delete_page') {
    if (!snapshot) throw new OperationError('page_not_found', 'Page not found.');
    const noop = snapshot.page.deleted_at != null;
    return { observedRevision, noop, file: await prepareFileTarget(engine, row, snapshot, null), apply: async tx => {
      if (!noop) { await tx.createVersion(row.slug, source); await tx.softDeletePage(row.slug, source); }
      return { status: 'soft_deleted', slug: row.slug, source_id: row.source_id, noop };
    } };
  }
  let content = preparedIntent?.content ?? p.content as string;
  let versionTags: string[] | undefined = preparedIntent?.tags;
  if (row.operation === 'restore_page' || row.operation === 'revert_version') {
    if (!snapshot) throw new OperationError('page_not_found', 'Page not found.');
    let page = snapshot.page;
    let tags = snapshot.tags;
    if (row.operation === 'revert_version') {
      const [version] = await engine.executeRaw<PageVersion>(
        'SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [p.version_id, page.id]);
      if (!version) throw new OperationError('not_found', 'Version not found for this page.');
      page = { ...page, compiled_truth: version.compiled_truth, frontmatter: version.frontmatter,
        ...(version.timeline !== null && version.timeline !== undefined ? { timeline: version.timeline } : {}),
        ...(version.title !== null && version.title !== undefined ? { title: version.title } : {}),
        ...(version.type !== null && version.type !== undefined ? { type: version.type } : {}) };
      if (version.tags !== null && version.tags !== undefined) tags = version.tags;
      versionTags = tags;
    }
    content = serializePageToMarkdown(page, tags);
  }
  let prepared: PreparedContentImport | undefined;
  const result = await importFromContent(engine, row.slug, content, {
    ...source, noEmbed: true, remote: row.authority.remote,
    forceRechunk: row.operation === 'restore_page' || row.operation === 'revert_version',
    allowEmptyOverwrite: p.allow_empty === true || row.operation === 'restore_page' || row.operation === 'revert_version',
    source_kind: typeof p.source_kind === 'string' ? p.source_kind : null,
    source_uri: typeof p.source_uri === 'string' ? p.source_uri : null,
    ingested_via: typeof p.ingested_via === 'string' ? p.ingested_via : null,
    prepare: async value => { prepared = value; return value.result; },
  });
  if (!prepared) throw new OperationError('invalid_params', result.error ?? 'The content was rejected before publication.');
  const ready = prepared;
  if (ready.observedRevision !== observedRevision) throw new OperationError('revision_conflict', 'The page changed during import preparation.');
  if (ready.slug !== row.slug) {
    await authorizeWrite(engine, row.authority, row.operation, ready.slug);
    const duplicate = await engine.readPageSnapshot(ready.slug, { ...source, excludePrivate: row.authority.remote });
    if (!duplicate) throw new OperationError('permission_denied', 'The duplicate is not readable by this writer.');
    return { observedRevision, noop: true, validate: tx => authorizeWrite(tx, row.authority, row.operation, ready.slug, true),
      apply: async () => ({ status: 'duplicate', slug: duplicate.page.slug, duplicate_revision: duplicate.revision }) };
  }
  const tags = versionTags ?? [...new Set([...(snapshot?.tags ?? []), ...ready.parsedPage.tags])].sort();
  const renderedPage: Page = { ...(snapshot?.page ?? { id: 0, slug: row.slug, source_id: row.source_id, created_at: new Date(), updated_at: new Date() }), ...ready.parsedPage };
  const rendered = serializePageToMarkdown(renderedPage, tags);
  const logicalNoop = snapshot !== null && digest(canonical(snapshot.page, snapshot.tags)) === digest(canonical(ready.parsedPage, tags));
  const noop = logicalNoop && (row.operation !== 'restore_page' || snapshot?.page.deleted_at == null);
  return { observedRevision, noop, file: await prepareFileTarget(engine, row, snapshot, rendered), apply: async tx => {
    if (!noop) {
      await ready.apply(tx);
      if (row.operation === 'restore_page') await tx.restorePage(row.slug, source);
      if (versionTags) {
        for (const tag of snapshot!.tags) if (!versionTags.includes(tag)) await tx.removeTag(row.slug, tag, source);
        for (const tag of versionTags) await tx.addTag(row.slug, tag, source);
      }
      // Index installation and terminal receipt share this transaction.
      await sealPageTextProjection(tx, row.slug, row.source_id);
    }
    return { status: noop ? 'skipped' : row.operation === 'restore_page' ? 'restored' : row.operation === 'revert_version' ? 'reverted' : 'created_or_updated',
      slug: row.slug, source_id: row.source_id, chunks: ready.result.chunks, noop,
      ...(row.operation === 'capture' ? { channel: 'capture', content_hash: p.capture_hash } : {}) };
  } };
}
