import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

const engine = new PGLiteEngine();
const root = mkdtempSync(join(tmpdir(), 'gbrain-semantic-pages-'));
const sourceId = 'semantic-pages-test';
const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } };
const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
beforeAll(async () => {
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId,root]);
  await submit('put_page', { slug: 'page', content: '---\ntype: note\ntitle: Example\n---\nStable prose\n' });
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

test('concurrent semantic tag mutations preserve every accepted tag and coherent file snapshot', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => submit('add_tag', { slug: 'page', tag: `tag-${i}` })));
  expect(results.every(result => result.state === 'committed')).toBe(true);
  const snapshot = (await engine.readPageSnapshot('page', { sourceId }))!;
  expect(snapshot.tags).toEqual(Array.from({ length: 6 }, (_, i) => `tag-${i}`));
  expect(snapshot.page.compiled_truth).toContain('Stable prose');
  for (const tag of snapshot.tags) expect(readFileSync(join(root,'page.md'),'utf8')).toContain(tag);
  const revision = snapshot.revision;
  const replay = await submit('add_tag', { slug: 'page', tag: 'tag-0' });
  expect(replay.revision).toBe(revision);
});

test('timeline replay is an exact no-op in Markdown, revision, versions and structured rows', async () => {
  const params = { slug: 'page', date: '2026-09-15', summary: 'Example milestone', detail: 'Example detail', source: 'example-source' };
  await submit('add_timeline_entry', params);
  const before = (await engine.readPageSnapshot('page', { sourceId }))!;
  const file = join(root,'page.md');
  const bytes = readFileSync(file,'utf8');
  const modified = statSync(file).mtimeMs;
  const versions = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id]);
  const replay = await submit('add_timeline_entry', params);
  expect(replay.status).toBe('skipped');
  expect((await engine.readPageSnapshot('page', { sourceId }))!.revision).toBe(before.revision);
  expect(readFileSync(file,'utf8')).toBe(bytes);
  expect(statSync(file).mtimeMs).toBe(modified);
  expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id])).toEqual(versions);
  expect(await engine.getTimeline('page', { sourceId })).toHaveLength(1);
});
