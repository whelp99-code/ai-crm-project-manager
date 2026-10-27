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

export interface W05ClauseCitation {
  clauseId: string;
  startByte: number;
  endByte: number;
  text: string;
  sourceHash: string;
}

export interface W05RenewalRevisionInput {
  renewalId: string;
  workspaceId: string;
  revisionId: string;
  revisionLabel: string;
  observedAt: string;
  expiresOn: string | null;
  noticePeriodDays: number | null;
  unknownTerms: string[];
  content: string;
  citations: W05ClauseCitation[];
  contractDraft?: W05ContractDraft;
}

export interface W05ContractItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceKrw: string | null;
}

export interface W05ContractTerms {
  startDate: string | null;
  endDate: string | null;
  valueKrw: string | null;
  items: W05ContractItem[] | null;
  conditions: string[] | null;
}

export interface W05ContractSource {
  kind: "NORMALIZED" | "OWNER_INPUT";
  id: string;
  version: number | null;
  reference: string;
  terms: W05ContractTerms;
}

export interface W05ContractDraft {
  source: W05ContractSource;
  terms: W05ContractTerms;
}

export interface W05RenewalRevision extends W05RenewalRevisionInput {
  version: number;
  sourceHash: string;
  recordedByPrincipalId: string;
}

export interface W05InternalCandidateReceipt {
  revisionId: string;
  requestHash: string;
  status: "INTERNAL_CANDIDATE";
  approvalStatus: "NOT_APPROVED";
  createdAt: string;
}

export interface W05RenewalDraft {
  id: string;
  workspaceId: string;
  revisions: W05RenewalRevision[];
  receipts: W05InternalCandidateReceipt[];
  version: number;
}

