import { expect, test } from 'bun:test';
import { runValidation } from '../scripts/persistence/validate.ts';

test('disk PGLite preserves accepted writes at every process-crash boundary and conserves journal state', async () => {
  const result = await runValidation({ engine: 'pglite', schedules: 50, operations: 32, seed: 5105 });
  expect(result.status).toBe('passed'); expect(result.full_gate).toBe(false);
  expect(result.crash_cases).toHaveLength(6);
  expect(Object.values(result.schedules.cases)).toEqual(Array(10).fill(5));
  expect(Object.values(result.schedules.boundaries)).toEqual(Array(5).fill(1));
  expect(result.soak.verified).toBe(32);
}, 180_000);
