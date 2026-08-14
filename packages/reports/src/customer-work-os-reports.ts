export type ReportEngagementStage =
  | "INQUIRY"
  | "DISCOVERY"
  | "PROPOSAL"
  | "NEGOTIATION"
  | "CONTRACTED"
  | "DELIVERY"
  | "ACCEPTANCE"
  | "BILLING"
  | "COLLECTION"
  | "CLOSED"
  | "ON_HOLD"
  | "LOST"
  | "CANCELLED";

export interface ReportEngagement {
  id: string;
  projectKey: string;
  name: string;
  stage: ReportEngagementStage;
  health: "normal" | "warning" | "critical";
  targetDate?: string;
}

export interface ReportActivity {
  engagementId: string;
  occurredAt: string;
}

export interface ReportCommitment {
  id: string;
  engagementId: string;
  description: string;
  dueAt: string;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: number;
  [key: string]: unknown;
}

export interface ReportAsset {
  id: string;
  engagementId: string;
  customerAccountId: string;
  productId: string;
  serialOrLicenseKey: string;
  status: "IN_STOCK" | "ALLOCATED" | "DELIVERED" | "ACTIVE" | "EXPIRED" | "RETIRED";
  renewalDate?: string;
}

export interface ReportFinancialItem {
  id: string;
  engagementId: string | null;
  direction: "IN" | "OUT";
  lifecycle: "PLANNED" | "APPROVED" | "CONFIRMED" | "BILLED" | "INCURRED" | "PARTIAL" | "SETTLED" | "OVERDUE" | "CANCELLED";
  netAmountKrw: string;
  grossAmountKrw: string;
  expectedDate: string;
  contractualDueDate?: string;
}

export interface ReportSettlement {
  id: string;
  financialItemId: string;
  amountKrw: string;
  reversalOfSettlementId?: string;
}

/** Stable read-model boundary. Domain state may contain additional collections. */
export interface CustomerWorkOsReportState {
  engagements: ReportEngagement[];
  activities: ReportActivity[];
  commitments: ReportCommitment[];
  assets: ReportAsset[];
  financialItems: ReportFinancialItem[];
  settlements: ReportSettlement[];
}

export interface MoneyWindow {
  days: 7 | 30 | 60 | 90;
  expectedIncomingKrw: string;
  expectedOutgoingKrw: string;
  netKrw: string;
}

export interface CockpitEngagement {
  id: string;
  projectKey: string;
  name: string;
  stage: ReportEngagement["stage"];
  health: ReportEngagement["health"];
  targetDate?: string;
  latestActivityAt?: string;
  openCommitments: number;
  overdueCommitments: number;
  expectedRevenueKrw: string;
  forecastCostKrw: string;
  forecastProfitKrw: string;
  marginBps: number;
  receivableKrw: string;
  payableKrw: string;
  cashPositionKrw: string;
  warningCodes: string[];
}

export interface RenewalCandidate {
  assetId: string;
  engagementId: string;
  customerAccountId: string;
  productId: string;
  serialOrLicenseKey: string;
  renewalDate: string;
  daysUntilRenewal: number;
  bucket: "OVERDUE" | "30" | "60" | "90";
}

export interface OwnerCockpitReport {
  asOf: string;
  activeEngagementCount: number;
  warningEngagementCount: number;
  overdueCommitmentCount: number;
  nextActionMissingCount: number;
  receivableKrw: string;
  payableKrw: string;
  cashPositionKrw: string;
  moneyWindows: MoneyWindow[];
  engagements: CockpitEngagement[];
  overdueCommitments: ReportCommitment[];
  renewals: RenewalCandidate[];
}

function money(value: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`invalid integer KRW: ${value}`);
  return BigInt(value);
}

function settledAmount(item: ReportFinancialItem, settlements: readonly ReportSettlement[]): bigint {
  return settlements
    .filter((settlement) => settlement.financialItemId === item.id)
    .reduce(
      (sum, settlement) => sum + (settlement.reversalOfSettlementId ? -money(settlement.amountKrw) : money(settlement.amountKrw)),
      0n,
    );
}

