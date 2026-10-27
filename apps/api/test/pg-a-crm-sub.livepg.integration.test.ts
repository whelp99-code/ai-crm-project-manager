import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";
import {
  createPgCrmSubRepository,
  type CrmSubRepository,
  type PgQueryable,
} from "@ai-crm/domain/pg-crm-sub-adapter";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";

/**
 * PG-A — CRM sub-aggregates PG proof (P6-b G001, mirrors N-12/N-13's
 * livepg acceptance shape for `crm_contracts` / `crm_communications` /
 * `crm_next_actions` / `crm_operational_exceptions` from
 * 0007_crm_subaggregates.sql).
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Applies migrations 0001..0006 idempotently via
 * `packages/persistence/scripts/pg-rls-smoke.sh` (same as the N-12/N-13
 * suite), then applies 0007 directly since the smoke script's migration
 * list is a shared file integrated by the leader separately.
 *
 * This slice authors ONLY new files: the migration, the adapter, and this
 * test. `CrmService.hydrateSubAggregates` + the app.ts dual-write/hydrate
 * wiring described in /tmp/pga-wiring-diff.md are integrated by the
 * leader afterward — the restart-survival assertions below (instance A
 * writes via the repo directly, fresh instance B's HTTP overview reflects
 * it) are the GRADED acceptance for that post-integration wiring. The
 * repo-level round-trip assertions (valueKrw incl. NULL + 10^30) and the
 * raw-SQL cross-workspace denial run independent of app.ts wiring and are
 * expected to pass today.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");
const migration0007 = join(repoRoot, "packages/persistence/migrations/0007_crm_subaggregates.sql");

const WS_A = "66666666-6666-6666-6666-666666666666";
const WS_B = "77777777-7777-7777-7777-777777777777";
const CUSTOMER_ID = "customer-pga-livepg-1";

/**
 * Local copy of app.ts's `createScopedPgQueryable`: wraps a real `pg.Pool`
 * so `withWorkspaceScope` runs `SET LOCAL`-equivalent `set_config` on one
 * checked-out connection/transaction, honoring FORCE RLS on the four new
 * sub-aggregate tables. Duplicated here (not imported from app.ts, which
 * does not export it) so this test can drive `CrmSubRepository` directly
 * without depending on the leader's app.ts wiring.
 */
