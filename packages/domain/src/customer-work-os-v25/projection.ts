import type { BaselinePlan, CanonicalBaselineRecord } from "./baseline.js";
import type { ProposedMutation, UpdatePlan, CaptureContext } from "./capture.js";
import type { ClarificationTask, LearningRule } from "./clarification.js";
import type { ManagerSnapshot } from "./manager.js";
import {
  CustomerWorkOsV25Error,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  clampConfidence,
  copy,
  deterministicHash,
  mapById,
  required,
  sorted,
  type AutomationActor,
  type RiskLevel,
} from "./shared.js";

export type ManagedEntityKind =
  | "ACCOUNT"
  | "CONTACT"
  | "ENGAGEMENT"
  | "ACTIVITY"
  | "DOCUMENT"
  | "CONTRACT"
  | "FINANCIAL_ITEM"
  | "SETTLEMENT"
  | "ASSET"
  | "CALENDAR_EVENT"
  | "REQUIREMENT"
  | "UNKNOWN"
  | "COMMITMENT"
  | "CHANGE_REQUEST"
  | "SOURCE_EVENT";

export interface ManagedEntity {
  id: string;
  workspaceId: string;
  kind: ManagedEntityKind;
  fields: Record<string, unknown>;
  evidenceRefs: string[];
  sourceIds: string[];
  confidence: number;
  risk: RiskLevel;
  status: "ACTIVE" | "SUPERSEDED" | "QUARANTINED";
  updatedAt: string;
  updatedByPrincipalId: string;
  version: number;
}

export interface AppliedAutomationMutation {
  id: string;
  workspaceId: string;
  planId: string;
  mutationId: string;
  entityId: string;
  appliedAt: string;
  appliedByPrincipalId: string;
  version: number;
}

export interface AutomationProjectionState {
  schemaVersion: 1;
  entities: ManagedEntity[];
  appliedMutations: AppliedAutomationMutation[];
  appliedBaselinePlanIds: string[];
}

