import type { CustomerWorkOsV2State } from "./platform.js";

export const COMPANY_OVERVIEW_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

export type CompanySourceStatus = "FRESH" | "STALE" | "UNKNOWN";

export interface CompanyOverviewSource {
  kind: "W04_DELIVERY_FIXTURE" | "W05_RENEWAL_CANDIDATE" | "WORK_FOLLOW_UP";
  recordId: string;
  revisionId: string | null;
  sourceHash: string | null;
  evidenceRefs: string[];
  observedAt: string | null;
  sourceOccurredAt: string | null;
  freshness: CompanySourceStatus;
}

export interface CompanyOverviewGroup {
  status: CompanySourceStatus;
  candidateCount: number | null;
  quantityTotals: Record<string, string> | null;
  sources: CompanyOverviewSource[];
}

export interface CompanyOverview {
  workspaceId: string;
  asOf: string;
  freshnessThresholdMs: number;
  authority: "LOCAL_CANDIDATE_ONLY";
  revenue: CompanyOverviewGroup;
  purchases: CompanyOverviewGroup;
  receivables: CompanyOverviewGroup;
  delivery: CompanyOverviewGroup;
  renewals: CompanyOverviewGroup;
  work: CompanyOverviewGroup;
}

/** Freshness uses the supplied fixed `asOf` clock and only source-specific observedAt values. */
function freshness(observedAt: string | null, asOfMs: number): CompanySourceStatus {
  if (observedAt === null) return "UNKNOWN";
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > asOfMs) return "UNKNOWN";
  return asOfMs - observedMs > COMPANY_OVERVIEW_FRESHNESS_MS ? "STALE" : "FRESH";
}

function group(sources: CompanyOverviewSource[], candidateCount: number | null, quantityTotals: Record<string, string> | null): CompanyOverviewGroup {
  const status: CompanySourceStatus =
    sources.length === 0 || sources.some((source) => source.freshness === "UNKNOWN")
      ? (sources.some((source) => source.freshness === "STALE") ? "STALE" : "UNKNOWN")
      : sources.some((source) => source.freshness === "STALE")
        ? "STALE"
        : "FRESH";
  return { status, candidateCount, quantityTotals, sources };
}

function uniqueRefs(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function exactTotals(
  records: readonly { quantities: readonly { ordered: number; delivered: number; accepted: number }[] }[],
): Record<string, string> | null {
  if (records.length === 0) return null;
  const totals = { ordered: 0n, delivered: 0n, accepted: 0n };
  for (const record of records) {
    for (const quantity of record.quantities) {
      totals.ordered += BigInt(quantity.ordered);
      totals.delivered += BigInt(quantity.delivered);
      totals.accepted += BigInt(quantity.accepted);
    }
  }
  return {
    ordered: totals.ordered.toString(),
    delivered: totals.delivered.toString(),
    accepted: totals.accepted.toString(),
  };
}

export function buildCompanyOverview(
  state: CustomerWorkOsV2State,
  workspaceId: string,
  asOf: string,
): CompanyOverview {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) throw new TypeError("asOf must be a valid ISO timestamp");
  if (state.workspaceId !== workspaceId) throw new TypeError("workspaceId does not match source state");

  const deliveryOrders = (state.delivery?.orders ?? []).filter((order) => order.workspaceId === workspaceId);
  const deliverySources = deliveryOrders.flatMap((order) => {
    const latest = [...order.revisions].sort((a, b) => b.version - a.version)[0];
    if (!latest) return [];
    const sourceEvent = state.inbox.events.find(
      (event) => event.id === order.sourceEventId && event.workspaceId === workspaceId,
    );
    return [{
      kind: "W04_DELIVERY_FIXTURE" as const,
      recordId: order.id,
      revisionId: latest.revisionId,
      sourceHash: latest.contentHash,
      evidenceRefs: uniqueRefs([order.sourceEventId, ...latest.citationRefs]),
      observedAt: null,
      sourceOccurredAt: sourceEvent?.occurredAt ?? null,
      freshness: freshness(null, asOfMs),
    }];
  });
  const latestQuantities = deliveryOrders.flatMap((order) => {
    const latest = [...order.revisions].sort((a, b) => b.version - a.version)[0];
    return latest ? [{ quantities: latest.quantities }] : [];
  });

  const renewalDrafts = (state.renewals?.drafts ?? []).filter((draft) => draft.workspaceId === workspaceId);
  const renewalSources = renewalDrafts.flatMap((draft) => {
    const latest = [...draft.revisions].sort((a, b) => b.version - a.version)[0];
    if (!latest) return [];
    const observedAt = latest.observedAt;
    return [{
      kind: "W05_RENEWAL_CANDIDATE" as const,
      recordId: draft.id,
      revisionId: latest.revisionId,
      sourceHash: latest.sourceHash,
      evidenceRefs: uniqueRefs(latest.citations.map((citation) => citation.clauseId)),
      observedAt,
      sourceOccurredAt: null,
      freshness: freshness(observedAt, asOfMs),
    }];
  });

  const workItems = state.followUps.items.filter((item) => item.workspaceId === workspaceId);
  const workSources = workItems.map((item) => ({
    kind: "WORK_FOLLOW_UP" as const,
    recordId: item.id,
    revisionId: null,
    sourceHash: null,
    evidenceRefs: uniqueRefs([item.sourceEventId, ...item.evidenceRefs]),
    observedAt: null,
    sourceOccurredAt: null,
    freshness: "UNKNOWN" as const,
  }));

  const unknownFinancial = (): CompanyOverviewGroup => ({
    status: "UNKNOWN",
    candidateCount: null,
    quantityTotals: null,
    sources: [],
  });

  return {
    workspaceId,
    asOf: new Date(asOfMs).toISOString(),
    freshnessThresholdMs: COMPANY_OVERVIEW_FRESHNESS_MS,
    authority: "LOCAL_CANDIDATE_ONLY",
    revenue: unknownFinancial(),
    purchases: unknownFinancial(),
    receivables: unknownFinancial(),
    delivery: group(deliverySources, deliverySources.length, exactTotals(latestQuantities)),
    renewals: group(renewalSources, renewalSources.length, null),
    work: group(workSources, workItems.length, null),
  };
}
