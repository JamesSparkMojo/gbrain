import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { getWriteRequest } from '../../src/core/persistence/journal.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { distribution } from './harness.ts';
import { overlapPercent } from './read-metrics.ts';

export interface ReadWorkloadOptions {
  engine?: 'pglite' | 'postgres'; databaseUrl?: string; pages?: number; queries?: number; writers?: number; writesPerWriter?: number;
}
const queries = ['lorem ipsum', 'consequat', 'voluptatem', 'aspernatur', 'magna', 'reprehenderit', 'commodo',
  'inventore', 'fixture page', 'section 1', 'section 2', 'page 100', 'doloremque', 'architecto', 'incididunt'];
function page(i: number, prefix: string) {
  const pad = String(i).padStart(5, '0');
  const body = `# ${prefix} Page ${i}\n\nDeterministic page for read-latency measurement. Body has stable text so search-index work is consistent run-to-run.\n\n` +
    'Section 1: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris.\n\n' +
    'Section 2: sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium totam rem aperiam eaque ipsa quae.\n\n' +
    `Reference: ${prefix}-${pad}.`;
  return { slug: `${prefix.toLowerCase()}/page-${pad}`, content: `---\ntype: note\ntitle: ${prefix} Page ${i}\n---\n${body}\n` };
}

