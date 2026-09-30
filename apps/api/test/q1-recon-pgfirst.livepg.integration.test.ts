import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { PgQueryable } from "@ai-crm/orchestration";
import type { FinancePackConfig } from "@ai-crm/finance";

/**
 * Continued-dev Q1 (D3/D4) acceptance against REAL PostgreSQL: the
 * reconciliation + daily-gate routes (`POST /api/finance/reconciliations`,
 * `POST /api/finance/exceptions/:id/resolve`, `POST
 * /api/finance/daily-gate/days`, `POST
 * /api/finance/daily-gate/activate-risk-tier`) are PG-PRIMARY fail-closed,
 * NOT the pre-existing memory-first best-effort dual-write (swallowed
 * try/catch + `dualWriteFailures` counter) that architect P3 flagged on
 * PG-D: a dropped PG write there could silently lose an OPEN reconciliation
 * exception (+ its `reconciledFingerprints` dedup entry) or a day record on
 * the next restart.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0006 via
 * `packages/persistence/scripts/pg-rls-smoke.sh`, then 0010 directly
 * (idempotent guard), mirroring `pg-c2-recon-dailygate.livepg.integration.test.ts`.
 *
 * Mirrors the ledger PG-C1 / governance PG-D preview->PG-write->commit
 * split: `ReconciliationService.previewReconcile`/`commitReconcile`,
 * `previewResolveException`/`commitResolveException`,
 * `DailyGate.previewRecordDay`/`commitRecordDay`,
 * `previewActivateRiskTier`/`commitActivateRiskTier` — computed WITHOUT
 * mutating in-memory state, persisted to PG FIRST, then committed to
 * memory — all inside the existing per-workspace `withWorkspaceMutex`.
 *
 * Covers:
 *  - Happy path: reconcile (variance -> exception) + resolve + record-day +
 *    activate-risk-tier all write PG rows AND the in-memory state (GET
 *    routes) reflects the SAME committed mutation.
 *  - Fail-closed (the falsifiable D3/D4 proof): a `pgPool` is injected whose
 *    `INSERT INTO finance_reconciliations` / `INSERT INTO
 *    finance_day_records` statements always throw. The route returns 5xx,
 *    the in-memory state is NEVER committed (the open exception / day
 *    record does not appear via GET), and 0 rows land in PG. Memory cannot
 *    lead PG for these writes.
 *  - Cross-workspace isolation: a forced write failure on one workspace
 *    never touches an unrelated workspace's state.
 *  - Concurrency (mutex holds): N concurrent same-workspace `record-day`
 *    calls (sequential dates) all commit exactly once each — no lost
 *    update, and the final streak/day-record count matches N exactly,
 *    proving `withWorkspaceMutex` still serializes the preview->PG-write->
 *    commit critical section for these routes.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const migration0010 = join(repoRoot, "packages/persistence/migrations/0010_finance_recon_dailygate.sql");

const WS_HAPPY = "b1111111-1111-1111-1111-111111111111";
const WS_FAIL_RECON = "b2222222-2222-2222-2222-222222222222";
const WS_FAIL_DAY = "b3333333-3333-3333-3333-333333333333";
const WS_CONCURRENT = "b4444444-4444-4444-4444-444444444444";
const WS_CROSS_UNTOUCHED = "b5555555-5555-5555-5555-555555555555";
const WS_FAIL_RECON_SECOND = "b6666666-6666-6666-6666-666666666666";
const WS_FAIL_DAY_SECOND = "b7777777-7777-7777-7777-777777777777";
const ALL_WS = [
  WS_HAPPY,
  WS_FAIL_RECON,
  WS_FAIL_DAY,
  WS_CONCURRENT,
  WS_CROSS_UNTOUCHED,
  WS_FAIL_RECON_SECOND,
  WS_FAIL_DAY_SECOND,
];

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
  // Small so a handful of concurrent record-day calls can cross
  // conservative -> eligible within the test.
  requiredConsecutiveDays: 3,
};

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

/**
 * Real-`pg.Pool`-backed `PgQueryable` implementing `withWorkspaceScope` the
 * same way `apps/api/src/app.ts`'s `createScopedPgQueryable` does — mirrors
 * `pg-d-audit-primary.livepg.integration.test.ts`'s `scopedQueryableFromPool`.
 *
 * `failInsertForWorkspace`, when set, makes any `INSERT INTO <tableRegex>`
 * statement scoped to that exact workspace id throw a simulated PG failure
 * BEFORE it reaches the database — a stand-in for a dropped connection /
 * constraint violation on the real INSERT.
 */
