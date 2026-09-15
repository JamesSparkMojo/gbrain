import { describe, expect, test } from 'bun:test';
import { overlapPercent, summarizeReadRuns } from '../scripts/persistence/read-metrics.ts';
import { runReadPerformance } from '../scripts/persistence/performance.ts';

describe('read-load evidence', () => {
  test('rejects invalid workload sizes before opening a datastore', async () => {
    await expect(runReadPerformance({ pages: 0 })).rejects.toThrow('Invalid pages');
  });
  test('late completion cannot hide an idle interval in the middle of reads', () => {
    expect(overlapPercent(100, 200, [[90, 120], [180, 220]])).toBe(40);
    expect(overlapPercent(100, 200, [[90, 160], [130, 190]])).toBe(90);
    expect(overlapPercent(100, 200, [[190, 220], [80, 180], [150, 190]])).toBe(100);
  });
  const run = (idle: number, loaded: number) => ({ ok: true, overlap_pct: 95,
    phase_a: { p50_ms: idle, p95_ms: idle, p99_ms: idle, queries_run: 200 },
    phase_b: { p50_ms: loaded, p95_ms: loaded, p99_ms: loaded, queries_run: 200, writes_completed: 12, writes_failed: 0 } });
  test('compares independent medians and preserves the 50 percent boundary', () => {
    const results = [run(10, 15), run(1000, 10), run(9, 1000)];
    expect(summarizeReadRuns(results).verdict).toBe('pass');
    expect(summarizeReadRuns([run(10, 15.01), run(10, 15.01), run(10, 15.01)]).verdict).toBe('fail');
  });
  test('a fast invalid or incomplete sample always fails', () => {
    for (const mutate of [
      (r: any) => { r.ok = false; }, (r: any) => { r.overlap_pct = 89.99; },
      (r: any) => { r.phase_b.writes_completed = 0; }, (r: any) => { r.phase_b.writes_failed = 1; },
      (r: any) => { r.phase_b.queries_run = 199; }, (r: any) => { r.phase_a.p99_ms = NaN; },
    ]) { const results = [run(10, 1), run(10, 1), run(10, 1)]; mutate(results[1]); expect(summarizeReadRuns(results).verdict).toBe('fail'); }
    expect(summarizeReadRuns([run(10, 1), run(10, 1)]).verdict).toBe('fail');
  });
});
