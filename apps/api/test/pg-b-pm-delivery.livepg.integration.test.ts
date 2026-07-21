import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgPmRepository,
  type PgQueryable,
  type PmRepository,
} from "../../../packages/domain/src/pg-pm-adapter.js";
import type { PmPlan, PmAssignment, PmTarget, TargetObservation, VarianceException } from "../../../packages/domain/src/pm.js";
import type { DeliveryProject } from "../../../packages/domain/src/delivery.js";

/**
 * Ultragoal P6-b G001 / PG-B (PM + delivery) acceptance against REAL
 * PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`.
 *
 * Applies migrations 0001..0006 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as the other livepg
 * suites), THEN applies 0008_pm_delivery.sql directly here (idempotent
 * `to_regclass` probe) since the leader has not yet wired 0007/0008/0009/
 * 0010 into the shared smoke script's `apply_migrations()` — see
 * /tmp/pgb-wiring-diff.md for the pending smoke-script integration.
 *
 * Proves, at the `PmRepository` layer (mirrors `n08-pg-primary.livepg`'s
 * direct-repository style, since app.ts is not yet wired with PG-B routes
 * by this slice — see the wiring diff):
 *  - restart-survival per aggregate: save via one repository instance
 *    (simulated process A), read back via a FRESH repository instance
 *    against the SAME pool (simulated process B / restart) and assert
 *    exact equality — including a plan WITH multiple `revisions[]` entries
 *    and a delivery project WITH `deliverables[]`/`tasks[]`/`risks[]`/
 *    `requirementIds[]`, proving the jsonb round-trip is exact, not just
 *    "non-empty".
 *  - cross-workspace denial under raw `SET ROLE ai_crm_runtime_api`
 *    (NOBYPASSRLS): workspace B never sees workspace A's rows even when
 *    physically querying the full table, proving FORCE RLS itself denies
 *    the row.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const migration0008 = join(repoRoot, "packages/persistence/migrations/0008_pm_delivery.sql");

const WS_A = "55555555-5555-5555-5555-555555555555";
const WS_B = "66666666-6666-6666-6666-666666666666";

/**
 * Minimal real-`pg.Pool`-backed `PgQueryable` implementing
 * `withWorkspaceScope` the same way `apps/api/src/app.ts`'s
 * `createScopedPgQueryable` does (single checked-out connection, `BEGIN`,
 * parameterized `set_config('app.workspace_id', $1, true)`, `COMMIT`).
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

let pool: import("pg").Pool | undefined;

describe.skipIf(!LIVE)("PG-B PM + delivery PG-primary + restart-survival against REAL Postgres (LIVE_PG_TEST=1)", () => {
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

    const { Client, Pool } = (await import("pg")) as typeof import("pg");

    // Apply 0008_pm_delivery.sql idempotently (not yet wired into the
    // shared smoke script by the leader — see module doc comment).
    const probe = new Client({ connectionString: DATABASE_URL });
    await probe.connect();
    try {
      const { rows } = await probe.query<{ present: boolean }>(
        `SELECT to_regclass('public.pm_plans') IS NOT NULL AS present`,
      );
      if (!rows[0]?.present) {
        const sql = readFileSync(migration0008, "utf8");
        await probe.query(sql);
      }
    } finally {
      await probe.end();
    }

    const seed = new Client({ connectionString: DATABASE_URL });
    await seed.connect();
    try {
      await seed.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "pg-b-livepg-a", WS_B, "pg-b-livepg-b"],
      );
    } finally {
      await seed.end();
    }

    pool = new Pool({ connectionString: DATABASE_URL });
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      const cleanup = new (await import("pg")).Client({ connectionString: DATABASE_URL });
      await cleanup.connect();
      try {
        for (const ws of [WS_A, WS_B]) {
          await cleanup.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await cleanup.query(`DELETE FROM pm_variance_exceptions WHERE workspace_id = $1`, [ws]);
          await cleanup.query(`DELETE FROM pm_target_observations WHERE workspace_id = $1`, [ws]);
          await cleanup.query(`DELETE FROM pm_targets WHERE workspace_id = $1`, [ws]);
          await cleanup.query(`DELETE FROM pm_assignments WHERE workspace_id = $1`, [ws]);
          await cleanup.query(`DELETE FROM pm_plans WHERE workspace_id = $1`, [ws]);
          await cleanup.query(`DELETE FROM delivery_projects WHERE workspace_id = $1`, [ws]);
        }
        await cleanup.query(`RESET app.workspace_id`);
        await cleanup.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
      } finally {
        await cleanup.end();
      }
      await pool.end();
    }
  }, 60_000);

  it(
    "restart-survival: a plan WITH revisions[], a target+observation+exception, an assignment, and a delivery project WITH deliverables/tasks/risks/requirementIds all round-trip exactly through a FRESH repository instance against the same pool",
    async () => {
      if (!pool) throw new Error("pool not initialized");
      const repoA: PmRepository = createPgPmRepository(scopedQueryableFromPool(pool));

      const plan: PmPlan = {
        id: "pgb-plan-1",
        workspaceId: WS_A,
        projectId: "pgb-project-1",
        version: 2,
        revisions: [
          { revision: 1, objective: "kickoff", taskIds: ["task-1", "task-2"], createdByPrincipalId: "pm-1", createdAt: "2026-07-01T00:00:00.000Z" },
          { revision: 2, objective: "replan", taskIds: ["task-1", "task-2", "task-3"], createdByPrincipalId: "pm-1", createdAt: "2026-07-05T00:00:00.000Z" },
        ],
      };
      await repoA.savePlan(plan);

      const assignment: PmAssignment = {
        id: "pgb-assignment-1",
        workspaceId: WS_A,
        projectId: "pgb-project-1",
        planId: "pgb-plan-1",
        taskId: "task-1",
        assigneePrincipalId: "engineer-1",
        assignedByPrincipalId: "pm-1",
        status: "active",
        createdAt: "2026-07-02T00:00:00.000Z",
      };
      await repoA.saveAssignment(assignment);

      const target: PmTarget = {
        id: "pgb-target-1",
        workspaceId: WS_A,
        projectId: "pgb-project-1",
        metric: "schedule",
        target: 10,
        tolerance: 2,
        direction: "max",
        version: 1,
      };
      await repoA.saveTarget(target);

      const observation: TargetObservation = {
        id: "pgb-observation-1",
        workspaceId: WS_A,
        projectId: "pgb-project-1",
        targetId: "pgb-target-1",
        actual: 15,
        observedAt: "2026-07-06T00:00:00.000Z",
        evidenceRef: "evidence-1",
      };
      await repoA.saveObservation(observation);

      const exception: VarianceException = {
        id: "pgb-exception-1",
        workspaceId: WS_A,
        projectId: "pgb-project-1",
        targetId: "pgb-target-1",
        metric: "schedule",
        target: 10,
        actual: 15,
        variance: 5,
        severity: "high",
        evidenceRef: "evidence-1",
      };
      await repoA.saveException(exception);

      const project: DeliveryProject = {
        id: "pgb-delivery-1",
        workspaceId: WS_A,
        customerId: "customer-1",
        name: "PG-B LivePG Project",
        contractId: "contract-1",
        contractScope: "full",
        scheduleStart: "2026-07-01",
        scheduleEnd: "2026-12-31",
        deliverables: [
          { id: "deliverable-1", title: "Design doc", required: true, status: "approved", requirementIds: ["req-1"] },
          { id: "deliverable-2", title: "Build", required: true, status: "pending", requirementIds: ["req-2"] },
        ],
        completionRule: "all_required_deliverables_approved",
        riskThreshold: 0.3,
        tasks: [
          { id: "task-1", title: "Design", status: "done", requirementIds: ["req-1"], deliverableId: "deliverable-1" },
          { id: "task-2", title: "Implement", status: "in_progress", requirementIds: ["req-2"] },
        ],
        requirementIds: ["req-1", "req-2"],
        risks: [{ id: "risk-1", title: "Vendor delay", probability: 0.2, impact: 0.5, status: "open" }],
        status: "active",
        version: 3,
      };
      await repoA.saveProject(project);

      // --- Simulate restart: FRESH repository instance against the SAME pool. ---
      const repoB: PmRepository = createPgPmRepository(scopedQueryableFromPool(pool));

      const plansB = await repoB.getPlansForWorkspace(WS_A);
      expect(plansB).toHaveLength(1);
      expect(plansB[0]).toEqual(plan);

      const assignmentsB = await repoB.getAssignmentsForWorkspace(WS_A);
      expect(assignmentsB).toHaveLength(1);
      expect(assignmentsB[0]).toEqual(assignment);

      const targetsB = await repoB.getTargetsForWorkspace(WS_A);
      expect(targetsB).toHaveLength(1);
      expect(targetsB[0]).toEqual(target);

      const observationsB = await repoB.getObservationsForWorkspace(WS_A);
      expect(observationsB).toHaveLength(1);
      expect(observationsB[0]).toEqual(observation);

      const exceptionsB = await repoB.getExceptionsForWorkspace(WS_A);
      expect(exceptionsB).toHaveLength(1);
      expect(exceptionsB[0]).toEqual(exception);

      const projectsB = await repoB.getProjectsForWorkspace(WS_A);
      expect(projectsB).toHaveLength(1);
      expect(projectsB[0]).toEqual(project);

      // Hydrate-on-boot admin path (listAll*) also reflects every aggregate.
      expect((await repoB.listAllPlans()).some((p) => p.id === plan.id)).toBe(true);
      expect((await repoB.listAllAssignments()).some((a) => a.id === assignment.id)).toBe(true);
      expect((await repoB.listAllTargets()).some((t) => t.id === target.id)).toBe(true);
      expect((await repoB.listAllObservations()).some((o) => o.id === observation.id)).toBe(true);
      expect((await repoB.listAllExceptions()).some((e) => e.id === exception.id)).toBe(true);
      expect((await repoB.listAllProjects()).some((p) => p.id === project.id)).toBe(true);
    },
    60_000,
  );

  it(
    "cross-workspace denial: workspace B never sees workspace A's pm_plans/delivery_projects rows under raw SET ROLE ai_crm_runtime_api (NOBYPASSRLS)",
    async () => {
      if (!pool) throw new Error("pool not initialized");
      const repo: PmRepository = createPgPmRepository(scopedQueryableFromPool(pool));

      await repo.savePlan({
        id: "pgb-plan-cross-1",
        workspaceId: WS_A,
        projectId: "pgb-project-cross-1",
        version: 1,
        revisions: [{ revision: 1, objective: "cross-ws", taskIds: [], createdByPrincipalId: "pm-1", createdAt: "2026-07-01T00:00:00.000Z" }],
      });
      await repo.saveProject({
        id: "pgb-delivery-cross-1",
        workspaceId: WS_A,
        customerId: "customer-cross-1",
        name: "Cross-WS Project",
        contractId: "contract-cross-1",
        contractScope: "full",
        scheduleStart: "2026-07-01",
        scheduleEnd: "2026-12-31",
        deliverables: [{ id: "deliverable-cross-1", title: "Doc", required: true, status: "pending", requirementIds: [] }],
        completionRule: "all_required_deliverables_approved",
        riskThreshold: 0.5,
        tasks: [],
        requirementIds: [],
        risks: [],
        status: "active",
        version: 1,
      });

      const { Client } = (await import("pg")) as typeof import("pg");
      const client = new Client({ connectionString: DATABASE_URL });
      await client.connect();
      try {
        await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
          await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);
          const plansScoped = await client.query(`SELECT id FROM pm_plans`);
          expect((plansScoped.rows as Array<{ id: string }>).some((r) => r.id === "pgb-plan-cross-1")).toBe(false);
          const projectsScoped = await client.query(`SELECT id FROM delivery_projects`);
          expect((projectsScoped.rows as Array<{ id: string }>).some((r) => r.id === "pgb-delivery-cross-1")).toBe(false);
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
