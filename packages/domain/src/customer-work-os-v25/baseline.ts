import {
  CustomerWorkOsV25Error,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  clampConfidence,
  copy,
  deterministicHash,
  mapById,
  normalizeText,
  required,
  sorted,
  type AutomationActor,
  type RiskLevel,
} from "./shared.js";

export type BaselineRecordKind =
  | "ACCOUNT"
  | "CONTACT"
  | "ENGAGEMENT"
  | "ACTIVITY"
  | "DOCUMENT"
  | "CONTRACT"
  | "FINANCIAL_ITEM"
  | "SETTLEMENT"
  | "ASSET"
  | "CALENDAR_EVENT";

export interface BaselineSourceRecord {
  id: string;
  workspaceId: string;
  sourceSystem: "NOTION" | "GMAIL" | "OUTLOOK" | "CALENDAR" | "DRIVE" | "CSV" | "MANUAL";
  sourceRef: string;
  kind: BaselineRecordKind;
  occurredAt: string | null;
  data: Record<string, unknown>;
  confidence: number;
  contentHash: string;
}

export interface CanonicalBaselineRecord {
  id: string;
  workspaceId: string;
  kind: BaselineRecordKind;
  canonicalKey: string;
  data: Record<string, unknown>;
  sourceRefs: string[];
  sourceRecordIds: string[];
  confidence: number;
  risk: RiskLevel;
  status: "READY" | "NEEDS_REVIEW" | "QUARANTINED";
  version: number;
}

export interface BaselineConflict {
  id: string;
  workspaceId: string;
  canonicalRecordId: string;
  field: string;
  values: Array<{ value: unknown; sourceRef: string }>;
  severity: "INFO" | "WARNING" | "BLOCKING";
  resolvedValue: unknown | null;
  resolvedByPrincipalId: string | null;
  version: number;
}

export interface BaselineQuestion {
  id: string;
  workspaceId: string;
  planId: string;
  canonicalRecordId: string;
  field: string;
  prompt: string;
  options: Array<{ id: string; label: string; value: unknown; evidenceRefs: string[] }>;
  status: "OPEN" | "ANSWERED" | "DEFERRED";
  answer: unknown | null;
  answeredByPrincipalId: string | null;
  version: number;
}

export interface BaselinePlan {
  id: string;
  workspaceId: string;
  snapshotHash: string;
  status: "NEEDS_REVIEW" | "READY" | "APPLIED" | "REJECTED";
  canonicalRecordIds: string[];
  conflictIds: string[];
  questionIds: string[];
  duplicateSourceRecordIds: string[];
  quarantinedSourceRecordIds: string[];
  createdAt: string;
  appliedAt: string | null;
  appliedByPrincipalId: string | null;
  version: number;
}

export interface BaselineBuilderState {
  schemaVersion: 1;
  sourceRecords: BaselineSourceRecord[];
  canonicalRecords: CanonicalBaselineRecord[];
  conflicts: BaselineConflict[];
  questions: BaselineQuestion[];
  plans: BaselinePlan[];
}

function valueKey(value: unknown): string {
  if (typeof value === "string") return normalizeText(value);
  return JSON.stringify(value);
}

