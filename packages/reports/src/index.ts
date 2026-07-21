/**
 * Final-report snapshot + follow-up domain (AC-13/AC-14): the report row
 * persists an IMMUTABLE snapshot of goal-vs-result, variances, financial
 * impact, AI action history, exceptions, and evidence links. Once submitted
 * a snapshot can never be mutated in place — only status/decision metadata
 * changes via approve/reject, and follow-up actions are tracked separately.
 */

import { createHash } from "node:crypto";

export class ReportDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReportDomainError";
  }
}

export interface VarianceFigure {
  planned: number;
  actual: number;
  /** actual - planned */
  variance: number;
}

export interface DeliverableStatus {
  deliverableId: string;
  title: string;
  state: "pending" | "in_progress" | "approved" | "rejected";
  accepted: boolean;
}

export interface FinancialImpact {
  /** signed integer KRW string */
  revenueKrw: string;
  /** signed integer KRW string */
  costKrw: string;
  /** signed integer KRW string; revenueKrw - costKrw */
  profitabilityKrw: string;
  asOf: string;
}

export interface AiActionEntry {
  at: string;
  principalId: string;
  kind: "plan" | "execute" | "review" | "exception";
  intentId?: string;
  auditEventId?: string;
  summary: string;
}

export interface ExceptionEntry {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  status: "open" | "resolved";
}

export interface EvidenceLink {
  claim: string;
  objectKey: string;
  version: string;
  digest: string;
}

export interface FinalReportSnapshot {
  /** (a) */
  goalVsResult: { goal: string; result: string; met: boolean };
  /** (b) */
  deliverables: DeliverableStatus[];
  /** (c) */
  scheduleVariance: VarianceFigure;
  /** (d) */
  scopeVariance: VarianceFigure;
  /** (e) */
  costVariance: VarianceFigure;
  /** (f) */
  riskVariance: { materializedRiskIds: string[]; figure: VarianceFigure };
  /** (g) */
  financialImpact: FinancialImpact;
  /** (h) chronological */
  aiActionHistory: AiActionEntry[];
  /** (i) */
  exceptions: ExceptionEntry[];
  /** (j) */
  evidenceLinks: EvidenceLink[];
}

export type ReportStatus = "SUBMITTED" | "APPROVED" | "REJECTED";

export interface FinalReport {
  id: string;
  workspaceId: string;
  projectId: string;
  submittedByPrincipalId: string;
  submittedAt: string;
  status: ReportStatus;
  snapshot: FinalReportSnapshot;
  snapshotHash: string;
  decidedByPrincipalId?: string;
  decidedAt?: string;
  rejectionReason?: string;
}

export type SubmitReportInput = Pick<
  FinalReport,
  "id" | "workspaceId" | "projectId" | "submittedByPrincipalId" | "submittedAt" | "snapshot"
>;

export interface FollowUpAction {
  id: string;
  workspaceId: string;
  reportId: string;
  title: string;
  description: string;
  status: "OPEN" | "DONE";
  createdByPrincipalId: string;
  createdAt: string;
  completedByPrincipalId?: string;
  completedAt?: string;
}

export type AddFollowUpInput = Pick<
  FollowUpAction,
  "id" | "workspaceId" | "reportId" | "title" | "description" | "createdByPrincipalId" | "createdAt"
>;

const SIGNED_INTEGER = /^-?\d+$/;

