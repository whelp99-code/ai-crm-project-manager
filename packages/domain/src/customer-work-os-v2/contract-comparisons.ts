import { createHash } from "node:crypto";
import { canonicalHashOf } from "@ai-crm/policy-engine";
import { CustomerWorkOsV2Error, assertStepUp, assertWorkspace, copy, integer, mapValues, required, sorted, type V2Actor } from "./shared.js";

export interface F2Clause {
  id: string;
  text: string;
  startByte: number;
  endByte: number;
  proposal: {
    status: "UNCONFIRMED";
    origin: "CALLER_PROPOSAL";
    conditional: boolean;
    kind: "delivery" | "acceptance" | "payment" | "renewal" | null;
    dueOn: string | null;
  };
}

export interface F2SourceRevision {
  workspaceId: string;
  sourceId: string;
  revisionId: string;
  sourceUrl: string;
  observedAt: string;
  content: string;
  sourceHash: string;
  clauses: F2Clause[];
}

export interface F2Finding {
  id: string;
  changes: Array<"added" | "deleted" | "date_changed" | "number_changed" | "text_changed" | "condition_changed" | "interpretation_changed">;
  prior: F2Clause | null;
  next: F2Clause | null;
  interpretation: "UNCONFIRMED";
  deadlineStatus: "UNKNOWN";
  proposedDeadlineStatus: "OVERDUE" | "UPCOMING" | "UNKNOWN";
}

export interface F2Comparison {
  id: string;
  workspaceId: string;
  prior: F2SourceRevision;
  next: F2SourceRevision;
  findings: F2Finding[];
  requestHash: string;
  createdAt: string;
  recordedByPrincipalId: string;
  approved: false;
  sent: false;
  sourceVerified: false;
}

export interface ContractComparisonState {
  schemaVersion: 1;
  comparisons: F2Comparison[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", "source and clause must be objects");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} is required`);
  return value;
}

function date(value: unknown): string {
  const result = text(value, "dueOn");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result) {
    throw new CustomerWorkOsV2Error("INVALID_DATE", "date must be a real YYYY-MM-DD calendar date");
  }
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value, "observedAt");
  date(result.slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
    !Number.isFinite(Date.parse(result))) {
    throw new CustomerWorkOsV2Error("EXPLICIT_OFFSET_REQUIRED", "timestamp must include an explicit offset");
  }
  return new Date(result).toISOString();
}

function kind(value: unknown): F2Clause["proposal"]["kind"] {
  switch (value) {
    case null: case "delivery": case "acceptance": case "payment": case "renewal": return value;
    default: throw new CustomerWorkOsV2Error("INVALID_INPUT", "unknown obligation candidate kind");
  }
}

