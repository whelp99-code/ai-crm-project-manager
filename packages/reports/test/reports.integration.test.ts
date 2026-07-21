import { describe, expect, it } from "vitest";
import {
  ReportDomainError,
  ReportService,
  type AiActionEntry,
  type FinalReportSnapshot,
  type SubmitReportInput,
} from "../src/index.js";

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportDomainError);
    expect((error as ReportDomainError).code).toBe(code);
  }
}

function validSnapshot(overrides: Partial<FinalReportSnapshot> = {}): FinalReportSnapshot {
  return {
    goalVsResult: { goal: "Ship v1 launch", result: "Launched on schedule", met: true },
    deliverables: [{ deliverableId: "d-1", title: "Landing page", state: "approved", accepted: true }],
    scheduleVariance: { planned: 30, actual: 32, variance: 2 },
    scopeVariance: { planned: 10, actual: 10, variance: 0 },
    costVariance: { planned: 1000, actual: 950, variance: -50 },
    riskVariance: { materializedRiskIds: ["risk-1"], figure: { planned: 2, actual: 1, variance: -1 } },
    financialImpact: { revenueKrw: "5000000", costKrw: "3000000", profitabilityKrw: "2000000", asOf: "2026-07-01" },
    aiActionHistory: [
      { at: "2026-06-01T09:00:00Z", principalId: "ai-planner", kind: "plan", summary: "planned rollout" },
      { at: "2026-06-15T09:00:00Z", principalId: "ai-executor", kind: "execute", summary: "executed rollout" },
    ],
    exceptions: [{ id: "exc-1", title: "vendor delay", severity: "low", status: "resolved" }],
    evidenceLinks: [{ claim: "revenue figure", objectKey: "reports/2026/rev.csv", version: "v1", digest: "sha256:abc" }],
    ...overrides,
  };
}

function submitInput(id: string, overrides: Partial<SubmitReportInput> = {}): SubmitReportInput {
  return {
    id,
    workspaceId: "ws-1",
    projectId: "proj-1",
    submittedByPrincipalId: "ai-submitter",
    submittedAt: "2026-07-01T10:00:00Z",
    snapshot: validSnapshot(),
    ...overrides,
  };
}

function service(): ReportService {
  return new ReportService();
}

describe("ReportService — submitReport validation", () => {
  it("accepts a valid submission with all ten AC-13 fields present and populates snapshotHash", () => {
    const svc = service();
    const report = svc.submitReport(submitInput("rpt-1"));
    expect(report.status).toBe("SUBMITTED");
    expect(report.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects inconsistent variance figures", () => {
    const svc = service();
    expectCode(
      () =>
        svc.submitReport(
          submitInput("rpt-2", { snapshot: validSnapshot({ scheduleVariance: { planned: 30, actual: 32, variance: 5 } }) }),
        ),
      "INCONSISTENT_VARIANCE",
    );
  });

  it("rejects non-chronological aiActionHistory", () => {
    const svc = service();
    const history: AiActionEntry[] = [
      { at: "2026-06-15T09:00:00Z", principalId: "ai-executor", kind: "execute", summary: "executed rollout" },
      { at: "2026-06-01T09:00:00Z", principalId: "ai-planner", kind: "plan", summary: "planned rollout" },
    ];
    expectCode(
      () => svc.submitReport(submitInput("rpt-3", { snapshot: validSnapshot({ aiActionHistory: history }) })),
      "NON_CHRONOLOGICAL",
    );
  });

  it("rejects an empty deliverables list", () => {
    const svc = service();
    expectCode(
      () => svc.submitReport(submitInput("rpt-4", { snapshot: validSnapshot({ deliverables: [] }) })),
      "MISSING_DELIVERABLES",
    );
  });

  it("rejects an empty evidenceLinks list", () => {
    const svc = service();
    expectCode(
      () => svc.submitReport(submitInput("rpt-5", { snapshot: validSnapshot({ evidenceLinks: [] }) })),
      "MISSING_EVIDENCE",
    );
  });

  it("rejects inconsistent financial impact figures", () => {
    const svc = service();
    expectCode(
      () =>
        svc.submitReport(
          submitInput("rpt-6", {
            snapshot: validSnapshot({
              financialImpact: { revenueKrw: "5000000", costKrw: "3000000", profitabilityKrw: "1000000", asOf: "2026-07-01" },
            }),
          }),
        ),
      "INCONSISTENT_FINANCIALS",
    );
  });

  it("rejects duplicate report ids", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-7"));
    expectCode(() => svc.submitReport(submitInput("rpt-7")), "DUPLICATE_ID");
  });
});

