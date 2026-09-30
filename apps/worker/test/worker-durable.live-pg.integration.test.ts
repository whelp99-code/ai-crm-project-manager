import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
  intentToPersisted,
} from "@ai-crm/governance";
import { loadGovernance, runDurableWorkerTick } from "../src/main.js";

/**
 * G-02 worker lease recovery against REAL PostgreSQL (not the in-memory
 * repo fake used by worker-durable.integration.test.ts).
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Mirrors apps/api/test/sor-restart-livepg.integration.test.ts's
 * migration bootstrap + workspace seed pattern.
 */
const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const registry = new ActionRegistry({ updateCustomer: "INTERNAL_REVERSIBLE_UPDATE" });

const authorizeRequest = {
  command: "updateCustomer",
  workspaceId: WS_ID,
  resourceId: "customer-livepg-1",
  resourceVersion: 1,
  payload: { note: "worker-durable-livepg" },
  requesterPrincipalId: "seed-service-livepg",
};

describe.skipIf(!LIVE)("G-02 worker durable lease recovery against REAL Postgres (LIVE_PG_TEST=1)", () => {
  let intentId: string | undefined;

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
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_ID, "worker-durable-livepg"],
      );
    } finally {
      await client.end();
    }
  }, 60_000);

  afterAll(async () => {
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [WS_ID]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "seeds a LEASED intent with an expired deadline into real Postgres, recovers it via a hydrated worker runtime, and durably reflects QUEUED",
    async () => {
      // 1. Seed a LEASED intent with an already-past deadline directly into
      //    real Postgres via a throwaway seeding runtime (stands in for a
      //    prior worker/API process that leased, then crashed).
      const seedRuntime = await loadGovernance({ DATABASE_URL });
      expect(seedRuntime.govRepo).toBeDefined();
      // Empty-registry runtime.governance can't authorize "updateCustomer";
      // use a separate governance instance with the real registry for the
      // authorize/lease step, then persist through the real DSN's govRepo.
      const seedGovernance = new GovernanceAuthorizationService(registry);
      const seeded = seedGovernance.authorize(authorizeRequest);
      intentId = seeded.intent!.id;
      const lease = seedGovernance.leaseIntent(
        intentId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:00.000Z",
      );
      expect(lease.status).toBe("LEASED");
      await seedRuntime.govRepo!.saveIntent(
        intentToPersisted(seedGovernance.getIntent(WS_ID, intentId)),
      );
      await seedRuntime.closePool();

      const seededDirect = await directLoadIntent(intentId);
      expect(seededDirect?.status).toBe("LEASED");

      // 2. Simulated worker restart: fresh runtime hydrated from the SAME
      //    real DSN, past the lease deadline.
      const workerRuntime = await loadGovernance({ DATABASE_URL });
      expect(workerRuntime.govRepo).toBeDefined();
      expect(workerRuntime.governance.getIntent(WS_ID, intentId).status).toBe("LEASED");

      const result = await runDurableWorkerTick(workerRuntime, "2026-01-01T00:05:00.000Z");
      expect(result.recoveredLeases).toHaveLength(1);
      expect(result.recoveredLeases[0]?.id).toBe(intentId);
      expect(result.recoveredLeases[0]?.status).toBe("QUEUED");
      await workerRuntime.closePool();

      // 3. Durability proof: reload straight from real Postgres via a fresh
      //    plain client — not the worker's in-process governance instance.
      const reloaded = await directLoadIntent(intentId);
      expect(reloaded?.status).toBe("QUEUED");
      expect(reloaded?.lease_deadline).toBeNull();

      // 4. Restart survival: a third fresh runtime hydrated again from the
      //    same real DSN also sees QUEUED.
      const restartedRuntime = await loadGovernance({ DATABASE_URL });
      expect(restartedRuntime.governance.getIntent(WS_ID, intentId).status).toBe("QUEUED");
      await restartedRuntime.closePool();
    },
    60_000,
  );

  async function directLoadIntent(
    id: string,
  ): Promise<{ status: string; lease_deadline: string | null } | undefined> {
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT status, lease_deadline FROM orch_governance_intents WHERE workspace_id = $1 AND id = $2`,
        [WS_ID, id],
      );
      return result.rows[0] as { status: string; lease_deadline: string | null } | undefined;
    } finally {
      await client.end();
    }
  }
});
