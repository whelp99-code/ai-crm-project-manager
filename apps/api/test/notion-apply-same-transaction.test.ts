import { describe, expect, it } from "vitest";
import type { ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import {
  CustomerWorkOsNotionService,
  PgNotionPlanStore,
  applyApprovedNotionPlan,
  type NotionPlanRecord,
} from "../src/customer-work-os-notion.js";
import { CustomerWorkOsRuntimeManager, PgCustomerWorkOsSnapshotStore } from "../src/customer-work-os-runtime.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";

interface QueryResult<T> { rows: T[]; rowCount?: number | null }
interface Scripted {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

function planRecord(): NotionPlanRecord {
  const plan: NotionCwosImportPlan = {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:snap",
    capturedAt: "2026-09-29T00:00:00.000Z",
    planHash: "fnv1a32:apply",
    accounts: [{
      id: "account-1",
      workspaceId: WORKSPACE,
      legacySourceId: "src-1",
      provenance: {},
      name: "계정",
      normalizedName: "계정",
      kinds: ["customer"],
      status: "active",
    }],
    engagements: [],
    activities: [],
    financialItems: [],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 1, projects: 0, activities: 0, finance: 0 },
      imported: { accounts: 1, engagements: 0, activities: 0, financialItems: 0 },
      quarantined: 0,
      outOfScope: { priceLedger: 0 },
      finance: {
        inboundNetKrw: "0", inboundVatKrw: "0", inboundGrossKrw: "0",
        outboundNetKrw: "0", outboundVatKrw: "0", outboundGrossKrw: "0",
      },
      orphanRelations: 0,
      duplicateCandidates: 0,
    },
    readOnlySource: true,
  };
  return {
    id: "plan-1",
    workspaceId: WORKSPACE,
    snapshotId: plan.snapshotId,
    snapshotHash: plan.snapshotHash,
    planHash: plan.planHash,
    capturedAt: plan.capturedAt,
    plan,
    status: "APPROVED",
    createdByPrincipalId: "owner",
    approvedByPrincipalId: "owner",
    approvedAt: plan.capturedAt,
    createdAt: plan.capturedAt,
    version: 2,
  };
}

function receipt(record: NotionPlanRecord): ApprovalReceipt {
  return {
    id: "receipt-1",
    workspaceId: WORKSPACE,
    resourceType: "import_plan",
    resourceId: record.id,
    resourceVersion: record.version,
    action: "NOTION_IMPORT_APPROVE",
    payloadHash: "unused",
    status: "CONSUMED",
    approvedByPrincipalId: "owner",
  };
}