describe("ReportService — immutability", () => {
  it("verifyImmutable returns true right after submission", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-10"));
    expect(svc.verifyImmutable("ws-1", "rpt-10")).toBe(true);
  });

  it("getReport returns a clone whose mutation does not affect stored state", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-11"));
    const first = svc.getReport("ws-1", "rpt-11");
    first.snapshot.goalVsResult.result = "tampered";
    first.snapshot.deliverables.push({ deliverableId: "rogue", title: "rogue", state: "pending", accepted: false });
    const second = svc.getReport("ws-1", "rpt-11");
    expect(second.snapshot.goalVsResult.result).toBe("Launched on schedule");
    expect(second.snapshot.deliverables).toHaveLength(1);
  });
});

describe("ReportService — approve / reject", () => {
  it("approves a submitted report", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-20"));
    const approved = svc.approveReport("ws-1", "rpt-20", "cfo-approver", "2026-07-02T10:00:00Z");
    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedByPrincipalId).toBe("cfo-approver");
  });

  it("rejects approval when approver equals submitter (SoD violation)", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-21"));
    expectCode(() => svc.approveReport("ws-1", "rpt-21", "ai-submitter", "2026-07-02T10:00:00Z"), "SOD_VIOLATION");
  });

  it("rejects approval when the report is not SUBMITTED", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-22"));
    svc.approveReport("ws-1", "rpt-22", "cfo-approver", "2026-07-02T10:00:00Z");
    expectCode(() => svc.approveReport("ws-1", "rpt-22", "cfo-approver-2", "2026-07-03T10:00:00Z"), "INVALID_STATE");
  });

  it("requires a non-empty rejection reason", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-23"));
    expectCode(() => svc.rejectReport("ws-1", "rpt-23", "cfo-approver", "2026-07-02T10:00:00Z", "  "), "REJECTION_REASON_REQUIRED");
  });

  it("records the rejection reason and decision metadata", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-24"));
    const rejected = svc.rejectReport("ws-1", "rpt-24", "cfo-approver", "2026-07-02T10:00:00Z", "financials do not reconcile");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("financials do not reconcile");
    expect(rejected.decidedByPrincipalId).toBe("cfo-approver");
  });

  it("rejects rejection when decider equals submitter (SoD violation)", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-25"));
    expectCode(() => svc.rejectReport("ws-1", "rpt-25", "ai-submitter", "2026-07-02T10:00:00Z", "not good"), "SOD_VIOLATION");
  });
});

