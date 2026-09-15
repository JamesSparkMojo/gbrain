/** Stable OS locks for cooperating writers on one owner host. No TTL takeover. */
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { family, GLIBC, MUSL } from 'detect-libc';

interface NativeBinding {
  target: string;
  openLock(path: string): object;
  tryLock(handle: object): boolean;
  close(handle: object): void;
}

export class NativeLockUnavailableError extends Error {
  readonly code = 'writer_lock_unavailable';
  constructor(message = 'Native writer locking is unavailable on this host', cause?: unknown) {
    super(message, { cause });
    this.name = 'NativeLockUnavailableError';
  }
}

export interface NativeLockHandle {
  /** True after release. A released handle must not authorize further work. */
  readonly released: boolean;
  /** Idempotent. Closing the OS handle releases its lock without unlinking. */
  release(): Promise<void>;
}

export interface NativeLockOptions {
  /** A zero budget tries once. Defaults to five seconds. */
  timeoutMs?: number;
  /** Delay between nonblocking attempts; defaults to 25 ms. */
  pollMs?: number;
  signal?: AbortSignal;
}

let bindingPromise: Promise<NativeBinding> | undefined;

async function loadBinding(): Promise<NativeBinding> {
  const arch = process.arch;
  if (arch !== 'x64' && arch !== 'arm64') throw new NativeLockUnavailableError(`Native writer locking does not support ${process.platform}/${arch}`);
  let binding: NativeBinding;
  let target: string;
  try {
    if (process.platform === 'linux') {
      const libc = await family();
      if (libc !== GLIBC && libc !== MUSL) throw new NativeLockUnavailableError('Cannot identify the Linux C runtime for writer locking');
      target = `linux-${arch}-${libc}`;
      // Literal requires are intentional: Bun embeds each .node asset in its
      // compiled executables. Dynamic prebuild discovery does not embed them.
      if (libc === GLIBC) binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/linux-x64-glibc.node')
        : require('../../../native/locks/prebuilds/linux-arm64-glibc.node');
      else binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/linux-x64-musl.node')
        : require('../../../native/locks/prebuilds/linux-arm64-musl.node');
    } else if (process.platform === 'darwin') {
      target = `darwin-${arch}`;
      binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/darwin-x64.node')
        : require('../../../native/locks/prebuilds/darwin-arm64.node');
    } else if (process.platform === 'win32') {
      target = `win32-${arch}`;
      binding = arch === 'x64'
        ? require('../../../native/locks/prebuilds/win32-x64.node')
        : require('../../../native/locks/prebuilds/win32-arm64.node');
    } else throw new NativeLockUnavailableError(`Native writer locking does not support ${process.platform}/${arch}`);
    if (binding.target !== target || typeof binding.openLock !== 'function' || typeof binding.tryLock !== 'function' || typeof binding.close !== 'function') {
      throw new NativeLockUnavailableError('Installed native writer lock addon has the wrong target or ABI');
    }
    return binding;
  } catch (cause) {
    if (cause instanceof NativeLockUnavailableError) throw cause;
    throw new NativeLockUnavailableError('Cannot load the native writer lock addon; reinstall this GBrain version', cause);
  }
}

/** Lazy so a nonowner Postgres server can still accept writes and serve reads. */
export async function nativeLockCapability(): Promise<{ target: string; napi: 3 }> {
  const binding = await (bindingPromise ??= loadBinding());
  return { target: binding.target, napi: 3 };
}

function budget(value: number | undefined, fallback: number, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > 2 ** 31 - 1) throw new RangeError(`Native lock duration must be between ${minimum} and ${2 ** 31 - 1} milliseconds`);
  return result;
}

/** The caller supplies a stable absolute path outside the mutable worktree. */
export async function acquireNativeLock(path: string, options: NativeLockOptions = {}): Promise<NativeLockHandle | null> {
  if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('Native lock path must be absolute and contain no NUL');
  const timeoutMs = budget(options.timeoutMs, 5000, 0);
  const pollMs = budget(options.pollMs, 25, 1);
  const { signal } = options;
  signal?.throwIfAborted();
  const binding = await (bindingPromise ??= loadBinding());
  let handle: object;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    handle = binding.openLock(path);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw new NativeLockUnavailableError('Cannot open the stable writer lock file', cause);
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { binding.close(handle); }
    catch (cause) { throw new NativeLockUnavailableError('Cannot close the writer lock handle; this host must stop publishing', cause); }
  };
  const deadline = performance.now() + timeoutMs;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let acquired: boolean;
      try { acquired = binding.tryLock(handle); }
      catch (cause) { throw new NativeLockUnavailableError('The OS could not acquire the writer lock', cause); }
      if (acquired) return { get released() { return released; }, release };
      const remaining = deadline - performance.now();
      if (remaining <= 0) { await release(); return null; }
      await delay(Math.min(pollMs, remaining), undefined, { signal });
    }
  } catch (error) {
    await release();
    throw error;
  }
}

export function tryAcquireNativeLock(path: string): Promise<NativeLockHandle | null> {
  return acquireNativeLock(path, { timeoutMs: 0 });
}
