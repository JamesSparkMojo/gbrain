import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../pglite-lock.ts';
import { assertManagedFilesystemWrite } from './filesystem-guard.ts';
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';

/** Refuse unsupported multi-stage writers before providers, files or git change. */
export async function assertUnmanagedCanonicalWriter(engine: SqlEngine, operation: string): Promise<void> {
  const rows = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (rows?.[0]?.enabled) throw new OperationError('writer_coordinator_required',
    `${operation} cannot mutate a managed brain through the legacy writer.`,
    'Use supported persistence operations. Source topology and maintenance require a verified drain before migration.');
}

/** Legacy reinit may rename only after acquiring the stable sibling kernel lock. */
export async function backupUnmanagedPglite(dataDir: string, backupDir: string): Promise<void> {
  assertManagedFilesystemWrite(dataDir);
  if (!existsSync(dataDir) || existsSync(backupDir)) throw new Error('PGLite backup paths changed; inspect before retrying.');
  const lock = await acquireLock(dataDir, { timeoutMs: 0 });
  try {
    assertManagedFilesystemWrite(dataDir);
    if (existsSync(backupDir)) throw new Error('PGLite backup already exists; inspect before retrying.');
    renameSync(dataDir, backupDir);
    // Metadata moved with the old datastore. Remove only this ticket's marker;
    // release still targets the original stable sibling native lock.
    lock.lockDir = join(backupDir, '.gbrain-lock');
  } finally { await releaseLock(lock); }
}
