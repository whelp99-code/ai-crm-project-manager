import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { LedgerService, type ChartAccount, type FinancePackConfig, type JournalEntry } from "@ai-crm/finance";
import { createPgLedgerRepository, type LedgerRepository, type PgQueryable } from "@ai-crm/finance/pg-finance-ledger-adapter";

/**
 * PG-C1 (F6 double-entry ledger) acceptance against REAL PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies 0001..0006 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as the other
 * livepg suites), then applies 0009_finance_ledger.sql itself the same
 * idempotent schema_migrations-gated way the smoke script applies its own
 * migrations — 0009 is not yet wired into the smoke script (that's the
 * leader's serial integration step; see /tmp/pgc1-wiring-diff.md).
 *
 * This suite talks to `LedgerService` + `createPgLedgerRepository`
 * DIRECTLY (no `createApp`/HTTP layer) because finance ledger routes are
 * not wired into `apps/api/src/app.ts` yet — that wiring is the leader's
 * serial integration step. Exercising the real adapter/service pair
 * against real PG is the PG-C1-scope proof; the leader's app.ts wiring
 * only has to plug these same two exports into HTTP routes per
 * /tmp/pgc1-wiring-diff.md.
 *
 * Covers:
 *  - restart-survival: instance A posts entries (PG-first: repo write,
 *    then LedgerService commit) -> fresh instance B hydrates via
 *    `listAllEntries()` + `hydrateJournalEntries()` -> entries + lines +
 *    exact BigInt money (including a 10^30 amount) round-trip identically.
 *  - POSTED immutability: a direct UPDATE (non-reversal shape) or DELETE
 *    against a POSTED row is rejected by 0009's trigger; the one-time
 *    reversed_by_entry_id transition is allowed; a second attempt to
 *    re-reverse, or any mutation of a REVERSED row, is rejected.
 *  - atomic two-row post/reverse: `LedgerRepository.postEntryAtomic`
 *    commits the reversal's POSTED row and the original's POSTED ->
 *    REVERSED row together in one `withWorkspaceScope` transaction.
 *  - cross-workspace denial: workspace A's entries are invisible to
 *    workspace B, both via the scoped repository read and under raw
 *    `SET ROLE ai_crm_runtime_api` (NOBYPASSRLS).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const ledgerMigrationFile = join(repoRoot, "packages/persistence/migrations/0009_finance_ledger.sql");

const WS_A = "66666666-6666-6666-6666-666666666666";
const WS_B = "77777777-7777-7777-7777-777777777777";

const CHART: ChartAccount[] = [
  { code: "1000", name: "현금", type: "asset" },
  { code: "1200", name: "매출채권", type: "asset" },
  { code: "4000", name: "용역매출", type: "revenue" },
];

function fixtureConfig(): FinancePackConfig {
  return {
    packVersion: 1,
    chartOfAccounts: CHART,
    decimalScale: 0,
    dayCloseCutoff: "20:00",
    cutoffBoundary: "inclusive",
    reconciliationToleranceKrw: "100",
    requiredConsecutiveDays: 90,
  };
}

/**
 * Minimal real-`pg.Pool`-backed `PgQueryable` implementing
 * `withWorkspaceScope` the same way `apps/api/src/app.ts`'s
 * `createScopedPgQueryable` does (single checked-out connection, `BEGIN`,
 * parameterized `set_config('app.workspace_id', $1, true)`, `COMMIT`).
 * Mirrors `n08-pg-primary.livepg.integration.test.ts`'s
 * `scopedQueryableFromPool` exactly, retyped for the ledger adapter's
 * `PgQueryable`.
 */
