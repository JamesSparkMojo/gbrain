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

describe('frontmatter install-hook (B13)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fm-hook-'));
    gitInit(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('installHook writes executable .githooks/pre-commit and sets core.hooksPath', () => {
    const result = installHook(tmp, false);
    expect(result).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('gbrain frontmatter');
    expect(content).toContain('git diff --cached');
    // installHook's contract is "set core.hooksPath unless it's already set
    // elsewhere". Test BOTH branches deterministically by reading the local
    // scope only: clean CI → local should be `.githooks`; developer with a
    // global core.hooksPath (e.g. dotfiles → ~/.config/git/hooks) → local
    // should be empty because installHook correctly skipped clobbering.
    // Reading via `--get` without `--local` falls back to global scope when
    // local is unset, which made this test environmentally fragile.
    let globalHooksPath = '';
    try {
      globalHooksPath = execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    } catch { /* unset is the expected clean-env case */ }
    let localHooksPath = '';
    try {
      localHooksPath = execFileSync('git', ['-C', tmp, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    } catch { /* unset is fine when global was present */ }
    if (globalHooksPath) {
      expect(localHooksPath).toBe('');
    } else {
      expect(localHooksPath).toBe('.githooks');
    }
  });

  test('#1840 — generated hook matches .md/.mdx (single-backslash regex, not over-escaped)', () => {
    installHook(tmp, false);
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

  test('installHook refuses to clobber existing hook without --force', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = installHook(tmp, false);
    expect(result).toBe('skipped_existing');
    // Original survives.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('installHook with force overwrites and saves .bak', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    const result = installHook(tmp, true);
    expect(result).toBe('installed');
    expect(existsSync(hookPath + '.bak')).toBe(true);
    expect(readFileSync(hookPath + '.bak', 'utf8')).toContain('user hook');
    expect(readFileSync(hookPath, 'utf8')).toContain('gbrain frontmatter');
  });

  test('installHook on existing gbrain hook refreshes silently (no .bak)', () => {
    installHook(tmp, false);
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath + '.bak')).toBe(false);
    // Re-run; should be 'unchanged' (banner already present).
    const second = installHook(tmp, false);
    expect(second).toBe('unchanged');
  });

  test('uninstallHook removes the gbrain hook and restores .bak when present', () => {
    const hooksDir = join(tmp, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"');
    installHook(tmp, true);
    expect(existsSync(hookPath + '.bak')).toBe(true);

    const removed = uninstallHook(tmp);
    expect(removed).toBe(true);
    // .bak content restored as the active hook.
    expect(readFileSync(hookPath, 'utf8')).toContain('user hook');
    expect(existsSync(hookPath + '.bak')).toBe(false);
  });

  test('uninstallHook on a non-gbrain hook returns false (does not remove user hook)', () => {
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

  test('#4600 nested source: hook installs at the discovered git root, scoped to the subdirectory', () => {
    mkdirSync(join(tmp, 'brain'));
    expect(installHook(join(tmp, 'brain'), false)).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(join(tmp, 'brain', '.githooks'))).toBe(false);
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('# gbrain-scope: brain/');
    expect(content).toContain("--diff-filter=ACM -- 'brain/' | grep -E '\\.mdx?$'");
  });

  test('#4600 several nested sources share one hook: pathspecs union, no .bak, idempotent', () => {
    mkdirSync(join(tmp, 'brain'));
    mkdirSync(join(tmp, 'wiki'));
    expect(installHook(join(tmp, 'brain'), false)).toBe('installed');
    expect(installHook(join(tmp, 'wiki'), false)).toBe('installed');
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('# gbrain-scope: brain/');
    expect(content).toContain('# gbrain-scope: wiki/');
    expect(content).toContain("-- 'brain/' 'wiki/' |");
    expect(existsSync(hookPath + '.bak')).toBe(false);
    expect(installHook(join(tmp, 'wiki'), false)).toBe('unchanged');
  });

  test('#4600 root-registered source keeps the unscoped script; a root install widens a scoped hook to the whole repo', () => {
    installHook(tmp, false);
    const hookPath = join(tmp, '.githooks', 'pre-commit');
    expect(readFileSync(hookPath, 'utf8')).not.toContain('gbrain-scope');
    expect(readFileSync(hookPath, 'utf8')).toContain("--diff-filter=ACM | grep -E '\\.mdx?$'");

    mkdirSync(join(tmp, 'brain'));
    expect(installHook(join(tmp, 'brain'), false)).toBe('unchanged'); // whole repo already covers brain/
    expect(readFileSync(hookPath, 'utf8')).not.toContain('gbrain-scope');
  });

  test('#4600 the scoped hook ignores staged files outside the source (host README commits pass)', () => {
    mkdirSync(join(tmp, 'brain'));
    installHook(join(tmp, 'brain'), false);
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

  test('#4600 uninstall for one nested source drops only its scope; the last one removes the hook', () => {
    mkdirSync(join(tmp, 'brain'));
    mkdirSync(join(tmp, 'wiki'));
    installHook(join(tmp, 'brain'), false);
    installHook(join(tmp, 'wiki'), false);
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
    // GIT_CONFIG_GLOBAL=/dev/null: a developer's global core.hooksPath must
    // not turn this into the "set elsewhere" branch.
    await withEnv({ GIT_CONFIG_GLOBAL: '/dev/null' }, async () => {
      expect(installHook(join(tmp, 'brain'), false)).toBe('installed_unwired');
    });
    expect(existsSync(join(tmp, '.githooks', 'pre-commit'))).toBe(true);
    let localHooksPath = '';
    try {
      localHooksPath = execFileSync('git', ['-C', tmp, 'config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    } catch { /* unset is the asserted outcome */ }
    expect(localHooksPath).toBe('');
  });

  test('#4600 a path outside any git repo is refused with the shared sync message, nothing written', () => {
    const plain = mkdtempSync(join(tmpdir(), 'fm-hook-nogit-'));
    try {
      expect(() => installHook(plain, false)).toThrow(/Not inside a git repository/);
      expect(existsSync(join(plain, '.githooks'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