function stringField(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function riskFor(kind: BaselineRecordKind): RiskLevel {
  if (["CONTRACT", "FINANCIAL_ITEM", "SETTLEMENT"].includes(kind)) return "HIGH";
  if (["ENGAGEMENT", "ASSET"].includes(kind)) return "MEDIUM";
  return "LOW";
}

function canonicalKey(record: BaselineSourceRecord): string {
  const data = record.data;
  switch (record.kind) {
    case "ACCOUNT": {
      const name = stringField(data, ["normalizedName", "name", "company", "accountName"]);
      const registration = stringField(data, ["businessRegistrationNumber", "registrationNumber"]);
      return `account:${normalizeText(registration ?? name ?? record.sourceRef).replace(/\s+/g, "")}`;
    }
    case "CONTACT": {
      const email = stringField(data, ["email", "primaryEmail"]);
      const phone = stringField(data, ["phone", "primaryPhone"]);
      const name = stringField(data, ["name", "contactName"]);
      return `contact:${normalizeText(email ?? phone ?? `${name ?? "unknown"}:${record.sourceRef}`)}`;
    }
    case "ENGAGEMENT": {
      const projectKey = stringField(data, ["projectKey", "projectId", "legacyProjectKey"]);
      const name = stringField(data, ["name", "projectName", "title"]);
      return `engagement:${normalizeText(projectKey ?? name ?? record.sourceRef)}`;
    }
    case "DOCUMENT": {
      const hash = stringField(data, ["contentHash", "hash"]);
      const title = stringField(data, ["title", "name"]);
      return `document:${normalizeText(hash ?? `${title ?? "document"}:${record.sourceRef}`)}`;
    }
    case "FINANCIAL_ITEM":
    case "SETTLEMENT": {
      const externalId = stringField(data, ["transactionId", "externalId", "bankReference", "invoiceNumber"]);
      const amount = data.grossAmountKrw ?? data.amountKrw ?? data.amount;
      const date = stringField(data, ["settledAt", "expectedDate", "date"]);
      const memo = stringField(data, ["memo", "description", "name"]);
      return `${record.kind.toLocaleLowerCase()}:${normalizeText(externalId ?? `${String(amount ?? "")}:${date ?? ""}:${memo ?? ""}`)}`;
    }
    default:
      return `${record.kind.toLocaleLowerCase()}:${record.contentHash}`;
  }
}

function mergeGroup(
  workspaceId: string,
  key: string,
  group: BaselineSourceRecord[],
): { canonical: CanonicalBaselineRecord; conflicts: BaselineConflict[] } {
  const fieldValues = new Map<string, Array<{ value: unknown; sourceRef: string }>>();
  for (const source of group) {
    for (const [field, value] of Object.entries(source.data)) {
      if (value === undefined || value === null || value === "") continue;
      const values = fieldValues.get(field) ?? [];
      if (!values.some((item) => valueKey(item.value) === valueKey(value))) {
        values.push({ value: copy(value), sourceRef: source.sourceRef });
      }
      fieldValues.set(field, values);
    }
  }

  const merged: Record<string, unknown> = {};
  const conflicts: BaselineConflict[] = [];
  const recordId = `baseline-${deterministicHash({ workspaceId, key }).slice(-16)}`;
  for (const [field, values] of [...fieldValues.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    merged[field] = copy(values[0]!.value);
    if (values.length > 1) {
      const blocking = ["projectKey", "contractValueKrw", "grossAmountKrw", "amountKrw", "customerId"].includes(field);
      conflicts.push({
        id: `conflict-${deterministicHash({ recordId, field, values }).slice(-16)}`,
        workspaceId,
        canonicalRecordId: recordId,
        field,
        values: copy(values),
        severity: blocking ? "BLOCKING" : "WARNING",
        resolvedValue: null,
        resolvedByPrincipalId: null,
        version: 1,
      });
    }
  }

  const confidence = Math.round(
    (group.reduce((sum, item) => sum + clampConfidence(item.confidence), 0) / group.length) * 10_000,
  ) / 10_000;
  const risk = riskFor(group[0]!.kind);
  const status = conflicts.some((item) => item.severity === "BLOCKING") || confidence < 0.8
    ? "NEEDS_REVIEW"
    : "READY";
  return {
    canonical: {
      id: recordId,
      workspaceId,
      kind: group[0]!.kind,
      canonicalKey: key,
      data: merged,
      sourceRefs: [...new Set(group.map((item) => item.sourceRef))].sort(),
      sourceRecordIds: group.map((item) => item.id).sort(),
      confidence,
      risk,
      status,
      version: 1,
    },
    conflicts,
  };
}

export class BaselineBuilderService {
  private sourceRecords = new Map<string, BaselineSourceRecord>();
  private canonicalRecords = new Map<string, CanonicalBaselineRecord>();
  private conflicts = new Map<string, BaselineConflict>();
  private questions = new Map<string, BaselineQuestion>();
  private plans = new Map<string, BaselinePlan>();

  build(
    input: {
      id: string;
      workspaceId: string;
      records: BaselineSourceRecord[];
      snapshotHash?: string;
      createdAt: string;
    },
    actor: AutomationActor,
  ): BaselinePlan {
    assertHumanOrService(actor);
    assertWorkspace(actor, input.workspaceId);
    if (input.records.length === 0) throw new CustomerWorkOsV25Error("EMPTY_BASELINE", "baseline requires source records");
    if (this.plans.has(input.id)) throw new CustomerWorkOsV25Error("DUPLICATE_PLAN", "baseline plan already exists");
    const requestedSnapshotHash = input.snapshotHash?.trim() || deterministicHash(input.records.map((item) => ({
      id: item.id,
      sourceSystem: item.sourceSystem,
      sourceRef: item.sourceRef,
      kind: item.kind,
      contentHash: item.contentHash,
      data: item.data,
    })));
    const replay = [...this.plans.values()].find((item) => item.workspaceId === input.workspaceId && item.snapshotHash === requestedSnapshotHash);
    if (replay) return copy(replay);

    const duplicateSourceRecordIds: string[] = [];
    const quarantinedSourceRecordIds: string[] = [];
    const accepted: BaselineSourceRecord[] = [];
    const seenFingerprints = new Set<string>();
    const seenSourceIds = new Set<string>();

    for (const raw of input.records) {
      const sourceId = required(raw.id, "sourceRecord.id");
      if (seenSourceIds.has(sourceId) || this.sourceRecords.has(sourceId)) {
        throw new CustomerWorkOsV25Error("DUPLICATE_SOURCE_ID", `baseline source id already exists: ${sourceId}`);
      }
      seenSourceIds.add(sourceId);
      assertWorkspace(actor, raw.workspaceId);
      const record: BaselineSourceRecord = {
        ...copy(raw),
        id: sourceId,
        sourceRef: required(raw.sourceRef, "sourceRecord.sourceRef"),
        contentHash: required(raw.contentHash, "sourceRecord.contentHash"),
        confidence: clampConfidence(raw.confidence),
      };
      const fingerprint = `${record.sourceSystem}:${record.contentHash}`;
      if (seenFingerprints.has(fingerprint) || [...this.sourceRecords.values()].some((item) => `${item.sourceSystem}:${item.contentHash}` === fingerprint)) {
        duplicateSourceRecordIds.push(record.id);
        continue;
      }
      seenFingerprints.add(fingerprint);
      if (record.confidence < 0.25 || Object.keys(record.data).length === 0) {
        quarantinedSourceRecordIds.push(record.id);
        continue;
      }
      this.sourceRecords.set(record.id, record);
      accepted.push(record);
    }

    const groups = new Map<string, BaselineSourceRecord[]>();
    for (const record of accepted) {
      const key = canonicalKey(record);
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }

    const planCanonicalIds: string[] = [];
    const planConflictIds: string[] = [];
    const planQuestionIds: string[] = [];
    for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const merged = mergeGroup(input.workspaceId, key, group);
      this.canonicalRecords.set(merged.canonical.id, merged.canonical);
      planCanonicalIds.push(merged.canonical.id);
      for (const conflict of merged.conflicts) {
        this.conflicts.set(conflict.id, conflict);
        planConflictIds.push(conflict.id);
        const options = conflict.values.map((item, index) => ({
          id: `${conflict.id}-option-${index + 1}`,
          label: String(item.value),
          value: copy(item.value),
          evidenceRefs: [item.sourceRef],
        }));
        const question: BaselineQuestion = {
          id: `question-${conflict.id}`,
          workspaceId: input.workspaceId,
          planId: input.id,
          canonicalRecordId: conflict.canonicalRecordId,
          field: conflict.field,
          prompt: `${merged.canonical.kind}의 '${conflict.field}' 값이 서로 다릅니다. 어떤 값이 맞나요?`,
          options,
          status: "OPEN",
          answer: null,
          answeredByPrincipalId: null,
          version: 1,
        };
        this.questions.set(question.id, question);
        planQuestionIds.push(question.id);
      }
    }

    const snapshotHash = requestedSnapshotHash;

    const plan: BaselinePlan = {
      id: required(input.id, "plan.id"),
      workspaceId: input.workspaceId,
      snapshotHash,
      status: planQuestionIds.length > 0 ? "NEEDS_REVIEW" : "READY",
      canonicalRecordIds: planCanonicalIds.sort(),
      conflictIds: planConflictIds.sort(),
      questionIds: planQuestionIds.sort(),
      duplicateSourceRecordIds: duplicateSourceRecordIds.sort(),
      quarantinedSourceRecordIds: quarantinedSourceRecordIds.sort(),
      createdAt: input.createdAt,
      appliedAt: null,
      appliedByPrincipalId: null,
      version: 1,
    };
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  answerQuestion(
    questionId: string,
    answer: unknown,
    actor: AutomationActor,
  ): BaselineQuestion {
    assertHuman(actor);
    const current = this.questions.get(questionId);
    if (!current) throw new CustomerWorkOsV25Error("QUESTION_NOT_FOUND", "baseline question not found");
    assertWorkspace(actor, current.workspaceId);
    if (current.status !== "OPEN") throw new CustomerWorkOsV25Error("QUESTION_CLOSED", "question is already closed");
    const conflict = this.conflicts.get(`conflict-${questionId.replace(/^question-conflict-/, "")}`)
      ?? [...this.conflicts.values()].find((item) => `question-${item.id}` === questionId);
    if (!conflict) throw new CustomerWorkOsV25Error("CONFLICT_NOT_FOUND", "baseline conflict not found");
    const canonical = this.canonicalRecords.get(current.canonicalRecordId);
    if (!canonical) throw new CustomerWorkOsV25Error("CANONICAL_NOT_FOUND", "canonical record not found");

    conflict.resolvedValue = copy(answer);
    conflict.resolvedByPrincipalId = actor.principalId;
    conflict.version += 1;
    canonical.data[current.field] = copy(answer);
    const hasOpenCanonicalQuestion = [...this.questions.values()].some((item) =>
      item.id !== current.id &&
      item.canonicalRecordId === canonical.id &&
      item.status === "OPEN",
    );
    canonical.status = hasOpenCanonicalQuestion ? "NEEDS_REVIEW" : "READY";
    canonical.version += 1;
    current.status = "ANSWERED";
    current.answer = copy(answer);
    current.answeredByPrincipalId = actor.principalId;
    current.version += 1;

    const plan = this.plans.get(current.planId);
    if (plan && plan.questionIds.every((id) => this.questions.get(id)?.status !== "OPEN")) {
      plan.status = "READY";
      plan.version += 1;
    }
    return copy(current);
  }

  apply(planId: string, appliedAt: string, actor: AutomationActor): BaselinePlan {
    assertHuman(actor);
    const plan = this.plans.get(planId);
    if (!plan) throw new CustomerWorkOsV25Error("PLAN_NOT_FOUND", "baseline plan not found");
    assertWorkspace(actor, plan.workspaceId);
    if (plan.status !== "READY") throw new CustomerWorkOsV25Error("PLAN_NOT_READY", "all blocking baseline questions must be resolved");
    plan.status = "APPLIED";
    plan.appliedAt = appliedAt;
    plan.appliedByPrincipalId = actor.principalId;
    plan.version += 1;
    return copy(plan);
  }

  getPlan(planId: string, workspaceId: string): BaselinePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new CustomerWorkOsV25Error("PLAN_NOT_FOUND", "baseline plan not found");
    if (plan.workspaceId !== workspaceId) throw new CustomerWorkOsV25Error("CROSS_WORKSPACE", "cross-workspace baseline access is forbidden");
    return copy(plan);
  }

  canonicalForPlan(planId: string, workspaceId: string): CanonicalBaselineRecord[] {
    const plan = this.getPlan(planId, workspaceId);
    return plan.canonicalRecordIds.map((id) => {
      const record = this.canonicalRecords.get(id);
      if (!record) throw new CustomerWorkOsV25Error("CANONICAL_NOT_FOUND", `canonical record not found: ${id}`);
      return copy(record);
    });
  }

  readyPlans(workspaceId: string): BaselinePlan[] {
    return [...this.plans.values()]
      .filter((item) => item.workspaceId === workspaceId && item.status === "READY")
      .map(copy)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  reviewQueue(workspaceId: string): BaselineQuestion[] {
    return [...this.questions.values()]
      .filter((item) => item.workspaceId === workspaceId && item.status === "OPEN")
      .map(copy)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  exportState(): BaselineBuilderState {
    return {
      schemaVersion: 1,
      sourceRecords: sorted(this.sourceRecords.values()),
      canonicalRecords: sorted(this.canonicalRecords.values()),
      conflicts: sorted(this.conflicts.values()),
      questions: sorted(this.questions.values()),
      plans: sorted(this.plans.values()),
    };
  }

  hydrateState(input: BaselineBuilderState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported baseline state");
    this.sourceRecords = mapById(input.sourceRecords, "sourceRecord");
    this.canonicalRecords = mapById(input.canonicalRecords, "canonicalRecord");
    this.conflicts = mapById(input.conflicts, "conflict");
    this.questions = mapById(input.questions, "question");
    this.plans = mapById(input.plans, "plan");
  }
}
