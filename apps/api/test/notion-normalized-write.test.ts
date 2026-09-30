import { describe, expect, it } from "vitest";
import type { ApprovalReceipt, CustomerWorkOsState } from "@ai-crm/domain/customer-work-os";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import {
  CustomerWorkOsNotionService,
  PgNotionPlanStore,
  applyApprovedNotionPlan,
  type NotionPlanRecord,
} from "../src/customer-work-os-notion.js";
import { writeNormalizedCustomerWorkState } from "../src/customer-work-os-normalized-write.js";
import { CustomerWorkOsRuntimeManager, PgCustomerWorkOsSnapshotStore } from "../src/customer-work-os-runtime.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const QUARANTINE_SOURCE = "quarantine-source-not-a-row";

interface QueryResult<T> { rows: T[]; rowCount?: number | null }

function emptyState(): CustomerWorkOsState {
  return {
    schemaVersion: 1,
    accounts: [],
    contacts: [],
    engagements: [],
    parties: [],
    activities: [],
    artifacts: [],
    knowledge: [],
    commitments: [],
    products: [],
    quotes: [],
    contracts: [],
    deliveryProjects: [],
    changes: [],
    purchaseOrders: [],
    assets: [],
    financialItems: [],
    settlements: [],
    financialItemBaseLifecycle: [],
    consumedReceiptIds: [],
  };
}

function plannedState(): CustomerWorkOsState {
  const state = emptyState();
  state.accounts = Array.from({ length: 45 }, (_, index) => ({
    id: `account-${index}`,
    workspaceId: WORKSPACE,
    name: `계정 ${index}`,
    normalizedName: `계정 ${index}`,
    kinds: ["customer"] as const,
    status: "active" as const,
    sourceRef: `notion://account-src-${index}`,
    version: 1,
  }));
  state.accounts.push({
    id: "quarantined-account",
    workspaceId: WORKSPACE,
    name: "격리",
    normalizedName: "격리",
    kinds: ["customer"],
    status: "active",
    sourceRef: `notion://${QUARANTINE_SOURCE}`,
    version: 1,
  });
  state.engagements = Array.from({ length: 35 }, (_, index) => ({
    id: `engagement-${index}`,
    workspaceId: WORKSPACE,
    projectKey: `P-${index}`,
    name: `작업 ${index}`,
    type: "opportunity" as const,
    stage: "DISCOVERY" as const,
    health: "normal" as const,
    ownerPrincipalId: "owner",
    version: 1,
  }));
  state.parties = Array.from({ length: 61 }, (_, index) => ({
    id: `party-${index}`,
    workspaceId: WORKSPACE,
    engagementId: `engagement-${index % 35}`,
    accountId: `account-${index % 45}`,
    role: "customer" as const,
    primary: index < 35,
    commercialResponsibility: true,
    deliveryResponsibility: false,
  }));
  state.activities = Array.from({ length: 13 }, (_, index) => ({
    id: `activity-${index}`,
    workspaceId: WORKSPACE,
    engagementId: "engagement-0",
    type: "note" as const,
    occurredAt: "2026-09-01T00:00:00.000Z",
    summary: `활동 ${index}`,
    evidenceRef: `notion://activity-src-${index}`,
    humanReviewed: true,
  }));
  state.commitments = Array.from({ length: 25 }, (_, index) => ({
    id: `commitment-${index}`,
    workspaceId: WORKSPACE,
    engagementId: "engagement-0",
    ownerPrincipalId: "owner",
    description: `다음 ${index}`,
    dueAt: null,
    status: "OPEN" as const,
    priority: 50,
    financialImpact: false,
    approvalRequired: false,
    version: 1,
  }));
  state.artifacts = Array.from({ length: 2 }, (_, index) => ({
    id: `artifact-${index}`,
    workspaceId: WORKSPACE,
    engagementId: "engagement-0",
    type: "proposal" as const,
    title: "proposal imported from Notion",
    versionLabel: `legacy-${index + 1}`,
    status: "REVIEW" as const,
    storageUri: `notion://artifact-${index}`,
    metadata: { importedFrom: "Notion" },
    version: 1,
  }));
  state.financialItems = Array.from({ length: 8 }, (_, index) => ({
    id: `finance-${index}`,
    workspaceId: WORKSPACE,
    engagementId: "engagement-0",
    accountId: "account-0",
    direction: index < 3 ? "IN" as const : "OUT" as const,
    category: index < 3 ? "contract_revenue" as const : "hardware_cost" as const,
    lifecycle: index < 5 ? "SETTLED" as const : "PLANNED" as const,
    netAmountKrw: "1000",
    vatAmountKrw: "100",
    grossAmountKrw: "1100",
    expectedDate: "2026-09-01",
    evidenceRef: `notion://finance-src-${index}`,
    revision: 1,
  }));
  state.settlements = Array.from({ length: 5 }, (_, index) => ({
    id: `settlement-${index}`,
    workspaceId: WORKSPACE,
    financialItemId: `finance-${index}`,
    direction: index < 3 ? "IN" as const : "OUT" as const,
    amountKrw: "1100",
    settledAt: "2026-09-01",
    accountOrCard: "notion-import",
    evidenceRef: `notion://finance-src-${index}`,
  }));
  return state;
}

