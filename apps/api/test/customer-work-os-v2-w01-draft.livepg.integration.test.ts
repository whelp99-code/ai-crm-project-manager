import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  PgCwosV2StateStore,
  type V2PgQueryable,
} from "../src/customer-work-os-v2-runtime.js";

const EXPECTED_DATABASE = "ai_crm_dryrun_20260930";
const LIVE =
  process.env.LIVE_PG_TEST === "1" &&
  process.env.W01_DRYRUN_TEST_DB === EXPECTED_DATABASE &&
  Boolean(process.env.DATABASE_URL?.trim());
const workspaceId = "d1111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "d2222222-2222-4222-8222-222222222222";
const actor: V2Actor = {
  principalId: "w01-local-pg-owner",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

let pool: import("pg").Pool;
let queryable: V2PgQueryable;

function runtimeRoleQueryable(poolInstance: import("pg").Pool): V2PgQueryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      return (await poolInstance.query(text, values ? [...values] : undefined)) as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(scopedWorkspaceId: string, fn: (db: V2PgQueryable) => Promise<T>) {
      const client = await poolInstance.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE ai_crm_runtime_api");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scopedWorkspaceId]);
        const db: V2PgQueryable = {
          async query<T2 = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            return (await client.query(text, values ? [...values] : undefined)) as unknown as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(db);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const payload = {
  engagement: { id: "w01-local-pg-engagement", version: 1 },
  versionLabel: "v1",
  validUntil: "2026-08-31",
  scope: "HCI 4-node delivery",
  lines: [{
    id: "w01-local-pg-line",
    sourceId: "w01-local-pg-source-line",
    productId: "hci-local-pg",
    description: "HCI 4-node",
    quantity: 1,
    unitCostKrw: "60000000",
    unitPriceKrw: "100000000",
    vendorAccountId: "vendor-local-pg",
  }],
  options: ["Customer application changes"],
  templateRef: "베를로 견적서 기본양식 - 20260706.xlsx",
  templateObservation: {
    filename: "베를로 견적서 기본양식 - 20260706.xlsx",
    bytes: 23074,
    sha256: "7fe54a33f4b2ad3179361a892fbabb5dd53588fe52e279fe2441beec49437daa",
    sheetNames: ["참고견적", "베를로 템플릿"],
    mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
    historicalCandidateId: "1ckGSGoiJ5KYi6k2LBuBssnkRV75ipGcL",
  },
  vat: { netAmountKrw: "100000000", vatAmountKrw: "10000000", grossAmountKrw: "110000000" },
  po: { customerPoId: "customer-po-local-pg", supplierPoId: "supplier-po-local-pg" },
};

describe.skipIf(!LIVE)("W01 v2 draft persistence against the local dry-run PostgreSQL database", () => {
  let store: PgCwosV2StateStore;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL is required for W01 local PostgreSQL verification");
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
    if (current.rows[0]?.database_name !== EXPECTED_DATABASE) {
      throw new Error(`refusing W01 test against non-dry-run database: ${current.rows[0]?.database_name ?? "unknown"}`);
    }
    queryable = runtimeRoleQueryable(pool);
    store = new PgCwosV2StateStore(queryable);
    await store.load(workspaceId);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
  }, 30_000);

  it("persists one authorized draft result, replays after manager reconstruction, and keeps tenant isolation", async () => {
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    let envelope = await runtime.read(workspaceId);

    if (!envelope.state.identity.principals.some((item) => item.id === actor.principalId)) {
      await runtime.command({
        workspaceId,
        actor,
        expectedVersion: envelope.version,
        idempotencyKey: "w01-local-pg-principal-v1",
        command: "identity.registerPrincipal",
        payload: { id: actor.principalId, kind: "human", displayName: "W01 Local PG Owner", active: true },
      });
      envelope = await runtime.read(workspaceId);
    }
    if (!envelope.state.identity.memberships.some((item) => item.principalId === actor.principalId && item.status === "ACTIVE")) {
      await runtime.command({
        workspaceId,
        actor,
        expectedVersion: envelope.version,
        idempotencyKey: "w01-local-pg-membership-v1",
        command: "identity.addMembership",
        payload: { id: "w01-local-pg-membership", principalId: actor.principalId },
      });
      envelope = await runtime.read(workspaceId);
    }

    const first = await runtime.command({
      workspaceId,
      actor,
      expectedVersion: envelope.version,
      idempotencyKey: "w01-local-pg-draft-v1",
      command: "w01.quoteDraft",
      payload,
    });
    const persisted = await store.load(workspaceId);
    expect(persisted).toBeDefined();
    const draftRecord = persisted!.idempotency.filter((item) => item.key === "w01-local-pg-draft-v1");
    expect(draftRecord).toHaveLength(1);
    expect(draftRecord[0]?.result).toEqual(first.result);
    expect(first.result).toMatchObject({
      quote: { versionLabel: "v1", totalPriceKrw: "100000000" },
      engagementVersion: 1,
      options: ["Customer application changes"],
      vat: payload.vat,
      po: payload.po,
      templateObservation: {
        mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
        sameHistoricalDocument: false,
        approvalVerified: false,
      },
    });

    const auditCount = await queryable.withWorkspaceScope!(workspaceId, (db) =>
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cwos_v2_audit_events WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, "w01-local-pg-draft-v1"],
      ),
    );
    const reopened = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    const replay = await reopened.command({
      workspaceId,
      actor,
      expectedVersion: persisted!.version - 1,
      idempotencyKey: "w01-local-pg-draft-v1",
      command: "w01.quoteDraft",
      payload,
    });
    const auditCountAfterReplay = await queryable.withWorkspaceScope!(workspaceId, (db) =>
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cwos_v2_audit_events WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, "w01-local-pg-draft-v1"],
      ),
    );
    expect(replay.result).toEqual(first.result);
    expect(replay.envelope.version).toBe(first.envelope.version);
    expect(auditCountAfterReplay?.rows[0]?.count).toBe(auditCount?.rows[0]?.count);

    await expect(reopened.command({
      workspaceId,
      actor: { ...actor, stepUpVerified: false },
      expectedVersion: replay.envelope.version,
      idempotencyKey: "w01-local-pg-no-step-up",
      command: "w01.quoteDraft",
      payload,
    })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(reopened.command({
      workspaceId,
      actor,
      expectedVersion: replay.envelope.version,
      idempotencyKey: "w01-local-pg-draft-v1",
      command: "w01.quoteDraft",
      payload: { ...payload, options: ["Changed option"] },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const hiddenFromOtherWorkspace = await queryable.withWorkspaceScope!(otherWorkspaceId, (db) =>
      db.query(
        "SELECT workspace_id FROM cwos_v2_runtime_snapshots WHERE workspace_id=$1",
        [workspaceId],
      ),
    );
    expect(hiddenFromOtherWorkspace?.rows).toHaveLength(0);
  });
});