describe("ReportService — follow-up actions", () => {
  it("cannot add a follow-up while the report is still SUBMITTED", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-30"));
    expectCode(
      () =>
        svc.addFollowUp({
          id: "fu-1",
          workspaceId: "ws-1",
          reportId: "rpt-30",
          title: "fix budget line",
          description: "correct the cost variance",
          createdByPrincipalId: "ai-submitter",
          createdAt: "2026-07-02T10:00:00Z",
        }),
      "INVALID_STATE",
    );
  });

  it("can add a follow-up after the report is REJECTED", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-31"));
    svc.rejectReport("ws-1", "rpt-31", "cfo-approver", "2026-07-02T10:00:00Z", "needs rework");
    const followUp = svc.addFollowUp({
      id: "fu-2",
      workspaceId: "ws-1",
      reportId: "rpt-31",
      title: "fix budget line",
      description: "correct the cost variance",
      createdByPrincipalId: "cfo-approver",
      createdAt: "2026-07-02T11:00:00Z",
    });
    expect(followUp.status).toBe("OPEN");
  });

  it("completeFollowUp transitions OPEN to DONE", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-32"));
    svc.approveReport("ws-1", "rpt-32", "cfo-approver", "2026-07-02T10:00:00Z");
    svc.addFollowUp({
      id: "fu-3",
      workspaceId: "ws-1",
      reportId: "rpt-32",
      title: "archive evidence",
      description: "move evidence to cold storage",
      createdByPrincipalId: "cfo-approver",
      createdAt: "2026-07-02T11:00:00Z",
    });
    const done = svc.completeFollowUp("ws-1", "fu-3", "ops-lead", "2026-07-03T09:00:00Z");
    expect(done.status).toBe("DONE");
  });

  it("rejects completing an already-DONE follow-up", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-33"));
    svc.approveReport("ws-1", "rpt-33", "cfo-approver", "2026-07-02T10:00:00Z");
    svc.addFollowUp({
      id: "fu-4",
      workspaceId: "ws-1",
      reportId: "rpt-33",
      title: "archive evidence",
      description: "move evidence to cold storage",
      createdByPrincipalId: "cfo-approver",
      createdAt: "2026-07-02T11:00:00Z",
    });
    svc.completeFollowUp("ws-1", "fu-4", "ops-lead", "2026-07-03T09:00:00Z");
    expectCode(() => svc.completeFollowUp("ws-1", "fu-4", "ops-lead", "2026-07-04T09:00:00Z"), "INVALID_STATE");
  });

  it("lists follow-ups for a report via followUpsFor", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-34"));
    svc.approveReport("ws-1", "rpt-34", "cfo-approver", "2026-07-02T10:00:00Z");
    svc.addFollowUp({
      id: "fu-5",
      workspaceId: "ws-1",
      reportId: "rpt-34",
      title: "archive evidence",
      description: "move evidence to cold storage",
      createdByPrincipalId: "cfo-approver",
      createdAt: "2026-07-02T11:00:00Z",
    });
    expect(svc.followUpsFor("ws-1", "rpt-34")).toHaveLength(1);
  });
});

describe("ReportService — AC-13 per-field echo", () => {
  it("echoes every snapshot field (a)-(j) exactly as submitted", () => {
    const svc = service();
    const input = submitInput("rpt-40");
    svc.submitReport(input);
    const stored = svc.getReport("ws-1", "rpt-40");

    // (a) goalVsResult
    expect(stored.snapshot.goalVsResult).toEqual(input.snapshot.goalVsResult);
    // (b) deliverables
    expect(stored.snapshot.deliverables).toEqual(input.snapshot.deliverables);
    // (c) scheduleVariance
    expect(stored.snapshot.scheduleVariance).toEqual(input.snapshot.scheduleVariance);
    // (d) scopeVariance
    expect(stored.snapshot.scopeVariance).toEqual(input.snapshot.scopeVariance);
    // (e) costVariance
    expect(stored.snapshot.costVariance).toEqual(input.snapshot.costVariance);
    // (f) riskVariance
    expect(stored.snapshot.riskVariance).toEqual(input.snapshot.riskVariance);
    // (g) financialImpact
    expect(stored.snapshot.financialImpact).toEqual(input.snapshot.financialImpact);
    // (h) aiActionHistory
    expect(stored.snapshot.aiActionHistory).toEqual(input.snapshot.aiActionHistory);
    // (i) exceptions
    expect(stored.snapshot.exceptions).toEqual(input.snapshot.exceptions);
    // (j) evidenceLinks
    expect(stored.snapshot.evidenceLinks).toEqual(input.snapshot.evidenceLinks);
  });
});

describe("ReportService — cross-workspace", () => {
  it("denies access to a report from another workspace", () => {
    const svc = service();
    svc.submitReport(submitInput("rpt-50"));
    expectCode(() => svc.getReport("ws-2", "rpt-50"), "CROSS_WORKSPACE");
  });
});
