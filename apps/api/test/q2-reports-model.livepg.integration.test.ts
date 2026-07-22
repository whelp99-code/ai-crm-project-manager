import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { ModelClient } from "@ai-crm/model-gateway";

/**
 * Q2 (D2) — reports (final-report snapshots) + model-gateway (MODEL_INVOKE
 * audit trail) PG proof. Mirrors the N-12/N-13/PG-A livepg acceptance shape:
 * finalize/invoke on instance A -> fresh instance B hydrates from PG ->
 * GET on B reflects it (restart survival) + cross-workspace denial.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0011 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as the other livepg
 * suites), which also opens the `ai_crm_runtime_model_gateway` role
 * membership this suite's dev DSN needs to write `model_invocations`.
 *
 * report_snapshots: `snapshot`/`snapshotHash` are asserted byte-identical
 * across the restart (immutable round-trip) — hydrate never recomputes the
 * hash, it is stored/read back verbatim (see pg-reports-adapter.ts).
 *
 * model_invocations: ADR-010 disjoint-principal boundary — `createApp`
 * opens a SEPARATE pool for this table (falls back to the same dev DSN,
 * same bootstrap-superuser-bypasses-RLS caveat as `adminDatabaseUrl`); the
 * shared `ai_crm_runtime_api` pool never touches it (see
 * CreateAppOptions.modelGatewayDatabaseUrl doc in app.ts).
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_A = "88888888-8888-8888-8888-888888888888";
const WS_B = "99999999-9999-9999-9999-999999999999";
const REPORT_ID = "report-q2-livepg-1";
const MODEL_SERVICE_PRINCIPAL = "principal-model-gateway";

const OUTPUT_SCHEMA = {
  schemaVersion: "risk.v1",
  root: { kind: "object", fields: { riskLevel: { kind: "enum", values: ["low", "medium", "high"] } } },
};

/** Deterministic, network-free `ModelClient` — never calls a real provider. */
const deterministicModelClient: ModelClient = {
  async invoke() {
    return { structuredOutput: { riskLevel: "medium" }, modelVersion: "q2-livepg-model-v1", retentionHonored: true };
  },
};

