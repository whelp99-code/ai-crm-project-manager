import { describe, expect, it } from "vitest";
import {
  buildOwnerCockpit,
  type CustomerWorkOsReportState,
} from "../src/customer-work-os-reports.js";

const WORKSPACE = "workspace-report";

function state(): CustomerWorkOsReportState {
  return {
    engagements: [
      {
        id: "risk",
        projectKey: "PRJ-1",
        name: "위험 프로젝트",
        stage: "BILLING",
        health: "warning",
        targetDate: "2026-08-10",
      },
      {
        id: "stalled",
        projectKey: "PRJ-2",
        name: "정체 영업",
        stage: "PROPOSAL",
        health: "normal",
        targetDate: "2026-09-30",
      },
    ],
    activities: [
      {
        engagementId: "stalled",
        occurredAt: "2026-08-01T00:00:00Z",
      },
    ],
    commitments: [
      {
        id: "overdue",
        workspaceId: WORKSPACE,
        engagementId: "risk",
        ownerPrincipalId: "owner",
        description: "수금 확인",
        dueAt: "2026-08-12",
        status: "OPEN",
        priority: 100,
        financialImpact: true,
        approvalRequired: false,
        version: 1,
      },
    ],
    assets: [
      {
        id: "asset",
        engagementId: "risk",
        customerAccountId: "customer",
        productId: "product",
        serialOrLicenseKey: "SERIAL",
        status: "ACTIVE",
        renewalDate: "2026-09-01",
      },
    ],
    financialItems: [
      {
        id: "revenue",
        engagementId: "risk",
        direction: "IN",
        lifecycle: "BILLED",
        netAmountKrw: "1000000",
        grossAmountKrw: "1100000",
        expectedDate: "2026-08-20",
        contractualDueDate: "2026-08-20",
      },
      {
        id: "cost",
        engagementId: "risk",
        direction: "OUT",
        lifecycle: "INCURRED",
        netAmountKrw: "950000",
        grossAmountKrw: "1045000",
        expectedDate: "2026-08-18",
        contractualDueDate: "2026-08-18",
      },
    ],
    settlements: [
      {
        id: "paid",
        financialItemId: "cost",
        amountKrw: "500000",
      },
    ],
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
    input.settlements.push({
      id: "reverse",
      financialItemId: "cost",
      amountKrw: "500000",
      reversalOfSettlementId: "paid",
    });
    const report = buildOwnerCockpit(input, "2026-08-14");
    expect(report.payableKrw).toBe("1045000");
    expect(report.cashPositionKrw).toBe("0");
  });
});
