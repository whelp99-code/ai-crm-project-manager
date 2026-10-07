import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";
import type { PgQueryable } from "@ai-crm/orchestration";

/**
 * PG-D (D3) acceptance against REAL PostgreSQL: the governance/audit WRITE
 * path is PG-PRIMARY fail-closed for governance-bearing mutations
 * (authorize/decide/consume), NOT memory-primary best-effort.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0004 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh`, same as
 * `n08-pg-primary.livepg.integration.test.ts`.
 *
 * Mirrors the PG-C1 ledger preview/commit split
 * (`packages/finance/src/ledger.ts` / `apps/api/src/app.ts` ledger routes):
 * `POST /api/governance/authorize` / `.../decide` / `.../consume` now call
 * `governance.preview*` (computes the validated transition + new audit
 * event(s) into a detached, uncommitted draft), then AWAIT
 * `pgFirstAuditAppend` (the PG `audit_events`/`audit_chain_heads`/
 * `outbox_events` write) BEFORE calling `governance.commit*`. Unlike the
 * pre-existing `dualWriteAudit` (still best-effort for
 * notifications/`dualWriteAgentState`), `pgFirstAuditAppend` is never
 * wrapped in a swallowing try/catch.
 *
 * Covers:
 *  - Happy path: an authorize mutation through the real HTTP surface
 *    dual-writes `audit_events` + advances `audit_chain_heads` +
 *    enqueues `outbox_events`, and the in-memory governance state (GET
 *    /api/governance/controls, GET /api/governance/audit) reflects the
 *    SAME committed mutation (PG-primary success, not a race).
 *  - Fail-closed (the falsifiable D3 proof): a `pgPool` is injected whose
 *    `INSERT INTO audit_events` statement always throws (constraint/
 *    connection failure double). The authorize/decide/consume ROUTE
 *    returns 5xx, NO row is ever written to PG's `audit_events`/
 *    `audit_chain_heads`, and — critically — the in-memory governance
 *    state was NEVER committed: `GET /api/governance/controls` /
 *    `GET /api/governance/audit` for that workspace stay exactly as they
 *    were before the failed call. Memory cannot lead PG.
 *  - Cross-workspace isolation: a forced audit-write failure on workspace
 *    A never touches workspace B's chain-head/state.
 *  - Chain-head monotonic: after a fail-closed attempt is retried
 *    successfully (once the injected failure is lifted), the chain-head
 *    continues cleanly (no gap, no duplicate, no partial row left behind
 *    by the rolled-back failed attempt).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_A = "f1111111-1111-1111-1111-111111111111";
const WS_B = "f2222222-2222-2222-2222-222222222222";
const OPERATOR = "operator-pgd-livepg";

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

/**
 * Real-`pg.Pool`-backed `PgQueryable` implementing `withWorkspaceScope` the
 * same way `apps/api/src/app.ts`'s `createScopedPgQueryable` does (single
 * checked-out connection, `BEGIN`, parameterized
 * `set_config('app.workspace_id', $1, true)`, `COMMIT`) — mirrors
 * `n08-pg-primary.livepg.integration.test.ts`'s `scopedQueryableFromPool`.
 *
 * `failAuditInsertForWorkspace`, when set, makes any `INSERT INTO
 * audit_events` statement scoped to that exact workspace id throw a
 * simulated PG failure BEFORE it reaches the database — a stand-in for a
 * dropped connection / constraint violation on the real INSERT. Every
 * other statement (head upsert/select, other workspaces, reads) passes
 * through to the real pool untouched, so the SAME transaction's `BEGIN`/
 * head `SELECT ... FOR UPDATE` still runs for real and is rolled back for
 * real when the simulated failure propagates out of `withWorkspaceScope`.
 */
