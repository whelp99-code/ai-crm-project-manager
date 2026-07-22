import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { PgQueryable } from "@ai-crm/orchestration";
import type { ChartAccount, FinancePackConfig } from "@ai-crm/finance";

/**
 * P6-b G002 (PG-D) — architect P2 fix acceptance against REAL PostgreSQL:
 * the per-workspace async mutex (`withWorkspaceMutex` in `app.ts`) closes the
 * concurrent-same-workspace TOCTOU the D3 preview -> await PG write -> commit
 * split opened for BOTH the governance routes (authorize/decide/consume) and
 * the ledger routes (draft/verify/post/reverse).
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0006 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as the other livepg
 * suites) then applies 0009_finance_ledger.sql itself, mirroring
 * `pg-c1-ledger.livepg.integration.test.ts`.
 *
 * Falsifiable proof: without `withWorkspaceMutex` wrapping the routes'
 * preview->PG-write->commit section, `governance.previewAuthorize` /
 * `previewConsumeControl` clone `this.state` at call time
 * (`GovernanceAuthorizationService.previewTransact`), so N concurrent
 * same-workspace requests all preview from the SAME pre-image and the
 * last commit (`this.state = draft`) clobbers every earlier one — an
 * in-memory lost update — while two concurrent `/consume` calls on one
 * APPROVED control can both pass the `status === "APPROVED"` check before
 * either commits (double `CONTROL_CONSUMED`). The mutex serializes the
 * whole critical section per workspace so this is structurally impossible:
 * each request's preview only ever starts after the previous same-workspace
 * request's commit has landed.
 *
 * Covers:
 *  - Concurrent same-workspace authorize: no lost update — every one of N
 *    concurrent requests commits, and in-memory audit count == PG
 *    audit_events count == chain-head sequence (no divergence).
 *  - Concurrent /consume TOCTOU closed: exactly ONE of two concurrent
 *    consumes of a single APPROVED control succeeds; the other fails
 *    closed (CONTROL_NOT_APPROVED) — never two CONTROL_CONSUMED events for
 *    one approval.
 *  - Concurrent same-workspace ledger /verify TOCTOU closed: exactly ONE of
 *    two concurrent verifies of a single DRAFT entry succeeds — the other
 *    fails closed (INVALID_STATE), and both memory and PG show the entry
 *    VERIFIED exactly once (never double-committed).
 *  - Cross-workspace: two different workspaces make concurrent progress —
 *    a slow-PG-write workspace does not head-of-line block an unrelated
 *    workspace's request (mutex is per-workspace, not global).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const ledgerMigrationFile = join(repoRoot, "packages/persistence/migrations/0009_finance_ledger.sql");

const WS_GOV = "a1111111-1111-1111-1111-111111111111";
const WS_CONSUME = "a2222222-2222-2222-2222-222222222222";
const WS_LEDGER = "a3333333-3333-3333-3333-333333333333";
const WS_CROSS_SLOW = "a4444444-4444-4444-4444-444444444444";
const WS_CROSS_FAST = "a5555555-5555-5555-5555-555555555555";
const ALL_WS = [WS_GOV, WS_CONSUME, WS_LEDGER, WS_CROSS_SLOW, WS_CROSS_FAST];
const OPERATOR = "operator-mutex-livepg";

const CHART: ChartAccount[] = [
  { code: "1000", name: "현금", type: "asset" },
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
 * Applies 0009_finance_ledger.sql idempotently, the same schema_migrations-
 * gated way the smoke script applies 0001..0006 (mirrors pg-c1-ledger's
 * `applyLedgerMigration`) — 0009 is not yet wired into the smoke script.
 */
