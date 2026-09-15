import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { registerLocalWriter, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, compactWriteReceipts, getWriteRequest, getWriteRequestById, receiptFor, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { publishMutation, recoverPublication } from '../src/core/persistence/coordinator.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
const sourceId = 'persistence-journal-test';
const hostId = randomUUID();
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId, remote: false,
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  const pg = process.env.DATABASE_URL;
  const local = new PGLiteEngine();
  await local.connect({}); await local.initSchema(); engines.push(local);
  if (pg) {
    assertSafeE2eDatabaseUrl(pg);
    const remote = new PostgresEngine();
    await remote.connect({ database_url: pg, poolSize: 4 }); await remote.initSchema(); engines.push(remote);
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'cli');
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); await engine.disconnect(); }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
async function admission(engine: BrainEngine, slug: string, content = 'new', extra: Partial<WriteAdmission> = {}): Promise<WriteAdmission> {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const authority = await submissionAuthority(ctx(engine), 'put_page', sourceId, source.incarnation, slug);
  const page = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source.incarnation, slug,
    pageId: page?.page.id ?? null, requestId: randomUUID(), callerIntent: { content }, intent: { content }, authority, ...extra };
}

describe('durable mutation journal', () => {
  test('activation rejects legacy canonical writers but accepts guarded publication', async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(engine.putPage('unguarded', input('No'), { sourceId })).rejects.toThrow('writer_coordinator_required');
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          await tx.putPage('guarded', input('Yes'), { sourceId });
          await tx.addTag('guarded', 'coherent', { sourceId });
        }));
        expect((await engine.readPageSnapshot('guarded', { sourceId }))!.tags).toEqual(['coherent']);
        await expect(engine.addTag('guarded', 'uncoordinated', { sourceId })).rejects.toThrow('writer_coordinator_required');
      } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); }
    }
  });
  test('concurrent duplicate admissions reserve one ID and conflict on altered intent', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'duplicate');
      const rows = await Promise.all(Array.from({ length: 8 }, () => admitWrite(engine, a)));
      expect(new Set(rows.map(r => r.id)).size).toBe(1);
      await expect(admitWrite(engine, { ...a, callerIntent: { content: 'altered' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const cancelled = await cancelWriteRequest(engine, a.principal, a.requestId!);
      expect(cancelled!.state).toBe('cancelled');
      expect((await admitWrite(engine, a)).state).toBe('cancelled');
      expect(receiptFor(cancelled!).retry_after_ms).toBeNull();
    }
  });
  test('two accepted create-only intents have exactly one commit', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'create-race', 'A');
      const b = await admission(engine, 'create-race', 'B');
      await Promise.all([admitWrite(engine, a), admitWrite(engine, b)]);
      const first = (await claimNextWrite(engine, hostId))!;
      const committed = await publishMutation(engine, first, { observedRevision: null,
        apply: async tx => { await tx.putPage(first.slug, input(String(first.intent!.content)), { sourceId }); return { status: 'created' }; } }, hostId);
      expect(committed.state).toBe('committed');
      const second = (await claimNextWrite(engine, hostId))!;
      const conflict = await publishMutation(engine, second, { observedRevision: null, apply: async () => { throw new Error('must not execute'); } }, hostId);
      expect(conflict.state).toBe('conflict');
      expect((await engine.readPageSnapshot(first.slug, { sourceId }))!.revision).toBe(String(committed.outcome!.revision));
    }
  });
  test('stale no-op loses its revision precondition before no-op detection', async () => {
    for (const engine of engines) {
      const page = await engine.putPage('stale-noop', input('Original'), { sourceId });
      const a = await admission(engine, 'stale-noop', 'Original', { intent: { content: 'Original', expected_revision: page.knowledge_revision } });
      const row = await admitWrite(engine, a);
      await engine.addTag('stale-noop', 'changed', { sourceId });
      await expect(preparePageMutation(engine, row, { engine: engine.kind })).rejects.toMatchObject({ code: 'revision_conflict' });
      await cancelWriteRequest(engine, a.principal, a.requestId!);
    }
  });
  test('quota admits exactly its budget, duplicates consume none, terminal reservations remain', async () => {
    for (const engine of engines) {
      const local = await registerLocalWriter(engine, 'stdio');
      const [inc] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
      const authority = await submissionAuthority({ ...ctx(engine), remote: true }, 'put_page', sourceId, inc.incarnation, 'quota');
      const base = await admission(engine, 'quota');
      const requests = Array.from({ length: 3 }, () => ({ ...base, principal: authority.principal, authority, requestId: randomUUID() }));
      const results = await Promise.allSettled(requests.map(a => admitWrite(engine, a, { principalOutstanding: 2 })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      for (const a of requests) {
        const row = await getWriteRequest(engine, a.principal, a.requestId);
        if (row) {
          expect((await admitWrite(engine, a, { principalOutstanding: 2 })).id).toBe(row.id);
          await cancelWriteRequest(engine, a.principal, a.requestId);
        }
      }
      const [counter] = await engine.executeRaw<{ outstanding_count: number; lifetime_ids: number; terminal_bytes: number }>(
        'SELECT * FROM persistence_counters WHERE key=$1', [`principal:local_stdio:${local.id}`]);
      expect(Number(counter.outstanding_count)).toBe(0);
      expect(Number(counter.lifetime_ids)).toBe(2);
      expect(Number(counter.terminal_bytes)).toBeGreaterThan(0);
    }
  });
  test('file failure restores original bytes, leaves old database revision, and retains one outcome', async () => {
    for (const engine of engines) {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-journal-root-')); roots.push(root);
      const fileSource = `${sourceId}-${randomUUID().slice(0,8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT(id) DO UPDATE SET local_path=$2', [fileSource, root]);
      const binding = await claimWorktree(engine, fileSource, root, hostId);
      const page = await engine.putPage('file', input('Before'), { sourceId: fileSource });
      const path = join(root, 'file.md'); writeFileSync(path, 'Before');
      const authority = await submissionAuthority({ ...ctx(engine), sourceId: fileSource }, 'put_page', fileSource, binding.source_incarnation, 'file');
      const a = { ...(await admission(engine, 'file')), principal: authority.principal, authority, sourceId: fileSource,
        sourceIncarnation: binding.source_incarnation, pageId: page.id, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation };
      await admitWrite(engine, a);
      const row = (await claimNextWrite(engine, hostId))!;
      const uncertain = await publishMutation(engine, row, { observedRevision: page.knowledge_revision!, file: { path, root, content: 'After' },
        apply: async tx => { await tx.putPage('file', input('After'), { sourceId: fileSource }); return {}; } }, hostId,
      { boundary: async name => { if (name === 'before_commit') throw new Error('simulated rollback'); } });
      expect(uncertain.state).toBe('queued');
      expect(readFileSync(path, 'utf8')).toBe('Before');
      expect((await engine.getPage('file', { sourceId: fileSource }))!.knowledge_revision).toBe(page.knowledge_revision!);
      const retry = (await claimNextWrite(engine, hostId))!;
      const committed = await publishMutation(engine, retry, { observedRevision: page.knowledge_revision!, file: { path, root, content: 'After' },
        apply: async tx => { await tx.putPage('file', input('After'), { sourceId: fileSource }); return { status: 'updated' }; } }, hostId,
      { boundary: async name => { if (name === 'after_commit') throw new Error('lost response'); } });
      expect(committed.state).toBe('committed');
      expect(readFileSync(path, 'utf8')).toBe('After');
      expect((await getWriteRequestById(engine, row.id))!.recovery).toBeNull();
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [fileSource]);
    }
  });
  test('compaction preserves terminal identity and frozen result', async () => {
    for (const engine of engines) {
      const a = await admission(engine, 'compact');
      const row = await admitWrite(engine, a);
      await cancelWriteRequest(engine, a.principal, a.requestId!);
      await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [row.id]);
      expect(await compactWriteReceipts(engine)).toBeGreaterThan(0);
      const replay = await admitWrite(engine, a);
      expect(replay.compacted).toBe(true); expect(replay.state).toBe('cancelled'); expect(replay.intent).toBeNull();
    }
  });
});
