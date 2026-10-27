import { execFileSync } from "node:child_process";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import {
  createPgFinanceReconciliationRepository,
  createPgDailyGateRepository,
  type PgQueryable,
} from "@ai-crm/finance/pg-finance-recon-adapter";
import {
  ReconciliationService,
  DailyGate,
  type Reconciliation,
  type FinanceException,
  type DayInput,
  type FinancePackConfig,
} from "@ai-crm/finance";

/**
 * PG-C2 (Ultragoal P6-b G001 domain-PG core) acceptance against REAL
 * PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0006 via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as n12-n13-livepg /
 * n08-pg-primary / sor-restart-livepg), then applies 0010 directly — the
 * smoke script's `apply_migrations()` is a hardcoded id list the LEADER
 * still has to extend for 0007..0010 (see /tmp/pgc2-wiring-diff.md); this
 * suite must not depend on that not-yet-landed edit.
 *
 * This suite exercises the PERSISTENCE LAYER directly (repository +
 * service/DailyGate hydrate methods), NOT through `createApp()` HTTP
 * routes: `app.ts` has not been wired to the new
 * `pg-finance-recon-adapter.ts` repos yet (that wiring is the LEADER's
 * serial integration step — see the wiring diff). Proving the adapter +
 * hydrate methods survive a real restart against real Postgres here is the
 * PG-C2 acceptance target; HTTP-level wiring is verified once the leader
 * integrates all four wiring diffs.
 *
 * Covers:
 *   - reconciliation + exception restart survival, signed-money round-trip
 *     (negative KRW strings), statement_row jsonb round-trip identical.
 *   - daily-gate: record days spanning conservative -> eligible ->
 *     risk-tier activation -> fresh DailyGate instance restores machine
 *     state (streak/tier/lastDateEpoch/activatedMatrixVersion) from
 *     `finance_daily_gate_state` (NOT a recordDay replay) + day records
 *     present via `finance_day_records`.
 *   - cross-workspace denial under raw `SET ROLE ai_crm_runtime_api`
 *     (NOBYPASSRLS) for all four new tables.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const migration0010 = join(repoRoot, "packages/persistence/migrations/0010_finance_recon_dailygate.sql");
const migration0020 = join(repoRoot, "packages/persistence/migrations/0020_finance_daily_gate_pack_version.sql");

const WS_A = "55555555-5555-5555-5555-555555555555";
const WS_B = "66666666-6666-6666-6666-666666666666";

const FINANCE_PACK: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [
    { code: "1000", name: "현금", type: "asset" },
    { code: "1200", name: "매출채권", type: "asset" },
  ],
  decimalScale: 0,
  dayCloseCutoff: "18:00",
  cutoffBoundary: "inclusive",
  reconciliationToleranceKrw: "0",
  // Small value so the conservative -> eligible transition is fast in tests
  // (the domain default of 90 is a signed policy value tested separately in
  // packages/finance/test/finance-daily-gate.integration.test.ts).
  requiredConsecutiveDays: 3,
};

/** Mirrors apps/api/src/app.ts `createScopedPgQueryable` exactly (see wiring diff). */
function createScopedPgQueryable(pool: PgPool): PgQueryable {
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
          async query<T2 = unknown>(text2: string, params2?: unknown[]) {
            const result = await client.query(text2, params2);
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

function qualifyingDay(date: string): DayInput {
  return {
    date,
    importsCompleted: true,
    entriesBalanced: true,
    openFinanceExceptions: 0,
    receivedAt: `${date}T09:00:00+09:00`,
  };
}

describe.skipIf(!LIVE)("PG-C2 finance reconciliation + daily-gate against REAL Postgres (LIVE_PG_TEST=1)", () => {
  let pool: PgPool;

  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        ...pgSmokeConnectionEnv(DATABASE_URL),
      },
      stdio: "pipe",
    });

    const { Pool, Client } = (await import("pg")) as typeof import("pg");
    const setupClient = new Client({ connectionString: DATABASE_URL });
    await setupClient.connect();
    try {
      await setupClient.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "pg-c2-livepg-a", WS_B, "pg-c2-livepg-b"],
      );
      // Apply 0010 directly (idempotent guard) — the smoke script's
      // hardcoded apply_migrations() list has not been extended past 0006
      // yet; that is the LEADER's serial wiring step.
      const alreadyApplied = await setupClient.query(
        `SELECT to_regclass('public.finance_daily_gate_state') IS NOT NULL AS applied`,
      );
      if (!(alreadyApplied.rows[0] as { applied: boolean }).applied) {
        const sql = readFileSync(migration0010, "utf8");
        await setupClient.query(sql);
      }
      const versionTransitionTable = await setupClient.query(
        `SELECT to_regclass('public.finance_daily_gate_version_transitions') IS NOT NULL AS applied`,
      );
      if (!(versionTransitionTable.rows[0] as { applied: boolean }).applied) {
        await setupClient.query(readFileSync(migration0020, "utf8"));
      }
      await setupClient.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
    } finally {
      await setupClient.end();
    }

    pool = new Pool({ connectionString: DATABASE_URL });
  }, 60_000);

  afterAll(async () => {
    const { Client } = (await import("pg")) as typeof import("pg");
    await pool.end();
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      for (const ws of [WS_A, WS_B]) {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
        await client.query(`DELETE FROM finance_day_records WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM finance_daily_gate_version_transitions WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM finance_daily_gate_state WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM finance_exceptions WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM finance_reconciliations WHERE workspace_id = $1`, [ws]);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "reconciliation + exception restart survival: signed-money round-trip (negative KRW) and statement_row jsonb identical",
    async () => {
      const scoped = createScopedPgQueryable(pool);
      const repoA = createPgFinanceReconciliationRepository(scoped);
      const serviceA = new ReconciliationService(FINANCE_PACK);

      // Negative KRW (a refund/credit-memo statement row) — proves the sign
      // survives the numeric round-trip, not just magnitude.
      const matched = serviceA.reconcile({
        id: "recon-pgc2-matched-1",
        workspaceId: WS_A,
        statementRow: {
          account: "1000",
          postedAt: "2026-01-05T09:00:00+09:00",
          amountKrw: "-15000",
          rowFingerprint: "fp-pgc2-matched-1",
        },
        ledgerAmountKrw: "-15000",
        reconciledByPrincipalId: "recon-operator-1",
        reconciledAt: "2026-01-05T10:00:00.000Z",
      });
      expect(matched.status).toBe("MATCHED");

      const variance = serviceA.reconcile({
        id: "recon-pgc2-variance-1",
        workspaceId: WS_A,
        statementRow: {
          account: "1200",
          postedAt: "2026-01-06T09:00:00+09:00",
          amountKrw: "-9000",
          rowFingerprint: "fp-pgc2-variance-1",
        },
        ledgerAmountKrw: "-8000",
        reconciledByPrincipalId: "recon-operator-1",
        reconciledAt: "2026-01-06T10:00:00.000Z",
        exceptionId: "exc-pgc2-1",
      });
      expect(variance.status).toBe("VARIANCE");
      expect(variance.varianceKrw).toBe("1000");
      expect(variance.exceptionId).toBe("exc-pgc2-1");

      await repoA.saveReconciliation(matched);
      await repoA.saveReconciliation(variance);
      for (const exception of serviceA.openExceptions(WS_A)) {
        await repoA.saveException(exception);
      }

      // --- Simulate restart: fresh service + repository against the SAME pool. ---
      const repoB = createPgFinanceReconciliationRepository(createScopedPgQueryable(pool));
      const [reconciliations, exceptions] = await Promise.all([
        repoB.getReconciliationsForWorkspace(WS_A),
        repoB.getExceptionsForWorkspace(WS_A),
      ]);
      expect(reconciliations).toHaveLength(2);
      expect(exceptions).toHaveLength(1);

      const serviceB = new ReconciliationService(FINANCE_PACK);
      serviceB.hydrateReconciliations(reconciliations, exceptions);

      const restoredMatched = reconciliations.find((r) => r.id === "recon-pgc2-matched-1") as Reconciliation;
      expect(restoredMatched.ledgerAmountKrw).toBe("-15000");
      expect(restoredMatched.statementRow).toEqual(matched.statementRow);

      const restoredVariance = reconciliations.find((r) => r.id === "recon-pgc2-variance-1") as Reconciliation;
      expect(restoredVariance.ledgerAmountKrw).toBe("-8000");
      expect(restoredVariance.varianceKrw).toBe("1000");
      expect(restoredVariance.statementRow).toEqual(variance.statementRow);

      const restoredException = exceptions[0] as FinanceException;
      expect(restoredException.id).toBe("exc-pgc2-1");
      expect(restoredException.varianceKrw).toBe("1000");
      expect(restoredException.status).toBe("OPEN");

      // Hydrated service B must reject re-reconciling an already-persisted
      // fingerprint exactly like service A would (proves the fingerprint
      // dedup set was rebuilt, not just the maps).
      expect(() =>
        serviceB.reconcile({
          id: "recon-pgc2-dup-attempt",
          workspaceId: WS_A,
          statementRow: matched.statementRow,
          ledgerAmountKrw: "-15000",
          reconciledByPrincipalId: "recon-operator-1",
          reconciledAt: "2026-01-05T11:00:00.000Z",
        }),
      ).toThrow(/already reconciled/);

      // Admin/hydrate-on-boot path also round-trips.
      const allReconciliations = await repoB.listAllReconciliations();
      const allExceptions = await repoB.listAllExceptions();
      expect(allReconciliations.some((r) => r.id === "recon-pgc2-matched-1")).toBe(true);
      expect(allExceptions.some((e) => e.id === "exc-pgc2-1")).toBe(true);
    },
    60_000,
  );

  it(
    "daily-gate: conservative -> eligible -> risk-tier activation survives restart via machine-state restore (NOT recordDay replay); day records present",
    async () => {
      const scoped = createScopedPgQueryable(pool);
      const repoA = createPgDailyGateRepository(scoped);

      const gateA = new DailyGate(FINANCE_PACK, WS_B, FINANCE_PACK.packVersion);
      const dates = ["2026-02-01", "2026-02-02", "2026-02-03"];
      for (const date of dates) {
        const record = gateA.recordDay(qualifyingDay(date));
        await repoA.appendDayRecord(WS_B, record);
        await repoA.saveDailyGateState(WS_B, gateA.snapshotState());
      }
      expect(gateA.status()).toEqual({ streak: 3, tier: "eligible", policyVersion: 1 });

      gateA.activateRiskTier(7, "cfo-pgc2-1");
      await repoA.saveDailyGateState(WS_B, gateA.snapshotState());
      expect(gateA.status().tier).toBe("risk_tiered");
      const snapshotA = gateA.snapshotState();
      expect(snapshotA.activatedMatrixVersion).toBe(7);
      expect(snapshotA.lastDateEpoch).toBeDefined();

      // --- Simulate restart: fresh DailyGate instance, machine-state restore. ---
      const repoB = createPgDailyGateRepository(createScopedPgQueryable(pool));
      const persistedState = await repoB.getDailyGateState(WS_B);
      expect(persistedState).toBeDefined();
      // The matching persisted pack version is required for an exact restore.
      const gateB = new DailyGate(FINANCE_PACK, WS_B, FINANCE_PACK.packVersion);
      gateB.restoreState({
        streak: persistedState!.streak,
        tier: persistedState!.tier,
        ...(persistedState!.lastDateEpoch !== undefined ? { lastDateEpoch: persistedState!.lastDateEpoch } : {}),
        ...(persistedState!.activatedMatrixVersion !== undefined ? { activatedMatrixVersion: persistedState!.activatedMatrixVersion } : {}),
        ...(persistedState!.packVersion !== undefined ? { packVersion: persistedState!.packVersion } : {}),
      });

      const persistedRecords = await repoB.listDayRecords(WS_B);
      expect(persistedRecords).toHaveLength(3);
      gateB.hydrateDayRecords(persistedRecords);

      expect(gateB.status()).toEqual({ streak: 3, tier: "risk_tiered", policyVersion: 1 });
      expect(gateB.snapshotState()).toEqual(snapshotA);
      expect(gateB.listDayRecords()).toEqual(dates.map((date, i) => ({
        date,
        qualifying: true,
        streakAfter: i + 1,
        tierAfter: i + 1 < 3 ? "conservative" : "eligible",
      })));

      // Restart must NOT replay recordDay: OUT_OF_ORDER would otherwise
      // trip on the very first hydrated day if a caller mistakenly fed the
      // historical days back through recordDay instead of restoreState.
      const nextDay = gateB.recordDay(qualifyingDay("2026-02-04"));
      expect(nextDay.streakAfter).toBe(4);
      expect(gateB.status().tier).toBe("risk_tiered");
    },
    60_000,
  );

  it("daily-gate: mismatched persisted pack version atomically resets risk-tiered state and writes transition proof", async () => {
    const repo = createPgDailyGateRepository(createScopedPgQueryable(pool));
    await repo.saveDailyGateState(WS_A, {
      streak: 3,
      tier: "risk_tiered",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: 7,
      packVersion: 2,
    });
    const persisted = await repo.getDailyGateState(WS_A);
    const gate = new DailyGate(FINANCE_PACK, WS_A, FINANCE_PACK.packVersion);
    const restore = gate.restoreState(persisted!);
    expect(restore).toMatchObject({ reset: true, reason: "pack_version_mismatch", fromPackVersion: 2, toPackVersion: 1 });
    if (!restore.reset) throw new Error("expected DailyGate version drift reset");

    await repo.resetDailyGateStateWithAudit(WS_A, restore.resetState, {
      reason: restore.reason,
      fromPackVersion: restore.fromPackVersion,
      toPackVersion: restore.toPackVersion,
      prior: restore.prior,
    });
    expect(await repo.getDailyGateState(WS_A)).toMatchObject({
      streak: 0, tier: "conservative", lastDateEpoch: 20_000, packVersion: 1,
    });
    expect(await repo.listDailyGateVersionTransitions(WS_A)).toEqual([expect.objectContaining({
      reason: "pack_version_mismatch", fromPackVersion: 2, toPackVersion: 1,
      prior: expect.objectContaining({ streak: 3, tier: "risk_tiered", activatedMatrixVersion: 7 }),
    })]);
  }, 60_000);

  it("daily-gate: legacy NULL pack_version fails closed and records the missing-version audit reason", async () => {
    const repo = createPgDailyGateRepository(createScopedPgQueryable(pool));
    // Deliberately omit packVersion: migration 0020 represents pre-existing rows as NULL.
    await repo.saveDailyGateState(WS_A, {
      streak: 3,
      tier: "risk_tiered",
      lastDateEpoch: 20_001,
      activatedMatrixVersion: 8,
    });
    const gate = new DailyGate(FINANCE_PACK, WS_A, FINANCE_PACK.packVersion);
    const restore = gate.restoreState((await repo.getDailyGateState(WS_A))!);
    expect(restore).toMatchObject({ reset: true, reason: "persisted_pack_version_missing", fromPackVersion: undefined, toPackVersion: 1 });
    if (!restore.reset) throw new Error("expected legacy DailyGate version drift reset");
    await repo.resetDailyGateStateWithAudit(WS_A, restore.resetState, {
      reason: restore.reason,
      fromPackVersion: restore.fromPackVersion,
      toPackVersion: restore.toPackVersion,
      prior: restore.prior,
    });
    expect(await repo.getDailyGateState(WS_A)).toMatchObject({
      streak: 0, tier: "conservative", lastDateEpoch: 20_001, packVersion: 1,
    });
    const audits = await repo.listDailyGateVersionTransitions(WS_A);
    expect(audits.at(-1)).toEqual(expect.objectContaining({
      reason: "persisted_pack_version_missing", toPackVersion: 1,
      prior: expect.objectContaining({ tier: "risk_tiered", activatedMatrixVersion: 8 }),
    }));
  }, 60_000);

  it("cross-workspace denial under raw SET ROLE ai_crm_runtime_api (NOBYPASSRLS) for all four PG-C2 tables", async () => {
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      // Seed WS_A daily-gate rows as table owner/superuser (bypasses RLS),
      // so this block proves isolation on ALL FOUR tables, not just the two
      // already populated by the reconciliation test above.
      await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_A]);
      await client.query(
        `INSERT INTO finance_daily_gate_state (workspace_id, streak, tier, last_date_epoch, activated_matrix_version, version)
         VALUES ($1, 1, 'conservative', 20489, NULL, 1)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [WS_A],
      );
      await client.query(
        `INSERT INTO finance_day_records (workspace_id, date, qualifying, reason, streak_after, tier_after)
         VALUES ($1, '2026-02-01', true, NULL, 1, 'conservative')
         ON CONFLICT (workspace_id, date) DO NOTHING`,
        [WS_A],
      );
      await client.query(`RESET app.workspace_id`);

      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);

        // WS_A's reconciliation/exception rows (from the earlier test) must
        // be invisible under WS_B scope.
        const reconciliations = await client.query(`SELECT id FROM finance_reconciliations`);
        expect((reconciliations.rows as Array<{ id: string }>).some((r) => r.id.startsWith("recon-pgc2-"))).toBe(false);

        const exceptions = await client.query(`SELECT id FROM finance_exceptions`);
        expect((exceptions.rows as Array<{ id: string }>).some((r) => r.id === "exc-pgc2-1")).toBe(false);

        // WS_A's daily-gate-state/day-record rows (just seeded above) must
        // be invisible under WS_B scope; only WS_B's own rows (from the
        // daily-gate test) are visible — proving RLS filters, not blanket-denies.
        const gateStates = await client.query(`SELECT workspace_id FROM finance_daily_gate_state`);
        const gateStateRows = gateStates.rows as Array<{ workspace_id: string }>;
        expect(gateStateRows.some((r) => r.workspace_id === WS_A)).toBe(false);
        expect(gateStateRows.every((r) => r.workspace_id === WS_B)).toBe(true);
        expect(gateStateRows.length).toBeGreaterThan(0);

        const dayRecords = await client.query(`SELECT workspace_id FROM finance_day_records`);
        const dayRecordRows = dayRecords.rows as Array<{ workspace_id: string }>;
        expect(dayRecordRows.some((r) => r.workspace_id === WS_A)).toBe(false);
        expect(dayRecordRows.every((r) => r.workspace_id === WS_B)).toBe(true);
        expect(dayRecordRows.length).toBeGreaterThan(0);
      } finally {
        await client.query("COMMIT");
      }
    } finally {
      await client.end();
    }
  });
});
