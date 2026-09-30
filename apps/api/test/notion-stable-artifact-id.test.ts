import { describe, expect, it } from "vitest";
import { notionCwosHash, type NotionCwosImportPlan } from "@ai-crm/imports";
import { buildNotionSyncDesired, syncApprovedNotionPlan, type NotionSyncConnection } from "../src/customer-work-os-notion-sync.js";
import type { NotionPlanRecord } from "../src/customer-work-os-notion.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const PAGE = "3ce33ddb-7425-81e9-82d7-f102cd3aa952";
const ENGAGEMENT = "engagement-8a3ae664";
const FILE_PATH = "https://prod-files-secure.s3.us-west-2.amazonaws.com/07333ddb-7425-81ac-9707-0003477af64a/a30cec23-1308-4e20-921c-4841ccd8da4d/quote-legacy-1.pdf";

function signed(expiry: string): string {
  return `${FILE_PATH}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${expiry}&X-Amz-Expires=3600&X-Amz-Signature=${expiry}`;
}

function plan(urls: string[]): NotionCwosImportPlan {
  return {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    capturedAt: "2026-09-30T00:00:00.000Z",
    planHash: "fnv1a32:abc12345",
    accounts: [],
    engagements: [{
      id: ENGAGEMENT,
      workspaceId: WORKSPACE,
      legacySourceId: PAGE,
      provenance: {},
      projectKey: "202609-INSUNG-COWON-SRX340",
      name: "코원에너지 SCADA 방화벽",
      stage: "DELIVERY",
      parties: [],
      artifactRefs: { quote: urls },
    }],
    activities: [],
    financialItems: [],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 0, projects: 1, activities: 0, finance: 0 },
      imported: { accounts: 0, engagements: 1, activities: 0, financialItems: 0 },
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

function record(body: NotionCwosImportPlan, planHash: string): NotionPlanRecord {
  return {
    id: "notion-plan-test",
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:test",
    planHash,
    capturedAt: "2026-09-30T00:00:00.000Z",
    plan: body,
    status: "APPROVED",
    createdByPrincipalId: "owner",
    approvedByPrincipalId: "owner",
    createdAt: "2026-09-30T00:00:00.000Z",
    approvedAt: "2026-09-30T00:00:00.000Z",
    version: 2,
  };
}

function oldArtifactId(storageUri: string): string {
  return `artifact-${notionCwosHash({ engagement: ENGAGEMENT, kind: "quote", storageUri }).slice(-8)}`;
}

function artifactPool(seed: Record<string, unknown>[] = []) {
  const artifacts = seed.map((row) => ({ ...row }));
  let artifactInserts = 0;
  const connection: NotionSyncConnection = {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const sql = text.trim();
      if (sql.includes("current_database")) return { rows: [{ name: "core5_sync_scratch_20260930" }] as T[] };
      if (sql.includes("FROM cwos_notion_sync_runs")) return { rows: [] };
      if (sql.startsWith("INSERT INTO cwos_artifacts")) {
        const columns = sql.match(/\(([^)]+)\)/)?.[1]?.split(",").map((column) => column.trim()) ?? [];
        const stored: Record<string, unknown> = {};
        columns.forEach((column, index) => { stored[column] = values?.[index]; });
        if (typeof stored.metadata === "string") stored.metadata = JSON.parse(stored.metadata);
        const clash = artifacts.some((row) =>
          row.workspace_id === stored.workspace_id
          && row.engagement_id === stored.engagement_id
          && row.artifact_type === stored.artifact_type
          && row.title === stored.title
          && row.version_label === stored.version_label);
        if (clash) throw new Error("duplicate key value violates unique constraint cwos_artifacts_workspace_id_engagement_id_artifact_type_tit_key");
        artifacts.push(stored);
        artifactInserts += 1;
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE cwos_artifacts")) {
        const id = values?.[1];
        const row = artifacts.find((item) => item.id === id);
        if (row && typeof values?.[2] === "string") row.storage_uri = values[2];
        return { rows: [] };
      }
      if (sql.includes("FROM cwos_artifacts")) return { rows: artifacts.map((row) => ({ ...row })) as T[] };
      if (sql.startsWith("INSERT INTO") || sql.startsWith("UPDATE ")) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  return { connect: async () => connection, artifactInserts: () => artifactInserts, artifacts };
}

describe("stable notion artifact identity", () => {
  it("keeps the same artifact id when only the signed URL query changes", () => {
    const first = buildNotionSyncDesired(plan([signed("20260929T034446Z")]), "owner").desired.find((row) => row.kind === "artifact");
    const second = buildNotionSyncDesired(plan([signed("20260930T034446Z")]), "owner").desired.find((row) => row.kind === "artifact");
    expect(first?.id).toBe(second?.id);
    expect(first?.notionPageId).toBe(second?.notionPageId);
    expect(first?.id).not.toBe(oldArtifactId(signed("20260929T034446Z")));
  });

  it("matches a first-load artifact stored under the old signed-URL id instead of inserting", async () => {
    const previous = signed("20260929T034446Z");
    const pool = artifactPool([{
      id: oldArtifactId(previous),
      workspace_id: WORKSPACE,
      engagement_id: ENGAGEMENT,
      notion_page_id: null,
      notion_parent_page_id: null,
      archived_at: null,
      version: 1,
      synced_version: 1,
      artifact_type: "customer_quote",
      title: "quote imported from Notion",
      version_label: "legacy-1",
      status: "REVIEW",
      storage_uri: previous,
      metadata: { legacySourceId: PAGE, importedFrom: "Notion" },
    }]);
    const report = await syncApprovedNotionPlan({
      pool,
      record: record(plan([signed("20260930T034446Z")]), "fnv1a32:resign"),
      principalId: "owner",
      snapshotSha256: "sha256:resign",
    });
    expect(pool.artifactInserts()).toBe(0);
    expect(report.holdReasons.filter((reason) => reason === "SCHEMA_REJECT")).toEqual([]);
    expect(pool.artifacts.map((row) => row.id)).toEqual([oldArtifactId(previous)]);
  });

  it("inserts one row when the page gains a genuinely new file", async () => {
    const previous = signed("20260929T034446Z");
    const pool = artifactPool([{
      id: oldArtifactId(previous),
      workspace_id: WORKSPACE,
      engagement_id: ENGAGEMENT,
      notion_page_id: null,
      notion_parent_page_id: null,
      archived_at: null,
      version: 1,
      synced_version: 1,
      artifact_type: "customer_quote",
      title: "quote imported from Notion",
      version_label: "legacy-1",
      status: "REVIEW",
      storage_uri: previous,
      metadata: { legacySourceId: PAGE, importedFrom: "Notion" },
    }]);
    const report = await syncApprovedNotionPlan({
      pool,
      record: record(plan([signed("20260930T034446Z"), `${FILE_PATH.replace("legacy-1", "legacy-2")}?X-Amz-Date=20260930T034446Z`]), "fnv1a32:newfile"),
      principalId: "owner",
      snapshotSha256: "sha256:newfile",
    });
    expect(pool.artifactInserts()).toBe(1);
    expect(report.holdReasons.filter((reason) => reason === "SCHEMA_REJECT")).toEqual([]);
    expect(pool.artifacts).toHaveLength(2);
  });
});
