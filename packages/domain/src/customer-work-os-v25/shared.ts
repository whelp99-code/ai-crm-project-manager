export class CustomerWorkOsV25Error extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerWorkOsV25Error";
  }
}

export type PrincipalKind = "human" | "ai" | "service";

export interface AutomationActor {
  principalId: string;
  workspaceId: string;
  kind: PrincipalKind;
  stepUpVerified: boolean;
}

export type ConfidenceBand = "AUTO" | "REVIEW" | "CLARIFY";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ConfidencePolicy {
  autoApplyLowRisk: number;
  reviewMinimum: number;
  autoLinkAccount: number;
  autoLinkEngagement: number;
  maxQuestionsPerEvent: number;
}

export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  autoApplyLowRisk: 0.95,
  reviewMinimum: 0.7,
  autoLinkAccount: 0.95,
  autoLinkEngagement: 0.95,
  maxQuestionsPerEvent: 3,
};

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerWorkOsV25Error("INVALID_INPUT", `${field} is required`);
  return normalized;
}

export function assertWorkspace(actor: AutomationActor, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) {
    throw new CustomerWorkOsV25Error("CROSS_WORKSPACE", "cross-workspace operation is forbidden");
  }
}

export function assertHuman(actor: AutomationActor): void {
  if (actor.kind !== "human") {
    throw new CustomerWorkOsV25Error("HUMAN_REQUIRED", "a human principal is required");
  }
}

export function assertHumanOrService(actor: AutomationActor): void {
  if (actor.kind === "ai") {
    throw new CustomerWorkOsV25Error("AUTOMATION_PRINCIPAL_FORBIDDEN", "AI principals cannot directly mutate automation state");
  }
}

export function assertStepUp(actor: AutomationActor): void {
  assertHuman(actor);
  if (!actor.stepUpVerified) {
    throw new CustomerWorkOsV25Error("STEP_UP_REQUIRED", "step-up authentication is required");
  }
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[()\[\]{}'"`]/g, "")
    .trim();
}

export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function deterministicHash(value: unknown): string {
  const input = JSON.stringify(stable(value)) ?? "undefined";
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

export function clampConfidence(value: number, field = "confidence"): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CustomerWorkOsV25Error("INVALID_CONFIDENCE", `${field} must be between 0 and 1`);
  }
  return Math.round(value * 10_000) / 10_000;
}

export function confidenceBand(confidence: number, risk: RiskLevel, policy: ConfidencePolicy): ConfidenceBand {
  const normalized = clampConfidence(confidence);
  if (risk === "LOW" && normalized >= policy.autoApplyLowRisk) return "AUTO";
  if (normalized >= policy.reviewMinimum) return "REVIEW";
  return "CLARIFY";
}

export function parseIsoDate(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CustomerWorkOsV25Error("INVALID_DATE", `${field} must be a valid date or date-time`);
  }
  return date.toISOString();
}

export function uniqueStrings(values: readonly string[], field: string, allowEmpty = true): string[] {
  const normalized = [...new Set(values.map((value) => required(value, field)))].sort();
  if (!allowEmpty && normalized.length === 0) {
    throw new CustomerWorkOsV25Error("INVALID_INPUT", `${field} requires at least one value`);
  }
  return normalized;
}

export function record(value: unknown, field = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV25Error("INVALID_INPUT", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function mapById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = required(item.id, `${label}.id`);
    if (map.has(id)) throw new CustomerWorkOsV25Error("INVALID_STATE", `duplicate ${label} id: ${id}`);
    map.set(id, copy(item));
  }
  return map;
}

export function sorted<T extends { id: string }>(values: Iterable<T>): T[] {
  return [...values].map(copy).sort((left, right) => left.id.localeCompare(right.id));
}
