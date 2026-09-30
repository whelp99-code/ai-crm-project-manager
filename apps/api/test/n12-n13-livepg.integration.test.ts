import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * N-13 (D3) + N-12 (D2) acceptance against REAL PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0005 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh`, same as the N-08 /
 * sor-restart livepg suites.
 *
 * N-13 — audit restart-sourced (closes the N-08 residual): today's N-08
 * dual-write already persists `audit_events`/`audit_chain_heads`, but the
 * in-memory `GovernanceAuthorizationService` audit array was NOT
 * hydrate-replayed, so GET /api/governance/audit and /audit/verify reset
 * to empty on restart. This suite proves: instance A performs governed
 * mutations -> fresh instance B hydrates -> GET /api/governance/audit
 * returns A's events AND /audit/verify == true across the restart; plus a
 * tamper case (corrupt a persisted audit_events row -> a fresh hydrate's
 * verify detects the break).
 *
 * N-12 — CRM customers PG repository (first CRM domain PG proof): create a
 * customer on instance A -> fresh instance B hydrates -> GET
 * /api/customers/:id/overview reflects it (restart survival); cross-ws
 * denial both at the HTTP layer and under raw `SET ROLE ai_crm_runtime_api`
 * (NOBYPASSRLS).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_A = "22222222-2222-2222-2222-222222222222";
const WS_B = "33333333-3333-3333-3333-333333333333";
const WS_TAMPER = "44444444-4444-4444-4444-444444444444";
const OPERATOR = "operator-n12-n13-livepg";

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)(
  "N-13 audit restart-sourced + N-12 CRM customers PG-primary against REAL Postgres (LIVE_PG_TEST=1)",
  () => {
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
        await client.query(
          `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4), ($5, $6)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
          [WS_A, "n12-n13-livepg-a", WS_B, "n12-n13-livepg-b", WS_TAMPER, "n12-n13-livepg-tamper"],
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
        // trigger, even for the superuser session. Disable both for this
        // teardown connection only, delete the fixtures, then restore them.
        await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
        try {
          for (const ws of [WS_A, WS_B, WS_TAMPER]) {
            await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
            await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [ws]);
            await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [ws]);
            await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [ws]);
            await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [ws]);
            await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [ws]);
            await client.query(`DELETE FROM crm_customers WHERE workspace_id = $1`, [ws]);
          }
        } finally {
          await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
          await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
        }
        await client.query(`RESET app.workspace_id`);
        await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B, WS_TAMPER]]);
      } finally {
        await client.end();
      }
    }, 60_000);

    it(
      "N-13: instance A's governed mutations dual-write real audit_events; fresh instance B hydrates GET /api/governance/audit + /audit/verify from PG (not empty, not reset)",
      async () => {
        const instanceA = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const authorizeA = await instanceA.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_A },
          payload: {
            command: "customer.send",
            resourceId: "customer-audit-n13-1",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(authorizeA.statusCode).toBe(201);
        const controlId = (authorizeA.json() as { control: { id: string } }).control.id;

        const decideA = await instanceA.inject({
          method: "POST",
          url: `/api/governance/controls/${controlId}/decide`,
          headers: { "x-workspace-id": WS_A },
          payload: { principalId: "approver-audit-n13-1", decision: "APPROVE" },
        });
        expect(decideA.statusCode).toBe(200);

        const auditA = await instanceA.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_A },
        });
        expect(auditA.statusCode).toBe(200);
        const eventsA = auditA.json() as Array<{ id: string; sequence: number; kind: string }>;
        // POLICY_DECIDED + CONTROL_REQUESTED + CONTROL_APPROVED == 3.
        expect(eventsA.length).toBeGreaterThanOrEqual(3);

        const verifyA = await instanceA.inject({
          method: "GET",
          url: "/api/governance/audit/verify",
          headers: { "x-workspace-id": WS_A },
        });
        expect(verifyA.statusCode).toBe(200);
        expect((verifyA.json() as { valid: boolean }).valid).toBe(true);

        // --- Simulate restart: fresh instance B against the SAME DSN. ---
        const instanceB = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const auditB = await instanceB.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_A },
        });
        expect(auditB.statusCode).toBe(200);
        const eventsB = auditB.json() as Array<{ id: string; sequence: number; kind: string; hash: string }>;
        // Restart-sourced: NOT empty, and matches instance A's persisted history exactly.
        expect(eventsB.length).toBe(eventsA.length);
        expect(eventsB.map((e) => e.sequence)).toEqual(eventsA.map((e) => e.sequence));
        expect(eventsB.map((e) => e.kind)).toEqual(eventsA.map((e) => e.kind));

        const verifyB = await instanceB.inject({
          method: "GET",
          url: "/api/governance/audit/verify",
          headers: { "x-workspace-id": WS_A },
        });
        expect(verifyB.statusCode).toBe(200);
        expect((verifyB.json() as { valid: boolean }).valid).toBe(true);

        // A post-restart mutation on instance B must CONTINUE the chain
        // (never re-flush the hydrated events, never reset sequence to 1)
        // and the chain must still verify true afterwards.
        const notifB = await instanceB.inject({
          method: "POST",
          url: "/api/notifications",
          headers: { "x-workspace-id": WS_A },
          payload: { subjectId: controlId },
        });
        expect(notifB.statusCode).toBe(201);

        const auditB2 = await instanceB.inject({
          method: "GET",
          url: "/api/governance/audit",
          headers: { "x-workspace-id": WS_A },
        });
        const eventsB2 = auditB2.json() as Array<{ sequence: number }>;
        expect(eventsB2.length).toBe(eventsB.length + 1);
        expect(eventsB2[eventsB2.length - 1]!.sequence).toBe(eventsB[eventsB.length - 1]!.sequence + 1);

        const verifyB2 = await instanceB.inject({
          method: "GET",
          url: "/api/governance/audit/verify",
          headers: { "x-workspace-id": WS_A },
        });
        expect((verifyB2.json() as { valid: boolean }).valid).toBe(true);
      },
      60_000,
    );

    it(
      "N-13 tamper case: corrupting a persisted audit_events row is detected as a broken chain by /audit/verify after a fresh hydrate-restart",
      async () => {
        const instanceA = await bootApp({ databaseUrl: DATABASE_URL });

        const authorizeA = await instanceA.inject({
          method: "POST",
          url: "/api/governance/authorize",
          headers: { "x-workspace-id": WS_TAMPER },
          payload: {
            command: "customer.send",
            resourceId: "customer-audit-tamper-1",
            resourceVersion: 1,
            payload: { message: "hi" },
            requesterPrincipalId: OPERATOR,
          },
        });
        expect(authorizeA.statusCode).toBe(201);

        const verifyBeforeTamper = await instanceA.inject({
          method: "GET",
          url: "/api/governance/audit/verify",
          headers: { "x-workspace-id": WS_TAMPER },
        });
        expect((verifyBeforeTamper.json() as { valid: boolean }).valid).toBe(true);

        // Directly corrupt the FIRST persisted audit_events row's payload
        // (out-of-band, bypassing the app entirely) — proves tamper-evidence
        // is a real property of the persisted hash chain, not something the
        // in-memory service merely assumes.
        const { Client } = (await import("pg")) as typeof import("pg");
        const client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
        try {
          await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
          try {
            await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_TAMPER]);
            await client.query(
              `UPDATE audit_events SET payload = jsonb_set(payload, '{data,tampered}', 'true') WHERE workspace_id = $1 AND sequence = 1`,
              [WS_TAMPER],
            );
          } finally {
            await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
          }
        } finally {
          await client.end();
        }

        // Fresh instance (simulated restart) hydrates the now-tampered chain.
        const instanceC = await bootApp({ databaseUrl: DATABASE_URL });
        const verifyAfterTamper = await instanceC.inject({
          method: "GET",
          url: "/api/governance/audit/verify",
          headers: { "x-workspace-id": WS_TAMPER },
        });
        expect(verifyAfterTamper.statusCode).toBe(200);
        expect((verifyAfterTamper.json() as { valid: boolean }).valid).toBe(false);
      },
      60_000,
    );

    it(
      "N-12: a customer created on instance A survives restart on instance B (GET /api/customers/:id/overview) and is cross-workspace denied",
      async () => {
        const instanceA = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const createRes = await instanceA.inject({
          method: "POST",
          url: "/api/customers",
          headers: { "x-workspace-id": WS_A },
          payload: {
            id: "customer-n12-livepg-1",
            name: "N-12 LivePG Customer",
            status: "active",
            createdAt: "2026-07-19T00:00:00.000Z",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const customer = createRes.json() as { id: string; workspaceId: string };
        expect(customer.id).toBe("customer-n12-livepg-1");

        const overviewA = await instanceA.inject({
          method: "GET",
          url: `/api/customers/${customer.id}/overview`,
          headers: { "x-workspace-id": WS_A },
        });
        expect(overviewA.statusCode).toBe(200);

        // --- Simulate restart: fresh instance B against the SAME DSN. ---
        const instanceB = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const overviewB = await instanceB.inject({
          method: "GET",
          url: `/api/customers/${customer.id}/overview`,
          headers: { "x-workspace-id": WS_A },
        });
        expect(overviewB.statusCode).toBe(200);
        const overviewBody = overviewB.json() as { customer: { id: string; name: string; workspaceId: string } };
        expect(overviewBody.customer.id).toBe(customer.id);
        expect(overviewBody.customer.name).toBe("N-12 LivePG Customer");
        expect(overviewBody.customer.workspaceId).toBe(WS_A);

        // Cross-workspace denial at the HTTP layer: WS_B must never see WS_A's customer.
        const overviewCrossWs = await instanceB.inject({
          method: "GET",
          url: `/api/customers/${customer.id}/overview`,
          headers: { "x-workspace-id": WS_B },
        });
        expect(overviewCrossWs.statusCode).not.toBe(200);

        // Cross-workspace denial under raw SET ROLE ai_crm_runtime_api
        // (NOBYPASSRLS): proves FORCE RLS itself denies the row, not just
        // an app-level WHERE clause.
        const { Client } = (await import("pg")) as typeof import("pg");
        const client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
        try {
          await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
          await client.query("BEGIN");
          try {
            await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
            await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);
            const rlsScoped = await client.query(`SELECT id FROM crm_customers`);
            expect((rlsScoped.rows as Array<{ id: string }>).some((r) => r.id === customer.id)).toBe(false);
          } finally {
            await client.query("COMMIT");
          }
        } finally {
          await client.end();
        }
      },
      60_000,
    );
  },
);
