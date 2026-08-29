import {
  CustomerWorkOsV25Error,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  copy,
  deterministicHash,
  mapById,
  required,
  sorted,
  type AutomationActor,
} from "./shared.js";

export interface ManagerEngagement {
  id: string;
  name: string;
  stage: string;
  health: "normal" | "warning" | "critical";
  lastActivityAt: string | null;
  nextActionCount: number;
  forecastRevenueKrw: string;
  estimateAtCompletionKrw: string;
  forecastMarginBps: number;
}

export interface ManagerCommitment {
  id: string;
  engagementId: string;
  description: string;
  dueAt: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
}

export interface ManagerFinancialItem {
  id: string;
  engagementId: string | null;
  direction: "IN" | "OUT";
  lifecycle: string;
  grossAmountKrw: string;
  settledAmountKrw: string;
  contractualDueDate: string | null;
  expectedDate: string;
}

export interface ManagerChangeRequest {
  id: string;
  engagementId: string;
  description: string;
  status: "ANALYZED" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED";
  priceImpactKrw: string;
}

export interface ManagerAsset {
  id: string;
  engagementId: string;
  name: string;
  renewalDate: string | null;
  status: string;
}

export interface ManagerClarification {
  id: string;
  sourceId: string;
  prompt: string;
  createdAt: string;
  status: "OPEN" | "ANSWERED" | "DEFERRED" | "CANCELLED";
}

export interface ManagerSnapshot {
  workspaceId: string;
  asOf: string;
  engagements: ManagerEngagement[];
  commitments: ManagerCommitment[];
  financialItems: ManagerFinancialItem[];
  changeRequests: ManagerChangeRequest[];
  assets: ManagerAsset[];
  clarifications: ManagerClarification[];
}

export type ManagerFindingKind =
  | "NO_NEXT_ACTION"
  | "OVERDUE_COMMITMENT"
  | "STALE_ENGAGEMENT"
  | "LOW_MARGIN"
  | "OVERDUE_RECEIVABLE"
  | "PAYABLE_DUE_SOON"
  | "NEGATIVE_CASH_WINDOW"
  | "UNAPPROVED_SCOPE_CHANGE"
  | "RENEWAL_DUE"
  | "CLARIFICATION_BACKLOG";

export interface ManagerFinding {
  id: string;
  workspaceId: string;
  kind: ManagerFindingKind;
  severity: "INFO" | "WARNING" | "CRITICAL";
  engagementId: string | null;
  title: string;
  explanation: string;
  recommendedAction: string;
  evidenceRefs: string[];
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  createdAt: string;
  version: number;
}

export interface DailyBrief {
  id: string;
  workspaceId: string;
  asOf: string;
  headline: string;
  criticalFindingIds: string[];
  warningFindingIds: string[];
  infoFindingIds: string[];
  dueTodayCommitmentIds: string[];
  expectedIn7DaysKrw: string;
  expectedOut7DaysKrw: string;
  netCash7DaysKrw: string;
  openClarifications: number;
  version: number;
}

export interface AiManagerState {
  schemaVersion: 1;
  findings: ManagerFinding[];
  briefs: DailyBrief[];
}