function validSnapshot() {
  return {
    goalVsResult: { goal: "Ship Q2 slice", result: "Shipped on schedule", met: true },
    deliverables: [{ deliverableId: "d-q2-1", title: "PG reports adapter", state: "approved", accepted: true }],
    scheduleVariance: { planned: 10, actual: 11, variance: 1 },
    scopeVariance: { planned: 5, actual: 5, variance: 0 },
    costVariance: { planned: 500, actual: 480, variance: -20 },
    riskVariance: { materializedRiskIds: [], figure: { planned: 1, actual: 0, variance: -1 } },
    financialImpact: { revenueKrw: "1000000", costKrw: "700000", profitabilityKrw: "300000", asOf: "2026-07-20" },
    aiActionHistory: [
      { at: "2026-07-18T09:00:00Z", principalId: "ai-planner", kind: "plan", summary: "planned Q2 slice" },
      { at: "2026-07-19T09:00:00Z", principalId: "ai-executor", kind: "execute", summary: "executed Q2 slice" },
    ],
    exceptions: [],
    evidenceLinks: [{ claim: "restart survival proof", objectKey: "reports/q2/evidence.csv", version: "v1", digest: "sha256:q2evidence" }],
  };
}

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)("Q2 reports + model-gateway PG-primary against REAL Postgres (LIVE_PG_TEST=1)", () => {
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
        [WS_A, "q2-livepg-a", WS_B, "q2-livepg-b"],
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
      await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
      await client.query(`GRANT ai_crm_runtime_model_gateway TO CURRENT_USER`);
      await client.query(`ALTER TABLE report_snapshots DISABLE TRIGGER report_snapshots_immutability`);
      for (const ws of [WS_A, WS_B]) {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
        await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
        await client.query(`DELETE FROM report_snapshots WHERE workspace_id = $1`, [ws]);
        await client.query(`RESET ROLE`);
        await client.query(`SET LOCAL ROLE ai_crm_runtime_model_gateway`);
        await client.query(`DELETE FROM model_invocations WHERE workspace_id = $1`, [ws]);
        await client.query(`RESET ROLE`);
      }
      await client.query(`ALTER TABLE report_snapshots ENABLE TRIGGER report_snapshots_immutability`);
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "report snapshot: finalize on A -> fresh B hydrates -> GET reflects it, hash IDENTICAL, cross-ws denied",
    async () => {
      const instanceA = await bootApp({ databaseUrl: DATABASE_URL, modelClient: deterministicModelClient });
      expect((instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const submit = await instanceA.inject({
        method: "POST",
        url: "/api/reports",
        headers: { "x-workspace-id": WS_A },
        payload: {
          id: REPORT_ID,
          projectId: "project-q2-livepg",
          submittedByPrincipalId: "ai-submitter",
          submittedAt: "2026-07-20T10:00:00.000Z",
          snapshot: validSnapshot(),
        },
      });
      expect(submit.statusCode).toBe(201);
      const submitted = submit.json() as { id: string; snapshotHash: string };
      expect(submitted.id).toBe(REPORT_ID);

      // --- Simulate restart: fresh instance B against the SAME DSN. ---
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL, modelClient: deterministicModelClient });
      expect((instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const getOnB = await instanceB.inject({
        method: "GET",
        url: `/api/reports/${REPORT_ID}`,
        headers: { "x-workspace-id": WS_A },
      });
      expect(getOnB.statusCode).toBe(200);
      const hydrated = getOnB.json() as { id: string; snapshotHash: string; snapshot: unknown };
      // Restart-sourced: fresh instance B never called POST /api/reports itself,
      // so this can only reflect hydrate-on-boot reading report_snapshots back
      // from PG. The hash must round-trip byte-identical (immutable snapshot).
      expect(hydrated.id).toBe(REPORT_ID);
      expect(hydrated.snapshotHash).toBe(submitted.snapshotHash);
      expect(hydrated.snapshot).toEqual(validSnapshot());

      const immutableB = await instanceB.inject({
        method: "GET",
        url: `/api/reports/${REPORT_ID}/immutable`,
        headers: { "x-workspace-id": WS_A },
      });
      expect(immutableB.json()).toEqual({ immutable: true });

      // Cross-workspace denial: WS_B can never see WS_A's report.
      const crossWs = await instanceB.inject({
        method: "GET",
        url: `/api/reports/${REPORT_ID}`,
        headers: { "x-workspace-id": WS_B },
      });
      expect(crossWs.statusCode).toBe(400);
      expect(crossWs.json()).toMatchObject({ error: "CROSS_WORKSPACE" });
    },
    60_000,
  );

  it(
    "model invocation: MODEL_INVOKE on A -> fresh B hydrates -> GET /api/model/invocations reflects it, cross-ws denied",
    async () => {
      const instanceA = await bootApp({ databaseUrl: DATABASE_URL, modelClient: deterministicModelClient });
      expect((instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const invoke = await instanceA.inject({
        method: "POST",
        url: "/api/model/invoke",
        headers: { "x-workspace-id": WS_A },
        payload: {
          operationId: "op.risk.q2",
          principalId: MODEL_SERVICE_PRINCIPAL,
          promptVersion: "v1",
          modelVersion: "q2-livepg-model-v1",
          prompt: "assess q2 livepg risk",
          outputSchema: OUTPUT_SCHEMA,
          correlationId: "corr-q2-livepg-1",
        },
      });
      expect(invoke.statusCode).toBe(201);
      const invoked = invoke.json() as { invocation: { id: string; principalId: string; modelVersion: string } };
      expect(invoked.invocation.principalId).toBe(MODEL_SERVICE_PRINCIPAL);

      // --- Simulate restart: fresh instance B against the SAME DSN. ---
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL, modelClient: deterministicModelClient });
      expect((instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const listOnB = await instanceB.inject({
        method: "GET",
        url: "/api/model/invocations",
        headers: { "x-workspace-id": WS_A },
      });
      expect(listOnB.statusCode).toBe(200);
      const invocationsB = listOnB.json() as Array<{ id: string; principalId: string; modelVersion: string }>;
      // Restart-sourced: fresh instance B never called POST /api/model/invoke
      // itself, so this can only reflect hydrate-on-boot reading
      // model_invocations back from PG (via the ADR-010-scoped pool).
      const hydratedInvocation = invocationsB.find((r) => r.id === invoked.invocation.id);
      expect(hydratedInvocation).toBeDefined();
      expect(hydratedInvocation?.principalId).toBe(MODEL_SERVICE_PRINCIPAL);
      expect(hydratedInvocation?.modelVersion).toBe("q2-livepg-model-v1");

      // Cross-workspace denial: WS_B never sees WS_A's invocation.
      const crossWsList = await instanceB.inject({
        method: "GET",
        url: "/api/model/invocations",
        headers: { "x-workspace-id": WS_B },
      });
      expect(crossWsList.statusCode).toBe(200);
      const crossWsInvocations = crossWsList.json() as Array<{ id: string }>;
      expect(crossWsInvocations.some((r) => r.id === invoked.invocation.id)).toBe(false);
    },
    60_000,
  );
});
