/**
 * #4588 — the import SKIP path refreshes `pages.source_path`.
 *
 * A row whose slug moved before the sync rename repair existed keeps a
 * source_path naming the OLD file. Write-through prefers source_path, so every
 * later write recreates the old directory, and the full-sync reconcile reads
 * the stale path as "file removed". The changed-content import path already
 * heals this through putPage's COALESCE; the unchanged-content skip (the
 * common case on every re-sync) used to discard the real path handed in by
 * importFile. Both skip branches — the canonical hash short-circuit and the
 * #3694 legacy-hash reconcile — must now write it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { contentHashLegacy } from '../src/core/utils.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const SLUG = 'people/alpha';
const REAL_PATH = 'people/alpha.md';
const STALE_PATH = 'people/old.md';
const BODY = ['---', 'type: person', 'title: Alpha', '---', '', 'Alpha is a person.'].join('\n');

async function sourcePathOf(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
  expect(rows).toHaveLength(1);
  return rows[0].source_path;
}

async function driftTo(slug: string, stalePath: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2`,
    [stalePath, slug],
  );
  expect(await sourcePathOf(slug)).toBe(stalePath);
}

describe('#4588 import skip path refreshes a drifted source_path', () => {
  test('hash-equal skip rewrites source_path to the path the file really lives at', async () => {
    const first = await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(first.status).toBe('imported');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);

    await driftTo(SLUG, STALE_PATH);

    const again = await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    // pre-fix: still 'people/old.md' — the skip returned before any write.
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
  });

  test('#3694 legacy-hash skip rewrites source_path too', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const parsed = parseMarkdown(BODY, `${SLUG}.md`);
    const legacy = contentHashLegacy({
      title: parsed.title,
      type: parsed.type as never,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    });
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE source_id = 'default' AND slug = $2`,
      [legacy, SLUG],
    );
    await driftTo(SLUG, STALE_PATH);

    const again = await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    expect(again.status).toBe('skipped');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
    // The legacy branch still reconciled the hash (fast path next time).
    const row = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(row!.content_hash).not.toBe(legacy);
  });

  test('a skip without sourcePath (put_page / capture lane) leaves source_path alone', async () => {
    await importFromContent(engine, SLUG, BODY, { noEmbed: true, sourcePath: REAL_PATH });
    const again = await importFromContent(engine, SLUG, BODY, { noEmbed: true });
    expect(again.status).toBe('skipped');
    expect(await sourcePathOf(SLUG)).toBe(REAL_PATH);
  });
});