export interface RenewalState {
  schemaVersion: 1;
  drafts: W05RenewalDraft[];
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateDate(value: string | null): string | null {
  if (value === null) return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new CustomerWorkOsV2Error("INVALID_DATE", "expiry date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysByMonth[month - 1];
  if (year < 1 || !maxDay || day < 1 || day > maxDay) {
    throw new CustomerWorkOsV2Error("INVALID_DATE", "expiry date is not a valid calendar date");
  }
  return value;
}

function validateObservedAt(value: string): string {
  const observedAt = required(value, "observedAt");
  if (!OFFSET_TIMESTAMP_PATTERN.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) {
    throw new CustomerWorkOsV2Error("EXPLICIT_OFFSET_REQUIRED", "observedAt must be an ISO timestamp with Z or an explicit offset");
  }
  return new Date(observedAt).toISOString();
}

function normalizeCitations(content: string, citations: W05ClauseCitation[], sourceHash: string): W05ClauseCitation[] {
  if (!Array.isArray(citations) || citations.length === 0) {
    throw new CustomerWorkOsV2Error("CITATION_REQUIRED", "at least one exact clause citation is required");
  }
  const bytes = Buffer.from(content, "utf8");
  const ids = new Set<string>();
  return citations.map((citation) => {
    const clauseId = required(citation.clauseId, "citation.clauseId");
    if (ids.has(clauseId)) throw new CustomerWorkOsV2Error("DUPLICATE_ID", `duplicate citation ${clauseId}`);
    ids.add(clauseId);
    const startByte = integer(citation.startByte, "citation.startByte");
    const endByte = integer(citation.endByte, "citation.endByte", 1);
    const text = required(citation.text, "citation.text");
    if (endByte <= startByte || endByte > bytes.length || bytes.subarray(startByte, endByte).toString("utf8") !== text) {
      throw new CustomerWorkOsV2Error("CITATION_CONTENT_MISMATCH", "citation byte range must match the exact source content");
    }
    if (citation.sourceHash !== sourceHash) {
      throw new CustomerWorkOsV2Error("CITATION_HASH_MISMATCH", "citation source hash must match the measured content hash");
    }
    return { clauseId, startByte, endByte, text, sourceHash };
  });
}

function contractTerms(input: W05ContractTerms): W05ContractTerms {
  const startDate = validateDate(input.startDate);
  const endDate = validateDate(input.endDate);
  if (startDate !== null && endDate !== null && endDate < startDate) {
    throw new CustomerWorkOsV2Error("INVALID_DATE", "contract end must not precede its start");
  }
  const money = (value: string | null): string | null => {
    if (value === null) return null;
    if (!/^\d{1,30}$/.test(value)) throw new CustomerWorkOsV2Error("INVALID_MONEY", "contract amount must be exact nonnegative integer KRW");
    return BigInt(value).toString();
  };
  const ids = new Set<string>();
  const items = input.items === null ? null : input.items.map(item => {
    const id = required(item.id, "contract.item.id");
    if (ids.has(id)) throw new CustomerWorkOsV2Error("DUPLICATE_ID", "contract item IDs must be distinct");
    ids.add(id);
    return { id, description: required(item.description, "contract.item.description"),
      quantity: integer(item.quantity, "contract.item.quantity", 1), unitPriceKrw: money(item.unitPriceKrw) };
  });
  return { startDate, endDate, valueKrw: money(input.valueKrw), items,
    conditions: input.conditions === null ? null : input.conditions.map(value => required(value, "contract.condition")) };
}

function revisionRequestHash(input: Omit<W05RenewalRevision, "version" | "recordedByPrincipalId">): string {
  const canonical = {
    renewalId: input.renewalId,
    workspaceId: input.workspaceId,
    revisionId: input.revisionId,
    revisionLabel: input.revisionLabel,
    observedAt: input.observedAt,
    expiresOn: input.expiresOn,
    noticePeriodDays: input.noticePeriodDays,
    unknownTerms: input.unknownTerms,
    content: input.content,
    sourceHash: input.sourceHash,
    citations: input.citations,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class W05RenewalRevisionService {
  private drafts = new Map<string, W05RenewalDraft>();

  recordContractDraft(
    input: { renewalId: string; revisionId: string; revisionLabel: string; source: W05ContractSource; terms: W05ContractTerms },
    actor: V2Actor,
    now: string,
  ): W05RenewalDraft {
    const source: W05ContractSource = {
      kind: input.source.kind, id: required(input.source.id, "sourceContractId"),
      version: input.source.version === null ? null : integer(input.source.version, "sourceContractVersion", 1),
      reference: required(input.source.reference, "sourceContractReference"), terms: contractTerms(input.source.terms),
    };
    if (source.kind !== "NORMALIZED" && source.kind !== "OWNER_INPUT") {
      throw new CustomerWorkOsV2Error("INVALID_SOURCE", "contract source must identify its provenance");
    }
    if ((source.kind === "NORMALIZED") !== (source.version !== null)) {
      throw new CustomerWorkOsV2Error("INVALID_SOURCE", "only a normalized contract has a stored source version");
    }
    const draft = { source, terms: contractTerms(input.terms) };
    const content = JSON.stringify(draft);
    const sourceHash = createHash("sha256").update(content).digest("hex");
    return this.recordRevision({
      renewalId: input.renewalId, workspaceId: actor.workspaceId,
      revisionId: input.revisionId, revisionLabel: input.revisionLabel,
      observedAt: now, expiresOn: draft.terms.endDate, noticePeriodDays: null,
      unknownTerms: ["NOTICE_PERIOD", ...(source.kind === "OWNER_INPUT" ? ["SOURCE_VERIFICATION_REQUIRED"] : []),
        ...(source.terms.startDate === null || source.terms.endDate === null ? ["SOURCE_PERIOD"] : []),
        ...(source.terms.items === null ? ["SOURCE_ITEMS"] : []),
        ...(source.terms.valueKrw === null ? ["SOURCE_AMOUNT"] : []),
        ...(source.terms.conditions === null ? ["SOURCE_CONDITIONS"] : []),
        ...(draft.terms.startDate === null || draft.terms.endDate === null ? ["RENEWAL_PERIOD"] : []),
        ...(draft.terms.valueKrw === null ? ["RENEWAL_AMOUNT"] : []),
        ...(draft.terms.conditions === null ? ["RENEWAL_CONDITIONS"] : [])],
      content, citations: [{ clauseId: "structured-contract", startByte: 0,
        endByte: Buffer.byteLength(content, "utf8"), text: content, sourceHash }],
      contractDraft: draft,
    }, actor, now);
  }

  recordRevision(input: W05RenewalRevisionInput, actor: V2Actor, now: string): W05RenewalDraft {
    assertHuman(actor);
    assertStepUp(actor);
    const renewalId = required(input.renewalId, "renewalId");
    const workspaceId = required(input.workspaceId, "workspaceId");
    if (workspaceId !== actor.workspaceId) throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace renewal access is forbidden");
    const revisionId = required(input.revisionId, "revisionId");
    const revisionLabel = required(input.revisionLabel, "revisionLabel");
    const observedAt = validateObservedAt(input.observedAt);
    const expiresOn = validateDate(input.expiresOn);
    const noticePeriodDays = input.noticePeriodDays === null ? null : integer(input.noticePeriodDays, "noticePeriodDays");
    if (!Array.isArray(input.unknownTerms)) throw new CustomerWorkOsV2Error("INVALID_INPUT", "unknownTerms must be an array");
    const unknownTerms = [...new Set(input.unknownTerms.map((term) => required(term, "unknownTerm")))];
    const content = required(input.content, "content");
    if (input.contractDraft !== undefined && JSON.stringify(input.contractDraft) !== content) {
      throw new CustomerWorkOsV2Error("CONTRACT_CONTENT_MISMATCH", "structured terms must match the exactly cited content");
    }
    const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
    const citations = normalizeCitations(content, input.citations, sourceHash);
    const normalized = {
      renewalId,
      workspaceId,
      revisionId,
      revisionLabel,
      observedAt,
      expiresOn,
      noticePeriodDays,
      unknownTerms,
      content,
      sourceHash,
      citations,
      ...(input.contractDraft === undefined ? {} : { contractDraft: copy(input.contractDraft) }),
    };
    const requestHash = revisionRequestHash(normalized);
    const prior = this.drafts.get(renewalId);
    if (prior && prior.workspaceId !== workspaceId) {
      throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace renewal access is forbidden");
    }
    const oldReceipt = prior?.receipts.find((item) => item.revisionId === revisionId);
    if (oldReceipt) {
      if (oldReceipt.requestHash !== requestHash) {
        throw new CustomerWorkOsV2Error("IDEMPOTENCY_CONFLICT", "renewal revision id was reused with different source or terms");
      }
      return copy(prior!);
    }
    const version = (prior?.version ?? 0) + 1;
    const revision: W05RenewalRevision = {
      ...normalized,
      version,
      recordedByPrincipalId: actor.principalId,
    };
    const receipt: W05InternalCandidateReceipt = {
      revisionId,
      requestHash,
      status: "INTERNAL_CANDIDATE",
      approvalStatus: "NOT_APPROVED",
      createdAt: validateObservedAt(now),
    };
    const draft: W05RenewalDraft = {
      id: renewalId,
      workspaceId,
      revisions: [...(prior?.revisions ?? []), revision],
      receipts: [...(prior?.receipts ?? []), receipt],
      version,
    };
    this.drafts.set(renewalId, draft);
    return copy(draft);
  }

  exportState(): RenewalState {
    return { schemaVersion: 1, drafts: sorted(this.drafts.values()) };
  }

  hydrateState(input: RenewalState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported W05 renewal state");
    const drafts = mapValues(input.drafts, "renewalDraft");
    for (const draft of drafts.values()) {
      if (draft.version !== draft.revisions.length || draft.version !== draft.receipts.length) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "renewal revisions and receipts must be contiguous");
      }
      if (draft.revisions.some((revision, index) => revision.version !== index + 1 || revision.revisionId !== draft.receipts[index]?.revisionId)) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "renewal revision and receipt history mismatch");
      }
      if (draft.receipts.some((receipt) => receipt.approvalStatus !== "NOT_APPROVED" || receipt.status !== "INTERNAL_CANDIDATE")) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "local renewal receipt cannot imply approval");
      }
    }
    this.drafts = drafts;
  }
}