/** Deterministic JSON stringify with sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot: FinalReportSnapshot): string {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

function assertVarianceConsistent(figure: VarianceFigure, label: string): void {
  if (figure.variance !== figure.actual - figure.planned) {
    throw new ReportDomainError("INCONSISTENT_VARIANCE", `${label} variance must equal actual - planned`);
  }
}

export class ReportService {
  private readonly reports = new Map<string, FinalReport>();
  private readonly followUps = new Map<string, FollowUpAction>();

  submitReport(input: SubmitReportInput): FinalReport {
    if (this.reports.has(input.id)) {
      throw new ReportDomainError("DUPLICATE_ID", `report already exists: ${input.id}`);
    }

    const { snapshot } = input;

    if (snapshot.deliverables.length === 0) {
      throw new ReportDomainError("MISSING_DELIVERABLES", "at least one deliverable is required");
    }
    if (snapshot.evidenceLinks.length === 0) {
      throw new ReportDomainError("MISSING_EVIDENCE", "at least one evidence link is required");
    }
    if (snapshot.aiActionHistory.length === 0) {
      throw new ReportDomainError("NON_CHRONOLOGICAL", "aiActionHistory must be non-empty");
    }

    assertVarianceConsistent(snapshot.scheduleVariance, "schedule");
    assertVarianceConsistent(snapshot.scopeVariance, "scope");
    assertVarianceConsistent(snapshot.costVariance, "cost");
    assertVarianceConsistent(snapshot.riskVariance.figure, "risk");

    for (let i = 1; i < snapshot.aiActionHistory.length; i++) {
      const prev = snapshot.aiActionHistory[i - 1]!;
      const curr = snapshot.aiActionHistory[i]!;
      if (curr.at < prev.at) {
        throw new ReportDomainError("NON_CHRONOLOGICAL", "aiActionHistory must be sorted chronologically by `at`");
      }
    }

    const { revenueKrw, costKrw, profitabilityKrw } = snapshot.financialImpact;
    if (!SIGNED_INTEGER.test(revenueKrw) || !SIGNED_INTEGER.test(costKrw) || !SIGNED_INTEGER.test(profitabilityKrw)) {
      throw new ReportDomainError("INCONSISTENT_FINANCIALS", "financial amounts must be signed-integer KRW strings");
    }
    if (BigInt(profitabilityKrw) !== BigInt(revenueKrw) - BigInt(costKrw)) {
      throw new ReportDomainError("INCONSISTENT_FINANCIALS", "profitabilityKrw must equal revenueKrw - costKrw");
    }

    const snapshotClone = structuredClone(snapshot);
    const report: FinalReport = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      submittedByPrincipalId: input.submittedByPrincipalId,
      submittedAt: input.submittedAt,
      status: "SUBMITTED",
      snapshot: snapshotClone,
      snapshotHash: hashSnapshot(snapshotClone),
    };

    this.reports.set(report.id, Object.freeze(structuredClone(report)));
    return structuredClone(report);
  }

  approveReport(workspaceId: string, reportId: string, principalId: string, decidedAt: string): FinalReport {
    const report = this.requireReport(workspaceId, reportId);
    if (report.status !== "SUBMITTED") {
      throw new ReportDomainError("INVALID_STATE", `report ${reportId} is not SUBMITTED`);
    }
    if (principalId === report.submittedByPrincipalId) {
      throw new ReportDomainError("SOD_VIOLATION", "approver must differ from the submitting principal");
    }

    const next: FinalReport = {
      ...report,
      status: "APPROVED",
      decidedByPrincipalId: principalId,
      decidedAt,
    };
    this.reports.set(reportId, Object.freeze(structuredClone(next)));
    return structuredClone(next);
  }

  rejectReport(workspaceId: string, reportId: string, principalId: string, decidedAt: string, reason: string): FinalReport {
    const report = this.requireReport(workspaceId, reportId);
    if (report.status !== "SUBMITTED") {
      throw new ReportDomainError("INVALID_STATE", `report ${reportId} is not SUBMITTED`);
    }
    if (!reason.trim()) {
      throw new ReportDomainError("REJECTION_REASON_REQUIRED", "rejection requires a non-empty reason");
    }
    if (principalId === report.submittedByPrincipalId) {
      throw new ReportDomainError("SOD_VIOLATION", "decider must differ from the submitting principal");
    }

    const next: FinalReport = {
      ...report,
      status: "REJECTED",
      decidedByPrincipalId: principalId,
      decidedAt,
      rejectionReason: reason,
    };
    this.reports.set(reportId, Object.freeze(structuredClone(next)));
    return structuredClone(next);
  }

  /** Recomputes the snapshot hash from the stored snapshot and compares to the stored hash. */
  verifyImmutable(workspaceId: string, reportId: string): boolean {
    const report = this.requireReport(workspaceId, reportId);
    return hashSnapshot(report.snapshot) === report.snapshotHash;
  }

  getReport(workspaceId: string, reportId: string): FinalReport {
    return structuredClone(this.requireReport(workspaceId, reportId));
  }

  addFollowUp(input: AddFollowUpInput): FollowUpAction {
    const report = this.requireReport(input.workspaceId, input.reportId);
    if (report.status === "SUBMITTED") {
      throw new ReportDomainError("INVALID_STATE", "follow-up actions require a decided report (APPROVED or REJECTED)");
    }
    if (this.followUps.has(input.id)) {
      throw new ReportDomainError("DUPLICATE_ID", `follow-up already exists: ${input.id}`);
    }

    const followUp: FollowUpAction = {
      id: input.id,
      workspaceId: input.workspaceId,
      reportId: input.reportId,
      title: input.title,
      description: input.description,
      status: "OPEN",
      createdByPrincipalId: input.createdByPrincipalId,
      createdAt: input.createdAt,
    };
    this.followUps.set(followUp.id, structuredClone(followUp));
    return structuredClone(followUp);
  }

  completeFollowUp(workspaceId: string, followUpId: string, principalId: string, at: string): FollowUpAction {
    const followUp = this.requireFollowUp(workspaceId, followUpId);
    if (followUp.status !== "OPEN") {
      throw new ReportDomainError("INVALID_STATE", `follow-up ${followUpId} is not OPEN`);
    }
    const next: FollowUpAction = { ...followUp, status: "DONE", completedByPrincipalId: principalId, completedAt: at };
    this.followUps.set(followUpId, structuredClone(next));
    return structuredClone(next);
  }

  followUpsFor(workspaceId: string, reportId: string): FollowUpAction[] {
    this.requireReport(workspaceId, reportId);
    return [...this.followUps.values()]
      .filter((followUp) => followUp.workspaceId === workspaceId && followUp.reportId === reportId)
      .map((followUp) => structuredClone(followUp));
  }

  listReports(workspaceId: string): FinalReport[] {
    return [...this.reports.values()]
      .filter((report) => report.workspaceId === workspaceId)
      .map((report) => structuredClone(report));
  }

  private requireReport(workspaceId: string, reportId: string): FinalReport {
    const report = this.reports.get(reportId);
    if (!report) throw new ReportDomainError("NOT_FOUND", `report not found: ${reportId}`);
    if (report.workspaceId !== workspaceId) {
      throw new ReportDomainError("CROSS_WORKSPACE", "report belongs to another workspace");
    }
    return report;
  }

  private requireFollowUp(workspaceId: string, followUpId: string): FollowUpAction {
    const followUp = this.followUps.get(followUpId);
    if (!followUp) throw new ReportDomainError("NOT_FOUND", `follow-up not found: ${followUpId}`);
    if (followUp.workspaceId !== workspaceId) {
      throw new ReportDomainError("CROSS_WORKSPACE", "follow-up belongs to another workspace");
    }
    return followUp;
  }
}
