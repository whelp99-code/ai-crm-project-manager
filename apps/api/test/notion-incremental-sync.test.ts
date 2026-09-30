import { describe, expect, it } from "vitest";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import { rowToLive, syncApprovedNotionPlan, type NotionSyncConnection } from "../src/customer-work-os-notion-sync.js";
import type { NotionPlanRecord } from "../src/customer-work-os-notion.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";

function plan(): NotionCwosImportPlan {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    capturedAt: "2026-09-30T00:00:00.000Z",
    planHash: "fnv1a32:abc12345",
    accounts: [],
    engagements: [],
    activities: [],
    financialItems: [],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 0, projects: 0, activities: 0, finance: 0 },
      imported: { accounts: 0, engagements: 0, activities: 0, financialItems: 0 },
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
}

function record(): NotionPlanRecord {
  return {
    id: "notion-plan-test",
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    planHash: "fnv1a32:abc12345",
    capturedAt: "2026-09-30T00:00:00.000Z",
    plan: plan(),
    status: "APPROVED",
    createdByPrincipalId: "owner",
    approvedByPrincipalId: "owner",
    createdAt: "2026-09-30T00:00:00.000Z",
    approvedAt: "2026-09-30T00:00:00.000Z",
    version: 2,
  };
}

function fakePool(queries: string[], options: { applied?: boolean; database?: string } = {}) {
  const connection: NotionSyncConnection = {
    async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
      queries.push(text.trim());
      if (text.includes("current_database")) return { rows: [{ name: options.database ?? "ai_crm_sync_scratch" }] as T[] };
      if (text.includes("FROM cwos_notion_sync_runs") && options.applied) return { rows: [{ id: "existing" }] as T[] };
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => connection };
}

