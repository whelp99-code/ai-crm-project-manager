import { describe, expect, it } from "vitest";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import { syncApprovedNotionPlan, type NotionSyncConnection } from "../src/customer-work-os-notion-sync.js";
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