class RollbackTables {
  private checkpoint = new Map<string, Map<string, unknown[]>>();
  readonly tables = new Map<string, Map<string, unknown[]>>();
  readonly log: string[] = [];

  begin(): void {
    this.checkpoint = new Map([...this.tables].map(([table, rows]) => [table, new Map(rows)]));
  }

  rollback(): void {
    this.tables.clear();
    for (const [table, rows] of this.checkpoint) this.tables.set(table, new Map(rows));
  }

  count(table: string): number {
    return this.tables.get(table)?.size ?? 0;
  }
}

function p0001(): Error {
  return Object.assign(new Error("settlement allocation outside 0..gross range"), { code: "P0001" });
}

function scriptedWriter(store: RollbackTables) {
  return {
    async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
      const sql = text.replace(/\s+/g, " ").trim();
      store.log.push(sql);
      const table = sql.match(/(?:INTO|FROM) (cwos_[a-z_]+)/)?.[1];
      if (!table) return { rows: [] as T[] };
      const rows = store.tables.get(table) ?? new Map<string, unknown[]>();
      store.tables.set(table, rows);
      if (sql.startsWith("INSERT") && table === "cwos_settlements") {
        if (sql.includes("ON CONFLICT")) throw p0001();
        const id = String(values[0]);
        if (rows.has(id)) {
          if (!sql.includes("NOT EXISTS")) throw p0001();
          return { rows: [] as T[], rowCount: 0 };
        }
        rows.set(id, [...values]);
        return { rows: [] as T[], rowCount: 1 };
      }
      if (sql.startsWith("INSERT")) {
        const id = String(values[0]);
        if (rows.has(id) && sql.includes("ON CONFLICT")) return { rows: [] as T[], rowCount: 0 };
        if (rows.has(id)) throw new Error(`duplicate ${table} ${id}`);
        rows.set(id, [...values]);
        return { rows: [] as T[], rowCount: 1 };
      }
      return { rows: [] as T[] };
    },
  };
}