function dayStart(value: string): number {
  const timestamp = new Date(`${value.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`invalid report date: ${value}`);
  return timestamp;
}

function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / 86_400_000);
}

function inWindow(date: string, asOf: number, days: number): boolean {
  const target = dayStart(date);
  return target >= asOf && target <= asOf + days * 86_400_000;
}

function effectiveDueDate(item: ReportFinancialItem): string {
  return item.contractualDueDate ?? item.expectedDate;
}

function financeByEngagement(state: CustomerWorkOsReportState, engagementId: string) {
  const items = state.financialItems.filter(
    (item) => item.engagementId === engagementId && item.lifecycle !== "CANCELLED",
  );
  let revenue = 0n;
  let cost = 0n;
  let receivable = 0n;
  let payable = 0n;
  let incomingCash = 0n;
  let outgoingCash = 0n;
  for (const item of items) {
    const net = money(item.netAmountKrw);
    const gross = money(item.grossAmountKrw);
    const settled = settledAmount(item, state.settlements);
    if (item.direction === "IN") {
      revenue += net;
      incomingCash += settled;
      if (["BILLED", "PARTIAL", "OVERDUE", "SETTLED"].includes(item.lifecycle)) receivable += gross - settled;
    } else {
      cost += net;
      outgoingCash += settled;
      if (["CONFIRMED", "INCURRED", "PARTIAL", "OVERDUE", "SETTLED"].includes(item.lifecycle)) payable += gross - settled;
    }
  }
  const profit = revenue - cost;
  return {
    expectedRevenueKrw: revenue.toString(),
    forecastCostKrw: cost.toString(),
    forecastProfitKrw: profit.toString(),
    marginBps: revenue === 0n ? 0 : Number((profit * 10_000n) / revenue),
    receivableKrw: receivable.toString(),
    payableKrw: payable.toString(),
    cashPositionKrw: (incomingCash - outgoingCash).toString(),
  };
}

export function buildOwnerCockpit(state: CustomerWorkOsReportState, asOf: string): OwnerCockpitReport {
  const asOfMs = dayStart(asOf);
  const terminal = new Set<ReportEngagement["stage"]>(["CLOSED", "LOST", "CANCELLED"]);
  const active = state.engagements.filter((engagement) => !terminal.has(engagement.stage));
  const openCommitments = state.commitments.filter((item) => !["DONE", "CANCELLED"].includes(item.status));
  const overdue = openCommitments
    .filter((item) => dayStart(item.dueAt) < asOfMs)
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || right.priority - left.priority);

  const engagements = active
    .map((engagement): CockpitEngagement => {
      const commitments = openCommitments.filter((item) => item.engagementId === engagement.id);
      const overdueCount = commitments.filter((item) => dayStart(item.dueAt) < asOfMs).length;
      const latestActivityAt = state.activities
        .filter((item) => item.engagementId === engagement.id)
        .map((item) => item.occurredAt)
        .sort((left, right) => right.localeCompare(left))[0];
      const finance = financeByEngagement(state, engagement.id);
      const warnings: string[] = [];
      if (commitments.length === 0) warnings.push("NEXT_ACTION_MISSING");
      if (overdueCount > 0) warnings.push("COMMITMENT_OVERDUE");
      if (engagement.health !== "normal") warnings.push(`HEALTH_${engagement.health.toUpperCase()}`);
      if (engagement.targetDate && dayStart(engagement.targetDate) < asOfMs) warnings.push("TARGET_DATE_OVERDUE");
      if (
        latestActivityAt &&
        daysBetween(dayStart(latestActivityAt), asOfMs) >= 7 &&
        ["DISCOVERY", "PROPOSAL", "NEGOTIATION"].includes(engagement.stage)
      ) {
        warnings.push("DEAL_STALLED");
      }
      if (finance.marginBps < 1000 && money(finance.expectedRevenueKrw) > 0n) warnings.push("MARGIN_BELOW_10_PERCENT");
      if (money(finance.receivableKrw) > 0n) warnings.push("RECEIVABLE_OPEN");
      if (money(finance.payableKrw) > 0n) warnings.push("PAYABLE_OPEN");
      if (money(finance.cashPositionKrw) < 0n) warnings.push("NEGATIVE_PROJECT_CASH");
      return {
        id: engagement.id,
        projectKey: engagement.projectKey,
        name: engagement.name,
        stage: engagement.stage,
        health: engagement.health,
        ...(engagement.targetDate ? { targetDate: engagement.targetDate } : {}),
        ...(latestActivityAt ? { latestActivityAt } : {}),
        openCommitments: commitments.length,
        overdueCommitments: overdueCount,
        ...finance,
        warningCodes: warnings,
      };
    })
    .sort(
      (left, right) =>
        right.warningCodes.length - left.warningCodes.length || left.projectKey.localeCompare(right.projectKey),
    );

  const activeItems = state.financialItems.filter((item) => item.lifecycle !== "CANCELLED");
  const totals = activeItems.reduce(
    (current, item) => {
      const gross = money(item.grossAmountKrw);
      const settled = settledAmount(item, state.settlements);
      if (item.direction === "IN") {
        current.cash += settled;
        if (["BILLED", "PARTIAL", "OVERDUE", "SETTLED"].includes(item.lifecycle)) {
          current.receivable += gross - settled;
        }
      } else {
        current.cash -= settled;
        if (["CONFIRMED", "INCURRED", "PARTIAL", "OVERDUE", "SETTLED"].includes(item.lifecycle)) {
          current.payable += gross - settled;
        }
      }
      return current;
    },
    { receivable: 0n, payable: 0n, cash: 0n },
  );

  const moneyWindows = ([7, 30, 60, 90] as const).map((days): MoneyWindow => {
    let incoming = 0n;
    let outgoing = 0n;
    for (const item of activeItems) {
      if (!inWindow(effectiveDueDate(item), asOfMs, days)) continue;
      const outstanding = money(item.grossAmountKrw) - settledAmount(item, state.settlements);
      if (outstanding <= 0n) continue;
      if (item.direction === "IN") incoming += outstanding;
      else outgoing += outstanding;
    }
    return {
      days,
      expectedIncomingKrw: incoming.toString(),
      expectedOutgoingKrw: outgoing.toString(),
      netKrw: (incoming - outgoing).toString(),
    };
  });

  const renewals = state.assets
    .filter(
      (asset): asset is ReportAsset & { renewalDate: string } =>
        Boolean(asset.renewalDate) && !["EXPIRED", "RETIRED"].includes(asset.status),
    )
    .map((asset): RenewalCandidate | undefined => {
      const daysUntilRenewal = daysBetween(asOfMs, dayStart(asset.renewalDate));
      if (daysUntilRenewal > 90) return undefined;
      const bucket: RenewalCandidate["bucket"] =
        daysUntilRenewal < 0 ? "OVERDUE" : daysUntilRenewal <= 30 ? "30" : daysUntilRenewal <= 60 ? "60" : "90";
      return {
        assetId: asset.id,
        engagementId: asset.engagementId,
        customerAccountId: asset.customerAccountId,
        productId: asset.productId,
        serialOrLicenseKey: asset.serialOrLicenseKey,
        renewalDate: asset.renewalDate,
        daysUntilRenewal,
        bucket,
      };
    })
    .filter((item): item is RenewalCandidate => Boolean(item))
    .sort((left, right) => left.daysUntilRenewal - right.daysUntilRenewal);

  return {
    asOf: asOf.slice(0, 10),
    activeEngagementCount: active.length,
    warningEngagementCount: engagements.filter((item) => item.warningCodes.length > 0).length,
    overdueCommitmentCount: overdue.length,
    nextActionMissingCount: engagements.filter((item) => item.warningCodes.includes("NEXT_ACTION_MISSING")).length,
    receivableKrw: totals.receivable.toString(),
    payableKrw: totals.payable.toString(),
    cashPositionKrw: totals.cash.toString(),
    moneyWindows,
    engagements,
    overdueCommitments: structuredClone(overdue),
    renewals,
  };
}
