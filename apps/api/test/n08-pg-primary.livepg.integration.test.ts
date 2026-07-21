import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { GovernanceRepository, GovernancePgQueryable } from "@ai-crm/governance";
import { createPgGovernanceRepository } from "@ai-crm/governance";

/**
 * N-08 (D3 + D4) request-path acceptance against REAL PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0004 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh`, same as
 * `sor-restart-livepg.integration.test.ts`.
 *
 * D4 (B1) — PG-primary scoped governance read:
 *  - "falsifiable": a control row is INSERTed directly into
 *    `orch_governance_controls` out-of-band (bypassing the app's in-memory
 *    GovernanceAuthorizationService entirely), then `GET
 *    /api/governance/controls` is asserted to reflect it. This assertion
 *    is impossible to pass if reads stayed in-memory — the app process
 *    never called `governance.authorize`/etc. for this row, so an
 *    in-memory-only read would never see it.
 *  - cross-workspace denial: a request scoped to workspace A never returns
 *    workspace B's rows, both through the app's real HTTP surface AND via a
 *    raw `SET ROLE ai_crm_runtime_api` (NOBYPASSRLS) session proving FORCE
 *    RLS itself — not just an app-level WHERE clause — denies the
 *    cross-workspace read.
 *
 * D3 (B2) — audit/outbox in-txn dual-write + restart-sourcing:
 *  - a governed mutation through the real HTTP surface dual-writes
 *    `audit_events` + advances `audit_chain_heads` + enqueues
 *    `outbox_events` inside one `withWorkspaceScope` transaction;
 *  - instance B (fresh `createApp`, same DSN) hydrates
 *    `audit_chain_heads.head_sequence` and continues the SAME chain (no
 *    reset to 1) for a subsequent mutation;
 *  - two overlapping scoped writers appending onto the SAME workspace's
 *    audit chain concurrently still produce a contiguous, gap-free,
 *    duplicate-free `head_sequence` (row-locked via `FOR UPDATE`).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_A = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const WS_B = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const OPERATOR = "operator-n08-livepg";

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

/**
 * Minimal real-`pg.Pool`-backed `PgQueryable` implementing
 * `withWorkspaceScope` the same way `apps/api/src/app.ts`'s
 * `createScopedPgQueryable` does (single checked-out connection, `BEGIN`,
 * parameterized `set_config('app.workspace_id', $1, true)`, `COMMIT`) — used
 * here to drive two independent, genuinely concurrent
 * `PgGovernanceRepository.appendAuditEvents` callers against the SAME
 * workspace for the 2-writer contiguous-sequence acceptance.
 */