function source(value: unknown, workspaceId: string): F2SourceRevision {
  const input = record(value);
  assertWorkspace(workspaceId, text(input.workspaceId, "source.workspaceId"));
  const content = text(input.content, "content");
  const bytes = Buffer.from(content, "utf8");
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (input.sourceHash !== sourceHash) throw new CustomerWorkOsV2Error("CITATION_HASH_MISMATCH", "source hash does not match exact content");
  if (!Array.isArray(input.clauses)) throw new CustomerWorkOsV2Error("INVALID_INPUT", "clauses must be an array");
  const ids = new Set<string>();
  const clauses = input.clauses.map(value => {
    const clause = record(value);
    const id = required(text(clause.id, "clause.id"), "clause.id");
    if (ids.has(id)) throw new CustomerWorkOsV2Error("DUPLICATE_ID", "duplicate clause id");
    ids.add(id);
    const quoted = text(clause.text, "clause.text");
    if (typeof clause.startByte !== "number" || typeof clause.endByte !== "number") {
      throw new CustomerWorkOsV2Error("INVALID_INPUT", "citation offsets must be numbers");
    }
    const startByte = integer(clause.startByte, "startByte");
    const endByte = integer(clause.endByte, "endByte", 1);
    if (endByte <= startByte || endByte > bytes.length || !bytes.subarray(startByte, endByte).equals(Buffer.from(quoted, "utf8"))) {
      throw new CustomerWorkOsV2Error("CITATION_CONTENT_MISMATCH", "citation must match exact UTF-8 source bytes");
    }
    if (typeof clause.conditional !== "boolean") throw new CustomerWorkOsV2Error("INVALID_INPUT", "conditional must be boolean");
    const dueOn = clause.dueOn === null ? null : date(clause.dueOn);
    if (dueOn !== null && !quoted.includes(dueOn)) throw new CustomerWorkOsV2Error("CITATION_CONTENT_MISMATCH", "deadline must appear in the quoted clause");
    const proposal: F2Clause["proposal"] = {
      status: "UNCONFIRMED", origin: "CALLER_PROPOSAL", conditional: clause.conditional, kind: kind(clause.kind), dueOn,
    };
    return { id, text: quoted, startByte, endByte, proposal };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    workspaceId, sourceId: required(text(input.sourceId, "sourceId"), "sourceId"),
    revisionId: required(text(input.revisionId, "revisionId"), "revisionId"),
    sourceUrl: text(input.sourceUrl, "sourceUrl"), observedAt: timestamp(input.observedAt), content, sourceHash, clauses,
  };
}

export class ContractComparisonService {
  private comparisons = new Map<string, F2Comparison>();

  compare(input: { id: string; prior: unknown; next: unknown }, actor: V2Actor, now: string): F2Comparison {
    assertStepUp(actor);
    const id = required(input.id, "comparisonId");
    const prior = source(input.prior, actor.workspaceId);
    const next = source(input.next, actor.workspaceId);
    if (prior.sourceId !== next.sourceId || prior.revisionId === next.revisionId) {
      throw new CustomerWorkOsV2Error("INVALID_INPUT", "compare two distinct revisions of the same source");
    }
    const requestHash = canonicalHashOf("f2.compareRevisions", { id, prior, next });
    const existing = this.comparisons.get(id);
    if (existing) {
      assertWorkspace(actor.workspaceId, existing.workspaceId);
      if (existing.requestHash !== requestHash) throw new CustomerWorkOsV2Error("IDEMPOTENCY_CONFLICT", "comparison identity reused with different source");
      return copy(existing);
    }
    for (const comparison of this.comparisons.values()) {
      if (comparison.prior.sourceId === prior.sourceId &&
        JSON.stringify([comparison.prior.revisionId, comparison.next.revisionId].sort()) === JSON.stringify([prior.revisionId, next.revisionId].sort())) {
        throw new CustomerWorkOsV2Error("IDEMPOTENCY_CONFLICT", "revision pair already has a comparison identity");
      }
      for (const old of [comparison.prior, comparison.next]) {
        for (const revision of [prior, next]) {
          if (old.sourceId === revision.sourceId && old.revisionId === revision.revisionId &&
            canonicalHashOf("f2.sourceRevision", old) !== canonicalHashOf("f2.sourceRevision", revision)) {
            throw new CustomerWorkOsV2Error("IDEMPOTENCY_CONFLICT", "source revision is immutable");
          }
        }
      }
    }
    const createdAt = timestamp(now);
    const before = new Map(prior.clauses.map(clause => [clause.id, clause]));
    const after = new Map(next.clauses.map(clause => [clause.id, clause]));
    const findings: F2Finding[] = [...new Set([...before.keys(), ...after.keys()])].sort().map(clauseId => {
      const left = before.get(clauseId) ?? null;
      const right = after.get(clauseId) ?? null;
      const changes: F2Finding["changes"] = [];
      if (!left) changes.push("added");
      else if (!right) changes.push("deleted");
      else {
        const withoutDates = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}/g, "<date>");
        if (JSON.stringify(left.text.match(/\d{4}-\d{2}-\d{2}/g)) !== JSON.stringify(right.text.match(/\d{4}-\d{2}-\d{2}/g))) changes.push("date_changed");
        if (JSON.stringify(withoutDates(left.text).match(/\d+(?:\.\d+)?/g)) !== JSON.stringify(withoutDates(right.text).match(/\d+(?:\.\d+)?/g))) changes.push("number_changed");
        if (withoutDates(left.text).replace(/\d+(?:\.\d+)?/g, "<number>") !== withoutDates(right.text).replace(/\d+(?:\.\d+)?/g, "<number>")) changes.push("text_changed");
        if (left.proposal.conditional !== right.proposal.conditional) changes.push("condition_changed");
        if (left.proposal.kind !== right.proposal.kind || left.proposal.dueOn !== right.proposal.dueOn) changes.push("interpretation_changed");
      }
      return {
        id: clauseId, changes, prior: left, next: right, interpretation: "UNCONFIRMED", deadlineStatus: "UNKNOWN",
        proposedDeadlineStatus: !right || right.proposal.conditional || right.proposal.kind === null || right.proposal.dueOn === null
          ? "UNKNOWN" : right.proposal.dueOn < createdAt.slice(0, 10) ? "OVERDUE" : "UPCOMING",
      };
    });
    const comparison: F2Comparison = { id, workspaceId: actor.workspaceId, prior, next, findings, requestHash, createdAt,
      recordedByPrincipalId: actor.principalId, approved: false, sent: false, sourceVerified: false };
    this.comparisons.set(id, comparison);
    return copy(comparison);
  }

  exportState(): ContractComparisonState {
    return { schemaVersion: 1, comparisons: sorted(this.comparisons.values()) };
  }

  hydrateState(input: ContractComparisonState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported comparison state");
    const comparisons = mapValues(input.comparisons, "comparison");
    const restored = new ContractComparisonService();
    for (const comparison of comparisons.values()) {
      const revisionInput = (revision: F2SourceRevision) => ({
        ...revision, clauses: revision.clauses.map(clause => ({ ...clause, ...clause.proposal })),
      });
      const rebuilt = restored.compare({
        id: comparison.id, prior: revisionInput(comparison.prior), next: revisionInput(comparison.next),
      }, { workspaceId: comparison.workspaceId, principalId: comparison.recordedByPrincipalId, kind: "human", stepUpVerified: true }, comparison.createdAt);
      if (canonicalHashOf("f2.persistedComparison", rebuilt) !== canonicalHashOf("f2.persistedComparison", comparison)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "persisted comparison must match its unconfirmed source-bound candidate");
      }
    }
    this.comparisons = restored.comparisons;
  }
}
