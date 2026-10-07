import { createHash } from "node:crypto";
import {
  CustomerWorkOsV2Error,
  assertHuman,
  assertStepUp,
  copy,
  integer,
  mapValues,
  required,
  sorted,
  type V2Actor,
} from "./shared.js";

export type DeliveryFixtureDecision = "SUBMITTED" | "PARTIAL_ACCEPTED" | "ACCEPTED" | "REJECTED";

export interface DeliveryFixtureQuantity {
  lineId: string;
  ordered: number;
  delivered: number;
  accepted: number;
}

export interface DeliveryFixtureRevision {
  revisionId: string;
  version: number;
  decision: DeliveryFixtureDecision;
  quantities: DeliveryFixtureQuantity[];
  content: string;
  contentHash: string;
  citationRefs: string[];
  reason: string | null;
  recordedByPrincipalId: string;
}

export interface DeliveryFixtureOrder {
  id: string;
  workspaceId: string;
  workItemId: string;
  sourceEventId: string;
  quoteRevision: string;
  revisions: DeliveryFixtureRevision[];
  authoritativeAcceptance: "UNKNOWN";
  paymentEligibility: "UNKNOWN";
  version: number;
}

export interface DeliveryFixtureState {
  schemaVersion: 1;
  orders: DeliveryFixtureOrder[];
}

export interface RecordDeliveryFixtureRevisionInput {
  orderId: string;
  workItemId: string;
  sourceEventId: string;
  quoteRevision: string;
  revisionId: string;
  decision: DeliveryFixtureDecision;
  quantities: DeliveryFixtureQuantity[];
  content: string;
  contentHash: string;
  citationRefs: string[];
  reason?: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function normalizeQuantities(input: DeliveryFixtureQuantity[]): DeliveryFixtureQuantity[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY", "at least one delivery quantity is required");
  }
  const seen = new Set<string>();
  return input.map((line) => {
    const lineId = required(line.lineId, "lineId");
    if (seen.has(lineId)) throw new CustomerWorkOsV2Error("DUPLICATE_ID", `duplicate delivery line ${lineId}`);
    seen.add(lineId);
    const ordered = integer(line.ordered, "orderedQuantity", 1);
    const delivered = integer(line.delivered, "deliveredQuantity");
    const accepted = integer(line.accepted, "acceptedQuantity");
    if (delivered > ordered || accepted > delivered) {
      throw new CustomerWorkOsV2Error("INVALID_DELIVERY_QUANTITY", "accepted <= delivered <= ordered is required");
    }
    return { lineId, ordered, delivered, accepted };
  }).sort((left, right) => left.lineId.localeCompare(right.lineId));
}

function sameQuantities(left: DeliveryFixtureQuantity[], right: DeliveryFixtureQuantity[]): boolean {
  return left.length === right.length && left.every((line, index) => {
    const other = right[index];
    return Boolean(other) &&
      line.lineId === other!.lineId &&
      line.ordered === other!.ordered &&
      line.delivered === other!.delivered &&
      line.accepted === other!.accepted;
  });
}

function validateDecision(
  decision: DeliveryFixtureDecision,
  quantities: DeliveryFixtureQuantity[],
  reason: string | null,
): void {
  if (!["SUBMITTED", "PARTIAL_ACCEPTED", "ACCEPTED", "REJECTED"].includes(decision)) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY_DECISION", "unsupported delivery decision");
  }
  const delivered = quantities.reduce((sum, item) => sum + item.delivered, 0);
  const accepted = quantities.reduce((sum, item) => sum + item.accepted, 0);
  if (decision === "SUBMITTED" && accepted !== 0) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY_DECISION", "a submitted revision cannot contain accepted quantities");
  }
  if (decision === "PARTIAL_ACCEPTED" && !(accepted > 0 && accepted < delivered)) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY_DECISION", "partial acceptance requires 0 < accepted < delivered");
  }
  if (decision === "ACCEPTED" && !(delivered > 0 && accepted === delivered)) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY_DECISION", "accepted delivery requires all delivered quantities accepted");
  }
  if (decision === "REJECTED" && (accepted !== 0 || !reason)) {
    throw new CustomerWorkOsV2Error("INVALID_DELIVERY_DECISION", "rejection requires zero accepted quantities and a reason");
  }
}

export class W04DeliveryFixtureService {
  private orders = new Map<string, DeliveryFixtureOrder>();