function money(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new CustomerWorkOsV25Error("INVALID_MONEY", `${field} must be an integer KRW string`);
  return BigInt(value);
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function isActiveStage(stage: string): boolean {
  return !["CLOSED", "LOST", "CANCELLED"].includes(stage);
}

export class AiManagerService {
  private findings = new Map<string, ManagerFinding>();
  private briefs = new Map<string, DailyBrief>();

  runDaily(
    snapshot: ManagerSnapshot,
    thresholds: { staleDays: number; marginFloorBps: number; clarificationAgeDays: number } = {
      staleDays: 7,
      marginFloorBps: 1500,
      clarificationAgeDays: 1,
    },
    actor: AutomationActor,
  ): DailyBrief {
    assertHumanOrService(actor);
    assertWorkspace(actor, snapshot.workspaceId);
    const asOf = new Date(snapshot.asOf);
    if (!Number.isFinite(asOf.getTime())) throw new CustomerWorkOsV25Error("INVALID_DATE", "manager snapshot asOf is invalid");
    const runFindings: ManagerFinding[] = [];
    const add = (input: Omit<ManagerFinding, "id" | "workspaceId" | "status" | "createdAt" | "version">) => {
      const finding: ManagerFinding = {
        ...copy(input),
        id: `manager-finding-${deterministicHash({ asOf: snapshot.asOf, input }).slice(-16)}`,
        workspaceId: snapshot.workspaceId,
        status: "OPEN",
        createdAt: snapshot.asOf,
        version: 1,
      };
      const existing = this.findings.get(finding.id);
      if (!existing || existing.status === "RESOLVED") this.findings.set(finding.id, finding);
      runFindings.push(copy(existing && existing.status !== "RESOLVED" ? existing : finding));
    };

    for (const engagement of snapshot.engagements) {
      if (!isActiveStage(engagement.stage)) continue;
      if (engagement.nextActionCount === 0) {
        add({
          kind: "NO_NEXT_ACTION",
          severity: "CRITICAL",
          engagementId: engagement.id,
          title: `${engagement.name}: 다음 행동 없음`,
          explanation: "진행 중인 고객사업에 완료되지 않은 다음 행동이 없습니다.",
          recommendedAction: "고객 회신, 내부 확인 또는 파트너 후속 작업 중 하나를 등록하세요.",
          evidenceRefs: [`engagement://${engagement.id}`],
        });
      }
      if (engagement.lastActivityAt && daysBetween(engagement.lastActivityAt, snapshot.asOf) > thresholds.staleDays) {
        add({
          kind: "STALE_ENGAGEMENT",
          severity: "WARNING",
          engagementId: engagement.id,
          title: `${engagement.name}: ${thresholds.staleDays}일 이상 정체`,
          explanation: `마지막 활동이 ${engagement.lastActivityAt}입니다.`,
          recommendedAction: "고객 또는 파트너의 현재 상태를 확인하고 다음 일정을 확정하세요.",
          evidenceRefs: [`engagement://${engagement.id}/activity`],
        });
      }
      if (engagement.forecastMarginBps < thresholds.marginFloorBps) {
        add({
          kind: "LOW_MARGIN",
          severity: engagement.forecastMarginBps < 0 ? "CRITICAL" : "WARNING",
          engagementId: engagement.id,
          title: `${engagement.name}: 예상 이익률 하락`,
          explanation: `예상 이익률은 ${(engagement.forecastMarginBps / 100).toFixed(2)}%입니다.`,
          recommendedAction: "남은 원가, 무상 추가업무와 추가계약 가능성을 검토하세요.",
          evidenceRefs: [`engagement://${engagement.id}/finance`],
        });
      }
    }

    const dueTodayCommitmentIds: string[] = [];
    for (const commitment of snapshot.commitments) {
      if (["DONE", "CANCELLED"].includes(commitment.status)) continue;
      const dueDays = daysBetween(snapshot.asOf, commitment.dueAt);
      if (dueDays < 0) {
        add({
          kind: "OVERDUE_COMMITMENT",
          severity: "CRITICAL",
          engagementId: commitment.engagementId,
          title: `기한 초과: ${commitment.description}`,
          explanation: `약속 기한은 ${commitment.dueAt}입니다.`,
          recommendedAction: "즉시 처리하거나 고객과 새 기한을 합의하세요.",
          evidenceRefs: [`commitment://${commitment.id}`],
        });
      } else if (dueDays === 0) {
        dueTodayCommitmentIds.push(commitment.id);
      }
    }

    let incoming7 = 0n;
    let outgoing7 = 0n;
    for (const item of snapshot.financialItems) {
      if (item.lifecycle === "CANCELLED") continue;
      const gross = money(item.grossAmountKrw, "grossAmountKrw");
      const settled = money(item.settledAmountKrw, "settledAmountKrw");
      const remaining = gross - settled;
      if (remaining < 0n) throw new CustomerWorkOsV25Error("FINANCE_INVARIANT", "settled amount exceeds gross amount");
      const date = item.contractualDueDate ?? item.expectedDate;
      const dueDays = daysBetween(snapshot.asOf, date);
      if (dueDays >= 0 && dueDays <= 7) {
        if (item.direction === "IN") incoming7 += remaining;
        else outgoing7 += remaining;
      }
      if (item.direction === "IN" && remaining > 0n && dueDays < 0) {
        add({
          kind: "OVERDUE_RECEIVABLE",
          severity: "CRITICAL",
          engagementId: item.engagementId,
          title: "연체 미수금 발생",
          explanation: `${remaining.toString()}원 수금기일이 지났습니다.`,
          recommendedAction: "고객 회계 담당자 확인과 회신 초안을 준비하세요.",
          evidenceRefs: [`financial-item://${item.id}`],
        });
      }
      if (item.direction === "OUT" && remaining > 0n && dueDays >= 0 && dueDays <= 7) {
        add({
          kind: "PAYABLE_DUE_SOON",
          severity: "WARNING",
          engagementId: item.engagementId,
          title: "7일 이내 지급 예정",
          explanation: `${remaining.toString()}원 지급 예정입니다.`,
          recommendedAction: "입금 일정과 지급승인·증빙을 확인하세요.",
          evidenceRefs: [`financial-item://${item.id}`],
        });
      }
    }
    if (incoming7 - outgoing7 < 0n) {
      add({
        kind: "NEGATIVE_CASH_WINDOW",
        severity: "CRITICAL",
        engagementId: null,
        title: "향후 7일 순현금이 음수입니다",
        explanation: `예상 입금 ${incoming7}원, 예상 출금 ${outgoing7}원입니다.`,
        recommendedAction: "지급일 조정, 수금 독촉 또는 운영자금 확보를 검토하세요.",
        evidenceRefs: ["finance://forecast/7d"],
      });
    }

    for (const change of snapshot.changeRequests) {
      if (["ANALYZED", "AWAITING_APPROVAL"].includes(change.status)) {
        add({
          kind: "UNAPPROVED_SCOPE_CHANGE",
          severity: "CRITICAL",
          engagementId: change.engagementId,
          title: `미승인 범위 변경: ${change.description}`,
          explanation: `추가 매출 영향 ${change.priceImpactKrw}원이 아직 승인되지 않았습니다.`,
          recommendedAction: "무상 처리, 예비비 또는 추가견적 중 하나를 승인하세요.",
          evidenceRefs: [`change-request://${change.id}`],
        });
      }
    }

    for (const asset of snapshot.assets) {
      if (!asset.renewalDate || asset.status === "RETIRED") continue;
      const renewalDays = daysBetween(snapshot.asOf, asset.renewalDate);
      if (renewalDays >= 0 && renewalDays <= 90) {
        add({
          kind: "RENEWAL_DUE",
          severity: renewalDays <= 30 ? "CRITICAL" : "WARNING",
          engagementId: asset.engagementId,
          title: `${asset.name}: ${renewalDays}일 내 갱신`,
          explanation: `갱신일은 ${asset.renewalDate}입니다.`,
          recommendedAction: "벤더 단가 확인과 고객 갱신 제안을 준비하세요.",
          evidenceRefs: [`asset://${asset.id}`],
        });
      }
    }

    const oldClarifications = snapshot.clarifications.filter((item) =>
      item.status === "OPEN" && daysBetween(item.createdAt, snapshot.asOf) > thresholds.clarificationAgeDays,
    );
    if (oldClarifications.length > 0) {
      add({
        kind: "CLARIFICATION_BACKLOG",
        severity: "WARNING",
        engagementId: null,
        title: `확인 대기 ${oldClarifications.length}건`,
        explanation: "정확도가 낮아 자동 반영하지 못한 항목이 남아 있습니다.",
        recommendedAction: "Review Inbox에서 선택형 질문에 답해 데이터 품질을 확정하세요.",
        evidenceRefs: oldClarifications.map((item) => `clarification://${item.id}`),
      });
    }

    const critical = runFindings.filter((item) => item.severity === "CRITICAL").map((item) => item.id).sort();
    const warning = runFindings.filter((item) => item.severity === "WARNING").map((item) => item.id).sort();
    const info = runFindings.filter((item) => item.severity === "INFO").map((item) => item.id).sort();
    const brief: DailyBrief = {
      id: `daily-brief-${deterministicHash({ workspaceId: snapshot.workspaceId, asOf: snapshot.asOf }).slice(-16)}`,
      workspaceId: snapshot.workspaceId,
      asOf: snapshot.asOf,
      headline: critical.length > 0
        ? `즉시 확인할 위험 ${critical.length}건, 주의 ${warning.length}건이 있습니다.`
        : warning.length > 0
          ? `즉시 위험은 없고 주의 ${warning.length}건이 있습니다.`
          : "현재 감지된 주요 위험이 없습니다.",
      criticalFindingIds: critical,
      warningFindingIds: warning,
      infoFindingIds: info,
      dueTodayCommitmentIds: dueTodayCommitmentIds.sort(),
      expectedIn7DaysKrw: incoming7.toString(),
      expectedOut7DaysKrw: outgoing7.toString(),
      netCash7DaysKrw: (incoming7 - outgoing7).toString(),
      openClarifications: snapshot.clarifications.filter((item) => item.status === "OPEN").length,
      version: 1,
    };
    this.briefs.set(brief.id, brief);
    return copy(brief);
  }

  acknowledge(findingId: string, actor: AutomationActor): ManagerFinding {
    assertHuman(actor);
    const finding = this.findings.get(findingId);
    if (!finding) throw new CustomerWorkOsV25Error("FINDING_NOT_FOUND", "manager finding not found");
    assertWorkspace(actor, finding.workspaceId);
    if (finding.status !== "OPEN") throw new CustomerWorkOsV25Error("INVALID_STATUS", "only open findings can be acknowledged");
    finding.status = "ACKNOWLEDGED";
    finding.version += 1;
    return copy(finding);
  }

  latestBrief(workspaceId: string): DailyBrief | null {
    return [...this.briefs.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.asOf.localeCompare(left.asOf))[0] ?? null;
  }

  openFindings(workspaceId: string): ManagerFinding[] {
    return [...this.findings.values()]
      .filter((item) => item.workspaceId === workspaceId && item.status !== "RESOLVED")
      .map(copy)
      .sort((left, right) => {
        const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
        return rank[left.severity] - rank[right.severity] || left.title.localeCompare(right.title);
      });
  }

  exportState(): AiManagerState {
    return { schemaVersion: 1, findings: sorted(this.findings.values()), briefs: sorted(this.briefs.values()) };
  }

  hydrateState(input: AiManagerState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported AI manager state");
    this.findings = mapById(input.findings, "managerFinding");
    this.briefs = mapById(input.briefs, "dailyBrief");
  }
}
