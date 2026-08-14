import { createHash } from "node:crypto";
import {
  CustomerWorkOsV2Error,
  CustomerWorkOsV2Platform,
  customerWorkOsV2StateHash,
  type CustomerWorkOsV2State,
  type IdentityPrincipal,
  type V2Actor,
  type WorkspaceMembership,
} from "@ai-crm/domain/customer-work-os-v2";

export interface V2IdempotencyRecord {
  key: string;
  requestHash: string;
  statusCode: number;
  result: unknown;
  createdAt: string;
}

export interface V2RuntimeEnvelope {
  schemaVersion: 1;
  workspaceId: string;
  version: number;
  state: CustomerWorkOsV2State;
  idempotency: V2IdempotencyRecord[];
  stateHash: string;
  updatedByPrincipalId: string;
  updatedAt: string;
}

export interface V2AuditEvent {
  workspaceId: string;
  sequence: number;
  operationId: string;
  principalId: string;
  command: string;
  idempotencyKey: string;
  requestHash: string;
  beforeStateHash: string;
  afterStateHash: string;
  resultHash: string;
  previousEventHash: string | null;
  eventHash: string;
  createdAt: string;
}

export interface CwosV2StateStore {
  load(workspaceId: string): Promise<V2RuntimeEnvelope | undefined>;
  compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<V2RuntimeEnvelope, "version">,
    audit: Omit<V2AuditEvent, "sequence" | "previousEventHash" | "eventHash">,
  ): Promise<V2RuntimeEnvelope>;
  close?(): Promise<void>;
}

interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface V2PgQueryable {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: V2PgQueryable) => Promise<T>): Promise<T>;
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
  }
  return value;
}

export function v2Hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function emptyEnvelope(workspaceId: string, principalId: string, now: string): Omit<V2RuntimeEnvelope, "version"> {
  const state = new CustomerWorkOsV2Platform(workspaceId).exportState();
  return {
    schemaVersion: 1,
    workspaceId,
    state,
    idempotency: [],
    stateHash: customerWorkOsV2StateHash(state),
    updatedByPrincipalId: principalId,
    updatedAt: now,
  };
}

export function validateEnvelope(input: V2RuntimeEnvelope): void {
  if (input.schemaVersion !== 1 || input.state.schemaVersion !== 2) {
    throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported v2 runtime state");
  }
  if (!input.workspaceId.trim() || input.workspaceId !== input.state.workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE_STATE", "runtime and domain workspace differ");
  }
  if (input.version < 1 || !Number.isSafeInteger(input.version)) {
    throw new CustomerWorkOsV2Error("INVALID_STATE", "invalid runtime version");
  }
  if (!SHA256_PATTERN.test(input.stateHash) || input.stateHash !== customerWorkOsV2StateHash(input.state)) {
    throw new CustomerWorkOsV2Error("STATE_HASH_MISMATCH", "runtime state hash mismatch");
  }
  if (!input.updatedByPrincipalId.trim() || !Number.isFinite(Date.parse(input.updatedAt))) {
    throw new CustomerWorkOsV2Error("INVALID_STATE", "runtime update metadata is invalid");
  }
  if (input.idempotency.length > 500) {
    throw new CustomerWorkOsV2Error("INVALID_STATE", "idempotency window exceeds the configured bound");
  }
  const keys = new Set<string>();
  for (const item of input.idempotency) {
    if (!item.key.trim() || keys.has(item.key)) {
      throw new CustomerWorkOsV2Error("INVALID_STATE", "duplicate or empty idempotency key");
    }
    if (!SHA256_PATTERN.test(item.requestHash) || !Number.isSafeInteger(item.statusCode) || !Number.isFinite(Date.parse(item.createdAt))) {
      throw new CustomerWorkOsV2Error("INVALID_STATE", "invalid idempotency record");
    }
    keys.add(item.key);
  }
}

export function validateAuditInput(
  workspaceId: string,
  audit: Omit<V2AuditEvent, "sequence" | "previousEventHash" | "eventHash">,
): void {
  if (audit.workspaceId !== workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE_STATE", "audit and snapshot workspace differ");
  }
  for (const [field, value] of [
    ["operationId", audit.operationId],
    ["principalId", audit.principalId],
    ["command", audit.command],
    ["idempotencyKey", audit.idempotencyKey],
  ] as const) {
    if (!value.trim()) throw new CustomerWorkOsV2Error("INVALID_STATE", `audit ${field} is required`);
  }
  for (const hash of [
    audit.requestHash,
    audit.beforeStateHash,
    audit.afterStateHash,
    audit.resultHash,
  ]) {
    if (!SHA256_PATTERN.test(hash)) {
      throw new CustomerWorkOsV2Error("INVALID_STATE", "audit hashes must be lowercase SHA-256 values");
    }
  }
  if (!Number.isFinite(Date.parse(audit.createdAt))) {
    throw new CustomerWorkOsV2Error("INVALID_STATE", "audit createdAt is invalid");
  }
}
