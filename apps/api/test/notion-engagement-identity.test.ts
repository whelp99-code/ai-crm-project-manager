import { describe, expect, it, vi } from "vitest";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import { bindExistingEngagementIds, syncApprovedNotionPlan, type NotionSyncConnection } from "../src/customer-work-os-notion-sync.js";
import type { NotionPlanRecord } from "../src/customer-work-os-notion.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const PAGE = "18533ddb-7425-82f8-9e3b-81bfc5ea54ce";
const EXISTING = "engagement-580e2406";
const PLANNED = "engagement-3af71d0d";
const PROJECT_KEY = "202609-GAME-HCI";

function plan(): NotionCwosImportPlan {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    capturedAt: "2026-09-30T00:00:00.000Z",
    planHash: "fnv1a32:bind1",
    accounts: [{
      id: "account-aaaaaaaa", workspaceId: WORKSPACE, legacySourceId: "page-account", provenance: {},
      name: "게임조선", normalizedName: "게임조선", kinds: ["customer"], status: "active",
    }],
    engagements: [{
      id: PLANNED, workspaceId: WORKSPACE, legacySourceId: PAGE, provenance: {},
      projectKey: PROJECT_KEY, name: "게임조선 HCI Renewal", stage: "DELIVERY", engagementType: "renewal",
      sourceStage: "미분류", parties: [], artifactRefs: {},
    }],
    activities: [],
    financialItems: [{
      id: "financial-out-1", workspaceId: WORKSPACE, legacySourceId: "page-finance", provenance: {},
      engagementSourceId: PAGE, accountSourceId: "page-account", direction: "OUT", category: "service",
      lifecycle: "EXPECTED", netAmountKrw: "86300000", vatAmountKrw: "8630000", grossAmountKrw: "94930000",
      expectedDate: "2026-10-01", evidenceRefs: [], sourceFingerprint: "fp",
    }],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 1, projects: 1, activities: 0, finance: 1 },
      imported: { accounts: 1, engagements: 1, activities: 0, financialItems: 1 },
      quarantined: 0,
      outOfScope: { priceLedger: 0 },
      finance: {
        inboundNetKrw: "0", inboundVatKrw: "0", inboundGrossKrw: "0",
        outboundNetKrw: "86300000", outboundVatKrw: "8630000", outboundGrossKrw: "94930000",
      },
      orphanRelations: 0,
      duplicateCandidates: 0,
    },
    readOnlySource: true,
  };
}

function record(planHash = "fnv1a32:bind1"): NotionPlanRecord {
  return {
    id: "notion-plan-test",
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    planHash,
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

function liveEngagement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXISTING,
    workspace_id: WORKSPACE,
    notion_page_id: null,
    notion_parent_page_id: null,
    archived_at: null,
    version: 1,
    synced_version: 1,
    name: "게임조선 HCI Renewal",
    project_key: PROJECT_KEY,
    engagement_type: "delivery",
    stage: "DELIVERY",
    source_stage: null,
    start_date: null,
    target_date: null,
    ...overrides,
  };
}

function poolWith(seed: Record<string, unknown>) {
  const engagements = [seed];
  const finance: Record<string, unknown>[] = [];
  const runs: string[] = [];
  let engagementInserts = 0;
  const connection: NotionSyncConnection = {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const sql = text.trim();
      if (sql.includes("current_database")) return { rows: [{ name: "ai_crm_override_scratch" }] as T[] };
      if (sql.includes("FROM cwos_notion_sync_runs")) {
        return { rows: (runs.length > 0 ? [{ id: runs[0] }] : []) as T[] };
      }
      if (sql.startsWith("INSERT INTO cwos_notion_sync_runs")) {
        runs.push(String(values?.[0]));
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO cwos_engagements")) {
        const key = values?.[engagementColumnIndex(sql, "project_key")];
        if (engagements.some((row) => row.project_key === key)) {
          throw new Error("duplicate key value violates unique constraint cwos_engagements_workspace_id_project_key_key");
        }
        engagementInserts += 1;
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO cwos_financial_items")) {
        const columns = sql.match(/\(([^)]+)\)/)?.[1]?.split(",").map((column) => column.trim()) ?? [];
        const stored: Record<string, unknown> = {};
        columns.forEach((column, index) => { stored[column] = values?.[index]; });
        finance.push(stored);
        return { rows: [] };
      }
      if (sql.includes("FROM cwos_engagements")) return { rows: engagements.map((row) => ({ ...row })) as T[] };
      if (sql.startsWith("INSERT INTO") || sql.startsWith("UPDATE ")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    connect: async () => connection,
    engagementInserts: () => engagementInserts,
    finance,
    runs,
  };
}

function engagementColumnIndex(sql: string, name: string): number {
  const columns = sql.match(/\(([^)]+)\)/)?.[1]?.split(",").map((column) => column.trim()) ?? [];
  return columns.indexOf(name);
}

describe("engagement identity bind", () => {
  it("reuses the existing project_key engagement and binds finance to that id", async () => {
    const pool = poolWith(liveEngagement());
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const report = await syncApprovedNotionPlan({
      pool,
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:bind",
    });
    expect(pool.engagementInserts()).toBe(0);
    expect(report.holdReasons.filter((reason) => reason === "SCHEMA_REJECT")).toEqual([]);
    expect(pool.finance).toHaveLength(1);
    expect(pool.finance[0]?.engagement_id).toBe(EXISTING);
    expect(pool.finance[0]?.id).not.toBe(PLANNED);
    expect(log.mock.calls.some((call) => String(call[0]).includes(PLANNED) && String(call[0]).includes(EXISTING))).toBe(true);
    log.mockRestore();
  });

  it("returns alreadyApplied with zero writes on an unchanged re-run", async () => {
    const pool = poolWith(liveEngagement());
    await syncApprovedNotionPlan({
      pool,
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:bind",
    });
    const again = await syncApprovedNotionPlan({
      pool,
      record: record(),
      principalId: "owner",
      snapshotSha256: "sha256:bind",
    });
    expect(again).toMatchObject({ alreadyApplied: true, inserts: 0, updates: 0, archives: 0, holds: 0 });
    expect(pool.engagementInserts()).toBe(0);
    expect(pool.finance).toHaveLength(1);
  });

  it("prefers the database row when the planned id and the project_key row both exist", () => {
    const plannedLive = {
      kind: "engagement" as const,
      id: PLANNED,
      notionPageId: "other-page",
      pageId: "other-page",
      fields: { project_key: "OTHER", name: "other" },
    };
    const dbLive = {
      kind: "engagement" as const,
      id: EXISTING,
      notionPageId: PAGE,
      pageId: PAGE,
      fields: { project_key: PROJECT_KEY, name: "게임조선 HCI Renewal" },
    };
    const desired = [{
      kind: "engagement" as const,
      id: PLANNED,
      notionPageId: PAGE,
      pageId: PAGE,
      fields: { project_key: PROJECT_KEY, name: "게임조선 HCI Renewal", engagement_id: PLANNED },
    }, {
      kind: "financial_item" as const,
      id: "financial-out-1",
      notionPageId: "page-finance",
      pageId: "page-finance",
      fields: { engagement_id: PLANNED, net_amount_krw: "86300000" },
    }];
    const bound = bindExistingEngagementIds(desired, [plannedLive, dbLive]);
    expect(bound.mappings).toEqual([{ plannedId: PLANNED, resolvedId: EXISTING, via: "notion_page_id" }]);
    expect(bound.desired[0]?.id).toBe(EXISTING);
    expect(bound.desired[1]?.fields.engagement_id).toBe(EXISTING);
  });
});
