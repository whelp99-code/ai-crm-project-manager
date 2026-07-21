import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * G-01 restart-consistent SoR against REAL PostgreSQL (not a mock pool).
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`, container
 * `ai-crmprojectmanager-postgres-1`) — override via `DATABASE_URL`.
 *
 * Applies migrations 0001..0004 idempotently by reusing
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same schema_migrations
 * tracking the ops smoke tooling uses), seeds a workspace row (FK target
 * for orch_jobs/orch_governance_* workspace_id), boots instance A against
 * the real DSN, creates a job + a CHECKPOINT-governed control through the
 * real HTTP surface (dual-write goes through real UPSERT SQL against
 * orch_jobs/orch_work_items/orch_job_events and
 * orch_governance_controls/orch_governance_intents under FORCE RLS), then
 * boots a fresh instance B against the SAME DSN (simulated process
 * restart) and asserts hydrate-on-boot reads the same data back from real
 * Postgres — not a mock.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OPERATOR = "operator-restart-livepg";
const JOB_IDEMPOTENCY_KEY = "idem-restart-livepg-1";

function headers(extra: Record<string, string> = {}) {
  return {
    "x-workspace-id": WS_ID,
    "x-principal-id": OPERATOR,
    ...extra,
  };
}

function planClient(steps: Array<Record<string, unknown>>): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: steps.map((step) => {
            const {
              suggestedCommand,
              title = "step",
              resourceType = "",
              resourceId = "",
              resourceVersion = 1,
              payload = {},
            } = step;
            return {
              suggestedCommand,
              title,
              resourceType,
              resourceId,
              resourceVersion,
              payloadJson: JSON.stringify(payload ?? {}),
            };
          }),
        },
        modelVersion: "test-plan-livepg",
        retentionHonored: true,
      };
    },
  };
}

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)("G-01 SoR restart-consistency: hydrate-on-boot against REAL Postgres (LIVE_PG_TEST=1)", () => {
  let jobId: string | undefined;
  let controlId: string | undefined;

  beforeAll(async () => {
    // Apply 0001..0004 idempotently via the same schema_migrations-tracked
    // script the ops RLS smoke doc uses; also refuses non ai_crm targets.
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
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_ID, "sor-restart-livepg"],
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
      // N-08 / D3: authorize/decide dual-write audit_events/audit_chain_heads
      // /outbox_events too now, and both reference workspaces via a plain FK
      // (no ON DELETE CASCADE) — audit_events/audit_chain_heads are also
      // append-only / no-delete by trigger even for the superuser session.
      // Disable the two triggers for this teardown connection only, delete
      // the fixtures (including audit/outbox so the workspace FK is clear),
      // then restore them.
      await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
      await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
      try {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_ID]);
        await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM orch_job_events WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM orch_work_items WHERE workspace_id = $1`, [WS_ID]);
        await client.query(`DELETE FROM orch_jobs WHERE workspace_id = $1`, [WS_ID]);
        // PG-B wiring (P6-b G001) now dual-writes this test's POST
        // /api/pm/plans call for real; clean it up too or the workspaces FK
        // delete below fails.
        await client.query(`DELETE FROM pm_plans WHERE workspace_id = $1`, [WS_ID]);
      } finally {
        await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [WS_ID]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "instance A dual-writes to real Postgres; a freshly booted instance B hydrates the same job + control from real Postgres",
    async () => {
      const instanceA = await bootApp({
        databaseUrl: DATABASE_URL,
        modelClient: planClient([
          {
            suggestedCommand: "pm.task_assign",
            title: "Assign task",
            resourceId: "task-restart-livepg-1",
            resourceVersion: 1,
            payload: {
              projectId: "proj-restart-livepg",
              planId: "plan-restart-livepg",
              taskId: "task-restart-livepg-1",
              assigneePrincipalId: "worker-restart-livepg",
            },
          },
        ]),
      });
      expect((instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const planRes = await instanceA.inject({
        method: "POST",
        url: "/api/pm/plans",
        headers: { "x-workspace-id": WS_ID },
        payload: {
          id: "plan-restart-livepg",
          projectId: "proj-restart-livepg",
          objective: "restart survival against real postgres",
          taskIds: ["task-restart-livepg-1"],
          createdByPrincipalId: OPERATOR,
          createdAt: "2026-07-19T00:00:00.000Z",
        },
      });
      expect(planRes.statusCode).toBe(201);

      const created = await instanceA.inject({
        method: "POST",
        url: "/api/agent/commands",
        headers: headers({ "idempotency-key": JOB_IDEMPOTENCY_KEY }),
        payload: { text: "assign task across restart against real postgres" },
      });
      expect(created.statusCode).toBe(202);
      ({ jobId } = created.json() as { jobId: string });
      expect(jobId).toBeTruthy();

      const beforeRestart = await instanceA.inject({
        method: "GET",
        url: `/api/agent/jobs/${jobId}`,
        headers: { "x-workspace-id": WS_ID },
      });
      expect(beforeRestart.statusCode).toBe(200);
      const beforeSnapshot = beforeRestart.json() as {
        job: { id: string; status: string };
        workItems: Array<{ id: string; controlId?: string; suggestedCommand?: string }>;
      };
      expect(beforeSnapshot.job.id).toBe(jobId);
      controlId = beforeSnapshot.workItems[0]?.controlId;
      expect(controlId).toBeTruthy();

      const controlsBefore = await instanceA.inject({
        method: "GET",
        url: "/api/governance/controls",
        headers: { "x-workspace-id": WS_ID },
      });
      expect(controlsBefore.statusCode).toBe(200);
      expect((controlsBefore.json() as Array<{ id: string }>).some((c) => c.id === controlId)).toBe(true);

      // --- Simulate restart: construct instance B fresh, against the SAME real DSN. ---
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL });
      expect((instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe(
        "pg",
      );

      const afterRestart = await instanceB.inject({
        method: "GET",
        url: `/api/agent/jobs/${jobId}`,
        headers: { "x-workspace-id": WS_ID },
      });
      expect(afterRestart.statusCode).toBe(200);
      const afterSnapshot = afterRestart.json() as {
        job: { id: string; status: string };
        workItems: Array<{ id: string; controlId?: string }>;
      };
      expect(afterSnapshot.job.id).toBe(jobId);
      expect(afterSnapshot.workItems).toHaveLength(beforeSnapshot.workItems.length);
      expect(afterSnapshot.workItems[0]?.id).toBe(beforeSnapshot.workItems[0]?.id);

      const controlsAfter = await instanceB.inject({
        method: "GET",
        url: "/api/governance/controls",
        headers: { "x-workspace-id": WS_ID },
      });
      expect(controlsAfter.statusCode).toBe(200);
      expect((controlsAfter.json() as Array<{ id: string }>).some((c) => c.id === controlId)).toBe(true);
    },
    60_000,
  );
});
