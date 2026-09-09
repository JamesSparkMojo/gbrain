import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #4988: the skill's bash pre-pass divided byte counts by 4 and labelled the
// result "measured"; on Claude-loaded markdown (backticks, paths, punctuation)
// that undercounts 25-35%. The skill must state the divisor it uses in the
// report and defer to the host client's exact context breakdown when one exists.
const skill = readFileSync(join(import.meta.dir, '..', 'skills/context-audit/SKILL.md'), 'utf8');

describe('#4988 context-audit skill states its token-estimate basis', () => {
  test('pre-pass no longer hard-codes a bare chars/4 divisor', () => {
    expect(skill).not.toMatch(/\/ 4 \)\)/);
    expect(skill).not.toContain('chars/4');
  });

  test('report header carries the estimate basis and defers to the host figure', () => {
    expect(skill).toContain('Estimate basis');
    expect(skill).toMatch(/\/context/);
  });
});