describe("normalized notion write", () => {
  it("writes plan row counts and skips quarantined source refs", async () => {
    const store = new RollbackTables();
    const connection = scriptedWriter(store);
    store.begin();
    await writeNormalizedCustomerWorkState(connection, plannedState(), {
      excludeSourceIds: new Set([QUARANTINE_SOURCE]),
    });
    expect(store.count("cwos_accounts")).toBe(45);
    expect(store.count("cwos_contacts")).toBe(0);
    expect(store.count("cwos_engagements")).toBe(35);
    expect(store.count("cwos_engagement_parties")).toBe(61);
    expect(store.count("cwos_activities")).toBe(13);
    expect(store.count("cwos_commitments")).toBe(25);
    expect(store.count("cwos_artifacts")).toBe(2);
    expect(store.count("cwos_financial_items")).toBe(8);
    expect(store.count("cwos_settlements")).toBe(5);
    const accountValues = [...(store.tables.get("cwos_accounts")?.values() ?? [])].flat().map(String);
    expect(accountValues.some((value) => value.includes(QUARANTINE_SOURCE))).toBe(false);
    expect(store.log.some((sql) => sql.includes("cwos_settlements") && sql.includes("ON CONFLICT"))).toBe(false);
    expect(store.log.some((sql) => sql.includes("source_ref"))).toBe(true);
    expect(store.log.some((sql) => sql.includes("evidence_ref"))).toBe(true);
    const dueValues = [...(store.tables.get("cwos_commitments")?.values() ?? [])];
    expect(dueValues.every((row) => row.includes(null))).toBe(true);

    const held = new RollbackTables();
    const heldState = emptyState();
    heldState.accounts = [plannedState().accounts[0]!];
    heldState.financialItems = [{
      ...plannedState().financialItems[0]!,
      id: "held-finance",
      evidenceRef: `notion://${QUARANTINE_SOURCE}`,
    }];
    heldState.settlements = [{
      ...plannedState().settlements[0]!,
      id: "held-settlement",
      financialItemId: "held-finance",
      evidenceRef: `notion://${QUARANTINE_SOURCE}`,
    }];
    await writeNormalizedCustomerWorkState(scriptedWriter(held), heldState, { excludeSourceIds: new Set([QUARANTINE_SOURCE]) });
    expect(held.count("cwos_financial_items")).toBe(0);
    expect(held.count("cwos_settlements")).toBe(0);
    expect(held.count("cwos_accounts")).toBe(1);
  });

  it("re-applies settlements as a no-op without P0001", async () => {
    const store = new RollbackTables();
    const connection = scriptedWriter(store);
    const state = plannedState();
    await writeNormalizedCustomerWorkState(connection, state, { excludeSourceIds: new Set([QUARANTINE_SOURCE]) });
    const before = store.count("cwos_settlements");
    await writeNormalizedCustomerWorkState(connection, state, { excludeSourceIds: new Set([QUARANTINE_SOURCE]) });
    expect(store.count("cwos_settlements")).toBe(before);
    expect(store.count("cwos_accounts")).toBe(45);
  });

  it("rolls back normalized rows when participate throws inside the apply transaction", async () => {
    const seed = planRecord();
    const db = scriptedDatabase(seed);
    const notion = new CustomerWorkOsNotionService(new PgNotionPlanStore(db.pool));
    const manager = new CustomerWorkOsRuntimeManager(new PgCustomerWorkOsSnapshotStore(db.pool));
    await expect(applyApprovedNotionPlan({
      service: notion,
      manager,
      workspaceId: WORKSPACE,
      planId: seed.id,
      expectedVersion: seed.version,
      principalId: "owner",
      idempotencyKey: "apply-fail-normalized",
      receipt: receipt(seed),
      reason: "fail",
      participate: async () => { throw new Error("injected participate failure"); },
    })).rejects.toThrow(/injected participate failure/);
    expect(db.tables.count("cwos_accounts")).toBe(0);
    expect(db.tables.count("cwos_settlements")).toBe(0);
    expect(db.plans.get(`${WORKSPACE}\u0000${seed.id}`)?.status).not.toBe("APPLIED");
    expect(db.snapshots.size).toBe(0);
  });
});

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