describe("syncApprovedNotionPlan", () => {
  it("rolls back the marker and data when failure is injected after the marker insert", async () => {
    const queries: string[] = [];
    await expect(syncApprovedNotionPlan({
      pool: fakePool(queries),
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:test",
      injectFailureAfterMarker: async () => { throw new Error("injected"); },
    })).rejects.toThrow(/injected/);
    expect(queries.some((query) => query.startsWith("INSERT INTO cwos_notion_sync_runs"))).toBe(true);
    expect(queries.some((query) => query === "ROLLBACK")).toBe(true);
    expect(queries.some((query) => query === "COMMIT")).toBe(false);
  });

  it("does not write when the same plan hash is already applied", async () => {
    const queries: string[] = [];
    const report = await syncApprovedNotionPlan({
      pool: fakePool(queries, { applied: true }),
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:test",
    });
    expect(report.alreadyApplied).toBe(true);
    expect(report.inserts).toBe(0);
    expect(queries.some((query) => query.startsWith("INSERT INTO"))).toBe(false);
  });

  it("dry-run does not commit a marker", async () => {
    const queries: string[] = [];
    const report = await syncApprovedNotionPlan({
      pool: fakePool(queries),
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:test",
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(queries.some((query) => query.startsWith("INSERT INTO cwos_notion_sync_runs"))).toBe(false);
    expect(queries.some((query) => query === "COMMIT")).toBe(false);
    expect(queries.some((query) => query === "ROLLBACK")).toBe(true);
  });

  it("refuses to apply into the ai_crm database", async () => {
    const queries: string[] = [];
    await expect(syncApprovedNotionPlan({
      pool: fakePool(queries, { database: "ai_crm" }),
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:test",
    })).rejects.toThrow(/ai_crm/);
    expect(queries.some((query) => query === "COMMIT")).toBe(false);
  });
});

describe("notion sync canonical round-trip", () => {
  it("keeps a DATE column that arrived as YYYY-MM-DD text", () => {
    const live = rowToLive("engagement", {
      id: "engagement-aaaaaaaa",
      notion_page_id: "page-1",
      notion_parent_page_id: null,
      archived_at: null,
      version: 1,
      synced_version: 1,
      name: "경월",
      project_key: "P",
      engagement_type: "delivery",
      stage: "DELIVERY",
      start_date: "2025-12-01",
      target_date: "2025-12-31",
    });
    expect(live.fields.start_date).toBe("2025-12-01");
    expect(live.fields.target_date).toBe("2025-12-31");
  });

  it("refuses a Date for a DATE column instead of guessing UTC midnight", () => {
    expect(() => rowToLive("engagement", {
      id: "engagement-aaaaaaaa",
      notion_page_id: "page-1",
      notion_parent_page_id: null,
      archived_at: null,
      version: 1,
      synced_version: 1,
      name: "경월",
      project_key: "P",
      engagement_type: "delivery",
      stage: "DELIVERY",
      start_date: new Date("2025-12-01T00:00:00.000Z"),
      target_date: "2025-12-31",
    })).toThrow(/YYYY-MM-DD string/);
  });

  it("does not rewrite an unchanged snapshot loaded back as pg dates and reordered metadata", async () => {
    const base = populated();
    const pool = memoryPool();
    const first = await syncApprovedNotionPlan({
      pool, record: rec(base, "fnv1a32:load1"), principalId: "owner", snapshotSha256: "sha256:1",
    });
    expect(first.inserts).toBeGreaterThan(0);
    const queriesBefore = pool.queries.length;
    const second = await syncApprovedNotionPlan({
      pool, record: rec(base, "fnv1a32:load2"), principalId: "owner", snapshotSha256: "sha256:2",
    });
    expect(second).toMatchObject({ inserts: 0, updates: 0, archives: 0, holds: 0 });
    expect(pool.queries.slice(queriesBefore).some((query) => query.includes("version = version + 1"))).toBe(false);
    expect(pool.queries.some((query) => query.includes("start_date::text"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("expected_date::text"))).toBe(true);
  });

  it("classifies one add, one title change, one removal, and one settled amount change", async () => {
    const base = populated();
    const pool = memoryPool();
    await syncApprovedNotionPlan({
      pool, record: rec(base, "fnv1a32:load1"), principalId: "owner", snapshotSha256: "sha256:1",
    });
    const changed = populated();
    changed.accounts.push({
      id: "account-bbbbbbbb", workspaceId: WORKSPACE, legacySourceId: "page-add", provenance: {},
      name: "추가", normalizedName: "추가", kinds: ["customer"], status: "active",
    });
    changed.engagements[0]!.name = "경월 변경";
    changed.activities = [];
    changed.financialItems[0]!.grossAmountKrw = "2000";
    changed.financialItems[0]!.netAmountKrw = "2000";
    const report = await syncApprovedNotionPlan({
      pool, record: rec(changed, "fnv1a32:changed"), principalId: "owner", snapshotSha256: "sha256:3",
    });
    expect(report).toMatchObject({ inserts: 1, updates: 1, archives: 1, holds: 1 });
    expect(report.holdReasons).toEqual(["AMOUNT_OR_DIRECTION"]);
  });

  it("writes the original stage name and treats a Notion stage rename as a business update", async () => {
    const base = populated();
    base.engagements[0]!.sourceStage = "매입발주";
    const pool = memoryPool();
    const first = await syncApprovedNotionPlan({
      pool, record: rec(base, "fnv1a32:stage1"), principalId: "owner", snapshotSha256: "sha256:stage1",
    });
    expect(first.inserts).toBeGreaterThan(0);
    expect(pool.queries.some((query) => query.includes("INSERT INTO cwos_engagements") && query.includes("source_stage"))).toBe(true);
    const renamed = populated();
    renamed.engagements[0]!.sourceStage = "수행/검수";
    const second = await syncApprovedNotionPlan({
      pool, record: rec(renamed, "fnv1a32:stage2"), principalId: "owner", snapshotSha256: "sha256:stage2",
    });
    expect(second).toMatchObject({ inserts: 0, updates: 1, archives: 0, holds: 0 });
    expect(pool.queries.some((query) => query.includes("UPDATE cwos_engagements") && query.includes("source_stage"))).toBe(true);
    const third = await syncApprovedNotionPlan({
      pool, record: rec(renamed, "fnv1a32:stage3"), principalId: "owner", snapshotSha256: "sha256:stage3",
    });
    expect(third).toMatchObject({ inserts: 0, updates: 0, archives: 0, holds: 0 });
  });
});

function populated(): NotionCwosImportPlan {
  const base = plan();
  base.accounts = [{
    id: "account-aaaaaaaa", workspaceId: WORKSPACE, legacySourceId: "page-account", provenance: {},
    name: "고객", normalizedName: "고객", kinds: ["customer"], status: "active",
  }];
  base.engagements = [{
    id: "engagement-aaaaaaaa", workspaceId: WORKSPACE, legacySourceId: "page-project", provenance: {},
    projectKey: "P-1", name: "경월", stage: "DELIVERY", startDate: "2025-12-01", targetDate: "2025-12-31",
    parties: [], artifactRefs: { quote: ["notion://quote-1"] },
  }];
  base.activities = [{
    id: "activity-aaaaaaaa", workspaceId: WORKSPACE, legacySourceId: "page-activity", provenance: {},
    activityType: "note", occurredAt: "2025-12-01", summary: "메모",
    accountSourceIds: ["page-account"], projectSourceIds: ["page-project"], attachmentRefs: [],
  }];
  base.financialItems = [{
    id: "financial-aaaaaaaa", workspaceId: WORKSPACE, legacySourceId: "page-finance", provenance: {},
    engagementSourceId: "page-project", accountSourceId: "page-account", direction: "IN", category: "service",
    lifecycle: "SETTLED", netAmountKrw: "1000", vatAmountKrw: "0", grossAmountKrw: "1000",
    expectedDate: "2025-12-01", actualDate: "2025-12-01", evidenceRefs: [], sourceFingerprint: "fp",
  }];
  return base;
}

function rec(body: NotionCwosImportPlan, planHash: string): NotionPlanRecord {
  return { ...record(), plan: body, planHash };
}

const DATE_COLUMNS = new Set(["start_date", "target_date", "expected_date"]);
const TIMESTAMP_COLUMNS = new Set(["occurred_at", "due_at"]);

function memoryPool() {
  const rows = new Map<string, Record<string, unknown>[]>();
  const queries: string[] = [];
  const connection: NotionSyncConnection = {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const sql = text.trim();
      queries.push(sql);
      if (sql.includes("current_database")) return { rows: [{ name: "ai_crm_sync_scratch" }] as T[] };
      if (sql.includes("FROM cwos_notion_sync_runs")) return { rows: [] };
      if (sql.startsWith("INSERT INTO cwos_settlements")) {
        const table = rows.get("cwos_settlements") ?? [];
        table.push({ financial_item_id: values?.[2] });
        rows.set("cwos_settlements", table);
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO cwos_")) {
        const table = sql.match(/INSERT INTO (cwos_\w+)/)?.[1];
        if (table && table !== "cwos_notion_sync_runs" && table !== "cwos_notion_sync_holds") {
          const columns = sql.match(/\(([^)]+)\)/)?.[1]?.split(",").map((column) => column.trim()) ?? [];
          const stored: Record<string, unknown> = {};
          columns.forEach((column, index) => { stored[column] = values?.[index]; });
          const tableRows = rows.get(table) ?? [];
          tableRows.push(stored);
          rows.set(table, tableRows);
        }
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE ")) {
        const table = sql.match(/UPDATE (cwos_\w+)/)?.[1];
        const id = values?.[1];
        const tableRows = table ? rows.get(table) : undefined;
        const stored = tableRows?.find((row) => row.id === id);
        if (stored && values) {
          const setClause = sql.match(/SET ([\s\S]+) WHERE/)?.[1] ?? "";
          for (const assignment of setClause.split(",")) {
            const match = assignment.trim().match(/^([a-z_]+) = \$(\d+)/);
            if (!match) continue;
            stored[match[1]!] = values[Number(match[2]) - 1];
          }
          if (setClause.includes("archived_at = NULL")) stored.archived_at = null;
        }
        return { rows: [] };
      }
      const live = sql.match(/FROM (cwos_\w+)/);
      if (!live) return { rows: [] };
      const table = live[1]!;
      return { rows: (rows.get(table) ?? []).map((row) => distort(row)) as T[] };
    },
    release() {},
  };
  return { connect: async () => connection, queries };
}

function distort(row: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row, archived_at: null };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && DATE_COLUMNS.has(key)) next[key] = value.slice(0, 10);
    else if (typeof value === "string" && TIMESTAMP_COLUMNS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(value)) next[key] = new Date(`${value}T00:00:00.000Z`);
    else if (key === "metadata" && typeof value === "string") {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      next[key] = Object.fromEntries(Object.entries(parsed).reverse());
    } else if (key === "kinds" && typeof value === "string") next[key] = JSON.parse(value);
  }
  return next;
}