function scopedQueryableFromPool(pool: import("pg").Pool): PgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return result as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: PgQueryable = {
          async query<T2 = unknown>(text: string, params?: unknown[]) {
            const result = await client.query(text, params);
            return result as unknown as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure; original error is what matters
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * PG-FIRST fail-closed dual-write drill for `draft`: computes the entry via
 * `LedgerService.previewDraft` (no memory mutation), persists it to PG
 * FIRST via `repo.saveEntry`, and only then commits it to memory via
 * `LedgerService.commitDraft`. A PG failure here throws before
 * `commitDraft` ever runs — memory never gets ahead of PG.
 */
async function pgFirstDraft(
  ledger: LedgerService,
  repo: LedgerRepository,
  input: Parameters<LedgerService["previewDraft"]>[0],
): Promise<JournalEntry> {
  const entry = ledger.previewDraft(input);
  await repo.saveEntry(entry);
  return ledger.commitDraft(entry);
}

async function pgFirstVerify(
  ledger: LedgerService,
  repo: LedgerRepository,
  workspaceId: string,
  entryId: string,
  verifierPrincipalId: string,
): Promise<JournalEntry> {
  const entry = ledger.previewVerify(workspaceId, entryId, verifierPrincipalId);
  await repo.saveEntry(entry);
  return ledger.commitVerify(entry);
}

async function pgFirstPost(
  ledger: LedgerService,
  repo: LedgerRepository,
  workspaceId: string,
  entryId: string,
  posterPrincipalId: string,
): Promise<JournalEntry> {
  const { next, reversedOriginal } = ledger.previewPost(workspaceId, entryId, posterPrincipalId);
  await repo.postEntryAtomic(next, reversedOriginal);
  return ledger.commitPost(next, reversedOriginal);
}

async function pgFirstReverse(
  ledger: LedgerService,
  repo: LedgerRepository,
  workspaceId: string,
  originalEntryId: string,
  reversalEntryId: string,
  principalId: string,
  entryDate: string,
): Promise<JournalEntry> {
  const entry = ledger.previewReverse(workspaceId, originalEntryId, reversalEntryId, principalId, entryDate);
  await repo.saveEntry(entry);
  return ledger.commitDraft(entry);
}

/** Applies 0009_finance_ledger.sql idempotently, the same schema_migrations-gated way the smoke script applies 0001..0006. */
async function applyLedgerMigration(client: import("pg").Client): Promise<void> {
  const already = await client.query(`SELECT 1 FROM schema_migrations WHERE id = '0009_finance_ledger'`);
  if ((already.rowCount ?? 0) > 0) return;
  const sql = readFileSync(ledgerMigrationFile, "utf8");
  await client.query(sql);
  await client.query(`INSERT INTO schema_migrations (id) VALUES ('0009_finance_ledger') ON CONFLICT (id) DO NOTHING`);
}

describe.skipIf(!LIVE)("PG-C1 finance ledger PG-primary + immutability against REAL Postgres (LIVE_PG_TEST=1)", () => {
  const pools: PgPool[] = [];

  async function newPool(): Promise<PgPool> {
    const { Pool } = (await import("pg")) as typeof import("pg");
    return new Pool({ connectionString: DATABASE_URL });
  }

  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        PGHOST: "localhost",
        PGPORT: "5432",
        PGUSER: "ai_crm",
        PGPASSWORD: "ai_crm_dev",
        PGDATABASE: "ai_crm",
      },
      stdio: "pipe",
    });

    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await applyLedgerMigration(client);
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "pgc1-ledger-livepg-a", WS_B, "pgc1-ledger-livepg-b"],
      );
    } finally {
      await client.end();
    }
  }, 60_000);

  afterAll(async () => {
    while (pools.length) {
      await pools.pop()?.end();
    }
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      // finance_journal_entries POSTED/REVERSED rows are immutable by
      // trigger, and rows self-reference via reverses_entry_id /
      // reversed_by_entry_id — disable ALL triggers (including the FK
      // constraint triggers) for this superuser teardown connection only,
      // delete the fixtures, then restore them.
      await client.query(`ALTER TABLE finance_journal_entries DISABLE TRIGGER ALL`);
      try {
        for (const ws of [WS_A, WS_B]) {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await client.query(`DELETE FROM finance_journal_entries WHERE workspace_id = $1`, [ws]);
        }
      } finally {
        await client.query(`ALTER TABLE finance_journal_entries ENABLE TRIGGER ALL`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "restart-survival + exact BigInt money round-trip (incl. 10^30): instance A posts an entry -> fresh instance B hydrates it identically",
    async () => {
      const poolA = await newPool();
      pools.push(poolA);
      const repoA = createPgLedgerRepository(scopedQueryableFromPool(poolA));
      const ledgerA = new LedgerService(fixtureConfig());

      const HUGE = "1000000000000000000000000000000"; // 10^30
      await pgFirstDraft(ledgerA, repoA, {
        id: "je-restart-1",
        workspaceId: WS_A,
        entryDate: "2026-07-01",
        description: "10^30 KRW round-trip",
        evidenceRef: "evidence-restart-1",
        lines: [
          { accountCode: "1200", debitKrw: HUGE, creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: HUGE },
        ],
        createdByPrincipalId: "drafter-restart",
      });
      await pgFirstVerify(ledgerA, repoA, WS_A, "je-restart-1", "verifier-restart");
      const postedA = await pgFirstPost(ledgerA, repoA, WS_A, "je-restart-1", "poster-restart");
      expect(postedA.status).toBe("POSTED");
      expect(postedA.lines[0]?.debitKrw).toBe(HUGE);
      expect(postedA.lines[1]?.creditKrw).toBe(HUGE);

      // Confirm the PG row itself stored the exact integer text, not a
      // float-coerced/truncated/scientific-notation value.
      const rawTotals = await poolA.query(
        `SELECT debit_total_krw::text AS debit, credit_total_krw::text AS credit FROM finance_journal_entries WHERE id = 'je-restart-1'`,
      );
      expect(rawTotals.rows[0]).toEqual({ debit: HUGE, credit: HUGE });

      // --- Simulate restart: fresh pool + fresh LedgerService, hydrate from PG. ---
      const poolB = await newPool();
      pools.push(poolB);
      const repoB = createPgLedgerRepository(scopedQueryableFromPool(poolB));
      const ledgerB = new LedgerService(fixtureConfig());
      const allEntries = await repoB.listAllEntries();
      ledgerB.hydrateJournalEntries(allEntries);

      const hydrated = ledgerB.getEntry(WS_A, "je-restart-1");
      expect(hydrated.status).toBe("POSTED");
      expect(hydrated.lines).toEqual(postedA.lines);
      expect(hydrated.lines[0]?.debitKrw).toBe(HUGE);
      expect(hydrated.lines[1]?.creditKrw).toBe(HUGE);
      expect(hydrated.evidenceRef).toBe("evidence-restart-1");
      expect(hydrated.postedByPrincipalId).toBe("poster-restart");
      expect(hydrated.version).toBe(postedA.version);
    },
    60_000,
  );

  it(
    "POSTED immutability trigger: direct UPDATE/DELETE on a POSTED row is rejected; the reversed_by_entry_id transition (and only that shape) is allowed",
    async () => {
      const poolA = await newPool();
      pools.push(poolA);
      const repoA = createPgLedgerRepository(scopedQueryableFromPool(poolA));
      const ledgerA = new LedgerService(fixtureConfig());

      await pgFirstDraft(ledgerA, repoA, {
        id: "je-immut-1",
        workspaceId: WS_A,
        entryDate: "2026-07-02",
        description: "immutability probe",
        evidenceRef: "evidence-immut-1",
        lines: [
          { accountCode: "1000", debitKrw: "5000", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "5000" },
        ],
        createdByPrincipalId: "drafter-immut",
      });
      await pgFirstVerify(ledgerA, repoA, WS_A, "je-immut-1", "verifier-immut");
      await pgFirstPost(ledgerA, repoA, WS_A, "je-immut-1", "poster-immut");

      // A same-shape reversal row must exist for reverses_entry_id/reversed_by_entry_id FK.
      await repoA.saveEntry({
        id: "je-immut-1-rev",
        workspaceId: WS_A,
        entryDate: "2026-07-03",
        description: "Reversal of je-immut-1",
        lines: [
          { accountCode: "1000", debitKrw: "0", creditKrw: "5000" },
          { accountCode: "4000", debitKrw: "5000", creditKrw: "0" },
        ],
        status: "DRAFT",
        createdByPrincipalId: "drafter-immut-rev",
        reversesEntryId: "je-immut-1",
        version: 1,
      });

      // Disallowed: a plain column edit on a POSTED row (not the reverse transition).
      await expect(
        poolA.query(`UPDATE finance_journal_entries SET description = 'tampered' WHERE id = 'je-immut-1'`),
      ).rejects.toThrow(/immutable/i);

      // Disallowed: DELETE on a POSTED row.
      await expect(poolA.query(`DELETE FROM finance_journal_entries WHERE id = 'je-immut-1'`)).rejects.toThrow(
        /immutable/i,
      );

      // Allowed: the exact one-time reverse transition.
      await poolA.query(
        `UPDATE finance_journal_entries SET status = 'REVERSED', reversed_by_entry_id = 'je-immut-1-rev', version = version + 1 WHERE id = 'je-immut-1'`,
      );
      const afterReverse = await poolA.query<{ status: string; reversed_by_entry_id: string }>(
        `SELECT status, reversed_by_entry_id FROM finance_journal_entries WHERE id = 'je-immut-1'`,
      );
      expect(afterReverse.rows[0]).toEqual({ status: "REVERSED", reversed_by_entry_id: "je-immut-1-rev" });

      // Disallowed: re-reversing an already-reversed original.
      await expect(
        poolA.query(
          `UPDATE finance_journal_entries SET status = 'REVERSED', reversed_by_entry_id = 'je-immut-1-rev', version = version + 1 WHERE id = 'je-immut-1'`,
        ),
      ).rejects.toThrow(/immutable|already been reversed/i);

      // Disallowed: any mutation of a REVERSED (terminal) row.
      await expect(
        poolA.query(`UPDATE finance_journal_entries SET description = 'tampered-again' WHERE id = 'je-immut-1'`),
      ).rejects.toThrow(/immutable/i);
    },
    60_000,
  );

  it(
    "atomic two-row post/reverse: LedgerRepository.postEntryAtomic commits the reversal POSTED row and the original's POSTED -> REVERSED row together",
    async () => {
      const poolA = await newPool();
      pools.push(poolA);
      const repoA = createPgLedgerRepository(scopedQueryableFromPool(poolA));
      const ledgerA = new LedgerService(fixtureConfig());

      await pgFirstDraft(ledgerA, repoA, {
        id: "je-atomic-1",
        workspaceId: WS_A,
        entryDate: "2026-07-04",
        description: "atomic reverse original",
        evidenceRef: "evidence-atomic-1",
        lines: [
          { accountCode: "1200", debitKrw: "20000", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "20000" },
        ],
        createdByPrincipalId: "drafter-atomic",
      });
      await pgFirstVerify(ledgerA, repoA, WS_A, "je-atomic-1", "verifier-atomic");
      await pgFirstPost(ledgerA, repoA, WS_A, "je-atomic-1", "poster-atomic");

      await pgFirstReverse(ledgerA, repoA, WS_A, "je-atomic-1", "je-atomic-1-rev", "drafter-atomic-rev", "2026-07-05");
      await pgFirstVerify(ledgerA, repoA, WS_A, "je-atomic-1-rev", "verifier-atomic-rev");
      const postedReversal = await pgFirstPost(ledgerA, repoA, WS_A, "je-atomic-1-rev", "poster-atomic-rev");

      expect(postedReversal.status).toBe("POSTED");
      expect(postedReversal.reversesEntryId).toBe("je-atomic-1");

      const rows = await poolA.query<{ id: string; status: string; reversed_by_entry_id: string | null }>(
        `SELECT id, status, reversed_by_entry_id FROM finance_journal_entries WHERE id IN ('je-atomic-1', 'je-atomic-1-rev') ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        { id: "je-atomic-1", status: "REVERSED", reversed_by_entry_id: "je-atomic-1-rev" },
        { id: "je-atomic-1-rev", status: "POSTED", reversed_by_entry_id: null },
      ]);

      // Both sides also observable through the in-memory LedgerService after commitPost.
      expect(ledgerA.getEntry(WS_A, "je-atomic-1").status).toBe("REVERSED");
      expect(ledgerA.balances(WS_A)["1200"]).toBeDefined();
    },
    60_000,
  );

  it(
    "cross-workspace denial: workspace A's entries never appear in workspace B's scoped read, at the repository layer AND under raw SET ROLE ai_crm_runtime_api",
    async () => {
      const poolA = await newPool();
      pools.push(poolA);
      const repoA = createPgLedgerRepository(scopedQueryableFromPool(poolA));
      const ledgerA = new LedgerService(fixtureConfig());

      await pgFirstDraft(ledgerA, repoA, {
        id: "je-crossws-1",
        workspaceId: WS_A,
        entryDate: "2026-07-06",
        description: "cross-ws probe",
        lines: [
          { accountCode: "1000", debitKrw: "300", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "300" },
        ],
        createdByPrincipalId: "drafter-crossws",
      });

      // Repository-layer denial: WS_B's scoped read never returns WS_A's row.
      const wsB = await repoA.getEntriesForWorkspace(WS_B);
      expect(wsB.some((e) => e.id === "je-crossws-1")).toBe(false);

      // RLS-layer denial: SET ROLE ai_crm_runtime_api (NOBYPASSRLS), scoped
      // to WS_B, proves FORCE RLS itself denies the row — not just an
      // app-level WHERE clause — even though this connection can
      // physically see the whole table absent RLS.
      const { Client } = (await import("pg")) as typeof import("pg");
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
          await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);
          const rlsScoped = await client.query(`SELECT id FROM finance_journal_entries`);
          expect((rlsScoped.rows as Array<{ id: string }>).some((r) => r.id === "je-crossws-1")).toBe(false);
        } finally {
          await client.query("COMMIT");
        }
      } finally {
        await client.end();
      }
    },
    60_000,
  );
});
