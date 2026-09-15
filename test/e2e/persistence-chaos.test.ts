import { describe, expect, test } from 'bun:test';
import { runValidation } from '../../scripts/persistence/validate.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres process-separated journal concurrency', () => {
  test('isolated database verifies competing principals, publication boundaries and durable recovery', async () => {
    const result = await runValidation({ engine: 'postgres', databaseUrl: url, schedules: 50, operations: 64, seed: 5105 });
    expect(result.status).toBe('passed'); expect(result.full_gate).toBe(false);
    expect(result.crash_cases).toHaveLength(6);
    expect(Object.values(result.schedules.cases)).toEqual(Array(10).fill(5));
    expect(Object.values(result.schedules.boundaries)).toEqual(Array(5).fill(1));
    expect(result.soak.owner_processes).toBe(2); expect(result.soak.producer_processes).toBe(4);
    expect(result.soak.verified).toBe(64);
  }, 120_000);
});