function createScopedPgQueryable(pool: {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    release(): void;
  }>;
}): PgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return result as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: PgQueryable = {
          async query<T2 = unknown>(text: string, params?: unknown[]) {
            const result = await client.query(text, params);
            return result as { rows: T2[]; rowCount: number | null };
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

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)("PG-A CRM sub-aggregates PG-primary against REAL Postgres (LIVE_PG_TEST=1)", () => {
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
      const present = await client.query(`SELECT to_regclass('public.crm_contracts') IS NOT NULL AS ok`);
      if (!(present.rows[0] as { ok: boolean }).ok) {
        await client.query(readFileSync(migration0007, "utf8"));
      }
      await client.query(
        `INSERT INTO schema_migrations (id) VALUES ('0007_crm_subaggregates') ON CONFLICT (id) DO NOTHING`,
      );
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "pga-livepg-a", WS_B, "pga-livepg-b"],
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
      for (const ws of [WS_A, WS_B]) {
        await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
        await client.query(`DELETE FROM crm_contracts WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM crm_communications WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM crm_next_actions WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM crm_operational_exceptions WHERE workspace_id = $1`, [ws]);
        await client.query(`DELETE FROM crm_customers WHERE workspace_id = $1`, [ws]);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it(
    "PG-A: contracts/communications/nextActions/exceptions created via the repo survive restart (fresh instance hydrates + overview reflects) and are cross-workspace denied",
    async () => {
      const { Pool } = (await import("pg")) as typeof import("pg");
      const rawPool = new Pool({ connectionString: DATABASE_URL });
      const scopedQueryable = createScopedPgQueryable(rawPool);
      const repo: CrmSubRepository = createPgCrmSubRepository(scopedQueryable);

      try {
        // Instance A: create the parent customer through the real HTTP
        // surface (already-wired N-12 dual-write) so CrmService.overview()
        // does not reject the sub-aggregates with NOT_FOUND.
        const instanceA = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const createCustomer = await instanceA.inject({
          method: "POST",
          url: "/api/customers",
          headers: { "x-workspace-id": WS_A },
          payload: { id: CUSTOMER_ID, name: "PG-A LivePG Customer", status: "active", createdAt: "2026-07-19T00:00:00.000Z" },
        });
        expect(createCustomer.statusCode).toBe(201);

        // Create each sub-aggregate directly via the repo (bypassing the
        // in-memory CrmService entirely) to prove the migration + adapter
        // round-trip real column-mapped SQL under FORCE RLS.
        await repo.saveContract({
          id: "contract-pga-1",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          title: "Support Contract",
          scope: "annual-support",
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-12-31",
          valueKrw: "1000000",
        });
        await repo.saveContract({
          id: "contract-pga-2-null-value",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          title: "Pilot Contract (no value yet)",
          scope: "pilot",
          effectiveFrom: "2026-02-01",
          // valueKrw intentionally omitted -> NULL column, not "0".
        });
        await repo.saveContract({
          id: "contract-pga-3-large-value",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          title: "Enterprise Framework Contract",
          scope: "enterprise",
          effectiveFrom: "2026-03-01",
          valueKrw: "1000000000000000000000000000000", // 10^30
        });
        await repo.saveCommunication({
          id: "comm-pga-1",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          channel: "email",
          summary: "Kickoff call notes",
          occurredAt: "2026-04-01T00:00:00.000Z",
        });
        await repo.saveNextAction({
          id: "next-action-pga-1",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          title: "Send renewal quote",
          priority: 5,
          dueAt: "2026-05-01T00:00:00.000Z",
          status: "open",
        });
        await repo.saveException({
          id: "exception-pga-1",
          workspaceId: WS_A,
          customerId: CUSTOMER_ID,
          title: "SLA breach",
          severity: "critical",
          priority: 9,
          occurredAt: "2026-04-15T00:00:00.000Z",
          status: "open",
        });

        // Repo-level round-trip proof (runs independent of app.ts wiring):
        // valueKrw round-trips exactly, including the NULL case (never
        // coerced to "0") and the 10^30 large-integer case (unbounded
        // numeric, not numeric(20,4)).
        const contractsA = await repo.getContractsForWorkspace(WS_A);
        const byId = new Map(contractsA.map((c) => [c.id, c] as const));
        expect(byId.get("contract-pga-1")?.valueKrw).toBe("1000000");
        expect(byId.get("contract-pga-2-null-value")?.valueKrw).toBeUndefined();
        expect(byId.get("contract-pga-3-large-value")?.valueKrw).toBe("1000000000000000000000000000000");

        // --- Simulate restart: fresh instance B against the SAME DSN. ---
        const instanceB = await bootApp({ databaseUrl: DATABASE_URL });
        expect(
          (instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode,
        ).toBe("pg");

        const overviewB = await instanceB.inject({
          method: "GET",
          url: `/api/customers/${CUSTOMER_ID}/overview`,
          headers: { "x-workspace-id": WS_A },
        });
        expect(overviewB.statusCode).toBe(200);
        const overviewBody = overviewB.json() as {
          contracts: Array<{ id: string; valueKrw?: string }>;
          communications: Array<{ id: string }>;
          nextActions: Array<{ id: string }>;
          exceptions: Array<{ id: string }>;
        };
        // Restart-sourced: fresh instance B never called the repo/POST
        // routes for these sub-aggregates itself, so this can only reflect
        // hydrate-on-boot reading them back from PG.
        expect(overviewBody.contracts.map((c) => c.id).sort()).toEqual(
          ["contract-pga-1", "contract-pga-2-null-value", "contract-pga-3-large-value"].sort(),
        );
        const hydratedContractsById = new Map(overviewBody.contracts.map((c) => [c.id, c] as const));
        expect(hydratedContractsById.get("contract-pga-1")?.valueKrw).toBe("1000000");
        expect(hydratedContractsById.get("contract-pga-2-null-value")?.valueKrw).toBeUndefined();
        expect(hydratedContractsById.get("contract-pga-3-large-value")?.valueKrw).toBe(
          "1000000000000000000000000000000",
        );
        expect(overviewBody.communications.map((c) => c.id)).toContain("comm-pga-1");
        expect(overviewBody.nextActions.map((a) => a.id)).toContain("next-action-pga-1");
        expect(overviewBody.exceptions.map((e) => e.id)).toContain("exception-pga-1");

        // Cross-workspace denial under raw SET ROLE ai_crm_runtime_api
        // (NOBYPASSRLS): proves FORCE RLS itself denies the rows on all
        // four new tables, not just an app-level WHERE clause.
        const { Client } = (await import("pg")) as typeof import("pg");
        const client = new Client({ connectionString: DATABASE_URL });
        await client.connect();
        try {
          await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
          await client.query("BEGIN");
          try {
            await client.query(`SET LOCAL ROLE ai_crm_runtime_api`);
            await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);
            const contractsUnderB = await client.query(`SELECT id FROM crm_contracts`);
            const communicationsUnderB = await client.query(`SELECT id FROM crm_communications`);
            const nextActionsUnderB = await client.query(`SELECT id FROM crm_next_actions`);
            const exceptionsUnderB = await client.query(`SELECT id FROM crm_operational_exceptions`);
            expect((contractsUnderB.rows as Array<{ id: string }>).some((r) => r.id === "contract-pga-1")).toBe(
              false,
            );
            expect(
              (communicationsUnderB.rows as Array<{ id: string }>).some((r) => r.id === "comm-pga-1"),
            ).toBe(false);
            expect(
              (nextActionsUnderB.rows as Array<{ id: string }>).some((r) => r.id === "next-action-pga-1"),
            ).toBe(false);
            expect(
              (exceptionsUnderB.rows as Array<{ id: string }>).some((r) => r.id === "exception-pga-1"),
            ).toBe(false);
          } finally {
            await client.query("COMMIT");
          }
        } finally {
          await client.end();
        }
      } finally {
        await rawPool.end();
      }
    },
    60_000,
  );
});