async function applyLedgerMigration(client: import("pg").Client): Promise<void> {
  const already = await client.query(`SELECT 1 FROM schema_migrations WHERE id = '0009_finance_ledger'`);
  if ((already.rowCount ?? 0) > 0) return;
  const sql = readFileSync(ledgerMigrationFile, "utf8");
  await client.query(sql);
  await client.query(`INSERT INTO schema_migrations (id) VALUES ('0009_finance_ledger') ON CONFLICT (id) DO NOTHING`);
}

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
 * `writeGateForWorkspace`, when set, stops the matching workspace after its
 * transaction scope is established but before its scoped PG work starts. It
 * lets the cross-workspace test prove ordering without relying on elapsed
 * wall-clock time.
 */
function scopedQueryableFromPool(
  pool: import("pg").Pool,
  options?: {
    writeGateForWorkspace?: {
      workspaceId: string;
      entered: () => void;
      release: Promise<void>;
    };
  },
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
        const writeGate = options?.writeGateForWorkspace;
        if (writeGate?.workspaceId === workspaceId) {
          writeGate.entered();
          await writeGate.release;
        }
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

describe.skipIf(!LIVE)("PG mutex concurrency (P6-b G002 / PG-D architect P2 fix) against REAL Postgres (LIVE_PG_TEST=1)", () => {
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
      const values = ALL_WS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(", ");
      const params = ALL_WS.flatMap((ws, i) => [ws, `pgmutex-livepg-${i}`]);
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
      await client.query(`ALTER TABLE finance_journal_entries DISABLE TRIGGER ALL`);
      try {
        for (const ws of ALL_WS) {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM finance_journal_entries WHERE workspace_id = $1`, [ws]);
        }
      } finally {
        await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
        await client.query(`ALTER TABLE finance_journal_entries ENABLE TRIGGER ALL`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [ALL_WS]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "concurrent same-workspace authorize: no in-memory lost update — every request commits and memory == PG audit_events == chain-head",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({ pgPool: scopedQueryableFromPool(pool) });
        expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

        const N = 5;
        const responses = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            app.inject({
              method: "POST",
              url: "/api/governance/authorize",
              headers: { "x-workspace-id": WS_GOV },
              payload: {
                command: "customer.send",
                resourceId: `customer-mutex-concurrent-${i}`,
                resourceVersion: 1,
                payload: { message: "hi" },
                requesterPrincipalId: OPERATOR,
              },
            }),
          ),
        );

        // Without the mutex, concurrent previews clone the SAME pre-image
        // and the later commit clobbers the earlier one in memory — some of
        // these would silently disappear from GET /audit / GET /controls
        // even though every HTTP call itself returned 201. With the mutex,
        // every single request's commit is preserved.
        for (const response of responses) {
          expect(response.statusCode).toBe(201);
        }

        const controls = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_GOV },
        });
        expect((controls.json() as unknown[]).length).toBe(N);

        const audit = await app.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_GOV },
        });
        const auditEvents = audit.json() as Array<{ sequence: number }>;
        // Each authorize appends TWO audit events (POLICY_DECIDED +
        // CONTROL_REQUESTED), so N concurrent authorizes append 2*N total.
        const expectedEvents = N * 2;
        expect(auditEvents.length).toBe(expectedEvents);

        // In-memory count matches the real PG audit_events row count AND the
        // chain-head — no transient divergence between memory and PG, and no
        // lost update within memory itself.
        const eventsRow = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1`, [
          WS_GOV,
        ]);
        expect((eventsRow.rows[0] as { n: number }).n).toBe(expectedEvents);

        const headRow = await pool.query(`SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`, [
          WS_GOV,
        ]);
        expect(Number((headRow.rows[0] as { head_sequence: string | number }).head_sequence)).toBe(expectedEvents);

        // Sequences are gapless/unique 1..(2N) — the mutex fully serialized
        // the critical section, so PG's FOR UPDATE head lock was never
        // contended in a way that produced a gap or a duplicate.
        const sequences = auditEvents.map((e) => e.sequence).sort((a, b) => a - b);
        expect(sequences).toEqual(Array.from({ length: expectedEvents }, (_, i) => i + 1));
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "concurrent /consume TOCTOU closed: exactly ONE of two concurrent consumes of a single APPROVED control succeeds",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({ pgPool: scopedQueryableFromPool(pool) });

        const resourceId = "customer-mutex-consume-1";
        const authorize = await app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_CONSUME },
          payload: {
            command: "customer.send",
            resourceId,
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(authorize.statusCode).toBe(201);
        const control = authorize.json().control as { id: string; payloadHash: string; policyVersion: number };

        const decide = await app.inject({
          method: "POST",
          url: `/api/governance/controls/${control.id}/decide`,
          headers: { "x-workspace-id": WS_CONSUME },
          payload: { principalId: "approver-mutex", decision: "APPROVE" },
        });
        expect(decide.statusCode).toBe(200);

        const consumePayload = {
          resourceId,
          resourceVersion: 1,
          payloadHash: control.payloadHash,
          policyVersion: control.policyVersion,
        };

        // Fire TWO concurrent consumes of the SAME single-use APPROVED
        // control. Without the mutex both previews can observe
        // `status === "APPROVED"` before either commits — a double
        // CONTROL_CONSUMED. With the mutex, the second request's preview
        // only starts after the first's commit lands, so it always observes
        // the already-CONSUMED status.
        const [first, second] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/api/governance/controls/${control.id}/consume`,
            headers: { "x-workspace-id": WS_CONSUME },
            payload: consumePayload,
          }),
          app.inject({
            method: "POST",
            url: `/api/governance/controls/${control.id}/consume`,
            headers: { "x-workspace-id": WS_CONSUME },
            payload: consumePayload,
          }),
        ]);

        const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
        // Exactly one 201 (succeeded) and one failure (CONTROL_NOT_APPROVED,
        // surfaced as 400 by the default GovernanceError mapping) — never
        // two 201s. 201 sorts before 400 numerically.
        expect(statuses[0]).toBe(201);
        expect(statuses[1]).toBeGreaterThanOrEqual(400);
        expect(statuses[1]).toBeLessThan(500);
        const succeeded = first.statusCode === 201 ? first : second;
        const failed = first.statusCode === 201 ? second : first;
        expect((failed.json() as { error: string }).error).toBe("CONTROL_NOT_APPROVED");
        expect(succeeded.json().id).toBeTruthy();

        // Exactly ONE CONTROL_CONSUMED audit event was ever appended, both
        // in memory and in real PG — not two.
        const audit = await app.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_CONSUME },
        });
        const consumedEvents = (audit.json() as Array<{ kind: string }>).filter((e) => e.kind === "CONTROL_CONSUMED");
        expect(consumedEvents.length).toBe(1);

        const pgConsumedRow = await pool.query(
          `SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND event_type = 'CONTROL_CONSUMED'`,
          [WS_CONSUME],
        );
        expect((pgConsumedRow.rows[0] as { n: number }).n).toBe(1);

        // The control itself is CONSUMED exactly once (single-use), never
        // left APPROVED nor double-transitioned.
        const controlsAfter = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_CONSUME },
        });
        const persisted = (controlsAfter.json() as Array<{ id: string; status: string }>).find(
          (c) => c.id === control.id,
        );
        expect(persisted?.status).toBe("CONSUMED");
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "concurrent same-workspace ledger /verify TOCTOU closed: exactly ONE of two concurrent verifies of a single DRAFT entry succeeds",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool),
          financePack: fixtureConfig(),
        });

        const entryId = "je-mutex-verify-1";
        const draft = await app.inject({
          method: "POST",
          url: "/api/finance/journal-entries",
          headers: { "x-workspace-id": WS_LEDGER },
          payload: {
            id: entryId,
            entryDate: "2026-01-15",
            description: "mutex verify TOCTOU draft",
            lines: [
              { accountCode: "1000", debitKrw: "100", creditKrw: "0" },
              { accountCode: "4000", debitKrw: "0", creditKrw: "100" },
            ],
            createdByPrincipalId: "drafter-mutex",
          },
        });
        expect(draft.statusCode).toBe(201);

        // `LedgerService.buildVerifiedEntry` clones the entry at preview time
        // and only checks `status === "DRAFT"`; without the mutex, two
        // concurrent /verify calls on the SAME entry both preview from the
        // still-DRAFT pre-image and both would commit VERIFIED (the second
        // commit clobbering the first in memory). With the mutex, the
        // second request's preview only starts after the first's commit
        // lands, so it always observes the already-VERIFIED status and
        // fails closed.
        const [first, second] = await Promise.all([
          app.inject({
            method: "POST",
            url: `/api/finance/journal-entries/${entryId}/verify`,
            headers: { "x-workspace-id": WS_LEDGER },
            payload: { verifierPrincipalId: "verifier-mutex-a" },
          }),
          app.inject({
            method: "POST",
            url: `/api/finance/journal-entries/${entryId}/verify`,
            headers: { "x-workspace-id": WS_LEDGER },
            payload: { verifierPrincipalId: "verifier-mutex-b" },
          }),
        ]);

        const statuses = [first.statusCode, second.statusCode].sort((a, b) => a - b);
        // Exactly one 200 (succeeded) and one failure (INVALID_STATE,
        // surfaced as 400) — never two successful verifies. 200 sorts
        // before 400 numerically.
        expect(statuses[0]).toBe(200);
        expect(statuses[1]).toBeGreaterThanOrEqual(400);
        expect(statuses[1]).toBeLessThan(500);
        const failed = first.statusCode === 200 ? second : first;
        expect((failed.json() as { error: string }).error).toBe("INVALID_STATE");

        // In-memory and real PG both show the entry VERIFIED exactly once at
        // exactly version 2 (never version 3 from a double-commit).
        const pgRow = await pool.query(
          `SELECT status, version FROM finance_journal_entries WHERE workspace_id = $1 AND id = $2`,
          [WS_LEDGER, entryId],
        );
        expect(pgRow.rows[0]).toEqual({ status: "VERIFIED", version: 2 });
      } finally {
        await pool.end();
      }
    },
    60_000,
  );

  it(
    "cross-workspace: a slow-PG-write workspace does NOT head-of-line block an unrelated workspace's concurrent request (per-workspace mutex, not global)",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const pool = new Pool({ connectionString: DATABASE_URL });
      let signalSlowEntered!: () => void;
      const slowEntered = new Promise<void>((resolve) => {
        signalSlowEntered = resolve;
      });
      let releaseSlow!: () => void;
      const slowWriteRelease = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      let slowCompleted = false;
      let slowPromise: Promise<{ statusCode: number }> | undefined;
      try {
        const app = await bootApp({
          pgPool: scopedQueryableFromPool(pool, {
            writeGateForWorkspace: {
              workspaceId: WS_CROSS_SLOW,
              entered: signalSlowEntered,
              release: slowWriteRelease,
            },
          }),
        });

        slowPromise = app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_CROSS_SLOW },
          payload: {
            command: "customer.send",
            resourceId: "customer-mutex-cross-slow",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        }).finally(() => {
          slowCompleted = true;
        });
        await slowEntered;

        const fastResponse = await app.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_CROSS_FAST },
          payload: {
            command: "customer.send",
            resourceId: "customer-mutex-cross-fast",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });

        expect(fastResponse.statusCode).toBe(201);
        // The fast request completed while the slow workspace remained held at
        // its PG-write gate. A global mutex would have blocked it behind slow.
        expect(slowCompleted).toBe(false);
      } finally {
        // Always unblock and drain the held request before closing the pool,
        // including when a preceding assertion fails.
        releaseSlow();
        if (slowPromise) {
          const slowResponse = await slowPromise;
          expect(slowResponse.statusCode).toBe(201);
        }
        await pool.end();
      }
    },
    60_000,
  );
});