/** Original heavy query corpus; all fixture and pressure writes use public put_page. */
export async function runReadLatencyWorkload(options: ReadWorkloadOptions = {}) {
  const kind = options.engine ?? 'pglite'; const pages = options.pages ?? 500; const count = options.queries ?? 200;
  const writerCount = options.writers ?? 4; const cap = 4 * (options.writesPerWriter ?? 25);
  for (const [name, value] of Object.entries({ pages, queries: count, writers: writerCount, cap })) assert(Number.isSafeInteger(value) && value > 0, `Invalid workload ${name}`);
  const engine: BrainEngine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
  const at = performance.now(); const result: Record<string, any> = { ok: false, platform: platform(), engine: kind, runtime: `bun-${Bun.version}`,
    phase_a: null, phase_b: null, overlap_pct: 0, write_path: 'public put_page handler', verdict: 'informational' };
  let stop = false; let recording = false; let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let metricsWork: Promise<void> | undefined; let backgroundFailure: unknown;
  const writers: Promise<void>[] = []; const intervals: [number, number][] = [];
  const starts = new Map<string, number>(); const admissionAt = new Map<string, number>();
  const admissionMs: number[] = []; const completionMs: number[] = [];
  const samples: { at_ms: number; queue_count: number; queue_age_ms: number; recovery_bytes: number; rss_bytes: number; pool: unknown }[] = [];
  // Production search can degrade when one lexical arm fails. A benchmark
  // must not count that cheaper, partial read as a successful measurement.
  const keyword = engine.searchKeyword; const titles = engine.searchTitles;
  engine.searchKeyword = async function(query, opts) {
    try { return await keyword.call(this, query, opts); } catch (error) { backgroundFailure = error; throw error; }
  };
  engine.searchTitles = async function(query, opts) {
    try { return await titles.call(this, query, opts); } catch (error) { backgroundFailure = error; throw error; }
  };
  const transaction = engine.transaction;
  // Observe resolved admission transactions without adding queries. Preserve
  // the receiver so transaction clones retain their actual scoped connection.
  engine.transaction = async function<T>(this: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const value = await transaction.call(this, fn) as T;
    const row = value as Record<string, unknown> | null;
    if (recording && row && row.state === 'queued' && typeof row.request_id === 'string' && starts.has(row.request_id) && !admissionAt.has(row.request_id)) {
      const now = performance.now(); admissionAt.set(row.request_id, now); admissionMs.push(now - starts.get(row.request_id)!);
    }
    return value;
  };
  const put = operationsByName.put_page;
  const ctx: OperationContext = { engine, config: { engine: kind }, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } };
  async function write(i: number, prefix: string) {
    const requestId = randomUUID(); const started = performance.now(); if (recording) starts.set(requestId, started);
    let receipt: Record<string, unknown>;
    try { receipt = await put.handler(ctx, { ...page(i, prefix), request_id: requestId }) as Record<string, unknown>; }
    catch (error) {
      if ((error as { code?: string }).code !== 'write_pending') throw error;
      const principal = { kind: 'local_cli' as const, id: (await readLocalWriter(engine, 'cli')).id };
      const deadline = performance.now() + 120_000;
      for (;;) {
        const row = await getWriteRequest(engine, principal, requestId); assert(row, 'publicly accepted write disappeared');
        if (row.state === 'committed') { receipt = row as unknown as Record<string, unknown>; break; }
        assert(['queued', 'running', 'recovering'].includes(row.state), `public mutation failed: ${row.error_code}: ${row.error_message}`);
        assert(performance.now() < deadline, 'public mutation did not complete'); await Bun.sleep(25);
      }
    }
    assert.equal(receipt!.state, 'committed', 'pending receipt cannot count as a completed write');
    if (recording) { const end = performance.now(); intervals.push([started, end]); completionMs.push(end - started); }
  }
  try {
    if (engine instanceof PostgresEngine) { assertSafeE2eDatabaseUrl(options.databaseUrl!); await engine.connect({ database_url: options.databaseUrl, poolSize: 4 }); }
    else await engine.connect({});
    await engine.initSchema();
    process.stderr.write(`[_read_latency] ${kind}: seeding ${pages} pages through public mutations\n`);
    let seedIndex = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const i = seedIndex++; if (i >= pages) return; await write(i, 'Fixture'); } }));
    assert((await hybridSearch(engine, 'lorem ipsum', { limit: 10 })).length > 0, 'read fixture must contain searchable canonical projections');
    async function readPhase() {
      const timings: number[] = [];
      for (let i = 0; i < count; i++) { if (backgroundFailure) throw backgroundFailure;
        const started = performance.now(); await hybridSearch(engine, queries[i % queries.length], { limit: 10 });
        if (backgroundFailure) throw backgroundFailure; timings.push(performance.now() - started); }
      return { ...distribution(timings), queries_run: timings.length };
    }
    result.phase_a = await readPhase(); recording = true;
    const sample = async () => {
      const [row] = await engine.executeRaw<{ pending: number; age: string; recovery: string; database_sessions?: unknown }>(`SELECT
        COUNT(*) FILTER(WHERE state IN ('queued','running','recovering'))::integer AS pending,
        COALESCE(EXTRACT(EPOCH FROM (now()-MIN(created_at) FILTER(WHERE state IN ('queued','running','recovering'))))*1000,0)::text AS age,
        COALESCE(SUM(recovery_bytes),0)::text AS recovery
        ${kind === 'postgres' ? `, (SELECT json_build_object('total', count(*), 'active', count(*) FILTER(WHERE state='active'),
          'idle', count(*) FILTER(WHERE state='idle'), 'idle_in_transaction', count(*) FILTER(WHERE state='idle in transaction'))
          FROM pg_stat_activity WHERE datname=current_database()) AS database_sessions` : ''} FROM persistence_requests`);
      samples.push({ at_ms: performance.now() - at, queue_count: row.pending, queue_age_ms: Number(row.age), recovery_bytes: Number(row.recovery),
        rss_bytes: process.memoryUsage().rss, pool: engine instanceof PostgresEngine ? {
          tracked_subset: engine.getPoolDiagnostics(), database_sessions: row.database_sessions,
          scope: 'fresh fixture database; active count includes this sampler; tracked gauges cover a SQL subset' } : null });
    };
    await sample();
    metricsTimer = setInterval(() => { if (!metricsWork) metricsWork = sample().catch(error => { backgroundFailure = error; }).finally(() => { metricsWork = undefined; }); }, 250);
    const queryStart = performance.now(); let completed = 0; let failed = 0;
    for (let writer = 0; writer < writerCount; writer++) writers.push((async () => {
      for (let i = 0; !stop && i < cap; i++) { await write(pages + writer * cap + i, `WriterW${writer}`); completed++; }
    })().catch(error => { failed++; backgroundFailure = error; stop = true; }));
    result.phase_b = await readPhase(); const queryEnd = performance.now(); stop = true; await Promise.all(writers);
    if (backgroundFailure) throw backgroundFailure;
    await metricsWork; await sample();
    result.phase_b.writes_completed = completed; result.phase_b.writes_failed = failed;
    result.phase_b.writer_end_ms = Math.max(0, ...intervals.map(([, end]) => end - queryStart));
    result.overlap_pct = overlapPercent(queryStart, queryEnd, intervals);
    result.overlap_basis = 'union of actual public mutation intervals from invocation through terminal receipt';
    result.admission = distribution(admissionMs); result.commit = distribution(completionMs);
    assert.equal(admissionMs.length, completed, 'every completed write needs an observed durable admission');
    result.metrics = samples; result.throughput_writes_per_second = completed * 1000 / (performance.now() - queryStart);
    result.peak_queue_age_ms = Math.max(...samples.map(sample => sample.queue_age_ms));
    result.peak_recovery_bytes = Math.max(...samples.map(sample => sample.recovery_bytes));
    result.peak_rss_bytes = Math.max(...samples.map(sample => sample.rss_bytes));
    for (const p of ['p50', 'p95', 'p99']) result[`delta_${p}_pct`] = 100 * (result.phase_b[`${p}_ms`] / result.phase_a[`${p}_ms`] - 1);
    result.brain_page_count = Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::integer AS n FROM pages'))[0].n);
    assert(completed > 0, 'read-load sample needs actual committed writes'); assert(result.overlap_pct >= 90, `insufficient sustained overlap: ${result.overlap_pct}%`);
    result.ok = true;
  } catch (error) { result.error = String(error); }
  finally {
    stop = true; clearInterval(metricsTimer); await Promise.allSettled(writers); await metricsWork;
    try { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    catch (error) { result.ok = false; result.error = `${result.error ?? ''} shutdown: ${error}`; }
    result.elapsed_ms = performance.now() - at;
  }
  return result;
}