  recordRevision(input: RecordDeliveryFixtureRevisionInput, actor: V2Actor): DeliveryFixtureOrder {
    assertHuman(actor);
    assertStepUp(actor);
    const id = required(input.orderId, "orderId");
    const workItemId = required(input.workItemId, "workItemId");
    const sourceEventId = required(input.sourceEventId, "sourceEventId");
    const quoteRevision = required(input.quoteRevision, "quoteRevision");
    const revisionId = required(input.revisionId, "revisionId");
    const content = required(input.content, "content");
    const contentHash = required(input.contentHash, "contentHash");
    if (!HASH_PATTERN.test(contentHash) || createHash("sha256").update(content).digest("hex") !== contentHash) {
      throw new CustomerWorkOsV2Error("DELIVERY_CONTENT_HASH_MISMATCH", "content hash must bind the exact delivered content");
    }
    if (!Array.isArray(input.citationRefs)) {
      throw new CustomerWorkOsV2Error("DELIVERY_CITATION_REQUIRED", "delivery citation references must be an array");
    }
    const citationRefs = [...new Set(input.citationRefs.map((ref) => required(ref, "citationRef")))];
    if (citationRefs.length === 0) throw new CustomerWorkOsV2Error("DELIVERY_CITATION_REQUIRED", "delivery revision requires citation provenance");
    const quantities = normalizeQuantities(input.quantities);
    const reason = input.reason?.trim() || null;
    validateDecision(input.decision, quantities, reason);

    const prior = this.orders.get(id);
    if (prior && prior.workspaceId !== actor.workspaceId) {
      throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace delivery access is forbidden");
    }
    if (prior && (
      prior.workItemId !== workItemId ||
      prior.sourceEventId !== sourceEventId ||
      prior.quoteRevision !== quoteRevision
    )) {
      throw new CustomerWorkOsV2Error("DELIVERY_ORDER_IDENTITY_CONFLICT", "delivery order source identity cannot be changed");
    }
    const existingRevision = prior?.revisions.find((item) => item.revisionId === revisionId);
    if (existingRevision) {
      const same = existingRevision.decision === input.decision &&
        sameQuantities(existingRevision.quantities, quantities) &&
        existingRevision.content === content &&
        existingRevision.contentHash === contentHash &&
        JSON.stringify(existingRevision.citationRefs) === JSON.stringify(citationRefs) &&
        existingRevision.reason === reason &&
        existingRevision.recordedByPrincipalId === actor.principalId;
      if (!same) throw new CustomerWorkOsV2Error("IDEMPOTENCY_CONFLICT", "delivery revision id was reused with different content");
      return copy(prior!);
    }
    if (prior) {
      const originalLines = prior.revisions[0]?.quantities ?? [];
      if (
        originalLines.length !== quantities.length ||
        originalLines.some((line, index) =>
          line.lineId !== quantities[index]?.lineId || line.ordered !== quantities[index]?.ordered,
        )
      ) {
        throw new CustomerWorkOsV2Error("DELIVERY_ORDER_IDENTITY_CONFLICT", "ordered quantities and line identity are immutable");
      }
    }

    const version = (prior?.version ?? 0) + 1;
    const revision: DeliveryFixtureRevision = {
      revisionId,
      version,
      decision: input.decision,
      quantities: copy(quantities),
      content,
      contentHash,
      citationRefs,
      reason,
      recordedByPrincipalId: actor.principalId,
    };
    const order: DeliveryFixtureOrder = {
      id,
      workspaceId: actor.workspaceId,
      workItemId,
      sourceEventId,
      quoteRevision,
      revisions: [...(prior?.revisions ?? []), revision],
      authoritativeAcceptance: "UNKNOWN",
      paymentEligibility: "UNKNOWN",
      version,
    };
    this.orders.set(id, order);
    return copy(order);
  }

  exportState(): DeliveryFixtureState {
    return { schemaVersion: 1, orders: sorted(this.orders.values()) };
  }

  hydrateState(input: DeliveryFixtureState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported delivery fixture state");
    const orders = mapValues(input.orders, "deliveryOrder");
    for (const order of orders.values()) {
      if (
        order.authoritativeAcceptance !== "UNKNOWN" ||
        order.paymentEligibility !== "UNKNOWN" ||
        order.version !== order.revisions.length ||
        order.revisions.some((revision, index) => revision.version !== index + 1)
      ) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "delivery fixture history or unknown eligibility state is invalid");
      }
    }
    this.orders = orders;
  }
}
