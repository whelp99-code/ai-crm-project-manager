import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  PgCwosV2StateStore,
  type V2PgQueryable,
} from "../src/customer-work-os-v2-runtime.js";

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgresql://postgres:postgres@127.0.0.1:5432/ai_crm";
const WORKSPACE_ID = "b1111111-1111-4111-8111-111111111111";
const currentDir = dirname(fileURLToPath(import.meta.url));
const migration = join(currentDir, "../../../packages/persistence/migrations/0019_customer_work_os_v2_runtime.sql");

let pool: import("pg").Pool;

function scoped(poolInstance: import("pg").Pool): V2PgQueryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: unknown[]) {
      return (await poolInstance.query(text, values)) as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (queryable: V2PgQueryable) => Promise<T>) {
      const client = await poolInstance.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        const queryable: V2PgQueryable = {
          async query<T2 = Record<string, unknown>>(text: string, values?: unknown[]) {
            return (await client.query(text, values)) as unknown as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(queryable);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

describe.skipIf(!LIVE)("Customer Work OS v2 runtime against PostgreSQL 16", () => {
  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(readFileSync(migration, "utf8"));
    await pool.query("TRUNCATE TABLE cwos_v2_audit_events, cwos_v2_runtime_snapshots");
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query("TRUNCATE TABLE cwos_v2_audit_events, cwos_v2_runtime_snapshots");
      await pool.end();
    }
  }, 60_000);

  it("persists a compare-and-swap snapshot and an append-only hash-chain event", async () => {
    const actor: V2Actor = {
      principalId: "owner-livepg",
      workspaceId: WORKSPACE_ID,
      kind: "human",
      stepUpVerified: true,
    };
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(scoped(pool)),
      () => "2026-08-15T00:00:00.000Z",
    );

    const result = await runtime.command({
      workspaceId: WORKSPACE_ID,
      actor,
      expectedVersion: 0,
      idempotencyKey: "bootstrap-livepg",
      command: "identity.registerPrincipal",
      payload: {
        id: actor.principalId,
        kind: "human",
        displayName: "Live PG Owner",
        active: true,
      },
    });
    expect(result.envelope.version).toBe(1);

    const reloaded = await new PgCwosV2StateStore(scoped(pool)).load(WORKSPACE_ID);
    expect(reloaded?.stateHash).toBe(result.envelope.stateHash);
    expect(reloaded?.state.identity.principals).toHaveLength(1);

    const snapshot = await pool.query(
      "SELECT version,state_hash FROM cwos_v2_runtime_snapshots WHERE workspace_id=$1",
      [WORKSPACE_ID],
    );
    const audit = await pool.query(
      "SELECT sequence,before_state_hash,after_state_hash,previous_event_hash,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence",
      [WORKSPACE_ID],
    );
    expect(Number(snapshot.rows[0]?.version)).toBe(1);
    expect(snapshot.rows[0]?.state_hash).toBe(result.envelope.stateHash);
    expect(audit.rows).toHaveLength(1);
    expect(Number(audit.rows[0]?.sequence)).toBe(1);
    expect(audit.rows[0]?.previous_event_hash).toBeNull();
    expect(audit.rows[0]?.after_state_hash).toBe(result.envelope.stateHash);
  });

  it("FORCE RLS hides snapshots from a NOBYPASSRLS non-owner without the workspace GUC", async () => {
    const probeRole = "cwos_v2_rls_probe";
    const otherWorkspaceId = "c2222222-2222-4222-8222-222222222222";
    try {
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${probeRole}') THEN
            CREATE ROLE ${probeRole} NOLOGIN NOBYPASSRLS;
          END IF;
        END $$;
      `);
      await pool.query(`GRANT SELECT ON cwos_v2_runtime_snapshots TO ${probeRole}`);
      await pool.query(`GRANT ${probeRole} TO CURRENT_USER`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/permission denied|must be superuser|must be owner/i.test(message)) {
        return;
      }
      throw error;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${probeRole}`);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [otherWorkspaceId]);
      const leaked = await client.query("SELECT workspace_id FROM cwos_v2_runtime_snapshots");
      expect(leaked.rows).toHaveLength(0);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [WORKSPACE_ID]);
      const visible = await client.query("SELECT workspace_id FROM cwos_v2_runtime_snapshots");
      expect(visible.rows.map((row) => String(row.workspace_id))).toEqual([WORKSPACE_ID]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("fails closed when the persisted state hash is tampered", async () => {
    await pool.query(
      "UPDATE cwos_v2_runtime_snapshots SET state_hash=$2 WHERE workspace_id=$1",
      [WORKSPACE_ID, "0".repeat(64)],
    );
    await expect(new PgCwosV2StateStore(scoped(pool)).load(WORKSPACE_ID)).rejects.toMatchObject({
      code: "STATE_HASH_MISMATCH",
    });
  });
});
