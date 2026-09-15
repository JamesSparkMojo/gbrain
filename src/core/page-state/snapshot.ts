import { createHash } from 'node:crypto';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { ReadQuery } from '../search/read-enrichment.ts';
import { rowToPage } from '../utils.ts';
import type { PageSnapshot, PageSnapshotOptions, PageWithdrawal } from './types.ts';

/** The DB normalizes companion lines, preserving its lower()/POSIX-space semantics. */
function overlayWithdrawals(body: string, normalizedBody: string, withdrawals: PageWithdrawal[]): string {
  if (!withdrawals.length || !body.includes('gbrain:facts:begin')) return body;
  const original = parseFactsFence(body);
  const normalized = parseFactsFence(normalizedBody);
  // Preserve malformed-fence diagnostics instead of silently dropping partial rows.
  if (original.warnings.length || normalized.warnings.length) return body;
  const claims = new Map(normalized.facts.map(f => [f.rowNum, f.claim]));
  const ledger = new Map(withdrawals.map(w => [`${w.visibility}:${w.fact_hash}`, w.withdrawn_at]));
  let changed = false;
  const facts = original.facts.map(f => {
    const claim = claims.get(f.rowNum);
    if (claim === undefined || !f.active) return f;
    const hash = createHash('sha256').update(claim).digest('hex');
    const at = ledger.get(`${f.visibility}:${hash}`);
    if (!at) return f;
    changed = true;
    return { ...f, active: false, forgotten: true, validUntil: new Date(at).toISOString().slice(0, 10),
      context: [f.context, 'forgotten: memory withdrawn'].filter(Boolean).join(' | ') };
  });
  return changed ? replaceOrInsertFactsFence(body, renderFactsTable(facts)) : body;
}

/** One MVCC statement binds content, tags, identity and withdrawals to one revision. */
export async function readPageSnapshot(query: ReadQuery, slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
  const params: unknown[] = [slug, opts?.resolveAlias === true];
  const where = [`(p.slug=$1 OR ($2::boolean AND EXISTS (SELECT 1 FROM slug_aliases a
    WHERE a.alias_slug=$1 AND a.source_id=p.source_id AND a.canonical_slug=p.slug)))`];
  if (opts?.sourceIds?.length) {
    params.push(opts.sourceIds);
    where.push(`p.source_id=ANY($${params.length}::text[])`);
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    where.push(`p.source_id=$${params.length}`);
  }
  if (!opts?.includeDeleted) where.push('p.deleted_at IS NULL');
  if (opts?.excludePrivate) where.push(privatePagesFilterFragment('p'));
  params.push(opts?.sourceIds?.[0] ?? 'default');
  const rows = await query<Record<string, unknown>>(`WITH chosen AS (
    SELECT p.* FROM pages p WHERE ${where.join(' AND ')}
    ORDER BY (p.slug=$1) DESC, (p.source_id=$${params.length}) DESC, p.source_id ASC LIMIT 1
  ) SELECT p.*,
    (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS snapshot_tags,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',w.visibility,'fact_hash',w.fact_hash,'withdrawn_at',w.withdrawn_at)
      ORDER BY w.visibility,w.fact_hash) FROM fact_withdrawals w WHERE w.source_id=p.source_id
      ${opts?.excludePrivate ? "AND w.visibility='world'" : ''}), '[]'::jsonb) AS snapshot_withdrawals,
    (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS fingerprint_body
    FROM chosen p`, params);
  if (!rows.length) return null;
  const row = rows[0];
  const page = rowToPage(row);
  const withdrawals = row.snapshot_withdrawals as PageWithdrawal[];
  page.compiled_truth = overlayWithdrawals(page.compiled_truth, String(row.fingerprint_body ?? ''), withdrawals);
  return { page, tags: row.snapshot_tags as string[], revision: String(row.knowledge_revision),
    sourceIncarnation: String(row.source_incarnation), withdrawals };
}