function scopedQueryableFromPool(pool: import("pg").Pool): GovernancePgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return result as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: GovernancePgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: GovernancePgQueryable = {
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

describe.skipIf(!LIVE)("N-08 PG-primary governance read + audit dual-write against REAL Postgres (LIVE_PG_TEST=1)", () => {
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
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "n08-livepg-a", WS_B, "n08-livepg-b"],
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
      // audit_events / audit_chain_heads are append-only / no-delete by
      // trigger (BEFORE UPDATE OR DELETE / BEFORE DELETE) — even the
      // superuser session enforces them. Disable the two triggers for this
      // superuser cleanup connection only (test teardown, not a runtime
      // path), delete the test fixtures, then restore them.
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
    "D4 falsifiable: a control written directly into PG (out-of-band, bypassing app memory) is reflected by GET /api/governance/controls",
    async () => {
      const app = await bootApp({ databaseUrl: DATABASE_URL });
      expect((app as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");

      const { Client } = (await import("pg")) as typeof import("pg");
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      const outOfBandId = "control-out-of-band-1";
      try {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_A]);
        await client.query(
          `INSERT INTO orch_governance_controls (
             id, workspace_id, action_type, kind, resource_id, resource_version,
             payload_hash, policy_version, requester_principal_id, status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())`,
          [
            outOfBandId,
            WS_A,
            "CUSTOMER_SEND",
            "APPROVAL",
            "customer-out-of-band",
            1,
            "hash-out-of-band",
            1,
            "operator-out-of-band",
            "PENDING",
          ],
        );
      } finally {
        await client.end();
      }

      // The app process never called governance.authorize/etc. for this
      // row — an in-memory-only read has zero way to know it exists. If
      // this assertion passes, the read genuinely went to PG.
      const list = await app.inject({
        method: "GET",
        url: "/api/governance/controls",
        headers: { "x-workspace-id": WS_A },
      });
      expect(list.statusCode).toBe(200);
      const controls = list.json() as Array<{ id: string; status: string }>;
      expect(controls.some((c) => c.id === outOfBandId)).toBe(true);

      const single = await app.inject({
        method: "GET",
        url: `/api/governance/controls/${outOfBandId}`,
        headers: { "x-workspace-id": WS_A },
      });
      expect(single.statusCode).toBe(200);
      expect((single.json() as { id: string }).id).toBe(outOfBandId);
    },
    60_000,
  );

  it(
    "D4 cross-workspace denial: workspace A's read never returns workspace B's control, at the HTTP layer AND under raw SET ROLE ai_crm_runtime_api",
    async () => {
      const app = await bootApp({ databaseUrl: DATABASE_URL });

      const { Client } = (await import("pg")) as typeof import("pg");
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      const controlBId = "control-cross-ws-b";
      try {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_B]);
        await client.query(
          `INSERT INTO orch_governance_controls (
             id, workspace_id, action_type, kind, resource_id, resource_version,
             payload_hash, policy_version, requester_principal_id, status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())`,
          [controlBId, WS_B, "CUSTOMER_SEND", "APPROVAL", "customer-b", 1, "hash-b", 1, "operator-b", "PENDING"],
        );

        // HTTP-layer denial: app's scoped getControlsForWorkspace(WS_A) query.
        const listA = await app.inject({
          method: "GET",
          url: "/api/governance/controls",
          headers: { "x-workspace-id": WS_A },
        });
        expect(listA.statusCode).toBe(200);
        expect((listA.json() as Array<{ id: string }>).some((c) => c.id === controlBId)).toBe(false);

        // RLS-layer denial: SET ROLE ai_crm_runtime_api (NOBYPASSRLS),
        // scope to WS_A, prove workspace B's row is invisible even though
        // this connection can physically see the whole table absent RLS.
        await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
          await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_A]);
          const rlsScoped = await client.query(`SELECT id, workspace_id FROM orch_governance_controls`);
          expect((rlsScoped.rows as Array<{ id: string }>).some((r) => r.id === controlBId)).toBe(false);
        } finally {
          await client.query("COMMIT");
        }
      } finally {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_B]);
        await client.query(`DELETE FROM orch_governance_controls WHERE id = $1`, [controlBId]);
        await client.query(`RESET app.workspace_id`);
        await client.end();
      }
    },
    60_000,
  );

  it(
    "D3 write -> restart -> read: instance A's governed mutation dual-writes real audit_events + advances audit_chain_heads + enqueues outbox_events; instance B hydrates and continues the SAME chain",
    async () => {
      const instanceA = await bootApp({ databaseUrl: DATABASE_URL });
      expect((instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const authorizeA = await instanceA.inject({
        method: "POST",
        url: "/api/governance/authorize",
        headers: { "x-workspace-id": WS_A },
        payload: {
          command: "customer.send",
          resourceId: "customer-audit-1",
          resourceVersion: 1,
          payload: { message: "hi" },
          requesterPrincipalId: OPERATOR,
        },
      });
      expect(authorizeA.statusCode).toBe(201);
      const controlId = (authorizeA.json() as { control: { id: string } }).control.id;
      expect(controlId).toBeTruthy();

      const { Client } = (await import("pg")) as typeof import("pg");
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      let headAfterA: number;
      try {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_A]);
        const headRow = await client.query(`SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`, [
          WS_A,
        ]);
        expect(headRow.rowCount).toBe(1);
        headAfterA = Number((headRow.rows[0] as { head_sequence: string | number }).head_sequence);
        // authorize() appends POLICY_DECIDED + CONTROL_REQUESTED -> at least 2.
        expect(headAfterA).toBeGreaterThanOrEqual(2);

        const eventsRow = await client.query(
          `SELECT sequence, event_type, previous_event_hash, event_hash FROM audit_events WHERE workspace_id = $1 ORDER BY sequence ASC`,
          [WS_A],
        );
        expect(eventsRow.rowCount).toBe(headAfterA);
        const events = (
          eventsRow.rows as Array<{
            sequence: string | number;
            event_type: string;
            previous_event_hash: string;
            event_hash: string;
          }>
        ).map((row) => ({ ...row, sequence: Number(row.sequence) }));
        expect(events[0]!.sequence).toBe(1);
        expect(events[0]!.previous_event_hash).toMatch(/^0{64}$/);
        for (let i = 1; i < events.length; i++) {
          expect(events[i]!.sequence).toBe(events[i - 1]!.sequence + 1);
          expect(events[i]!.previous_event_hash).toBe(events[i - 1]!.event_hash);
        }

        const outboxRow = await client.query(`SELECT count(*)::int AS n FROM outbox_events WHERE workspace_id = $1`, [
          WS_A,
        ]);
        expect((outboxRow.rows[0] as { n: number }).n).toBe(headAfterA);
      } finally {
        await client.end();
      }

      // --- Simulate restart: fresh instance B against the SAME DSN. ---
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL });
      expect((instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );
      const runtimeB = (instanceB as FastifyInstance & { aiCrm?: { auditChainHeads?: Record<string, number> } })
        .aiCrm;
      expect(runtimeB?.auditChainHeads?.[WS_A]).toBe(headAfterA);

      // A second governed mutation on instance B must CONTINUE the chain,
      // never reset to 1 (instance B's in-memory audit list is empty
      // post-restart, but the PG chain-head is not).
      const decideB = await instanceB.inject({
        method: "POST",
        url: `/api/governance/controls/${controlId}/decide`,
        headers: { "x-workspace-id": WS_A },
        payload: { principalId: "approver-audit-1", decision: "APPROVE" },
      });
      expect(decideB.statusCode).toBe(200);

      const client2 = new Client({ connectionString: DATABASE_URL });
      await client2.connect();
      try {
        await client2.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_A]);
        const headAfterB = await client2.query(`SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`, [
          WS_A,
        ]);
        const headAfterBValue = Number((headAfterB.rows[0] as { head_sequence: string | number }).head_sequence);
        expect(headAfterBValue).toBeGreaterThan(headAfterA);

        const newestEvent = await client2.query(
          `SELECT sequence FROM audit_events WHERE workspace_id = $1 ORDER BY sequence DESC LIMIT 1`,
          [WS_A],
        );
        expect(Number((newestEvent.rows[0] as { sequence: string | number }).sequence)).toBe(headAfterA + 1);
      } finally {
        await client2.end();
      }
    },
    60_000,
  );

  it(
    "D3 two-writer concurrency: two overlapping scoped appendAuditEvents callers on the SAME workspace produce a contiguous, gap-free, duplicate-free head_sequence",
    async () => {
      const { Pool, Client } = (await import("pg")) as typeof import("pg");
      const poolA = new Pool({ connectionString: DATABASE_URL });
      const poolB = new Pool({ connectionString: DATABASE_URL });
      const repoA: GovernanceRepository = createPgGovernanceRepository(scopedQueryableFromPool(poolA));
      const repoB: GovernanceRepository = createPgGovernanceRepository(scopedQueryableFromPool(poolB));

      try {
        const [resultsA, resultsB] = await Promise.all([
          repoA.appendAuditEvents(WS_B, [
            { kind: "CONCURRENT_TEST_A_1", subjectId: "s-a-1", data: { writer: "A" } },
            { kind: "CONCURRENT_TEST_A_2", subjectId: "s-a-2", data: { writer: "A" } },
          ]),
          repoB.appendAuditEvents(WS_B, [
            { kind: "CONCURRENT_TEST_B_1", subjectId: "s-b-1", data: { writer: "B" } },
            { kind: "CONCURRENT_TEST_B_2", subjectId: "s-b-2", data: { writer: "B" } },
          ]),
        ]);

        const allSequences = [...resultsA, ...resultsB].map((r) => r.sequence).sort((a, b) => a - b);
        // No duplicates.
        expect(new Set(allSequences).size).toBe(allSequences.length);
        // Contiguous: exactly {min, min+1, ..., min+3}, no gaps.
        const min = allSequences[0]!;
        expect(allSequences).toEqual([min, min + 1, min + 2, min + 3]);

        const client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
        try {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_B]);
          const rows = await client.query(
            `SELECT sequence FROM audit_events WHERE workspace_id = $1 AND sequence >= $2 ORDER BY sequence ASC`,
            [WS_B, min],
          );
          const dbSequences = (rows.rows as Array<{ sequence: number }>).map((r) => Number(r.sequence));
          expect(dbSequences).toEqual(allSequences);

          const headRow = await client.query(`SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`, [
            WS_B,
          ]);
          expect(Number((headRow.rows[0] as { head_sequence: string | number }).head_sequence)).toBe(min + 3);
        } finally {
          await client.end();
        }
      } finally {
        await poolA.end();
        await poolB.end();
      }
    },
    60_000,
  );
});