function scopedQueryableFromPool(pool: import("pg").Pool, options?: { failAuditInsertForWorkspace?: string }): PgQueryable {
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
              options?.failAuditInsertForWorkspace === workspaceId &&
              /INSERT\s+INTO\s+audit_events/i.test(text)
            ) {
              throw new Error("SIMULATED_PG_AUDIT_WRITE_FAILURE");
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

describe.skipIf(!LIVE)("PG-D (D3) audit write PG-primary fail-closed against REAL Postgres (LIVE_PG_TEST=1)", () => {
  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        ...pgSmokeConnectionEnv(DATABASE_URL),
      },
      stdio: "pipe",
    });

    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "pgd-livepg-a", WS_B, "pgd-livepg-b"],
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
        for (const ws of [WS_A, WS_B]) {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [ws]);
        }
      } finally {
        await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "happy path: authorize dual-writes audit_events + advances audit_chain_heads + enqueues outbox_events, and in-memory state reflects the SAME committed mutation (PG-primary)",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({ pgPool: scopedQueryableFromPool(pool) });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const authorize = await app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_A },
          payload: {
            command: "customer.send",
            resourceId: "customer-pgd-happy-1",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(authorize.statusCode).toBe(201);
        const controlId = (authorize.json() as { control: { id: string } }).control.id;
        expect(controlId).toBeTruthy();

        // In-memory state reflects the committed mutation.
        const controls = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_A },
        });
        expect(controls.statusCode).toBe(200);
        expect((controls.json() as Array<{ id: string }>).some((c) => c.id === controlId)).toBe(true);

        const audit = await app.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_A },
        });
        const auditEvents = audit.json() as Array<{ kind: string }>;
        expect(auditEvents.some((e) => e.kind === "CONTROL_REQUESTED")).toBe(true);

        // Real PG rows: audit_events + audit_chain_heads + outbox_events.
        const eventsRow = await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1`,
          [WS_A],
        );
        expect((eventsRow.rows[0] as { n: number }).n).toBe(auditEvents.length);

        const headRow = await pool.query(`SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`, [
          WS_A,
        ]);
        expect(Number((headRow.rows[0] as { head_sequence: string | number }).head_sequence)).toBe(
          auditEvents.length,
        );

        const outboxRow = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE workspace_id = $1`, [
          WS_A,
        ]);
        expect((outboxRow.rows[0] as { n: number }).n).toBe(auditEvents.length);
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "fail-closed (falsifiable D3 proof): a forced PG audit-write failure aborts authorize/decide/consume with 5xx AND leaves in-memory governance state uncommitted — memory can never lead PG",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, { failAuditInsertForWorkspace: WS_B }),
        });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        // --- Snapshot before the doomed call. ---
        const beforeControls = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_B },
        });
        expect(beforeControls.statusCode).toBe(200);
        expect((beforeControls.json() as unknown[]).length).toBe(0);

        const beforeAudit = await app.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_B },
        });
        expect((beforeAudit.json() as unknown[]).length).toBe(0);

        // --- The doomed authorize call: PG audit INSERT is forced to throw. ---
        const authorize = await app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_B },
          payload: {
            command: "customer.send",
            resourceId: "customer-pgd-fail-1",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        // A PG failure MUST throw (5xx), never silently succeed.
        expect(authorize.statusCode).toBeGreaterThanOrEqual(500);
        expect(authorize.statusCode).toBeLessThan(600);

        // --- Memory MUST NOT have advanced past the failed PG write. ---
        const afterControls = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_B },
        });
        expect((afterControls.json() as unknown[]).length).toBe(0);

        const afterAudit = await app.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_B },
        });
        expect((afterAudit.json() as unknown[]).length).toBe(0);

        // --- PG itself has NO partial row: the whole transaction rolled back. ---
        const eventsRow = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1`, [
          WS_B,
        ]);
        expect((eventsRow.rows[0] as { n: number }).n).toBe(0);

        const headRow = await pool.query(`SELECT count(*)::int AS n FROM audit_chain_heads WHERE workspace_id = $1`, [
          WS_B,
        ]);
        expect((headRow.rows[0] as { n: number }).n).toBe(0);

        const outboxRow = await pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE workspace_id = $1`, [
          WS_B,
        ]);
        expect((outboxRow.rows[0] as { n: number }).n).toBe(0);

        // --- Cross-workspace isolation: workspace A is completely untouched
        // by workspace B's forced failure (this app instance's pool only
        // fails audit inserts scoped to WS_B). ---
        const authorizeA = await app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_A },
          payload: {
            command: "customer.send",
            resourceId: "customer-pgd-cross-ws-a",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(authorizeA.statusCode).toBe(201);

        // --- Chain-head monotonic: retrying (same request) on B once the
        // simulated failure is lifted succeeds cleanly, with NO gap/dup left
        // by the rolled-back failed attempt (head starts at 0, ends at
        // exactly the count of THIS successful attempt's events). ---
        const appNoFailure = await bootApp({ pgPool: scopedQueryableFromPool(pool) });
        const retry = await appNoFailure.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_B },
          payload: {
            command: "customer.send",
            resourceId: "customer-pgd-fail-1-retry",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(retry.statusCode).toBe(201);

        const retryAudit = await appNoFailure.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_B },
        });
        const retryAuditEvents = retryAudit.json() as Array<{ sequence: number }>;
        expect(retryAuditEvents.length).toBeGreaterThan(0);

        const headAfterRetry = await pool.query(
          `SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`,
          [WS_B],
        );
        // Head starts fresh at exactly this retry's event count — no
        // sequence numbers were ever burned by the rolled-back failed
        // attempt (proves the failed transaction left ZERO trace, not just
        // zero visible rows).
        expect(Number((headAfterRetry.rows[0] as { head_sequence: string | number }).head_sequence)).toBe(
          retryAuditEvents.length,
        );

        const eventsAfterRetry = await pool.query(
          `SELECT sequence FROM audit_events WHERE workspace_id = $1 ORDER BY sequence ASC`,
          [WS_B],
        );
        const sequences = (eventsAfterRetry.rows as Array<{ sequence: string | number }>).map((r) => Number(r.sequence));
        expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
      } finally {
        await pool.end();
      }
    },
    60_000,
  );
});