function scriptedDatabase(seed: NotionPlanRecord) {
  const snapshots = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, NotionPlanRecord>([[`${seed.workspaceId}\u0000${seed.id}`, structuredClone(seed)]]);
  const log: string[] = [];
  let checkpoint = { snapshots: new Map(snapshots), plans: new Map(plans) };
  const sqlOf = (text: string) => text.replace(/\s+/g, " ").trim();
  const connection: Scripted = {
    async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
      const sql = sqlOf(text);
      log.push(sql);
      const ok = (rows: unknown[], rowCount?: number): QueryResult<T> => ({ rows: rows as T[], ...(rowCount === undefined ? {} : { rowCount }) });
      if (sql === "BEGIN") {
        checkpoint = { snapshots: new Map(snapshots), plans: new Map([...plans].map(([key, value]) => [key, structuredClone(value)])) };
        return ok([]);
      }
      if (sql === "COMMIT") return ok([]);
      if (sql === "ROLLBACK") {
        snapshots.clear();
        plans.clear();
        for (const [key, value] of checkpoint.snapshots) snapshots.set(key, value);
        for (const [key, value] of checkpoint.plans) plans.set(key, value);
        return ok([]);
      }
      if (sql.startsWith("SELECT set_config")) return ok([]);
      if (sql.includes("INSERT INTO cwos_runtime_audit_heads")) return ok([], 1);
      if (sql.includes("FROM cwos_runtime_audit_heads")) return ok([{ head_sequence: 0, head_event_hash: null }]);
      if (sql.includes("FROM cwos_runtime_snapshots")) {
        const row = snapshots.get(String(values[0]));
        return ok(row ? [row] : []);
      }
      if (sql.startsWith("INSERT INTO cwos_runtime_snapshots")) {
        const row = {
          workspace_id: values[0],
          version: 1,
          schema_version: 1,
          state: JSON.parse(String(values[1])),
          idempotency: JSON.parse(String(values[2])),
          state_hash: values[3],
          updated_by_principal_id: values[4],
          updated_at: values[5],
        };
        snapshots.set(String(values[0]), row);
        return ok([row]);
      }
      if (sql.startsWith("INSERT INTO cwos_runtime_events")) return ok([{ id: "11111111-1111-4111-8111-111111111111" }]);
      if (sql.startsWith("UPDATE cwos_runtime_audit_heads")) return ok([], 1);
      if (sql.includes("FROM cwos_notion_import_plans")) {
        const row = plans.get(`${values[0]}\u0000${values[1]}`);
        return ok(row ? [toRow(row)] : []);
      }
      if (sql.startsWith("UPDATE cwos_notion_import_plans")) {
        const row = plans.get(`${values[0]}\u0000${values[1]}`);
        if (!row || row.version !== values[2] || row.status !== "APPROVED") return ok([], 0);
        const next: NotionPlanRecord = {
          ...row,
          status: "APPLIED",
          appliedByPrincipalId: String(values[3]),
          appliedAt: String(values[4]),
          version: row.version + 1,
        };
        plans.set(`${values[0]}\u0000${values[1]}`, next);
        return ok([toRow(next)], 1);
      }
      if (sql.startsWith("INSERT INTO cwos_notion_import_plan_events")) return ok([], 1);
      if (/^INSERT INTO cwos_(accounts|contacts|engagements|engagement_parties|activities|commitments|artifacts|financial_items|settlements)\b/.test(sql)) return ok([], 1);
      throw new Error(`unhandled sql: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => connection, end: async () => {} };
  return { pool, log, snapshots, plans };
}

function toRow(record: NotionPlanRecord) {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    snapshot_id: record.snapshotId,
    snapshot_hash: record.snapshotHash,
    plan_hash: record.planHash,
    captured_at: record.capturedAt,
    plan: record.plan,
    status: record.status,
    created_by_principal_id: record.createdByPrincipalId,
    approved_by_principal_id: record.approvedByPrincipalId ?? null,
    applied_by_principal_id: record.appliedByPrincipalId ?? null,
    created_at: record.createdAt,
    approved_at: record.approvedAt ?? null,
    applied_at: record.appliedAt ?? null,
    version: record.version,
  };
}

function writeTransaction(log: string[]): string[] {
  const start = log.findIndex((sql) => sql.startsWith("INSERT INTO cwos_runtime_snapshots"));
  expect(start).toBeGreaterThan(0);
  let begin = start;
  while (begin > 0 && log[begin] !== "BEGIN") begin -= 1;
  const end = log.findIndex((sql, index) => index > start && (sql === "COMMIT" || sql === "ROLLBACK"));
  expect(end).toBeGreaterThan(start);
  return log.slice(begin, end + 1);
}

describe("applyApprovedNotionPlan transaction", () => {
  it("rolls back the snapshot when participate throws", async () => {
    const seed = planRecord();
    const db = scriptedDatabase(seed);
    const notion = new CustomerWorkOsNotionService(new PgNotionPlanStore(db.pool));
    const manager = new CustomerWorkOsRuntimeManager(new PgCustomerWorkOsSnapshotStore(db.pool));
    const before = db.log.length;
    await expect(applyApprovedNotionPlan({
      service: notion,
      manager,
      workspaceId: WORKSPACE,
      planId: seed.id,
      expectedVersion: seed.version,
      principalId: "owner",
      idempotencyKey: "apply-fail",
      receipt: receipt(seed),
      reason: "fail",
      participate: async () => { throw new Error("injected participate failure"); },
    })).rejects.toThrow(/injected participate failure/);
    const tx = writeTransaction(db.log.slice(before));
    expect(tx.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(tx.filter((sql) => sql === "COMMIT")).toHaveLength(0);
    expect(db.plans.get(`${WORKSPACE}\u0000${seed.id}`)?.status).not.toBe("APPLIED");
    expect(db.snapshots.size).toBe(0);
    const domain = await manager.read(WORKSPACE, (service) => service.exportState());
    expect(domain.accounts).toHaveLength(0);
    expect(domain.commitments).toHaveLength(0);
  });

  it("commits the snapshot and APPLIED marker in one transaction", async () => {
    const seed = planRecord();
    const db = scriptedDatabase(seed);
    const notion = new CustomerWorkOsNotionService(new PgNotionPlanStore(db.pool));
    const manager = new CustomerWorkOsRuntimeManager(new PgCustomerWorkOsSnapshotStore(db.pool));
    const before = db.log.length;
    const applied = await applyApprovedNotionPlan({
      service: notion,
      manager,
      workspaceId: WORKSPACE,
      planId: seed.id,
      expectedVersion: seed.version,
      principalId: "owner",
      idempotencyKey: "apply-ok",
      receipt: receipt(seed),
      reason: "apply",
    });
    const tx = writeTransaction(db.log.slice(before));
    expect(tx[0]).toBe("BEGIN");
    expect(tx.at(-1)).toBe("COMMIT");
    expect(tx.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(tx.some((sql) => sql.startsWith("INSERT INTO cwos_runtime_snapshots"))).toBe(true);
    expect(tx.some((sql) => sql.startsWith("UPDATE cwos_notion_import_plans"))).toBe(true);
    const snapshotAt = tx.findIndex((sql) => sql.startsWith("INSERT INTO cwos_runtime_snapshots"));
    const planAt = tx.findIndex((sql) => sql.startsWith("UPDATE cwos_notion_import_plans"));
    expect(snapshotAt).toBeLessThan(planAt);
    expect(planAt).toBeLessThan(tx.length - 1);
    expect(applied.plan.status).toBe("APPLIED");
    expect(db.plans.get(`${WORKSPACE}\u0000${seed.id}`)?.status).toBe("APPLIED");
  });
});