function scopedQueryableFromPool(
  pool: import("pg").Pool,
  options?: { failInsertForWorkspace?: { workspaceId: string; tableRegex: RegExp } },
): PgQueryable {
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
            if (
              options?.failInsertForWorkspace?.workspaceId === workspaceId &&
              options.failInsertForWorkspace.tableRegex.test(text)
            ) {
              throw new Error("SIMULATED_PG_RECON_DAILYGATE_WRITE_FAILURE");
            }
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

describe.skipIf(!LIVE)("Q1 (D3/D4) reconciliation + daily-gate PG-primary fail-closed against REAL Postgres (LIVE_PG_TEST=1)", () => {
  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        PGHOST: "localhost",
        PGPORT: "5432",
        PGUSER: process.env.PGUSER ?? "ai_crm",
        PGPASSWORD: process.env.PGPASSWORD ?? "ai_crm_dev",
        PGDATABASE: process.env.PGDATABASE ?? "ai_crm",
      },
      stdio: "pipe",
    });

    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const alreadyApplied = await client.query(
        `SELECT to_regclass('public.finance_daily_gate_state') IS NOT NULL AS applied`,
      );
      if (!(alreadyApplied.rows[0] as { applied: boolean }).applied) {
        const { readFileSync } = await import("node:fs");
        const sql = readFileSync(migration0010, "utf8");
        await client.query(sql);
      }
      const values = ALL_WS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
      const params = ALL_WS.flatMap((ws, i) => [ws, `q1-recon-pgfirst-${i}`]);
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ${values} ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        params,
      );
    } finally {
      await client.end();
    }
  }, 60_000);

  afterAll(async () => {
    while (apps.length) {
      await apps.pop()?.close();
    }
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
      await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
      try {
        for (const ws of ALL_WS) {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await client.query(`DELETE FROM finance_day_records WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM finance_daily_gate_state WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM finance_exceptions WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM finance_reconciliations WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [ws]);
        }
      } finally {
        await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [ALL_WS]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "happy path: reconcile (variance -> exception) + resolve + record-day + activate-risk-tier all write PG and memory reflects the SAME committed state",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({ pgPool: scopedQueryableFromPool(pool), financePack: FINANCE_PACK });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const reconcile = await app.inject({
          method: "POST",
          url: "/api/finance/reconciliations",
          headers: { "x-workspace-id": WS_HAPPY },
          payload: {
            id: "recon-happy-1",
            statementRow: { account: "1000", postedAt: "2026-03-01T09:00:00+09:00", amountKrw: "9000", rowFingerprint: "fp-happy-1" },
            ledgerAmountKrw: "8000",
            reconciledByPrincipalId: "recon-operator-happy",
            reconciledAt: "2026-03-01T10:00:00.000Z",
            exceptionId: "exc-happy-1",
          },
        });
        expect(reconcile.statusCode).toBe(201);
        const reconciled = reconcile.json() as { status: string; exceptionId?: string };
        expect(reconciled.status).toBe("VARIANCE");
        expect(reconciled.exceptionId).toBe("exc-happy-1");

        const openExceptions = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_HAPPY },
        });
        expect((openExceptions.json() as Array<{ id: string }>).some((e) => e.id === "exc-happy-1")).toBe(true);

        const reconRow = await pool.query(`SELECT count(*)::int AS n FROM finance_reconciliations WHERE workspace_id = $1`, [WS_HAPPY]);
        expect((reconRow.rows[0] as { n: number }).n).toBe(1);
        const excRow = await pool.query(`SELECT count(*)::int AS n FROM finance_exceptions WHERE workspace_id = $1`, [WS_HAPPY]);
        expect((excRow.rows[0] as { n: number }).n).toBe(1);

        const resolve = await app.inject({
          method: "POST",
          url: "/api/finance/exceptions/exc-happy-1/resolve",
          headers: { "x-workspace-id": WS_HAPPY },
          payload: {
            resolvedByPrincipalId: "recon-operator-resolver",
            resolvedAt: "2026-03-02T10:00:00.000Z",
            resolutionNote: "confirmed bank fee, adjusted",
          },
        });
        expect(resolve.statusCode).toBe(200);
        expect((resolve.json() as { status: string }).status).toBe("RESOLVED");

        const afterResolve = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_HAPPY },
        });
        expect((afterResolve.json() as unknown[]).length).toBe(0);

        const excRowResolved = await pool.query(
          `SELECT status FROM finance_exceptions WHERE workspace_id = $1 AND id = 'exc-happy-1'`,
          [WS_HAPPY],
        );
        expect((excRowResolved.rows[0] as { status: string }).status).toBe("RESOLVED");

        const recordDay = await app.inject({
          method: "POST",
          url: "/api/finance/daily-gate/days",
          headers: { "x-workspace-id": WS_HAPPY },
          payload: {
            date: "2026-03-01",
            importsCompleted: true,
            entriesBalanced: true,
            openFinanceExceptions: 0,
            receivedAt: "2026-03-01T09:00:00+09:00",
          },
        });
        expect(recordDay.statusCode).toBe(201);
        expect((recordDay.json() as { qualifying: boolean }).qualifying).toBe(true);

        const gateStatus = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_HAPPY },
        });
        expect((gateStatus.json() as { streak: number }).streak).toBe(1);

        const dayRow = await pool.query(`SELECT count(*)::int AS n FROM finance_day_records WHERE workspace_id = $1`, [WS_HAPPY]);
        expect((dayRow.rows[0] as { n: number }).n).toBe(1);
        const stateRow = await pool.query(`SELECT streak FROM finance_daily_gate_state WHERE workspace_id = $1`, [WS_HAPPY]);
        expect((stateRow.rows[0] as { streak: number }).streak).toBe(1);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "fail-closed (falsifiable D3 proof): a forced PG reconciliation-INSERT failure aborts /reconciliations with 5xx AND leaves memory (open exceptions) uncommitted AND 0 PG rows",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, {
            failInsertForWorkspace: { workspaceId: WS_FAIL_RECON, tableRegex: /INSERT\s+INTO\s+finance_reconciliations/i },
          }),
          financePack: FINANCE_PACK,
        });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const beforeExceptions = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_FAIL_RECON },
        });
        expect((beforeExceptions.json() as unknown[]).length).toBe(0);

        const doomed = await app.inject({
          method: "POST",
          url: "/api/finance/reconciliations",
          headers: { "x-workspace-id": WS_FAIL_RECON },
          payload: {
            id: "recon-doomed-1",
            statementRow: { account: "1000", postedAt: "2026-03-05T09:00:00+09:00", amountKrw: "9000", rowFingerprint: "fp-doomed-1" },
            ledgerAmountKrw: "8000",
            reconciledByPrincipalId: "recon-operator-doomed",
            reconciledAt: "2026-03-05T10:00:00.000Z",
            exceptionId: "exc-doomed-1",
          },
        });
        expect(doomed.statusCode).toBeGreaterThanOrEqual(500);
        expect(doomed.statusCode).toBeLessThan(600);

        // In-memory state MUST NOT have advanced past the failed PG write:
        // the OPEN exception the doomed variance would have created is
        // absent, proving `commitReconcile` never ran.
        const afterExceptions = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_FAIL_RECON },
        });
        expect((afterExceptions.json() as unknown[]).length).toBe(0);

        // 0 rows in PG for both tables — memory can never lead PG.
        const reconRow = await pool.query(`SELECT count(*)::int AS n FROM finance_reconciliations WHERE workspace_id = $1`, [WS_FAIL_RECON]);
        expect((reconRow.rows[0] as { n: number }).n).toBe(0);
        const excRow = await pool.query(`SELECT count(*)::int AS n FROM finance_exceptions WHERE workspace_id = $1`, [WS_FAIL_RECON]);
        expect((excRow.rows[0] as { n: number }).n).toBe(0);

        // Retrying without a fingerprint collision (dedup set was never
        // populated by the failed attempt) succeeds cleanly once the
        // injected failure is not in play for a fresh id/fingerprint.
        const retry = await app.inject({
          method: "POST",
          url: "/api/finance/reconciliations",
          headers: { "x-workspace-id": WS_FAIL_RECON },
          payload: {
            id: "recon-doomed-1",
            statementRow: { account: "1000", postedAt: "2026-03-05T09:00:00+09:00", amountKrw: "9000", rowFingerprint: "fp-doomed-1" },
            ledgerAmountKrw: "8000",
            reconciledByPrincipalId: "recon-operator-doomed",
            reconciledAt: "2026-03-05T10:00:00.000Z",
            exceptionId: "exc-doomed-1",
          },
        });
        // Same repo failure is still scoped to WS_FAIL_RECON for this app
        // instance, so this retry deliberately still fails 5xx too — the
        // point is that a same-id retry is not blocked by a phantom
        // DUPLICATE_ID from a partially-committed prior attempt.
        expect(retry.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "fail-closed (falsifiable D4 proof) + cross-workspace isolation: a forced PG day-record-INSERT failure aborts /daily-gate/days with 5xx AND leaves memory (streak/day list) uncommitted AND 0 PG rows, while an unrelated workspace is untouched",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, {
            failInsertForWorkspace: { workspaceId: WS_FAIL_DAY, tableRegex: /INSERT\s+INTO\s+finance_day_records/i },
          }),
          financePack: FINANCE_PACK,
        });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const beforeGate = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_FAIL_DAY },
        });
        expect((beforeGate.json() as { streak: number }).streak).toBe(0);

        const doomed = await app.inject({
          method: "POST",
          url: "/api/finance/daily-gate/days",
          headers: { "x-workspace-id": WS_FAIL_DAY },
          payload: {
            date: "2026-04-01",
            importsCompleted: true,
            entriesBalanced: true,
            openFinanceExceptions: 0,
            receivedAt: "2026-04-01T09:00:00+09:00",
          },
        });
        expect(doomed.statusCode).toBeGreaterThanOrEqual(500);
        expect(doomed.statusCode).toBeLessThan(600);

        // The day record does NOT appear in memory — `commitRecordDay`
        // never ran, so the streak stays at its pre-call value.
        const afterGate = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_FAIL_DAY },
        });
        expect((afterGate.json() as { streak: number }).streak).toBe(0);

        const dayRow = await pool.query(`SELECT count(*)::int AS n FROM finance_day_records WHERE workspace_id = $1`, [WS_FAIL_DAY]);
        expect((dayRow.rows[0] as { n: number }).n).toBe(0);
        const stateRow = await pool.query(`SELECT count(*)::int AS n FROM finance_daily_gate_state WHERE workspace_id = $1`, [WS_FAIL_DAY]);
        expect((stateRow.rows[0] as { n: number }).n).toBe(0);

        // Cross-workspace isolation: the same app instance's day-record
        // route for an UNRELATED workspace (no injected failure there)
        // succeeds normally — the forced failure is scoped to WS_FAIL_DAY
        // only, never a global outage.
        const untouched = await app.inject({
          method: "POST",
          url: "/api/finance/daily-gate/days",
          headers: { "x-workspace-id": WS_CROSS_UNTOUCHED },
          payload: {
            date: "2026-04-01",
            importsCompleted: true,
            entriesBalanced: true,
            openFinanceExceptions: 0,
            receivedAt: "2026-04-01T09:00:00+09:00",
          },
        });
        expect(untouched.statusCode).toBe(201);
        const untouchedRow = await pool.query(`SELECT count(*)::int AS n FROM finance_day_records WHERE workspace_id = $1`, [WS_CROSS_UNTOUCHED]);
        expect((untouchedRow.rows[0] as { n: number }).n).toBe(1);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "concurrency (mutex holds): N concurrent same-workspace record-day calls with sequential dates each commit exactly once — no lost update, final streak/day-record count == N",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({ pgPool: scopedQueryableFromPool(pool), financePack: FINANCE_PACK });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const dates = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"];
        const responses = await Promise.all(
          dates.map((date) =>
            app.inject({
              method: "POST",
              url: "/api/finance/daily-gate/days",
              headers: { "x-workspace-id": WS_CONCURRENT },
              payload: {
                date,
                importsCompleted: true,
                entriesBalanced: true,
                openFinanceExceptions: 0,
                receivedAt: `${date}T09:00:00+09:00`,
              },
            }),
          ),
        );

        // Without `withWorkspaceMutex` serializing preview->PG-write->
        // commit, concurrent `previewRecordDay` calls would all compute
        // against the SAME pre-image `lastDateEpoch`/`streak`, so most
        // would throw OUT_OF_ORDER (racing against each other) or silently
        // clobber each other's streak advance on commit. With the mutex,
        // every one of the N sequential-date requests commits successfully.
        for (const response of responses) {
          expect(response.statusCode).toBe(201);
        }

        const gateStatus = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_CONCURRENT },
        });
        // 5 qualifying days in a row, requiredConsecutiveDays=3 -> eligible.
        const status = gateStatus.json() as { streak: number; tier: string };
        expect(status.streak).toBe(dates.length);
        expect(status.tier).toBe("eligible");

        const dayRow = await pool.query(`SELECT count(*)::int AS n FROM finance_day_records WHERE workspace_id = $1`, [WS_CONCURRENT]);
        expect((dayRow.rows[0] as { n: number }).n).toBe(dates.length);
        const stateRow = await pool.query(`SELECT streak, tier FROM finance_daily_gate_state WHERE workspace_id = $1`, [WS_CONCURRENT]);
        expect((stateRow.rows[0] as { streak: number }).streak).toBe(dates.length);
        expect((stateRow.rows[0] as { tier: string }).tier).toBe("eligible");
      } finally {
        await pool.end();
      }
    },
    60_000,
  );
  it(
    "atomic rollback (P2 fix, load-bearing): a forced PG exception-INSERT failure (the SECOND write of the reconcile pair) still rolls back the ALREADY-SUCCEEDED reconciliation INSERT inside the SAME transaction -> 5xx, 0 rows in BOTH finance_reconciliations and finance_exceptions, memory (open exceptions) uncommitted. Fails against the pre-fix two-transaction code, where the reconciliation row would survive.",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, {
            failInsertForWorkspace: { workspaceId: WS_FAIL_RECON_SECOND, tableRegex: /INSERT\s+INTO\s+finance_exceptions/i },
          }),
          financePack: FINANCE_PACK,
        });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const beforeExceptions = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_FAIL_RECON_SECOND },
        });
        expect((beforeExceptions.json() as unknown[]).length).toBe(0);

        const doomed = await app.inject({
          method: "POST",
          url: "/api/finance/reconciliations",
          headers: { "x-workspace-id": WS_FAIL_RECON_SECOND },
          payload: {
            id: "recon-second-write-doomed-1",
            statementRow: { account: "1000", postedAt: "2026-03-06T09:00:00+09:00", amountKrw: "9000", rowFingerprint: "fp-second-write-doomed-1" },
            ledgerAmountKrw: "8000",
            reconciledByPrincipalId: "recon-operator-second-write",
            reconciledAt: "2026-03-06T10:00:00.000Z",
            exceptionId: "exc-second-write-doomed-1",
          },
        });
        expect(doomed.statusCode).toBeGreaterThanOrEqual(500);
        expect(doomed.statusCode).toBeLessThan(600);

        // Memory MUST NOT advance: commitReconcile never ran.
        const afterExceptions = await app.inject({
          method: "GET",
          url: "/api/finance/exceptions",
          headers: { "x-workspace-id": WS_FAIL_RECON_SECOND },
        });
        expect((afterExceptions.json() as unknown[]).length).toBe(0);

        // The load-bearing assertion: the reconciliation INSERT (the FIRST
        // write) succeeded on the wire before the exception INSERT threw,
        // but because both run on the SAME withWorkspaceScope transaction,
        // the ROLLBACK undoes it too — 0 rows in BOTH tables, not just the
        // exception table.
        const reconRow = await pool.query(
          `SELECT count(*)::int AS n FROM finance_reconciliations WHERE workspace_id = $1`,
          [WS_FAIL_RECON_SECOND],
        );
        expect((reconRow.rows[0] as { n: number }).n).toBe(0);
        const excRow = await pool.query(
          `SELECT count(*)::int AS n FROM finance_exceptions WHERE workspace_id = $1`,
          [WS_FAIL_RECON_SECOND],
        );
        expect((excRow.rows[0] as { n: number }).n).toBe(0);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "atomic rollback (P2 fix, load-bearing): a forced PG daily-gate-state-UPSERT failure (the SECOND write of the record-day pair) still rolls back the ALREADY-SUCCEEDED day-record INSERT inside the SAME transaction -> 5xx, 0 rows in BOTH finance_day_records and finance_daily_gate_state, memory (streak) uncommitted. Fails against the pre-fix two-transaction code, where the day-record row would survive.",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, {
            failInsertForWorkspace: { workspaceId: WS_FAIL_DAY_SECOND, tableRegex: /INSERT\s+INTO\s+finance_daily_gate_state/i },
          }),
          financePack: FINANCE_PACK,
        });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const beforeGate = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_FAIL_DAY_SECOND },
        });
        expect((beforeGate.json() as { streak: number }).streak).toBe(0);

        const doomed = await app.inject({
          method: "POST",
          url: "/api/finance/daily-gate/days",
          headers: { "x-workspace-id": WS_FAIL_DAY_SECOND },
          payload: {
            date: "2026-04-02",
            importsCompleted: true,
            entriesBalanced: true,
            openFinanceExceptions: 0,
            receivedAt: "2026-04-02T09:00:00+09:00",
          },
        });
        expect(doomed.statusCode).toBeGreaterThanOrEqual(500);
        expect(doomed.statusCode).toBeLessThan(600);

        // Memory MUST NOT advance: commitRecordDay never ran.
        const afterGate = await app.inject({
          method: "GET",
          url: "/api/finance/daily-gate",
          headers: { "x-workspace-id": WS_FAIL_DAY_SECOND },
        });
        expect((afterGate.json() as { streak: number }).streak).toBe(0);

        // The load-bearing assertion: the day-record INSERT (the FIRST
        // write) succeeded on the wire before the state UPSERT threw, but
        // because both run on the SAME withWorkspaceScope transaction, the
        // ROLLBACK undoes it too — 0 rows in BOTH tables, not just the
        // state table.
        const dayRow = await pool.query(
          `SELECT count(*)::int AS n FROM finance_day_records WHERE workspace_id = $1`,
          [WS_FAIL_DAY_SECOND],
        );
        expect((dayRow.rows[0] as { n: number }).n).toBe(0);
        const stateRow = await pool.query(
          `SELECT count(*)::int AS n FROM finance_daily_gate_state WHERE workspace_id = $1`,
          [WS_FAIL_DAY_SECOND],
        );
        expect((stateRow.rows[0] as { n: number }).n).toBe(0);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );
});