function stringValue(fields: Record<string, unknown>, keys: readonly string[], fallback = ""): string {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function numberValue(fields: Record<string, unknown>, keys: readonly string[], fallback = 0): number {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

function nullableString(fields: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = stringValue(fields, keys);
  return value || null;
}

function mutationKind(mutation: ProposedMutation): ManagedEntityKind {
  switch (mutation.category) {
    case "ACTIVITY": return "ACTIVITY";
    case "ACCOUNT_LINK":
    case "ENGAGEMENT_LINK": return "SOURCE_EVENT";
    case "ENGAGEMENT_FIELD": return "ENGAGEMENT";
    case "REQUIREMENT": return "REQUIREMENT";
    case "UNKNOWN": return "UNKNOWN";
    case "COMMITMENT": return "COMMITMENT";
    case "CHANGE_REQUEST": return "CHANGE_REQUEST";
    case "FINANCIAL_ITEM": return "FINANCIAL_ITEM";
    case "SETTLEMENT": return "SETTLEMENT";
    case "DOCUMENT": return "DOCUMENT";
  }
}

function mutationFields(mutation: ProposedMutation, sourceId: string): Record<string, unknown> {
  const base = mutation.value && typeof mutation.value === "object" && !Array.isArray(mutation.value)
    ? copy(mutation.value as Record<string, unknown>)
    : { value: copy(mutation.value) };
  if (mutation.field) base[mutation.field] = copy(mutation.value);
  if (mutation.targetId) {
    if (["COMMITMENT", "CHANGE_REQUEST", "FINANCIAL_ITEM", "SETTLEMENT", "ACTIVITY"].includes(mutation.category)) {
      base.engagementId = mutation.targetId;
    }
  }
  base.sourceId = sourceId;
  return base;
}

function projectedMoney(fields: Record<string, unknown>): bigint {
  const raw = stringValue(fields, ["netAmountKrw", "amountKrw", "grossAmountKrw"], "0");
  if (!/^-?\d+$/.test(raw)) throw new CustomerWorkOsV25Error("INVALID_MONEY", "projected financial amount must be an integer KRW string");
  return BigInt(raw);
}

function validateMutationForApplication(mutation: ProposedMutation): void {
  if (mutation.status !== "APPLIED") return;
  const value = mutation.value && typeof mutation.value === "object" && !Array.isArray(mutation.value)
    ? mutation.value as Record<string, unknown>
    : {};
  if (["ACTIVITY", "ENGAGEMENT_FIELD", "REQUIREMENT", "UNKNOWN", "COMMITMENT", "CHANGE_REQUEST", "FINANCIAL_ITEM", "SETTLEMENT", "DOCUMENT"].includes(mutation.category) && !mutation.targetId) {
    throw new CustomerWorkOsV25Error("ENGAGEMENT_LINK_REQUIRED", `${mutation.category} requires a confirmed engagement`);
  }
  if (mutation.category === "FINANCIAL_ITEM") {
    if (value.direction !== "IN" && value.direction !== "OUT") {
      throw new CustomerWorkOsV25Error("FINANCE_DIRECTION_REQUIRED", "financial item requires confirmed IN or OUT direction");
    }
    if (typeof value.amountKrw !== "string" || !/^\d+$/.test(value.amountKrw)) {
      throw new CustomerWorkOsV25Error("INVALID_MONEY", "financial item requires a non-negative integer amountKrw");
    }
  }
  if (mutation.category === "COMMITMENT") {
    if (typeof value.dueDate !== "string" || !Number.isFinite(Date.parse(value.dueDate))) {
      throw new CustomerWorkOsV25Error("COMMITMENT_DUE_DATE_REQUIRED", "commitment requires a confirmed due date");
    }
  }
  if (mutation.category === "ACCOUNT_LINK" || mutation.category === "ENGAGEMENT_LINK") {
    if (typeof mutation.value !== "string" || !mutation.value.trim()) {
      throw new CustomerWorkOsV25Error("LINK_VALUE_REQUIRED", `${mutation.category} requires a confirmed id`);
    }
  }
}

export class AutomationProjectionService {
  private entities = new Map<string, ManagedEntity>();
  private appliedMutations = new Map<string, AppliedAutomationMutation>();
  private appliedBaselinePlanIds = new Set<string>();

  seedBaseline(
    plan: BaselinePlan,
    records: CanonicalBaselineRecord[],
    appliedAt: string,
    actor: AutomationActor,
  ): ManagedEntity[] {
    assertHuman(actor);
    assertWorkspace(actor, plan.workspaceId);
    if (plan.status !== "APPLIED") throw new CustomerWorkOsV25Error("BASELINE_NOT_APPLIED", "baseline must be approved and applied first");
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) throw new CustomerWorkOsV25Error("DUPLICATE_BASELINE_RECORD", `duplicate baseline record: ${record.id}`);
      ids.add(record.id);
      if (record.workspaceId !== plan.workspaceId) throw new CustomerWorkOsV25Error("CROSS_WORKSPACE", "baseline record workspace mismatch");
      if (record.status !== "READY") throw new CustomerWorkOsV25Error("BASELINE_RECORD_NOT_READY", `baseline record ${record.id} is not ready`);
      const existing = this.entities.get(record.id);
      if (existing && existing.kind !== record.kind) throw new CustomerWorkOsV25Error("ENTITY_KIND_CONFLICT", `baseline entity kind changed for ${record.id}`);
    }
    if (this.appliedBaselinePlanIds.has(plan.id)) {
      return records.map((record) => {
        const item = this.entities.get(record.id);
        if (!item) throw new CustomerWorkOsV25Error("INVALID_STATE", `applied baseline entity missing: ${record.id}`);
        return copy(item);
      });
    }

    const nextEntities = new Map([...this.entities.entries()].map(([id, item]) => [id, copy(item)]));
    const result: ManagedEntity[] = [];
    for (const record of records) {
      const existing = nextEntities.get(record.id);
      const entity: ManagedEntity = {
        id: record.id,
        workspaceId: record.workspaceId,
        kind: record.kind,
        fields: copy(record.data),
        evidenceRefs: [...record.sourceRefs],
        sourceIds: [...record.sourceRecordIds],
        confidence: clampConfidence(record.confidence),
        risk: record.risk,
        status: "ACTIVE",
        updatedAt: appliedAt,
        updatedByPrincipalId: actor.principalId,
        version: (existing?.version ?? 0) + 1,
      };
      nextEntities.set(entity.id, entity);
      result.push(copy(entity));
    }
    this.entities = nextEntities;
    this.appliedBaselinePlanIds.add(plan.id);
    return result;
  }

  validateUpdatePlan(plan: UpdatePlan, actor: AutomationActor): void {
    assertHumanOrService(actor);
    assertWorkspace(actor, plan.workspaceId);
    if (!["AUTO_READY", "APPROVED", "APPLIED"].includes(plan.status)) {
      throw new CustomerWorkOsV25Error("PLAN_NOT_APPROVED", "update plan is not ready for application");
    }
    const selected = plan.mutations.filter((item) => ["AUTO_APPROVED", "APPROVED", "APPLIED"].includes(item.status));
    if (selected.length === 0) throw new CustomerWorkOsV25Error("NO_MUTATIONS_SELECTED", "update plan has no selected mutations");
    if (selected.some((item) => ["HIGH", "CRITICAL"].includes(item.risk)) && actor.kind !== "human") {
      throw new CustomerWorkOsV25Error("HUMAN_REQUIRED", "high-risk mutations require a human operator");
    }
    for (const mutation of selected) {
      const candidate = mutation.status === "APPLIED" ? mutation : { ...mutation, status: "APPLIED" as const };
      validateMutationForApplication(candidate);
    }
  }

  applyUpdatePlan(plan: UpdatePlan, appliedAt: string, actor: AutomationActor): AppliedAutomationMutation[] {
    this.validateUpdatePlan(plan, actor);
    if (plan.status !== "APPLIED") throw new CustomerWorkOsV25Error("PLAN_NOT_APPLIED", "update plan must be marked applied before projection");
    const nextEntities = new Map([...this.entities.entries()].map(([id, item]) => [id, copy(item)]));
    const nextApplications = new Map([...this.appliedMutations.entries()].map(([id, item]) => [id, copy(item)]));
    const applied: AppliedAutomationMutation[] = [];

    for (const mutation of plan.mutations) {
      if (mutation.status !== "APPLIED") continue;
      validateMutationForApplication(mutation);
      const applicationId = `applied-${deterministicHash({ planId: plan.id, mutationId: mutation.id }).slice(-16)}`;
      const existingApplication = nextApplications.get(applicationId);
      if (existingApplication) {
        applied.push(copy(existingApplication));
        continue;
      }
      const kind = mutationKind(mutation);
      const sourceLink = mutation.category === "ACCOUNT_LINK" || mutation.category === "ENGAGEMENT_LINK";
      const entityId = mutation.targetId && mutation.category === "ENGAGEMENT_FIELD"
        ? mutation.targetId
        : sourceLink
          ? `source-${plan.sourceId}`
          : `${kind.toLocaleLowerCase()}-${deterministicHash({ planId: plan.id, mutationId: mutation.id }).slice(-16)}`;
      const current = nextEntities.get(entityId);
      if (current && mutation.category === "ENGAGEMENT_FIELD" && current.kind !== "ENGAGEMENT") {
        throw new CustomerWorkOsV25Error("ENTITY_KIND_CONFLICT", `target ${entityId} is not an engagement`);
      }
      const fields = { ...(current?.fields ?? {}), ...mutationFields(mutation, plan.sourceId) };
      if (mutation.category === "ACCOUNT_LINK") fields.accountId = mutation.value;
      if (mutation.category === "ENGAGEMENT_LINK") fields.engagementId = mutation.value;
      const entity: ManagedEntity = {
        id: entityId,
        workspaceId: plan.workspaceId,
        kind,
        fields,
        evidenceRefs: [...new Set([...(current?.evidenceRefs ?? []), ...mutation.evidenceRefs])].sort(),
        sourceIds: [...new Set([...(current?.sourceIds ?? []), plan.sourceId])].sort(),
        confidence: Math.max(current?.confidence ?? 0, mutation.confidence),
        risk: mutation.risk,
        status: "ACTIVE",
        updatedAt: appliedAt,
        updatedByPrincipalId: actor.principalId,
        version: (current?.version ?? 0) + 1,
      };
      nextEntities.set(entity.id, entity);
      const record: AppliedAutomationMutation = {
        id: applicationId,
        workspaceId: plan.workspaceId,
        planId: plan.id,
        mutationId: mutation.id,
        entityId: entity.id,
        appliedAt,
        appliedByPrincipalId: actor.principalId,
        version: 1,
      };
      nextApplications.set(record.id, record);
      applied.push(copy(record));

      if (mutation.category === "ACTIVITY" && mutation.targetId) {
        const engagement = nextEntities.get(mutation.targetId);
        if (engagement?.kind === "ENGAGEMENT") {
          const value = mutation.value as { occurredAt?: unknown };
          engagement.fields.lastActivityAt = typeof value.occurredAt === "string" ? value.occurredAt : appliedAt;
          engagement.version += 1;
          engagement.updatedAt = appliedAt;
          engagement.updatedByPrincipalId = actor.principalId;
        }
      }
    }
    this.entities = nextEntities;
    this.appliedMutations = nextApplications;
    return applied;
  }

  captureContext(workspaceId: string, rules: LearningRule[] = []): CaptureContext {
    const accounts = [...this.entities.values()].filter((item) => item.workspaceId === workspaceId && item.kind === "ACCOUNT" && item.status === "ACTIVE");
    const engagements = [...this.entities.values()].filter((item) => item.workspaceId === workspaceId && item.kind === "ENGAGEMENT" && item.status === "ACTIVE");
    const accountAliases = accounts.map((item) => ({
      id: item.id,
      aliases: [...new Set([
        stringValue(item.fields, ["name", "accountName", "company"]),
        ...(Array.isArray(item.fields.aliases) ? item.fields.aliases.filter((value): value is string => typeof value === "string") : []),
        ...rules.filter((rule) => rule.kind === "ACCOUNT_ALIAS" && rule.outputValue === item.id && rule.active).map((rule) => rule.inputPattern),
      ].filter(Boolean))],
    }));
    const engagementAliases = engagements.map((item) => ({
      id: item.id,
      aliases: [...new Set([
        stringValue(item.fields, ["name", "projectName", "title"]),
        ...(Array.isArray(item.fields.aliases) ? item.fields.aliases.filter((value): value is string => typeof value === "string") : []),
        ...rules.filter((rule) => rule.kind === "ENGAGEMENT_ALIAS" && rule.outputValue === item.id && rule.active).map((rule) => rule.inputPattern),
      ].filter(Boolean))],
      ...(stringValue(item.fields, ["projectKey", "projectId", "legacyProjectKey"])
        ? { projectKey: stringValue(item.fields, ["projectKey", "projectId", "legacyProjectKey"]) }
        : {}),
    }));
    return { accountAliases, engagementAliases, defaultTimezone: "Asia/Seoul" };
  }

  managerSnapshot(workspaceId: string, asOf: string, clarifications: ClarificationTask[]): ManagerSnapshot {
    const active = (kind: ManagedEntityKind) => [...this.entities.values()].filter((item) => item.workspaceId === workspaceId && item.kind === kind && item.status === "ACTIVE");
    const commitments = active("COMMITMENT");
    const activities = active("ACTIVITY");
    const financialEntities = active("FINANCIAL_ITEM");
    const financialByEngagement = new Map<string, { revenue: bigint; cost: bigint }>();
    for (const item of financialEntities) {
      const engagementId = nullableString(item.fields, ["engagementId"]);
      if (!engagementId) continue;
      const current = financialByEngagement.get(engagementId) ?? { revenue: 0n, cost: 0n };
      const direction = stringValue(item.fields, ["direction"]);
      const amount = projectedMoney(item.fields);
      if (direction === "IN") current.revenue += amount;
      else if (direction === "OUT") current.cost += amount;
      else throw new CustomerWorkOsV25Error("FINANCE_DIRECTION_REQUIRED", `financial entity ${item.id} has no confirmed direction`);
      financialByEngagement.set(engagementId, current);
    }

    return {
      workspaceId,
      asOf,
      engagements: active("ENGAGEMENT").map((item) => {
        const financial = financialByEngagement.get(item.id);
        const fallbackRevenue = BigInt(stringValue(item.fields, ["forecastRevenueKrw", "expectedRevenueKrw", "contractValueKrw"], "0"));
        const fallbackCost = BigInt(stringValue(item.fields, ["estimateAtCompletionKrw", "eacKrw", "expectedCostKrw"], "0"));
        const revenue = financial?.revenue ?? fallbackRevenue;
        const cost = financial?.cost ?? fallbackCost;
        const marginBps = revenue > 0n ? Number(((revenue - cost) * 10_000n) / revenue) : numberValue(item.fields, ["forecastMarginBps", "marginBps"], 0);
        const lastActivityAt = activities
          .filter((activity) => stringValue(activity.fields, ["engagementId"]) === item.id)
          .map((activity) => nullableString(activity.fields, ["occurredAt"]))
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? nullableString(item.fields, ["lastActivityAt", "occurredAt"]);
        return {
          id: item.id,
          name: stringValue(item.fields, ["name", "projectName", "title"], item.id),
          stage: stringValue(item.fields, ["stage", "status"], "INQUIRY"),
          health: (["normal", "warning", "critical"].includes(stringValue(item.fields, ["health"])) ? stringValue(item.fields, ["health"]) : "normal") as "normal" | "warning" | "critical",
          lastActivityAt,
          nextActionCount: commitments.filter((commitment) => stringValue(commitment.fields, ["engagementId"]) === item.id && !["DONE", "CANCELLED"].includes(stringValue(commitment.fields, ["status"], "OPEN"))).length,
          forecastRevenueKrw: revenue.toString(),
          estimateAtCompletionKrw: cost.toString(),
          forecastMarginBps: marginBps,
        };
      }),
      commitments: commitments.map((item) => ({
        id: item.id,
        engagementId: stringValue(item.fields, ["engagementId"]),
        description: stringValue(item.fields, ["description", "title"], item.id),
        dueAt: stringValue(item.fields, ["dueAt", "dueDate"], asOf),
        status: (["OPEN", "IN_PROGRESS", "WAITING", "DONE", "CANCELLED"].includes(stringValue(item.fields, ["status"])) ? stringValue(item.fields, ["status"]) : "OPEN") as "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED",
      })),
      financialItems: financialEntities.map((item) => {
        const direction = stringValue(item.fields, ["direction"]);
        if (direction !== "IN" && direction !== "OUT") throw new CustomerWorkOsV25Error("FINANCE_DIRECTION_REQUIRED", `financial entity ${item.id} has no confirmed direction`);
        return {
          id: item.id,
          engagementId: nullableString(item.fields, ["engagementId"]),
          direction,
          lifecycle: stringValue(item.fields, ["lifecycle", "status"], "PLANNED"),
          grossAmountKrw: stringValue(item.fields, ["grossAmountKrw", "amountKrw"], "0"),
          settledAmountKrw: stringValue(item.fields, ["settledAmountKrw", "paidAmountKrw", "collectedAmountKrw"], "0"),
          contractualDueDate: nullableString(item.fields, ["contractualDueDate", "dueDate"]),
          expectedDate: stringValue(item.fields, ["expectedDate", "dueDate"], asOf),
        };
      }),
      changeRequests: active("CHANGE_REQUEST").map((item) => ({
        id: item.id,
        engagementId: stringValue(item.fields, ["engagementId"]),
        description: stringValue(item.fields, ["description", "title"], item.id),
        status: (["ANALYZED", "AWAITING_APPROVAL", "APPROVED", "REJECTED", "APPLIED"].includes(stringValue(item.fields, ["status"])) ? stringValue(item.fields, ["status"]) : "ANALYZED") as "ANALYZED" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED",
        priceImpactKrw: stringValue(item.fields, ["priceImpactKrw", "additionalAmountKrw"], "0"),
      })),
      assets: active("ASSET").map((item) => ({
        id: item.id,
        engagementId: stringValue(item.fields, ["engagementId"]),
        name: stringValue(item.fields, ["name", "productName"], item.id),
        renewalDate: nullableString(item.fields, ["renewalDate", "expiresAt"]),
        status: stringValue(item.fields, ["status"], "ACTIVE"),
      })),
      clarifications: clarifications.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        prompt: item.prompt,
        createdAt: item.createdAt,
        status: item.status,
      })),
    };
  }

  entitiesForWorkspace(workspaceId: string): ManagedEntity[] {
    return [...this.entities.values()].filter((item) => item.workspaceId === workspaceId).map(copy).sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  }

  exportState(): AutomationProjectionState {
    return {
      schemaVersion: 1,
      entities: sorted(this.entities.values()),
      appliedMutations: sorted(this.appliedMutations.values()),
      appliedBaselinePlanIds: [...this.appliedBaselinePlanIds].sort(),
    };
  }

  hydrateState(input: AutomationProjectionState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported projection state");
    const entities = mapById(input.entities, "managedEntity");
    const applications = mapById(input.appliedMutations, "appliedMutation");
    const baselineIds = input.appliedBaselinePlanIds.map((id) => required(id, "baselinePlanId"));
    if (new Set(baselineIds).size !== baselineIds.length) throw new CustomerWorkOsV25Error("INVALID_STATE", "duplicate applied baseline plan id");
    for (const application of applications.values()) {
      if (!entities.has(application.entityId)) throw new CustomerWorkOsV25Error("INVALID_STATE", `applied mutation references missing entity ${application.entityId}`);
    }
    this.entities = entities;
    this.appliedMutations = applications;
    this.appliedBaselinePlanIds = new Set(baselineIds);
  }
}
