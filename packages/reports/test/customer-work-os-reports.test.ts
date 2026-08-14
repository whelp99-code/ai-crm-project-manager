import { describe, expect, it } from "vitest";
import { buildOwnerCockpit } from "../src/customer-work-os-reports.js";
import type { CustomerWorkOsState } from "@ai-crm/domain/customer-work-os";

const WORKSPACE = "workspace-report";

function state(): CustomerWorkOsState {
  return {
    schemaVersion: 1,
    accounts: [
      { id: "customer", workspaceId: WORKSPACE, name: "고객", normalizedName: "고객", kinds: ["customer"], status: "active", version: 1 },
      { id: "vendor", workspaceId: WORKSPACE, name: "벤더", normalizedName: "벤더", kinds: ["vendor"], status: "active", version: 1 },
    ],
    contacts: [],
    engagements: [
      { id: "risk", workspaceId: WORKSPACE, projectKey: "PRJ-1", name: "위험 프로젝트", type: "delivery", stage: "BILLING", health: "warning", ownerPrincipalId: "owner", targetDate: "2026-08-10", version: 1 },
      { id: "stalled", workspaceId: WORKSPACE, projectKey: "PRJ-2", name: "정체 영업", type: "opportunity", stage: "PROPOSAL", health: "normal", ownerPrincipalId: "owner", targetDate: "2026-09-30", version: 1 },
    ],
    parties: [],
    activities: [
      { id: "old", workspaceId: WORKSPACE, engagementId: "stalled", type: "meeting", occurredAt: "2026-08-01T00:00:00Z", summary: "오래된 미팅", evidenceRef: "meeting://old", humanReviewed: true },
    ],
    knowledge: [],
    commitments: [
      { id: "overdue", workspaceId: WORKSPACE, engagementId: "risk", ownerPrincipalId: "owner", description: "수금 확인", dueAt: "2026-08-12", status: "OPEN", priority: 100, financialImpact: true, approvalRequired: false, version: 1 },
    ],
    products: [],
    quotes: [],
    contracts: [],
    deliveryProjects: [],
    changes: [],
    purchaseOrders: [],
    assets: [
      { id: "asset", workspaceId: WORKSPACE, engagementId: "risk", customerAccountId: "customer", productId: "product", purchaseOrderId: "po", serialOrLicenseKey: "SERIAL", status: "ACTIVE", renewalDate: "2026-09-01", version: 1 },
    ],
    financialItems: [
      { id: "revenue", workspaceId: WORKSPACE, engagementId: "risk", accountId: "customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "1000000", vatAmountKrw: "100000", grossAmountKrw: "1100000", expectedDate: "2026-08-20", contractualDueDate: "2026-08-20", revision: 1 },
      { id: "cost", workspaceId: WORKSPACE, engagementId: "risk", accountId: "vendor", direction: "OUT", category: "hardware_cost", lifecycle: "INCURRED", netAmountKrw: "950000", vatAmountKrw: "95000", grossAmountKrw: "1045000", expectedDate: "2026-08-18", contractualDueDate: "2026-08-18", revision: 1 },
    ],
    settlements: [
      { id: "paid", workspaceId: WORKSPACE, financialItemId: "cost", direction: "OUT", amountKrw: "500000", settledAt: "2026-08-13", accountOrCard: "bank", evidenceRef: "bank://paid" },
    ],
    consumedReceiptIds: [],
  };
}

describe("buildOwnerCockpit", () => {
  it("surfaces overdue work, missing next action, stalled deals and project finance risk", () => {
    const report = buildOwnerCockpit(state(), "2026-08-14");
    expect(report.activeEngagementCount).toBe(2);
    expect(report.overdueCommitmentCount).toBe(1);
    expect(report.nextActionMissingCount).toBe(1);
    const risk = report.engagements.find((item) => item.id === "risk")!;
    expect(risk.warningCodes).toContain("TARGET_DATE_OVERDUE");
    expect(risk.warningCodes).toContain("MARGIN_BELOW_10_PERCENT");
    expect(risk.warningCodes).toContain("RECEIVABLE_OPEN");
    expect(risk.warningCodes).toContain("PAYABLE_OPEN");
    expect(risk.warningCodes).toContain("NEGATIVE_PROJECT_CASH");
    expect(risk.forecastProfitKrw).toBe("50000");
    expect(risk.marginBps).toBe(500);
    const stalled = report.engagements.find((item) => item.id === "stalled")!;
    expect(stalled.warningCodes).toContain("NEXT_ACTION_MISSING");
    expect(stalled.warningCodes).toContain("DEAL_STALLED");
  });

  it("computes global AR, AP, cash and 7/30/60/90 day windows", () => {
    const report = buildOwnerCockpit(state(), "2026-08-14");
    expect(report.receivableKrw).toBe("1100000");
    expect(report.payableKrw).toBe("545000");
    expect(report.cashPositionKrw).toBe("-500000");
    expect(report.moneyWindows).toEqual([
      { days: 7, expectedIncomingKrw: "1100000", expectedOutgoingKrw: "545000", netKrw: "555000" },
      { days: 30, expectedIncomingKrw: "1100000", expectedOutgoingKrw: "545000", netKrw: "555000" },
      { days: 60, expectedIncomingKrw: "1100000", expectedOutgoingKrw: "545000", netKrw: "555000" },
      { days: 90, expectedIncomingKrw: "1100000", expectedOutgoingKrw: "545000", netKrw: "555000" },
    ]);
  });

  it("builds a 90/60/30/overdue renewal radar", () => {
    const report = buildOwnerCockpit(state(), "2026-08-14");
    expect(report.renewals).toHaveLength(1);
    expect(report.renewals[0]).toMatchObject({ assetId: "asset", bucket: "30", daysUntilRenewal: 18 });
  });

  it("nets reversal settlements instead of inflating cash", () => {
    const input = state();
    input.settlements.push({ id: "reverse", workspaceId: WORKSPACE, financialItemId: "cost", direction: "OUT", amountKrw: "500000", settledAt: "2026-08-14", accountOrCard: "bank", evidenceRef: "bank://reverse", reversalOfSettlementId: "paid" });
    const report = buildOwnerCockpit(input, "2026-08-14");
    expect(report.payableKrw).toBe("1045000");
    expect(report.cashPositionKrw).toBe("0");
  });
});
