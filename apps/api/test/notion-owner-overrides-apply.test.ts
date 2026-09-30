import { describe, expect, it } from "vitest";
import { CustomerWorkOsService, type ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import { applyNotionPlanToDomain, type NotionPlanRecord } from "../src/customer-work-os-notion.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const CAPTURED_AT = "2026-09-30T01:40:53.000Z";

function receipt(): ApprovalReceipt {
  return {
    id: "receipt-overrides",
    workspaceId: WORKSPACE,
    resourceType: "import_plan",
    resourceId: "plan-overrides",
    resourceVersion: 2,
    action: "NOTION_IMPORT_APPROVE",
    payloadHash: "unused-by-apply",
    status: "CONSUMED",
    approvedByPrincipalId: "owner",
  };
}

function record(): NotionPlanRecord {
  const plan: NotionCwosImportPlan = {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:snap",
    capturedAt: CAPTURED_AT,
    planHash: "fnv1a32:overrides",
    accounts: [{
      id: "account-1",
      workspaceId: WORKSPACE,
      legacySourceId: "acct",
      provenance: {},
      name: "굿어스",
      normalizedName: "굿어스",
      kinds: ["partner"],
      status: "active",
    }],
    engagements: [{
      id: "eng-1",
      workspaceId: WORKSPACE,
      legacySourceId: "eng",
      provenance: {},
      projectKey: "P",
      name: "Renewal",
      stage: "DELIVERY",
      engagementType: "renewal",
      parties: [],
      artifactRefs: {},
    }],
    activities: [{
      id: "act-1",
      workspaceId: WORKSPACE,
      legacySourceId: "act",
      provenance: {},
      activityType: "email_in",
      occurredAt: "2026-07-14",
      summary: "계정 활동",
      accountSourceIds: ["acct"],
      projectSourceIds: [],
      attachmentRefs: [],
    }],
    financialItems: [{
      id: "fin-1",
      workspaceId: WORKSPACE,
      legacySourceId: "fin",
      provenance: {},
      engagementSourceId: "eng",
      accountSourceId: "acct",
      direction: "IN",
      category: "contract_revenue",
      lifecycle: "BILLED",
      netAmountKrw: "1000",
      vatAmountKrw: "100",
      grossAmountKrw: "1100",
      expectedDate: null,
      evidenceRefs: [],
      sourceFingerprint: "fp",
    }],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 1, projects: 1, activities: 1, finance: 1 },
      imported: { accounts: 1, engagements: 1, activities: 1, financialItems: 1 },
      quarantined: 0,
      outOfScope: { priceLedger: 0 },
      finance: { inboundNetKrw: "1000", inboundVatKrw: "100", inboundGrossKrw: "1100", outboundNetKrw: "0", outboundVatKrw: "0", outboundGrossKrw: "0" },
      orphanRelations: 0,
      duplicateCandidates: 0,
    },
    readOnlySource: true,
  };
  return {
    id: "plan-overrides",
    workspaceId: WORKSPACE,
    snapshotId: plan.snapshotId,
    snapshotHash: plan.snapshotHash,
    planHash: plan.planHash,
    capturedAt: CAPTURED_AT,
    plan,
    status: "APPROVED",
    createdByPrincipalId: "owner",
    createdAt: CAPTURED_AT,
    version: 2,
  };
}

describe("owner override apply", () => {
  it("keeps a null expected date, records an account-level activity, and uses the override engagement type", () => {
    const service = new CustomerWorkOsService();
    const recorded: Array<{ engagementId: string | null; accountId?: string }> = [];
    const original = service.recordActivity.bind(service);
    service.recordActivity = (input) => {
      recorded.push({ engagementId: input.engagementId, accountId: input.accountId });
      return original(input);
    };
    const result = applyNotionPlanToDomain({ service, record: record(), principalId: "owner", receipt: receipt() });
    expect(result.activities).toBe(1);
    expect(recorded).toEqual([{ engagementId: null, accountId: "account-1" }]);
    const snapshot = service.getEngagementSnapshot(WORKSPACE, "eng-1");
    expect(snapshot.engagement.type).toBe("renewal");
    expect(snapshot.financialItems[0]?.expectedDate).toBeNull();
    expect(snapshot.financialItems[0]?.expectedDate).not.toBe("2026-09-30");
  });
});
