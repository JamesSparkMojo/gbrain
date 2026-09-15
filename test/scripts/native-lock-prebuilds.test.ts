import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeLoad } from 'js-yaml';
import manifest from '../../native/locks/manifest.json';

const repo = join(import.meta.dir, '../..');
function verify(root: string) {
  return spawnSync(process.execPath, ['scripts/native/verify.ts'], { cwd: root, encoding: 'utf8' });
}

describe('native lock distribution integrity', () => {
  test('all eight vendored binaries match the current source and hash manifest', () => {
    const result = verify(repo);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 8 native lock prebuilds');
  });

  test.each(['binary', 'source'])('verification rejects changed %s bytes', (changed) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-native-manifest-'));
    try {
      cpSync(join(repo, 'native/locks'), join(root, 'native/locks'), { recursive: true });
      cpSync(join(repo, 'scripts/native'), join(root, 'scripts/native'), { recursive: true });
      const file = join(root, changed === 'source'
        ? 'native/locks/locks.c' : 'native/locks/prebuilds/linux-x64-glibc.node');
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(file, bytes);
      const result = verify(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(changed === 'source' ? 'source changed' : 'integrity mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('required CI executes every declared target at both supported Bun versions', () => {
    type NativeJob = {
      strategy: { matrix: { bun: string[]; target: string[]; include: Array<{ runner: string; target: string }> } };
      steps: Array<{ run?: string }>;
    };
    const workflow = safeLoad(readFileSync(join(repo, '.github/workflows/native-locks.yml'), 'utf8')) as {
      jobs: Record<string, NativeJob>;
    };
    const pairs: string[] = [];
    for (const job of Object.values(workflow.jobs)) {
      const matrix = job.strategy.matrix;
      expect(matrix.bun).toEqual(['1.3.11', '1.3.13']);
      const script = job.steps.map(step => step.run ?? '').join('\n');
      expect(script).toContain('bun install --frozen-lockfile --ignore-scripts');
      expect(script).toContain('bun test test/native-lock.test.ts');
      expect(script).toContain('bun scripts/native/compiled-smoke.ts');
      expect(script).toContain('bun scripts/native/verify.ts --rebuilt');
      for (const target of matrix.target) {
        expect(matrix.include.filter(entry => entry.target === target).length).toBe(1);
        for (const bun of matrix.bun) pairs.push(`${target}/${bun}`);
      }
    }
    expect(pairs.sort()).toEqual(Object.keys(manifest.artifacts)
      .flatMap(target => ['1.3.11', '1.3.13'].map(bun => `${target}/${bun}`)).sort());
    expect(new Set(pairs).size).toBe(16);
  });
});
