import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { activeGitHooks, installHook, uninstallHook } from '../src/commands/frontmatter-install-hook.ts';
import { withEnv } from './helpers/with-env.ts';

function gitInit(dir: string) {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

/**
 * installHook with the developer's global/system git config masked: a global
 * core.hooksPath (husky, secret-scanner templates, dotfiles) would otherwise
 * turn every "installed" here into "installed_unwired". Tests that WANT a
 * global value wrap withEnv themselves.
 */
const install = (path: string, force = false) =>
  withEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, () => installHook(path, force));

/** The repo-local core.hooksPath ('' when unset) — global scope never leaks in. */
function localHooksPath(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

describe('frontmatter install-hook (B13)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fm-hook-'));
    gitInit(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('installHook writes executable .githooks/pre-commit and sets core.hooksPath', async () => {
    const result = await install(tmp);
    expect(result).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('gbrain frontmatter');
    expect(content).toContain('git diff --cached');
    // install() masks the developer's global config, so the clean-machine
    // branch is the only one here; the "already set elsewhere" branch has its
    // own test below. Read the LOCAL scope so a global value can't satisfy it.
    expect(localHooksPath(tmp)).toBe('.githooks');
  });

  test('#1840 — generated hook matches .md/.mdx (single-backslash regex, not over-escaped)', async () => {
    await install(tmp);
    const content = readFileSync(join(tmp, '.githooks', 'pre-commit'), 'utf8');
    // The shell must see `grep -E '\.mdx?$'`. Pre-fix it emitted `'\\.mdx?$'`
    // (literal backslash), so the hook matched nothing and silently no-opped.
    expect(content).toContain("grep -E '\\.mdx?$'");
    expect(content).not.toContain("grep -E '\\\\.mdx?$'");

    // Prove the emitted pattern actually selects markdown files. Extract the
    // exact pattern between the single quotes and run it through ripgrep-free
    // JS regex parity (POSIX ERE `\.mdx?$` == JS `/\.mdx?$/`).
    const m = content.match(/grep -E '([^']+)'/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]);
    expect(re.test('notes/thing.md')).toBe(true);
    expect(re.test('notes/thing.mdx')).toBe(true);
    expect(re.test('notes/thing.txt')).toBe(false);
  });

  test('installHook refuses to clobber existing hook without --force', async () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = await install(tmp);
    expect(result).toBe('skipped_existing');
    // Original survives.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('installHook with force overwrites and saves .bak', async () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = await install(tmp, true);
    expect(result).toBe('installed');
    expect(existsSync(hookPath + '.bak')).toBe(true);
    expect(readFileSync(hookPath + '.bak', 'utf8')).toContain('user hook');
    expect(readFileSync(hookPath, 'utf8')).toContain('gbrain frontmatter');
  });

  test('installHook on existing gbrain hook refreshes silently (no .bak)', async () => {
    await install(tmp);
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath + '.bak')).toBe(false);
    // Re-run; should be 'unchanged' (banner already present).
    const second = await install(tmp);
    expect(second).toBe('unchanged');
  });

  test('uninstallHook removes the gbrain hook and restores .bak when present', async () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    await install(tmp, true);
    expect(existsSync(hookPath + '.bak')).toBe(true);

    const removed = uninstallHook(tmp);
    expect(removed).toBe(true);
    // .bak content restored as the active hook.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('uninstallHook on a non-gbrain hook returns false (does not remove user hook)', async () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const removed = uninstallHook(tmp);
    expect(removed).toBe(false);
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
  });

  // ── #4600: local_path is a SUBDIRECTORY of the host repo (the `<ws>/brain`
  // layout `gbrain bootstrap` creates) — the hook lands at the discovered git
  // root, pathspec-scoped to the source, one hook per root.

  test('#4600 nested source: hook installs at the discovered git root, scoped to the subdirectory', async () => {
    mkdirSync(join(tmp, 'brain'));
    expect(await install(join(tmp, 'brain'))).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(join(tmp, 'brain', '.githooks'))).toBe(false);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('# gbrain-scope: brain/');
    expect(content).toContain("--diff-filter=ACM -- 'brain/' | grep -E '\\.mdx?$'");
  });

  test('#4600 several nested sources share one hook: pathspecs union, no .bak, idempotent', async () => {
    mkdirSync(join(tmp, 'brain'));
    mkdirSync(join(tmp, 'wiki'));
    expect(await install(join(tmp, 'brain'))).toBe('installed');
    expect(await install(join(tmp, 'wiki'))).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('# gbrain-scope: brain/');
    expect(content).toContain('# gbrain-scope: wiki/');
    expect(content).toContain("-- 'brain/' 'wiki/' |");
    expect(existsSync(hookPath + '.bak')).toBe(false);
    expect(await install(join(tmp, 'wiki'))).toBe('unchanged');
  });

  test('#4600 root-registered source keeps the unscoped script; a root install widens a scoped hook to the whole repo', async () => {
    await install(tmp);
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(readFileSync(hookPath, 'utf8')).not.toContain('gbrain-scope');
    expect(readFileSync(hookPath, 'utf8')).toContain("--diff-filter=ACM | grep -E '\\.mdx?$'");

    mkdirSync(join(tmp, 'brain'));
    expect(await install(join(tmp, 'brain'))).toBe('unchanged'); // whole repo already covers brain/
    expect(readFileSync(hookPath, 'utf8')).not.toContain('gbrain-scope');
  });

  test('#4600 the other order: a root install after a nested one widens the scoped hook to the whole repo', async () => {
    mkdirSync(join(tmp, 'brain'));
    await install(join(tmp, 'brain'));
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(readFileSync(hookPath, 'utf8')).toContain('# gbrain-scope: brain/');
    expect(await install(tmp)).toBe('installed');
    const content = readFileSync(hookPath, 'utf8');
    expect(content).not.toContain('gbrain-scope');
    expect(content).toContain("--diff-filter=ACM | grep -E '\\.mdx?$'");
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('#4600 the scoped hook ignores staged files outside the source (host README commits pass)', async () => {
    mkdirSync(join(tmp, 'brain'));
    await install(join(tmp, 'brain'));
    // A `gbrain` stub that fails every validate call: any staged file that
    // reaches the loop blocks the commit, so exit 0 proves the pathspec.
    const bin = mkdtempSync(join(tmpdir(), 'fm-hook-bin-'));
    writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const runHook = (): number => {
      try {
        execFileSync('sh', [join(tmp, '.githooks', 'pre-commit')], { cwd: tmp, env, stdio: 'pipe' });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    try {
      writeFileSync(join(tmp, 'README.md'), 'no frontmatter here\n');
      execFileSync('git', ['-C', tmp, 'add', 'README.md']);
      expect(runHook()).toBe(0);
      writeFileSync(join(tmp, 'brain', 'bad.md'), 'no frontmatter here\n');
      execFileSync('git', ['-C', tmp, 'add', 'brain/bad.md']);
      expect(runHook()).toBe(1);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('#4600 uninstall for one nested source drops only its scope; the last one removes the hook', async () => {
    mkdirSync(join(tmp, 'brain'));
    mkdirSync(join(tmp, 'wiki'));
    await install(join(tmp, 'brain'));
    await install(join(tmp, 'wiki'));
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(uninstallHook(join(tmp, 'brain'))).toBe(true);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).not.toContain('brain/');
    expect(content).toContain("-- 'wiki/' |");
    expect(uninstallHook(join(tmp, 'wiki'))).toBe(true);
    expect(existsSync(hookPath)).toBe(false);
  });

  test('a host repo that already runs hooks from .git/hooks keeps core.hooksPath unset (hook written, not wired)', async () => {
    // Setting core.hooksPath makes git ignore <gitdir>/hooks/* for EVERY hook
    // type. `git init` ships only *.sample files there (inert); an executable
    // non-sample entry is a live hook the user relies on, so wiring .githooks
    // would silently disable it. Non-executable files are ignored by git too.
    const gitHooks = join(tmp, '.git', 'hooks');
    writeFileSync(join(gitHooks, 'pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(gitHooks, 'pre-rebase'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    expect(activeGitHooks(tmp)).toEqual(['pre-push']);
    mkdirSync(join(tmp, 'brain'));
    expect(await install(join(tmp, 'brain'))).toBe('installed_unwired');
    // A re-run refreshes an identical script — still inert, so still unwired
    // (not "unchanged", which the CLI prints as "already up to date").
    expect(await install(join(tmp, 'brain'))).toBe('installed_unwired');
    expect(existsSync(join(tmp, '.githooks', 'pre-commit'))).toBe(true);
    expect(localHooksPath(tmp)).toBe('');
  });

  test('a core.hooksPath already pointing elsewhere (global/corporate templates) is reported unwired, not installed', async () => {
    // git resolves core.hooksPath from every scope; a global one (husky,
    // secret-scanner templates, dotfiles) means git never looks at .githooks.
    // "installed" would be a lie — the hook is on disk but inert.
    const other = mkdtempSync(join(tmpdir(), 'fm-hook-elsewhere-'));
    try {
      writeFileSync(join(other, 'gitconfig'), `[core]\n\thooksPath = ${join(other, 'hooks')}\n`);
      // installHook directly: install() would mask the very global config
      // this test supplies.
      await withEnv({ GIT_CONFIG_GLOBAL: join(other, 'gitconfig') }, async () => {
        expect(installHook(tmp, false)).toBe('installed_unwired');
      });
      expect(existsSync(join(tmp, '.githooks', 'pre-commit'))).toBe(true);
      expect(localHooksPath(tmp)).toBe(''); // theirs to keep — never clobbered
      // The inverse: a hooksPath that RESOLVES to our dir (absolute, unresolved
      // /tmp on macOS) is wired, whatever its spelling.
      execFileSync('git', ['-C', tmp, 'config', 'core.hooksPath', join(tmp, '.githooks')]);
      expect(await install(tmp)).toBe('unchanged');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('a fresh clone that carries the committed gbrain hook gets wired on install (not "unchanged" while inert)', async () => {
    // The hook FILE travels with the repo; core.hooksPath is per-clone config
    // and does not. Install on the clone must fall through to the wiring step
    // instead of stopping at "the script is already current".
    await install(tmp);
    execFileSync('git', ['-C', tmp, 'add', '.githooks']);
    execFileSync('git', ['-C', tmp, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'add hook']);
    const clone = mkdtempSync(join(tmpdir(), 'fm-hook-clone-'));
    try {
      execFileSync('git', ['clone', '-q', tmp, clone]);
      expect(localHooksPath(clone)).toBe('');
      expect(await install(clone)).toBe('installed');
      expect(localHooksPath(clone)).toBe('.githooks');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test('a host repo that ships other hook scripts under .githooks/ keeps core.hooksPath unset (wiring would activate them)', async () => {
    // Third-party clones commit `.githooks/<hook>` as a convention. Pointing
    // core.hooksPath at that dir makes git run EVERY executable script in
    // it — not just ours — so the installer must refuse to flip the switch.
    mkdirSync(join(tmp, '.githooks'));
    writeFileSync(join(tmp, '.githooks', 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tmp, '.githooks', 'README.md'), 'docs, not a hook\n');
    expect(await install(tmp)).toBe('installed_unwired');
    expect(readFileSync(join(tmp, '.githooks', 'pre-commit'), 'utf8')).toContain('gbrain frontmatter');
    expect(localHooksPath(tmp)).toBe('');
  });

  test('#4600 a path outside any git repo is refused with the shared sync message, nothing written', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'fm-hook-nogit-'));
    try {
      await expect(install(plain)).rejects.toThrow(/Not inside a git repository/);
      expect(existsSync(join(plain, '.githooks'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
