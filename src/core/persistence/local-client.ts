/** Engine-free CLI routing to the process that already owns a PGLite brain. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type GBrainConfig } from '../config.ts';
import { resolveBrainId } from '../brain-resolver.ts';
import { loadMounts, type MountEntry } from '../brain-registry.ts';
import { inspectLockHolder } from '../pglite-lock.ts';
import { resolveSourceIdEngineFree } from '../source-resolver.ts';
import { OperationError } from '../ops/contract.ts';
import { parseWriteRequestId } from './preconditions.ts';
import {
  isPersistenceIpcMutation, isPersistenceIpcOperation, isPersistenceIpcRegistration,
  persistenceSocketPathForConfig, requestPersistenceCapabilities, requestPersistenceOperation,
  type PersistenceIpcRegistration,
} from './ipc.ts';

/** The brain axis must be resolved before inspecting any host lock/socket. */
export function persistenceConfigForBrain(
  hostConfig: GBrainConfig | null,
  brainId: string,
  mounts: readonly MountEntry[],
): GBrainConfig | null {
  if (brainId === 'host') return hostConfig;
  const mount = mounts.find(candidate => candidate.id === brainId || candidate.alias === brainId);
  if (!mount || mount.enabled === false) throw new OperationError('invalid_params', `Brain '${brainId}' is not an enabled mount.`);
  return { engine: mount.engine, database_path: mount.database_path, database_url: mount.database_url } as GBrainConfig;
}

/** Reads an existing registration only. Revocation/missing credentials never create a new principal. */
export function readPersistenceCliRegistration(brainId: string): PersistenceIpcRegistration {
  // Capability validation has already constrained this filename component to a UUID.
  const id = parseWriteRequestId(brainId);
  if (!id) throw new OperationError('permission_denied', 'Missing durable brain identity.');
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(configDir(), 'persistence', `${id}.cli.json`), 'utf8')); }
  catch { throw new OperationError('permission_denied', 'This CLI has no readable durable writer registration for the selected brain.',
    'Register or explicitly regrant the CLI writer on this brain, then retry the same request ID.'); }
  if (!isPersistenceIpcRegistration(value) || value.lane !== 'cli') {
    throw new OperationError('permission_denied', 'The local CLI writer registration is invalid.');
  }
  return value;
}

export type LocalDelegationResult = { handled: false } | { handled: true; result: unknown };

/**
 * Mutates params only to retain a generated request ID across local/IPC paths.
 * False means no live serve owns this selected brain; the normal engine path
 * may connect. Once a live serve is observed, every failure is final here:
 * never fall through after an unavailable socket or a lost acknowledgment.
 */
export async function maybeDelegateLocalOperation(
  operation: string,
  params: Record<string, unknown>,
  hostConfig: GBrainConfig | null,
  options: { brain?: string | null; cwd?: string; timeoutMs?: number } = {},
): Promise<LocalDelegationResult> {
  if (!isPersistenceIpcOperation(operation)) return { handled: false };
  if (isPersistenceIpcMutation(operation)) {
    params.request_id = parseWriteRequestId(params.request_id) ?? randomUUID();
  }
  const cwd = options.cwd ?? process.cwd();
  const brainId = resolveBrainId(options.brain, cwd);
  const config = persistenceConfigForBrain(hostConfig, brainId, brainId === 'host' ? [] : loadMounts());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url) return { handled: false };
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held || !holder.serve) return { handled: false };
  const socketPath = persistenceSocketPathForConfig(config);
  if (!socketPath) throw new OperationError('owner_unavailable', 'The selected PGLite owner has no persistence discovery path.');

  const explicit = typeof params.source === 'string' ? params.source : null;
  const source = resolveSourceIdEngineFree(explicit, cwd);
  const wireParams = { ...params };
  // These belong to the CLI context/renderer, not the operation schema.
  delete wireParams.source;
  delete wireParams.json;
  const capability = await requestPersistenceCapabilities(socketPath);
  if (!capability.operations.includes(operation)) {
    throw new OperationError('owner_unavailable', `The running persistence owner does not support '${operation}'.`,
      'Upgrade and restart the owner, then retry with the same request ID.');
  }
  const registration = readPersistenceCliRegistration(capability.brain_id);
  const result = await requestPersistenceOperation(socketPath, {
    version: 1, kind: 'operation', brain_id: capability.brain_id,
    operation, params: wireParams, registration, routing: { source, cwd },
  }, options.timeoutMs);
  return { handled: true, result };
}
