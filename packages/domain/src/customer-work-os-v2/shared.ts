export const CWOS_V2_VERSIONS = [
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
  "1.6.0",
  "1.7.0",
  "1.8.0",
  "1.9.0",
  "2.0.0",
] as const;

export type CwosV2Version = (typeof CWOS_V2_VERSIONS)[number];
export type PrincipalKind = "human" | "ai" | "service";

export interface V2Actor {
  principalId: string;
  workspaceId: string;
  kind: PrincipalKind;
  stepUpVerified: boolean;
}

export interface HumanApproval {
  approvalId: string;
  workspaceId: string;
  action: string;
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  approvedByPrincipalId: string;
  status: "APPROVED" | "CONSUMED";
}

export interface Finding {
  id: string;
  version: CwosV2Version;
  perspective:
    | "product"
    | "architecture"
    | "security"
    | "data"
    | "workflow"
    | "ai_governance"
    | "api"
    | "ux"
    | "recovery"
    | "operations";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title: string;
  status: "OPEN" | "RESOLVED";
  evidenceRef: string | null;
}

export class CustomerWorkOsV2Error extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomerWorkOsV2Error";
  }
}

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} is required`);
  return normalized;
}

export function positive(value: number, field: string, allowZero = false): number {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return value;
}

export function integer(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} must be an integer >= ${minimum}`);
  }
  return value;
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function assertWorkspace(expected: string, actual: string): void {
  if (required(expected, "workspaceId") !== required(actual, "entity.workspaceId")) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace access is forbidden");
  }
}

export function assertHuman(actor: V2Actor): void {
  if (actor.kind !== "human") throw new CustomerWorkOsV2Error("HUMAN_REQUIRED", "a human principal is required");
}

export function assertStepUp(actor: V2Actor): void {
  assertHuman(actor);
  if (!actor.stepUpVerified) throw new CustomerWorkOsV2Error("STEP_UP_REQUIRED", "step-up authentication is required");
}

export function assertApproval(input: {
  approval: HumanApproval;
  actor: V2Actor;
  action: string;
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  consumedApprovalIds: ReadonlySet<string>;
}): void {
  const { approval, actor } = input;
  assertHuman(actor);
  assertWorkspace(actor.workspaceId, approval.workspaceId);
  if (approval.status !== "APPROVED") throw new CustomerWorkOsV2Error("APPROVAL_NOT_ACTIVE", "approval must be active");
  if (input.consumedApprovalIds.has(approval.approvalId)) throw new CustomerWorkOsV2Error("REPLAYED_APPROVAL", "approval was already consumed");
  if (approval.approvedByPrincipalId === actor.principalId) {
    throw new CustomerWorkOsV2Error("SELF_APPROVAL", "requester and approver must be different principals");
  }
  if (
    approval.action !== input.action ||
    approval.resourceId !== input.resourceId ||
    approval.resourceVersion !== input.resourceVersion ||
    approval.payloadHash !== input.payloadHash
  ) {
    throw new CustomerWorkOsV2Error("STALE_APPROVAL", "approval binding does not match the requested mutation");
  }
}

export function uniqueById<T extends { id: string }>(items: readonly T[], label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    required(item.id, `${label}.id`);
    if (ids.has(item.id)) throw new CustomerWorkOsV2Error("INVALID_STATE", `duplicate ${label} id ${item.id}`);
    ids.add(item.id);
  }
}

export function mapValues<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  uniqueById(items, label);
  return new Map(items.map((item) => [item.id, copy(item)]));
}

export function sorted<T extends { id: string }>(items: Iterable<T>): T[] {
  return [...items].map((item) => copy(item)).sort((left, right) => left.id.localeCompare(right.id));
}
