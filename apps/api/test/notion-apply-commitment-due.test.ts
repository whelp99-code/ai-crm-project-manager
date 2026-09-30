import { describe, expect, it } from "vitest";
import { CustomerWorkOsService, type ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import { buildOwnerCockpit } from "@ai-crm/reports/customer-work-os";
import type { NotionCwosImportPlan } from "@ai-crm/imports";
import { applyNotionPlanToDomain, type NotionPlanRecord } from "../src/customer-work-os-notion.js";

const WORKSPACE = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const CAPTURED_AT = "2026-09-29T15:03:10.000Z";

function receipt(planId: string): ApprovalReceipt {
  return {
    id: "receipt-due",
    workspaceId: WORKSPACE,
    resourceType: "import_plan",
    resourceId: planId,
    resourceVersion: 2,
    action: "NOTION_IMPORT_APPROVE",
    payloadHash: "unused-by-apply",
    status: "CONSUMED",
    approvedByPrincipalId: "owner",
  };
}

function record(engagements: Array<{ id: string; stage: string; nextAction?: string; targetDate?: string }>): NotionPlanRecord {
  const plan: NotionCwosImportPlan = {
    workspaceId: WORKSPACE,
    snapshotId: "snap",
    snapshotHash: "sha256:snap",
    capturedAt: CAPTURED_AT,
    planHash: `fnv1a32:${engagements.map((item) => item.id).join("-") || "none"}`,
    accounts: [],
    engagements: engagements.map((item) => ({
      id: item.id,
      workspaceId: WORKSPACE,
      legacySourceId: item.id,
      provenance: {},
      projectKey: item.id,
      name: item.id,
      stage: item.stage,
      ...(item.targetDate ? { targetDate: item.targetDate } : {}),
      ...(item.nextAction ? { nextAction: item.nextAction } : {}),
      parties: [],
      artifactRefs: {},
    })),
    activities: [],
    financialItems: [],
    quarantined: [],
    outOfScope: [],
    reconciliation: {
      source: { accounts: 0, projects: engagements.length, activities: 0, finance: 0 },
      imported: { accounts: 0, engagements: engagements.length, activities: 0, financialItems: 0 },
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
    id: "plan-due",
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

describe("notion commitment due dates", () => {
  it("does not invent a due date from capturedAt", () => {
    const service = new CustomerWorkOsService();
    const planned = record([
      { id: "open-1", stage: "DELIVERY", nextAction: "견적 전달" },
      { id: "open-2", stage: "PROPOSAL", nextAction: "통화" },
      { id: "closed", stage: "CLOSED", nextAction: "종료 후 행동" },
      { id: "no-action", stage: "DELIVERY" },
    ]);
    const openWithAction = planned.plan.engagements.filter((item) => item.nextAction && !["CLOSED", "LOST", "CANCELLED"].includes(item.stage));
    applyNotionPlanToDomain({ service, record: planned, principalId: "owner", receipt: receipt(planned.id) });
    const commitments = service.exportState().commitments;
    expect(commitments).toHaveLength(openWithAction.length);
    expect(commitments.every((item) => item.dueAt === null)).toBe(true);
    expect(commitments.some((item) => item.dueAt === "2026-09-29")).toBe(false);
  });

  it("keeps the original Notion stage name on the engagement", () => {
    const service = new CustomerWorkOsService();
    const planned = record([{ id: "buy", stage: "DELIVERY" }]);
    planned.plan.engagements[0]!.sourceStage = "매입발주";
    applyNotionPlanToDomain({ service, record: planned, principalId: "owner", receipt: receipt(planned.id) });
    expect(service.exportState().engagements.map((item) => item.sourceStage)).toEqual(["매입발주"]);
  });

  it("keeps an explicit targetDate", () => {
    const service = new CustomerWorkOsService();
    const planned = record([{ id: "dated", stage: "DELIVERY", nextAction: "검수", targetDate: "2026-10-03" }]);
    applyNotionPlanToDomain({ service, record: planned, principalId: "owner", receipt: receipt(planned.id) });
    expect(service.exportState().commitments.map((item) => item.dueAt)).toEqual(["2026-10-03"]);
  });

  it("does not count a null due date as overdue in the owner cockpit", () => {
    const report = buildOwnerCockpit({
      engagements: [{ id: "eng", projectKey: "P", name: "P", stage: "DELIVERY", health: "normal" }],
      activities: [],
      commitments: [{
        id: "c",
        engagementId: "eng",
        description: "기한 없음",
        dueAt: null,
        status: "OPEN",
        priority: 50,
      }],
      assets: [],
      financialItems: [],
      settlements: [],
    }, "2026-09-30T00:00:00.000Z");
    expect(report.engagements.every((item) => item.overdueCommitments === 0)).toBe(true);
    expect(report.engagements.some((item) => item.warningCodes.includes("COMMITMENT_OVERDUE"))).toBe(false);
  });
});
