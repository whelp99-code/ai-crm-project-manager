import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AutomationActor } from "@ai-crm/domain/customer-work-os-v2.5";
import {
  CustomerWorkOsV25RuntimeManager,
  PgV25StateStore,
  type V25PgQueryable,
} from "../src/customer-work-os-v25-runtime.js";

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgresql://postgres:postgres@127.0.0.1:5432/ai_crm";
const WORKSPACE_ID = "b2525252-2525-4252-8252-252525252525";
const currentDir = dirname(fileURLToPath(import.meta.url));
const migration = join(currentDir, "../../../packages/persistence/migrations/0020_customer_work_os_v25_automation.sql");

let pool: import("pg").Pool;

function scoped(poolInstance: import("pg").Pool): V25PgQueryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      const result = values === undefined
        ? await poolInstance.query(text)
        : await poolInstance.query(text, [...values]);
      return result as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (queryable: V25PgQueryable) => Promise<T>) {
      const client = await poolInstance.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        const queryable: V25PgQueryable = {
          async query<T2 = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            const result = values === undefined
              ? await client.query(text)
              : await client.query(text, [...values]);
            return result as unknown as { rows: T2[]; rowCount: number | null };
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

describe.skipIf(!LIVE)("Customer Work OS v2.5 automation against PostgreSQL 16", () => {
  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(readFileSync(migration, "utf8"));
    await pool.query("TRUNCATE TABLE cwos_v25_automation_audit_events, cwos_v25_automation_snapshots");
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query("TRUNCATE TABLE cwos_v25_automation_audit_events, cwos_v25_automation_snapshots");
      await pool.end();
    }
  }, 60_000);

  it("persists one-shot capture, idempotency and an append-only state-hash chain", async () => {
    const actor: AutomationActor = {
      principalId: "owner-v25-livepg",
      workspaceId: WORKSPACE_ID,
      kind: "human",
      stepUpVerified: true,
    };
    const runtime = new CustomerWorkOsV25RuntimeManager(
      new PgV25StateStore(scoped(pool)),
      () => "2026-08-29T00:00:00.000Z",
    );
    const command = {
      workspaceId: WORKSPACE_ID,
      actor,
      expectedVersion: 0,
      idempotencyKey: "capture-v25-livepg",
      command: "capture.submit",
      payload: {
        capture: {
          id: "capture-livepg",
          workspaceId: WORKSPACE_ID,
          kind: "TEXT",
          title: "HCI 일정·재무",
          content: "선진 HCI PRJ-2026-001 검수일 2026-10-15, 총판 4천만원은 2026-09-30 지급한다.",
          occurredAt: "2026-08-29T00:00:00.000Z",
          sender: actor.principalId,
          sourceRef: "livepg://capture/1",
          providerEventId: "livepg-event-1",
          attachments: [],
          language: "ko",
        },
        context: {
          accountAliases: [{ id: "account-sunjin", aliases: ["선진"] }],
          engagementAliases: [{ id: "engagement-hci", aliases: ["선진 HCI"], projectKey: "PRJ-2026-001" }],
          defaultTimezone: "Asia/Seoul",
        },
      },
    } as const;

    const created = await runtime.command(command);
    expect(created.envelope.version).toBe(1);
    expect(created.envelope.state.capture.sources).toHaveLength(1);
    expect(created.envelope.state.capture.plans[0]?.mutations.some((item) => item.category === "FINANCIAL_ITEM")).toBe(true);

    const replay = await runtime.command(command);
    expect(replay.statusCode).toBe(created.statusCode);
    expect(replay.envelope.stateHash).toBe(created.envelope.stateHash);

    const reloaded = await new PgV25StateStore(scoped(pool)).load(WORKSPACE_ID);
    expect(reloaded?.stateHash).toBe(created.envelope.stateHash);
    expect(reloaded?.idempotency).toHaveLength(1);

    const snapshot = await pool.query(
      "SELECT version,state_hash FROM cwos_v25_automation_snapshots WHERE workspace_id=$1",
      [WORKSPACE_ID],
    );
    const audit = await pool.query(
      "SELECT sequence,before_state_hash,after_state_hash,previous_event_hash,event_hash FROM cwos_v25_automation_audit_events WHERE workspace_id=$1 ORDER BY sequence",
      [WORKSPACE_ID],
    );
    expect(Number(snapshot.rows[0]?.version)).toBe(1);
    expect(snapshot.rows[0]?.state_hash).toBe(created.envelope.stateHash);
    expect(audit.rows).toHaveLength(1);
    expect(Number(audit.rows[0]?.sequence)).toBe(1);
    expect(audit.rows[0]?.previous_event_hash).toBeNull();
    expect(audit.rows[0]?.after_state_hash).toBe(created.envelope.stateHash);

    await pool.query(
      "UPDATE cwos_v25_automation_snapshots SET state_hash=$2 WHERE workspace_id=$1",
      [WORKSPACE_ID, "fnv1a64:0000000000000000"],
    );
    await expect(new PgV25StateStore(scoped(pool)).load(WORKSPACE_ID)).rejects.toMatchObject({
      code: "STATE_HASH_MISMATCH",
    });
  });
});
