import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';

interface FileCapability { roots: string[]; active: boolean; }
const active = new AsyncLocalStorage<FileCapability>();
const managedRoots = new Map<string, Set<string>>();
function encloses(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function refreshManagedFilesystemRoots(engine: SqlEngine): Promise<void> {
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1');
  if (!brain) return;
  const roots = brain.enabled ? await engine.executeRaw<{ local_path: string }>(
    'SELECT DISTINCT local_path FROM persistence_host_bindings UNION SELECT local_path FROM sources WHERE local_path IS NOT NULL') : [];
  managedRoots.set(brain.brain_id, new Set(roots.map(row => resolve(row.local_path))));
}
export function hasFilesystemPublication(path: string): boolean {
  const held = active.getStore();
  return held?.active === true && held.roots.some(root => encloses(root, path));
}
export function assertManagedFilesystemWrite(path: string): void {
  const managed = [...managedRoots.values()].some(roots => [...roots].some(root => encloses(root, path)));
  if (managed && !hasFilesystemPublication(path)) throw new OperationError('writer_coordinator_required',
    'This file belongs to a managed canonical worktree.', 'Submit the change through the persistence coordinator.');
}
/** Invalidate inherited async contexts before the owner releases the kernel lock. */
export async function withFilesystemPublication<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const context = { roots: roots.map(root => resolve(root)), active: true };
  return active.run(context, async () => { try { return await fn(); } finally { context.active = false; } });
}
export async function assertLegacyFilesystemWriter(engine: SqlEngine, path: string): Promise<void> {
  await refreshManagedFilesystemRoots(engine);
  assertManagedFilesystemWrite(path);
}
