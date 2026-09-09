/**
 * #4613 — links_link_source_check constraint-shape self-heal.
 *
 * Migration v114 (#1941) opened `links.link_source` from a closed allowlist to
 * a kebab-case format gate. The migrator trusts the version ledger
 * (`m.version > current`), so a brain stamped >= 114 whose live CHECK still
 * carries the pre-v114 allowlist (restore from a drifted snapshot, manual DDL,
 * an interrupted historical migration) never replays v114 — and every kebab
 * provenance write (`atom-provenance`, `concept-provenance`) is rejected while
 * `doctor` reports the schema current.
 *
 * Third instance of the #2038 / #550 pattern: key the check off the actual
 * constraint SHAPE in pg_constraint (not the ledger), run the repair on every
 * migrate pass, refuse loudly instead of half-applying. The repair only ever
 * restores the migration-declared definition — it never touches rows. When
 * existing rows violate the gate, the DROP+ADD transaction rolls back as a
 * whole (the old constraint, if any, stays in place) and the violator count
 * is reported for manual resolution.
 */

import type { BrainEngine } from './engine.ts';

const CONSTRAINT_NAME = 'links_link_source_check';

/**
 * Kebab provenance-tag format gate (migration v114 / #1941). ONE copy here;
 * the drift-guard test pins it to the literal in migrate.ts v114, schema.sql
 * and pglite-schema.ts.
 */
export const LINK_SOURCE_KEBAB_RE = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';

const GATE_PREDICATE = `(link_source ~ '${LINK_SOURCE_KEBAB_RE}' AND char_length(link_source) <= 64)`;

/** v114's PGLite branch verbatim: plain DROP + ADD (validates existing rows inline). */
const RESTORE_DDL = `
  ALTER TABLE links DROP CONSTRAINT IF EXISTS ${CONSTRAINT_NAME};
  ALTER TABLE links ADD CONSTRAINT ${CONSTRAINT_NAME}
    CHECK (link_source IS NULL OR ${GATE_PREDICATE});
`;

export type LinkSourceCheckDrift = 'absent' | 'wrong_def' | 'not_validated';

export interface LinkSourceCheckStatus {
  /** The links table exists (nothing to check if not). */
  tablePresent: boolean;
  constraintPresent: boolean;
  /** `pg_get_constraintdef` output; null when absent. */
  def: string | null;
  /** Which drift shape was found; null when the live shape matches v114. */
  drift: LinkSourceCheckDrift | null;
  needsRepair: boolean;
}

export async function checkLinkSourceCheck(engine: BrainEngine): Promise<LinkSourceCheckStatus> {
  const tbl = await engine.executeRaw<{ reg: string | null }>(`SELECT to_regclass('links')::text AS reg`);
  if (!tbl[0]?.reg) {
    return { tablePresent: false, constraintPresent: false, def: null, drift: null, needsRepair: false };
  }
  const rows = await engine.executeRaw<{ def: string; convalidated: boolean }>(
    `SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = to_regclass('links') AND conname = '${CONSTRAINT_NAME}'`,
  );
  const row = rows[0];
  // pg_get_constraintdef deparses the regex Const verbatim, so a substring
  // match on the literal distinguishes v114 from any older allowlist.
  const drift: LinkSourceCheckDrift | null = !row
    ? 'absent'
    : !row.def.includes(LINK_SOURCE_KEBAB_RE)
      ? 'wrong_def'
      : !row.convalidated
        ? 'not_validated'
        : null;
  return { tablePresent: true, constraintPresent: !!row, def: row?.def ?? null, drift, needsRepair: drift !== null };
}

export interface LinkSourceCheckRepairResult {
  repaired: boolean;
  /** Rows whose link_source fails the kebab gate (they block the ADD). */
  violations: number;
  reason: 'already_correct' | 'no_table' | 'violations' | 'restored';
}

/**
 * Restore the v114 definition when the live shape drifted. Atomic on both
 * engines: DROP + ADD run in one transaction (same shape as the migration
 * runner's transaction branch), and ADD validates existing rows inline, so a
 * violating row aborts the whole thing — no NOT VALID remnant, the prior
 * constraint (if any) survives untouched.
 */
export async function repairLinkSourceCheck(engine: BrainEngine): Promise<LinkSourceCheckRepairResult> {
  const status = await checkLinkSourceCheck(engine);
  if (!status.tablePresent) return { repaired: false, violations: 0, reason: 'no_table' };
  if (!status.needsRepair) return { repaired: false, violations: 0, reason: 'already_correct' };
  try {
    await engine.transaction(async (tx) => {
      if (engine.kind === 'postgres') {
        try {
          await tx.runMigration(0, "SET LOCAL statement_timeout = '600000'");
        } catch { /* older Postgres without SET LOCAL support */ }
      }
      await tx.runMigration(0, RESTORE_DDL);
    });
  } catch (e) {
    const bad = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM links WHERE link_source IS NOT NULL AND NOT ${GATE_PREDICATE}`,
    );
    const violations = parseInt(bad[0]?.n ?? '0', 10);
    if (violations === 0) throw e; // not a data problem — surface the real error
    return { repaired: false, violations, reason: 'violations' };
  }
  return { repaired: true, violations: 0, reason: 'restored' };
}
