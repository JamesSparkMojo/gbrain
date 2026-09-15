import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { claimNextWrite, getWriteRequestById, releaseUnpublishedClaim, renewWriteClaim } from './journal.ts';
import { finishUnpublishedFailure, publishMutation, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { localHostId } from './identity.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { rebuildPendingPageProjections } from '../page-state/projections.ts';

export type PrepareMutation = (engine: BrainEngine, row: WriteRequest, config: GBrainConfig) => Promise<PreparedMutation>;
export class PersistenceConsumer {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | undefined;
  private active = new Set<Promise<void>>();
  private activeRoots = new Set<string>();
  private projectionWorker: Promise<unknown> | undefined;
  readonly hostId: string;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, readonly prepare: PrepareMutation,
    private opts: { hostId?: string; concurrency?: number; pollMs?: number; onError?: (error: unknown) => void } = {}) {
    this.hostId = opts.hostId ?? localHostId();
  }
  start(): void { this.stopping = false; this.schedule(0); }
  private schedule(ms: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule(this.opts.pollMs ?? 250)); }, ms);
    this.timer.unref?.();
  }
  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.doTick().catch(error => { this.report(error); }).finally(() => { this.tickPromise = undefined; });
    return this.tickPromise;
  }
  private async doTick(): Promise<void> {
    if (this.stopping) return;
    await refreshManagedFilesystemRoots(this.engine);
    if (!this.projectionWorker) this.projectionWorker = rebuildPendingPageProjections(this.engine, 2)
      .catch(error => this.report(error)).finally(() => { this.projectionWorker = undefined; });
    // Recover only our owner roots. Kernel exclusion, not elapsed heartbeat,
    // proves that a previous process can no longer be publishing this root.
    const recovery = await this.engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL ORDER BY r.sequence LIMIT 16`, [this.hostId]);
    for (const row of recovery) {
      if (this.activeRoots.has(row.worktree_id!)) continue;
      await recoverPublication(this.engine, row.id, this.hostId);
    }
    await this.engine.executeRaw(`UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL
      WHERE r.state='running' AND r.recovery IS NULL AND r.claim_expires_at<now()
      AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))`, [this.hostId]);
    const concurrency = this.opts.concurrency ?? (this.engine.kind === 'postgres' ? 2 : 1);
    const attemptedRoots = new Set(this.activeRoots);
    while (!this.stopping && this.active.size < concurrency) {
      const row = await claimNextWrite(this.engine, this.hostId, 30_000, [...attemptedRoots]);
      if (!row) break;
      const key = row.worktree_id ?? `db:${row.source_incarnation}`;
      attemptedRoots.add(key);
      if (this.activeRoots.has(key)) { await releaseUnpublishedClaim(this.engine, row, 'writer_busy'); break; }
      this.activeRoots.add(key);
      const task = this.execute(row).catch(error => this.report(error)).finally(() => {
        this.active.delete(task); this.activeRoots.delete(key); this.schedule(0);
      });
      this.active.add(task);
    }
  }
  private report(error: unknown): void {
    if (this.opts.onError) this.opts.onError(error);
    else process.stderr.write('[persistence] Consumer paused after a storage error; inspect writer status.\n');
  }
  private async execute(row: WriteRequest): Promise<void> {
    let renewing: Promise<unknown> | undefined;
    let claimLive = true;
    let closed = false;
    const interval = setInterval(() => {
      if (closed || renewing) return;
      renewing = renewWriteClaim({ executeRaw: this.engine.executeRawDirect.bind(this.engine) }, row.id, row.execution_token!).then(live => { claimLive &&= live; })
        .catch(() => { claimLive = false; }).finally(() => { renewing = undefined; });
    }, 10_000);
    interval.unref?.();
    try {
      const prepared = await this.prepare(this.engine, row, this.config);
      if (!claimLive || this.stopping) { await releaseUnpublishedClaim(this.engine, row, 'consumer_stopping'); return; }
      await publishMutation(this.engine, row, prepared, this.hostId);
    } catch (error) {
      const current = await getWriteRequestById(this.engine, row.id);
      if (current && !isTerminal(current) && current.execution_token === row.execution_token && !current.recovery) await finishUnpublishedFailure(this.engine, current, error);
      else throw error;
    } finally { closed = true; clearInterval(interval); await renewing; }
  }
  /** Mandatory barrier: engine.close must be sequenced AFTER this promise. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tickPromise;
    await Promise.allSettled([...this.active]);
    await this.projectionWorker;
  }
}
