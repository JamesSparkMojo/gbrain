import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from './authority.ts';
import { completeWrite, getWriteRequest, lockCounters } from './journal.ts';
import { isTerminal, principalKey, type Principal, type WriteRequest } from './model.ts';

export async function listWriteRequests(engine: BrainEngine, principal: Principal,
  opts: { sourceId: string; before?: string; limit?: number; authorize?: (row: WriteRequest) => Promise<boolean> }): Promise<{ requests: WriteRequest[]; next: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
  if (opts.before !== undefined && !/^\d+$/.test(opts.before)) throw new OperationError('invalid_params', 'Invalid write request cursor.');
  // Principal/source restrictions are applied before SQL pagination. Additional
  // current fences filter candidates without leaking counts or foreign cursors.
  const visible: WriteRequest[] = [];
  let before = opts.before;
  for (;;) {
    const rows = await engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
      WHERE principal_kind=$1 AND principal_id=$2 AND source_id=$3
      AND ($4::bigint IS NULL OR sequence<$4::bigint) ORDER BY sequence DESC LIMIT $5`,
    [principal.kind, principal.id, opts.sourceId, before ?? null, limit + 1]);
    if (!rows.length) return { requests: visible, next: null };
    for (const row of rows) {
      before = String(row.sequence);
      let allowed = false;
      try { await authorizeStoredRequest(engine, row); allowed = !opts.authorize || await opts.authorize(row); }
      catch (error) { if (!(error instanceof OperationError && ['permission_denied','source_changed'].includes(error.code))) throw error; }
      if (allowed) visible.push(row);
      if (visible.length > limit) return { requests: visible.slice(0, limit), next: String(visible[limit - 1].sequence) };
    }
    if (rows.length < limit + 1) return { requests: visible, next: null };
  }
}
export async function cancelWriteRequest(engine: BrainEngine, principal: Principal, requestId: string): Promise<WriteRequest | null> {
  const row = await getWriteRequest(engine, principal, requestId);
  if (!row) return null;
  return engine.transaction(async tx => {
    await authorizeStoredRequest(tx, row, true);
    await lockCounters(tx, ['brain', principalKey(principal), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
    const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
    if (!current || isTerminal(current)) return current ?? null;
    // A persisted recovery record means publication may have begun even when
    // the final transaction's publication_started flag was rolled back.
    if (current.publication_started || current.recovery) return current;
    return completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled', message: 'Cancelled before publication.' });
  });
}
export async function writerDiagnostics(engine: BrainEngine) {
  const [brain] = await engine.executeRaw<{ enabled: boolean; brain_id: string }>('SELECT enabled,brain_id FROM persistence_brain WHERE singleton=1');
  const worktrees = await engine.executeRaw(`SELECT w.id,w.owner_host_id,w.owner_epoch,w.topology_generation,w.state,w.heartbeat_at,
    COUNT(r.id) FILTER (WHERE r.state='queued')::integer AS queued,
    COUNT(r.id) FILTER (WHERE r.state='running')::integer AS running,
    COUNT(r.id) FILTER (WHERE r.state='recovering')::integer AS recovering,
    MIN(r.created_at) FILTER (WHERE r.state IN ('queued','running','recovering')) AS oldest_request_at,
    MAX(r.sequence) FILTER (WHERE r.state='committed') AS last_completed_sequence,
    COALESCE(SUM(r.recovery_bytes),0)::text AS recovery_bytes
    FROM persistence_worktrees w LEFT JOIN persistence_requests r ON r.worktree_id=w.id
    GROUP BY w.id ORDER BY w.id`);
  const counters = await engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key');
  const blockers = await engine.executeRaw(`SELECT request_id,worktree_id,state,blocked_reason,error_code,created_at
    FROM persistence_requests WHERE state='recovering' OR blocked_reason IS NOT NULL ORDER BY sequence LIMIT 100`);
  return { ...brain, worktrees, counters, blockers };
}