function planRecord(): NotionPlanRecord {
  const plan: NotionCwosImportPlan = {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:snap",
    capturedAt: "2026-09-29T00:00:00.000Z",
    planHash: "fnv1a32:normalized",
    accounts: [{
      id: "account-1",
      workspaceId: WORKSPACE,
      legacySourceId: "src-1",
      provenance: {},
      name: "계정",
      normalizedName: "계정",
      kinds: ["customer"],
      status: "active",
      sourceUrl: "notion://src-1",
    }],
    engagements: [{
      id: "engagement-1",
      workspaceId: WORKSPACE,
      legacySourceId: "eng-1",
      provenance: {},
      projectKey: "P-1",
      name: "작업",
      stage: "DISCOVERY",
      parties: [],
      artifactRefs: {},
      nextAction: "확인",
    }],
    activities: [],
    financialItems: [{
      id: "finance-1",
      workspaceId: WORKSPACE,
      legacySourceId: "fin-1",
      provenance: {},
      accountSourceId: "src-1",
      engagementSourceId: "eng-1",
      direction: "IN",
      category: "contract_revenue",
      lifecycle: "SETTLED",
      netAmountKrw: "1000",
      vatAmountKrw: "100",
      grossAmountKrw: "1100",
      expectedDate: "2026-09-01",
      actualDate: "2026-09-02",
      evidenceRefs: ["notion://fin-1"],
      sourceFingerprint: "fp-fin",
    }],
    quarantined: [{ entity: "account", sourceId: QUARANTINE_SOURCE, reasons: ["MISSING_REQUIRED_FIELD"], message: "held", rawFingerprint: "fp" }],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 1, projects: 1, activities: 0, finance: 1 },
      imported: { accounts: 1, engagements: 1, activities: 0, financialItems: 1 },
      quarantined: 1,
      outOfScope: { priceLedger: 0 },
      finance: {
        inboundNetKrw: "1000", inboundVatKrw: "100", inboundGrossKrw: "1100",
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

function scriptedDatabase(seed: NotionPlanRecord) {
  const snapshots = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, NotionPlanRecord>([[`${seed.workspaceId}\u0000${seed.id}`, structuredClone(seed)]]);
  const tables = new RollbackTables();
  const writer = scriptedWriter(tables);
  let checkpoint = { snapshots: new Map(snapshots), plans: new Map(plans) };
  const connection = {
    async query<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryResult<T>> {
      const sql = text.replace(/\s+/g, " ").trim();
      const ok = (rows: unknown[], rowCount?: number): QueryResult<T> => ({ rows: rows as T[], ...(rowCount === undefined ? {} : { rowCount }) });
      if (sql === "BEGIN") {
        checkpoint = { snapshots: new Map(snapshots), plans: new Map([...plans].map(([key, value]) => [key, structuredClone(value)])) };
        tables.begin();
        return ok([]);
      }
      if (sql === "COMMIT") return ok([]);
      if (sql === "ROLLBACK") {
        snapshots.clear();
        plans.clear();
        for (const [key, value] of checkpoint.snapshots) snapshots.set(key, value);
        for (const [key, value] of checkpoint.plans) plans.set(key, value);
        tables.rollback();
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
          workspace_id: values[0], version: 1, schema_version: 1,
          state: JSON.parse(String(values[1])), idempotency: JSON.parse(String(values[2])),
          state_hash: values[3], updated_by_principal_id: values[4], updated_at: values[5],
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
        const next: NotionPlanRecord = { ...row, status: "APPLIED", appliedByPrincipalId: String(values[3]), appliedAt: String(values[4]), version: row.version + 1 };
        plans.set(`${values[0]}\u0000${values[1]}`, next);
        return ok([toRow(next)], 1);
      }
      if (sql.startsWith("INSERT INTO cwos_notion_import_plan_events")) return ok([], 1);
      if (sql.includes("cwos_accounts") || sql.includes("cwos_engagements") || sql.includes("cwos_commitments") || sql.includes("cwos_financial") || sql.includes("cwos_settlements") || sql.includes("cwos_activities") || sql.includes("cwos_artifacts") || sql.includes("cwos_contacts") || sql.includes("cwos_engagement_parties")) {
        return writer.query(text, values);
      }
      throw new Error(`unhandled sql: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => connection, end: async () => {} };
  return { pool, snapshots, plans, tables };
}
