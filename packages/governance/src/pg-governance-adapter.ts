/**
 * PostgreSQL adapter skeleton for control_requests + execution_intents.
 *
 * Full dual-write cutover of GovernanceAuthorizationService is out of scope
 * for P1.5. This module:
 *  - defines a stable repository port (load/save shapes)
 *  - provides pure row ↔ domain mappers
 *  - ships an in-memory implementation for restart-survival tests
 *  - exposes createPgGovernanceRepository(pool) for later createApp injection
 *
 * createApp injection sketch (later):
 *   const govRepo = createPgGovernanceRepository(pool);
 *   // after authorize/decide/consume: await govRepo.saveControl(...); await govRepo.saveIntent(...)
 */

import { createHash, randomUUID } from "node:crypto";
import type { ActionType } from "@ai-crm/contracts";
import { stableStringify, type CanonicalValue } from "@ai-crm/policy-engine";
import type {
  Binding,
  ControlRequest,
  ControlStatus,
  ExecutionIntent,
  IntentStatus,
} from "./index.js";

/** Genesis previous-hash for a workspace's PG audit chain (mirrors index.ts's in-memory EMPTY_HASH). */
const GENESIS_AUDIT_HASH = "0".repeat(64);

/**
 * Canonical hash-chain material/algorithm for a single audit event, shared
 * by the PG-primary chain (`PgGovernanceRepository.appendAuditEvents` /
 * `getAuditEventsForWorkspace`) and the in-memory
 * `GovernanceAuthorizationService` chain (index.ts `appendAudit` /
 * `verifyAuditChain`), so a hash computed on write — whether by the
 * in-memory service or read back from PG on hydrate — verifies identically
 * regardless of source (N-13 / D3 restart-sourced, tamper-evident audit).
 *
 * `data` is serialized via `stableStringify` (recursively key-sorted), NOT
 * plain `JSON.stringify`: Postgres `jsonb` storage does not preserve object
 * key insertion order, so a hash computed at write time from the original
 * JS object and re-verified after a `jsonb` round-trip on hydrate would
 * spuriously mismatch under plain `JSON.stringify` even with zero tampering.
 * `stableStringify` is order-independent, so it survives the round-trip.
 */
export function computeAuditEventHash(input: {
  workspaceId: string;
  sequence: number;
  kind: string;
  subjectId: string;
  data: unknown;
  previousHash: string;
}): string {
  const material = `${input.workspaceId}\0${input.sequence}\0${input.kind}\0${input.subjectId}\0${stableStringify((input.data ?? {}) as CanonicalValue)}\0${input.previousHash}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Minimal input for a single PG-primary audit chain append. Distinct from
 * the in-memory `AuditEvent` shape (index.ts): PG owns its own sequence
 * numbers (allocated under `audit_chain_heads` row-lock) and hash chain,
 * independent of the in-memory hash chain, so a fresh process (post-restart,
 * in-memory chain reset to empty) still appends onto the REAL continuing PG
 * chain rather than starting over at sequence 1.
 */
export interface PersistedAuditEventInput {
  kind: string;
  subjectId: string;
  data: unknown;
  correlationId?: string;
}

export interface PersistedAuditEventResult {
  id: string;
  sequence: number;
  eventHash: string;
}

/**
 * A single persisted `audit_events` row, PG-shaped for hydrate-on-boot
 * replay into `GovernanceAuthorizationService.hydrate({ audits })`
 * (N-13 / D3). `hash`/`previousHash` are the PG-computed
 * `event_hash`/`previous_event_hash` columns verbatim —
 * `computeAuditEventHash` on the same fields must reproduce `hash`
 * exactly, which is what `verifyAuditChain` checks post-hydrate (and how a
 * directly-tampered `data`/`hash` column is detected as a broken chain
 * across restart).
 */
export interface PersistedAuditEventRow {
  id: string;
  workspaceId: string;
  sequence: number;
  kind: string;
  subjectId: string;
  data: unknown;
  previousHash: string;
  hash: string;
}
/**
 * A single claimed `outbox_events` row (D3 relay/at-least-once drainer).
 * Column-for-column mirror of the 0001 `outbox_events` table minus
 * `status`/`published_at` (those are drain-internal, not relay payload).
 */
export interface PersistedOutboxEventRow {
  id: string;
  workspaceId: string;
  auditEventId: string;
  eventType: string;
  partitionKey: string;
  payload: unknown;
  causationId?: string;
  createdAt: string;
}
export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  /**
   * Optional: run `fn` against a single checked-out connection/transaction
   * with `app.workspace_id` set via a SET LOCAL-equivalent
   * (`set_config('app.workspace_id', ..., true)`), so FORCE RLS policies on
   * orch_governance_controls / orch_governance_intents (0004) are enforced
   * for the duration of `fn`. A plain `pg.Pool.query()` checks out a
   * different connection per call, so a SET LOCAL-equivalent set on one call would not
   * apply to the next — callers that inject a real pool MUST implement this
   * (see apps/api/src/app.ts `createScopedPgQueryable`). When absent (unit
   * test mocks, or a caller documenting that the injected pool is already
   * per-request scoped), repository ops fall back to `this.db.query`
   * directly and RLS scoping is the caller's responsibility.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
  /**
   * Optional: checks out a single dedicated connection (like `pg.Pool.connect()`)
   * that the caller controls the lifetime of — MUST call `release()` exactly
   * once when done. Used by the outbox drainer (`claimPendingOutbox` /
   * `markOutboxPublished` / `abortOutboxClaim`) to hold one real
   * `SELECT ... FOR UPDATE SKIP LOCKED` claim open across the relay step,
   * which a bare autocommit statement cannot do (see `claimPendingOutbox`
   * doc). When absent (unit-test mocks), the outbox methods fall back to
   * per-call `this.db.query` and document the reduced concurrency guarantee.
   */
  connect?(): Promise<{
    query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
    release(): void;
  }>;
}

/** Subset of control_requests columns used by the in-memory governance service. */
export interface ControlRequestRow {
  id: string;
  workspace_id: string;
  action_type: string;
  control_kind: "APPROVAL" | "CHECKPOINT";
  resource_id: string | null;
  resource_version: number | null;
  payload_hash: string;
  // policy_version is integer in foundation SQL; service uses number.
  // Stored as text in adapter payload envelope when using the simplified shape.
  status: string;
  requester_principal_id?: string;
  decided_by_principal_id?: string | null;
  // Extended fields carried in a JSON envelope for the simplified port
  // until full dual-write maps every foundation column.
  binding_json?: unknown;
}

export interface ExecutionIntentRow {
  id: string;
  workspace_id: string;
  action_type: string;
  state: string;
  idempotency_key: string;
  resource_id: string | null;
  resource_version: number | null;
  payload_hash: string;
  lease_deadline: Date | string | null;
  lease_epoch: number;
  lease_token: string | null;
  control_id?: string | null;
  binding_json?: unknown;
}

export interface PersistedControlShape extends Binding {
  id: string;
  actionType: ActionType;
  kind: "APPROVAL" | "CHECKPOINT";
  requesterPrincipalId: string;
  decidedByPrincipalId?: string;
  status: ControlStatus;
}

export interface PersistedIntentShape extends Binding {
  id: string;
  actionType: ActionType;
  status: IntentStatus;
  controlId?: string;
  idempotencyKey: string;
  leaseDeadline?: string;
  leaseEpoch: number;
  leaseToken?: string;
}

export interface GovernanceRepository {
  saveControl(control: PersistedControlShape): Promise<void>;
  loadControl(workspaceId: string, controlId: string): Promise<PersistedControlShape | undefined>;
  saveIntent(intent: PersistedIntentShape): Promise<void>;
  loadIntent(workspaceId: string, intentId: string): Promise<PersistedIntentShape | undefined>;
  listControls(workspaceId: string): Promise<PersistedControlShape[]>;
  listIntents(workspaceId: string): Promise<PersistedIntentShape[]>;
  /**
   * PG-primary scoped read (N-08 / D4): a single-workspace SELECT run
   * through `withWorkspaceScope` so FORCE RLS enforces the workspace
   * boundary. Semantically identical to `listControls`/`listIntents` today
   * (both already scope through `this.scoped(...)`) but exposed under a
   * distinct name so request-path callers (apps/api GET
   * /api/governance/controls) can route reads through the repository as
   * PG-primary — bypassing the in-memory `GovernanceAuthorizationService`
   * snapshot entirely — without relying on `listControls`'s
   * dual-purpose name to carry that contract.
   */
  getControlsForWorkspace(workspaceId: string): Promise<PersistedControlShape[]>;
  getIntentsForWorkspace(workspaceId: string): Promise<PersistedIntentShape[]>;
  /**
   * List every persisted control across all workspaces. Used for
   * hydrate-on-boot restart-consistency; hydrate runs as the service/owner
   * role so cross-workspace RLS is expected to be bypassed intentionally.
   */
  listAllControls(): Promise<PersistedControlShape[]>;
  listAllIntents(): Promise<PersistedIntentShape[]>;
  /**
   * PG-primary audit append (N-08 / D3): appends `events` onto the
   * workspace's `audit_events` chain + advances `audit_chain_heads` +
   * enqueues `outbox_events`, all inside one `withWorkspaceScope` txn (so
   * FORCE RLS + the append-only/monotonic-head triggers apply). PG owns
   * sequence allocation (row-locked via `SELECT ... FOR UPDATE` on the head
   * row in the PG implementation) — callers must NOT assume the returned
   * sequence matches any in-memory sequence number. Returns one result per
   * input event in order. No-op / empty input returns `[]`.
   */
  appendAuditEvents(
    workspaceId: string,
    events: readonly PersistedAuditEventInput[],
  ): Promise<PersistedAuditEventResult[]>;
  /** Current `audit_chain_heads.head_sequence` for a workspace (0 if no row yet). Used by hydrate-on-boot. */
  getAuditChainHead(workspaceId: string): Promise<number>;
  /**
   * PG-primary scoped read (N-13 / D3): every persisted `audit_events` row
   * for `workspaceId`, ordered by `sequence` ascending, run through
   * `withWorkspaceScope` so FORCE RLS enforces the workspace boundary. Used
   * by hydrate-on-boot to rebuild the in-memory audit array + hash chain so
   * GET /api/governance/audit and /audit/verify survive restart (closes
   * the N-08 residual — see index.ts `hydrate()` doc comment).
   */
  getAuditEventsForWorkspace(workspaceId: string): Promise<PersistedAuditEventRow[]>;
  /**
   * Outbox drainer claim (D3 relay/at-least-once, closes the "no
   * drainer/relay" gap): claims up to `limit` PENDING `outbox_events` rows
   * via `SELECT ... FROM outbox_events WHERE status = 'PENDING' ORDER BY id
   * LIMIT $1 FOR UPDATE SKIP LOCKED` on a SINGLE checked-out
   * connection/transaction (via `PgQueryable.connect()`) that stays open
   * until `markOutboxPublished`/`abortOutboxClaim` closes it. Holding the
   * transaction open is what makes SKIP LOCKED actually exclusive between
   * two concurrent drainers: a bare autocommit `SELECT ... FOR UPDATE`
   * releases its row lock the instant the statement finishes, which would
   * not protect a relay step that runs *after* the SELECT returns. Runs
   * cross-workspace / admin (like `listAllControls`/`listAllIntents` —
   * outbox drain is a worker/admin concern, not a per-request one), so it
   * does NOT go through `withWorkspaceScope`. Returns `[]` (no open
   * transaction left behind) when nothing is PENDING. Only one claim may be
   * open at a time per repository instance.
   */
  claimPendingOutbox(limit: number): Promise<PersistedOutboxEventRow[]>;
  /**
   * Marks `ids` (a subset of the currently open claim, may be empty)
   * `status = 'PUBLISHED', published_at = now()` and commits + releases the
   * transaction opened by `claimPendingOutbox`. Any claimed id NOT included
   * in `ids` (e.g. relay failed for it) stays `PENDING` and unlocked once
   * this commits — available for the next `claimPendingOutbox` call.
   *
   * At-least-once semantics: relay happens BEFORE this call. If the worker
   * process crashes/throws after relaying but before `markOutboxPublished`
   * runs, the open transaction is never committed — Postgres rolls it back
   * on connection loss, every claimed row stays `PENDING`/unlocked, and the
   * next `claimPendingOutbox` re-claims and the worker re-relays them. A
   * relay target (log line / NOTIFY) MUST therefore be safe to observe more
   * than once for the same event.
   */
  markOutboxPublished(ids: readonly string[]): Promise<void>;
  /**
   * Aborts the currently open claim (rolls back, releases the connection)
   * without publishing anything — every claimed row stays `PENDING`. Used
   * when relay fails for every claimed row, and by tests to simulate a
   * worker crash between relay and `markOutboxPublished`. No-op if no claim
   * is open.
   */
  abortOutboxClaim(): Promise<void>;
  /**
   * D3 outbox CONSUMER (durable acked delivery, closes "at-least-once
   * EMISSION, not DELIVERY" gap left by the drainer above): reads up to
   * `limit` PUBLISHED `outbox_events` rows not yet durably consumed by
   * `consumerName`, ordered by `(created_at, id)` ascending for a
   * deterministic (not gating) processing order. The SOLE correctness
   * filter is `NOT EXISTS` against `outbox_consumed_events` for
   * `consumerName` (the dedup ledger). `outbox_consumer_offsets` is
   * intentionally NOT used to filter candidates: `created_at` is captured
   * at transaction START but MVCC visibility happens at COMMIT, so a row
   * that started earlier can commit after a row that started later already
   * advanced the offset — gating on `(created_at, id) > offset` would then
   * permanently and silently exclude that never-consumed row (silent
   * under-delivery, defeating at-least-once). The offset is retained purely
   * as an efficiency/observability watermark — see 0006_outbox_consumer.sql
   * doc and docs/ops/worker.md's "Outbox consumer" section for the residual
   * scaling trade-off this implies. Cross-workspace/admin concern like
   * `claimPendingOutbox` — does NOT go through `withWorkspaceScope`. Returns
   * `[]` when nothing new to consume.
   */
  listConsumableOutbox(consumerName: string, limit: number): Promise<PersistedOutboxEventRow[]>;
  /**
   * Applies consumption of `rows` (a batch previously returned by
   * `listConsumableOutbox`, in the same order) for `consumerName`:
   * idempotently records each row in `outbox_consumed_events` via
   * `ON CONFLICT (consumer_name, outbox_id) DO NOTHING` — redelivery of an
   * already-consumed id is therefore a no-op at the sink — then advances
   * `outbox_consumer_offsets` to the last row's `(created_at, id)` cursor
   * (monotonic: never regresses even if called with a stale/out-of-order
   * batch). Returns the ids that were NEWLY inserted (i.e. the true sink
   * effect this call performed); any id already present in the dedup
   * ledger is omitted, proving effectively-once delivery at this sink even
   * under at-least-once redelivery from the drainer/relay.
   */
  applyOutboxConsumed(
    consumerName: string,
    rows: readonly PersistedOutboxEventRow[],
  ): Promise<{ newlyConsumed: string[] }>;
  /** Current persisted cursor for `consumerName`, or `undefined` if it has never consumed anything. */
  getOutboxConsumerOffset(
    consumerName: string,
  ): Promise<{ lastConsumedId: string; lastConsumedCreatedAt: string } | undefined>;
}

function toIso(value: Date | string | undefined | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString();
}

export function controlToPersisted(control: ControlRequest): PersistedControlShape {
  const shape: PersistedControlShape = {
    id: control.id,
    workspaceId: control.workspaceId,
    resourceId: control.resourceId,
    resourceVersion: control.resourceVersion,
    payloadHash: control.payloadHash,
    policyVersion: control.policyVersion,
    actionType: control.actionType,
    kind: control.kind,
    requesterPrincipalId: control.requesterPrincipalId,
    status: control.status,
  };
  if (control.decidedByPrincipalId !== undefined) {
    shape.decidedByPrincipalId = control.decidedByPrincipalId;
  }
  if (control.trustedContextHash !== undefined) shape.trustedContextHash = control.trustedContextHash;
  return shape;
}

export function intentToPersisted(intent: ExecutionIntent): PersistedIntentShape {
  const shape: PersistedIntentShape = {
    id: intent.id,
    workspaceId: intent.workspaceId,
    resourceId: intent.resourceId,
    resourceVersion: intent.resourceVersion,
    payloadHash: intent.payloadHash,
    policyVersion: intent.policyVersion,
    actionType: intent.actionType,
    status: intent.status,
    idempotencyKey: intent.idempotencyKey,
    leaseEpoch: intent.leaseEpoch,
  };
  if (intent.controlId !== undefined) shape.controlId = intent.controlId;
  if (intent.trustedContextHash !== undefined) shape.trustedContextHash = intent.trustedContextHash;
  if (intent.leaseDeadline !== undefined) shape.leaseDeadline = intent.leaseDeadline;
  if (intent.leaseToken !== undefined) shape.leaseToken = intent.leaseToken;
  return shape;
}
export function controlFromPersisted(shape: PersistedControlShape): ControlRequest {
  const control: ControlRequest = {
    id: shape.id,
    workspaceId: shape.workspaceId,
    resourceId: shape.resourceId,
    resourceVersion: shape.resourceVersion,
    payloadHash: shape.payloadHash,
    policyVersion: shape.policyVersion,
    actionType: shape.actionType,
    kind: shape.kind,
    requesterPrincipalId: shape.requesterPrincipalId,
    status: shape.status,
  };
  if (shape.decidedByPrincipalId !== undefined) {
    control.decidedByPrincipalId = shape.decidedByPrincipalId;
  }
  if (shape.trustedContextHash !== undefined) control.trustedContextHash = shape.trustedContextHash;
  return control;
}

export function intentFromPersisted(shape: PersistedIntentShape): ExecutionIntent {
  const intent: ExecutionIntent = {
    id: shape.id,
    workspaceId: shape.workspaceId,
    resourceId: shape.resourceId,
    resourceVersion: shape.resourceVersion,
    payloadHash: shape.payloadHash,
    policyVersion: shape.policyVersion,
    actionType: shape.actionType,
    status: shape.status,
    idempotencyKey: shape.idempotencyKey,
    leaseEpoch: shape.leaseEpoch,
  };
  if (shape.controlId !== undefined) intent.controlId = shape.controlId;
  if (shape.trustedContextHash !== undefined) intent.trustedContextHash = shape.trustedContextHash;
  if (shape.leaseDeadline !== undefined) intent.leaseDeadline = shape.leaseDeadline;
  if (shape.leaseToken !== undefined) intent.leaseToken = shape.leaseToken;
  return intent;
}

export function mapControlRow(row: {
  id: string;
  workspace_id: string;
  action_type: string;
  kind: "APPROVAL" | "CHECKPOINT";
  resource_id: string;
  resource_version: number;
  payload_hash: string;
  policy_version: number;
  trusted_context_hash?: string | null;
  requester_principal_id: string;
  decided_by_principal_id?: string | null;
  status: string;
}): PersistedControlShape {
  const shape: PersistedControlShape = {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    actionType: row.action_type as ActionType,
    kind: row.kind,
    requesterPrincipalId: row.requester_principal_id,
    status: row.status as ControlStatus,
  };
  if (row.decided_by_principal_id) {
    shape.decidedByPrincipalId = row.decided_by_principal_id;
  }
  if (row.trusted_context_hash) shape.trustedContextHash = row.trusted_context_hash;
  return shape;
}

export function mapIntentRow(row: {
  id: string;
  workspace_id: string;
  action_type: string;
  status: string;
  idempotency_key: string;
  resource_id: string;
  resource_version: number;
  payload_hash: string;
  policy_version: number;
  trusted_context_hash?: string | null;
  lease_deadline?: Date | string | null;
  lease_epoch: number;
  lease_token?: string | null;
  control_id?: string | null;
}): PersistedIntentShape {
  const shape: PersistedIntentShape = {
    id: row.id,
    workspaceId: row.workspace_id,
    resourceId: row.resource_id,
    resourceVersion: row.resource_version,
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    actionType: row.action_type as ActionType,
    status: row.status as IntentStatus,
    idempotencyKey: row.idempotency_key,
    leaseEpoch: row.lease_epoch,
  };
  const deadline = toIso(row.lease_deadline ?? null);
  if (deadline !== undefined) shape.leaseDeadline = deadline;
  if (row.lease_token) shape.leaseToken = row.lease_token;
  if (row.control_id) shape.controlId = row.control_id;
  if (row.trusted_context_hash) shape.trustedContextHash = row.trusted_context_hash;
  return shape;
}
/** Raw `outbox_events` row shape as returned by `claimPendingOutbox`'s SELECT. */
interface OutboxEventDbRow {
  id: string;
  workspace_id: string;
  audit_event_id: string;
  event_type: string;
  partition_key: string;
  payload: unknown;
  causation_id: string | null;
  created_at: Date | string;
}

function mapOutboxRow(row: OutboxEventDbRow): PersistedOutboxEventRow {
  const raw = row.payload;
  const payload = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
  const shape: PersistedOutboxEventRow = {
    id: row.id,
    workspaceId: row.workspace_id,
    auditEventId: row.audit_event_id,
    eventType: row.event_type,
    partitionKey: row.partition_key,
    payload,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
  if (row.causation_id) shape.causationId = row.causation_id;
  return shape;
}

/**
 * In-memory governance repository for unit/restart tests without PostgreSQL.
 * Round-trips control_requests + execution_intents shapes.
 */
export class InMemoryGovernanceRepository implements GovernanceRepository {
  private readonly controls = new Map<string, PersistedControlShape>();
  private readonly intents = new Map<string, PersistedIntentShape>();
  private readonly auditHeads = new Map<string, { sequence: number; hash: string }>();
  private readonly auditRows = new Map<string, PersistedAuditEventRow[]>();
  private readonly outbox = new Map<
    string,
    { row: PersistedOutboxEventRow; status: "PENDING" | "PUBLISHED"; claimed: boolean }
  >();
  private outboxClaimedIds: Set<string> | undefined;
  /** consumerName -> Set of consumed outbox ids (mirrors `outbox_consumed_events`). */
  private readonly outboxConsumed = new Map<string, Set<string>>();
  /** consumerName -> persisted cursor (mirrors `outbox_consumer_offsets`). */
  private readonly outboxConsumerOffsets = new Map<
    string,
    { lastConsumedId: string; lastConsumedCreatedAt: string }
  >();

  private ckey(workspaceId: string, id: string): string {
    return `${workspaceId}\0${id}`;
  }

  async saveControl(control: PersistedControlShape): Promise<void> {
    this.controls.set(this.ckey(control.workspaceId, control.id), structuredClone(control));
  }

  async loadControl(workspaceId: string, controlId: string): Promise<PersistedControlShape | undefined> {
    const found = this.controls.get(this.ckey(workspaceId, controlId));
    return found ? structuredClone(found) : undefined;
  }

  async saveIntent(intent: PersistedIntentShape): Promise<void> {
    this.intents.set(this.ckey(intent.workspaceId, intent.id), structuredClone(intent));
  }

  async loadIntent(workspaceId: string, intentId: string): Promise<PersistedIntentShape | undefined> {
    const found = this.intents.get(this.ckey(workspaceId, intentId));
    return found ? structuredClone(found) : undefined;
  }

  async listControls(workspaceId: string): Promise<PersistedControlShape[]> {
    return [...this.controls.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => structuredClone(c));
  }

  async listIntents(workspaceId: string): Promise<PersistedIntentShape[]> {
    return [...this.intents.values()]
      .filter((i) => i.workspaceId === workspaceId)
      .map((i) => structuredClone(i));
  }
  async getControlsForWorkspace(workspaceId: string): Promise<PersistedControlShape[]> {
    return this.listControls(workspaceId);
  }

  async getIntentsForWorkspace(workspaceId: string): Promise<PersistedIntentShape[]> {
    return this.listIntents(workspaceId);
  }

  async listAllControls(): Promise<PersistedControlShape[]> {
    return [...this.controls.values()].map((c) => structuredClone(c));
  }

  async listAllIntents(): Promise<PersistedIntentShape[]> {
    return [...this.intents.values()].map((i) => structuredClone(i));
  }
  async getAuditChainHead(workspaceId: string): Promise<number> {
    return this.auditHeads.get(workspaceId)?.sequence ?? 0;
  }

  async appendAuditEvents(
    workspaceId: string,
    events: readonly PersistedAuditEventInput[],
  ): Promise<PersistedAuditEventResult[]> {
    if (events.length === 0) return [];
    const head = this.auditHeads.get(workspaceId) ?? { sequence: 0, hash: GENESIS_AUDIT_HASH };
    let sequence = head.sequence;
    let previousHash = head.hash;
    const results: PersistedAuditEventResult[] = [];
    const rows = this.auditRows.get(workspaceId) ?? [];
    for (const event of events) {
      sequence += 1;
      const eventHash = computeAuditEventHash({
        workspaceId,
        sequence,
        kind: event.kind,
        subjectId: event.subjectId,
        data: event.data,
        previousHash,
      });
      const id = `audit-mem-${workspaceId}-${sequence}`;
      results.push({ id, sequence, eventHash });
      rows.push({
        id,
        workspaceId,
        sequence,
        kind: event.kind,
        subjectId: event.subjectId,
        data: structuredClone(event.data ?? {}),
        previousHash,
        hash: eventHash,
      });
      this.outbox.set(id, {
        row: {
          id,
          workspaceId,
          auditEventId: id,
          eventType: event.kind,
          partitionKey: workspaceId,
          payload: { subjectId: event.subjectId, data: structuredClone(event.data ?? {}) },
          createdAt: new Date().toISOString(),
        },
        status: "PENDING",
        claimed: false,
      });
      previousHash = eventHash;
    }
    this.auditRows.set(workspaceId, rows);
    this.auditHeads.set(workspaceId, { sequence, hash: previousHash });
    return results;
  }

  /** See `GovernanceRepository.getAuditEventsForWorkspace` doc. */
  async getAuditEventsForWorkspace(workspaceId: string): Promise<PersistedAuditEventRow[]> {
    return (this.auditRows.get(workspaceId) ?? []).map((row) => structuredClone(row));
  }

  /** See `GovernanceRepository.claimPendingOutbox` doc. In-memory: no real concurrency, but honors the same claim/release protocol. */
  async claimPendingOutbox(limit: number): Promise<PersistedOutboxEventRow[]> {
    if (this.outboxClaimedIds) {
      throw new Error(
        "claimPendingOutbox: a previous claim is still open — call markOutboxPublished or abortOutboxClaim first",
      );
    }
    const pending = [...this.outbox.entries()]
      .filter(([, v]) => v.status === "PENDING" && !v.claimed)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, limit);
    if (pending.length === 0) return [];
    const claimedIds = new Set(pending.map(([id]) => id));
    for (const id of claimedIds) this.outbox.get(id)!.claimed = true;
    this.outboxClaimedIds = claimedIds;
    return pending.map(([, v]) => structuredClone(v.row));
  }

  /** See `GovernanceRepository.markOutboxPublished` doc. */
  async markOutboxPublished(ids: readonly string[]): Promise<void> {
    const claimed = this.outboxClaimedIds;
    for (const id of ids) {
      if (claimed && !claimed.has(id)) continue;
      const entry = this.outbox.get(id);
      if (entry) entry.status = "PUBLISHED";
    }
    if (claimed) {
      for (const id of claimed) {
        const entry = this.outbox.get(id);
        if (entry) entry.claimed = false;
      }
      this.outboxClaimedIds = undefined;
    }
  }

  /** See `GovernanceRepository.abortOutboxClaim` doc. */
  async abortOutboxClaim(): Promise<void> {
    if (!this.outboxClaimedIds) return;
    for (const id of this.outboxClaimedIds) {
      const entry = this.outbox.get(id);
      if (entry) entry.claimed = false;
    }
    this.outboxClaimedIds = undefined;
  }
  /** See `GovernanceRepository.listConsumableOutbox` doc. */
  async listConsumableOutbox(consumerName: string, limit: number): Promise<PersistedOutboxEventRow[]> {
    // Mirrors the PG adapter: `NOT EXISTS` (the `consumed` set below) is the
    // SOLE correctness filter. `outboxConsumerOffsets` is an
    // observability/efficiency watermark only — never used to gate
    // candidates (see `GovernanceRepository.listConsumableOutbox` doc for
    // why gating on it would silently under-deliver).
    const consumed = this.outboxConsumed.get(consumerName);
    const candidates = [...this.outbox.values()]
      .filter((v) => v.status === "PUBLISHED" && !(consumed && consumed.has(v.row.id)))
      .map((v) => v.row)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, limit);
    return candidates.map((row) => structuredClone(row));
  }

  /** See `GovernanceRepository.applyOutboxConsumed` doc. */
  async applyOutboxConsumed(
    consumerName: string,
    rows: readonly PersistedOutboxEventRow[],
  ): Promise<{ newlyConsumed: string[] }> {
    if (rows.length === 0) return { newlyConsumed: [] };
    let consumed = this.outboxConsumed.get(consumerName);
    if (!consumed) {
      consumed = new Set<string>();
      this.outboxConsumed.set(consumerName, consumed);
    }
    const newlyConsumed: string[] = [];
    for (const row of rows) {
      if (consumed.has(row.id)) continue;
      consumed.add(row.id);
      newlyConsumed.push(row.id);
    }
    const last = rows[rows.length - 1]!;
    const existing = this.outboxConsumerOffsets.get(consumerName);
    const advances =
      !existing ||
      last.createdAt > existing.lastConsumedCreatedAt ||
      (last.createdAt === existing.lastConsumedCreatedAt && last.id > existing.lastConsumedId);
    if (advances) {
      this.outboxConsumerOffsets.set(consumerName, {
        lastConsumedId: last.id,
        lastConsumedCreatedAt: last.createdAt,
      });
    }
    return { newlyConsumed };
  }

  /** See `GovernanceRepository.getOutboxConsumerOffset` doc. */
  async getOutboxConsumerOffset(
    consumerName: string,
  ): Promise<{ lastConsumedId: string; lastConsumedCreatedAt: string } | undefined> {
    const offset = this.outboxConsumerOffsets.get(consumerName);
    return offset ? { ...offset } : undefined;
  }


  toJSON(): { controls: PersistedControlShape[]; intents: PersistedIntentShape[] } {
    return {
      controls: [...this.controls.values()].map((c) => structuredClone(c)),
      intents: [...this.intents.values()].map((i) => structuredClone(i)),
    };
  }

  static fromJSON(data: {
    controls: PersistedControlShape[];
    intents: PersistedIntentShape[];
  }): InMemoryGovernanceRepository {
    const repo = new InMemoryGovernanceRepository();
    for (const c of data.controls) void repo.saveControl(c);
    for (const i of data.intents) void repo.saveIntent(i);
    return repo;
  }
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT statements
 * against the `orch_governance_controls` / `orch_governance_intents`
 * snapshot tables from 0004_governance_snapshot.sql (mirrors the
 * orchestration `pg-store.ts` pattern). These are sidecar tables that
 * persist PersistedControlShape / PersistedIntentShape verbatim — NOT the
 * foundation `control_requests` / `execution_intents` tables from 0001,
 * which require `policy_decision_id` / `control_claim_id` FKs the in-memory
 * governance model does not carry.
 *
 * Per-workspace ops (save/load/list scoped to one workspace) run through
 * `db.withWorkspaceScope` when the injected pool provides it, so
 * a SET LOCAL-equivalent via `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS. `listAllControls` /
 * `listAllIntents` are the hydrate-on-boot admin path: they read across
 * every workspace and are expected to run under an admin/superuser
 * connection (docker `ai_crm` bootstrap user bypasses RLS entirely) —
 * production must scope hydrate to a dedicated admin role instead of the
 * bootstrap superuser. See docs/ops/sor-persistence.md.
 */
export function createPgGovernanceRepository(pool: PgQueryable): GovernanceRepository {
  return new PgGovernanceRepository(pool);
}

interface OrchGovernanceControlRow {
  id: string;
  workspace_id: string;
  action_type: string;
  kind: "APPROVAL" | "CHECKPOINT";
  resource_id: string;
  resource_version: number;
  payload_hash: string;
  policy_version: number;
  trusted_context_hash: string | null;
  requester_principal_id: string;
  decided_by_principal_id: string | null;
  status: string;
}

interface OrchGovernanceIntentRow {
  id: string;
  workspace_id: string;
  action_type: string;
  status: string;
  idempotency_key: string;
  resource_id: string;
  resource_version: number;
  payload_hash: string;
  policy_version: number;
  trusted_context_hash: string | null;
  lease_deadline: Date | string | null;
  lease_epoch: number;
  lease_token: string | null;
  control_id: string | null;
}

class PgGovernanceRepository implements GovernanceRepository {
  constructor(private readonly db: PgQueryable) {}

  /** The single in-flight `claimPendingOutbox` transaction, if any (see interface doc). */
  private outboxClaim:
    | {
        client: { query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>; release(): void };
        claimedIds: Set<string>;
      }
    | undefined;

  /**
   * Runs `fn` scoped to `workspaceId` via `db.withWorkspaceScope` when the
   * injected pool implements it (real `pg.Pool` from createApp's onReady),
   * so a SET LOCAL-equivalent (`set_config('app.workspace_id', ..., true)`) is honored by FORCE RLS.
   * Falls back to running `fn` directly against the unscoped pool for
   * callers that do not implement scoping (unit-test mocks, or a pool the
   * caller documents as already per-request scoped).
   */
  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveControl(control: PersistedControlShape): Promise<void> {
    await this.scoped(control.workspaceId, (db) =>
      db.query(
        `INSERT INTO orch_governance_controls (
           id, workspace_id, action_type, kind, resource_id, resource_version,
           payload_hash, policy_version, trusted_context_hash, requester_principal_id,
           decided_by_principal_id, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           action_type = EXCLUDED.action_type,
           kind = EXCLUDED.kind,
           resource_id = EXCLUDED.resource_id,
           resource_version = EXCLUDED.resource_version,
           payload_hash = EXCLUDED.payload_hash,
           policy_version = EXCLUDED.policy_version,
           trusted_context_hash = EXCLUDED.trusted_context_hash,
           requester_principal_id = EXCLUDED.requester_principal_id,
           decided_by_principal_id = EXCLUDED.decided_by_principal_id,
           status = EXCLUDED.status,
           updated_at = now()`,
        [
          control.id,
          control.workspaceId,
          control.actionType,
          control.kind,
          control.resourceId,
          control.resourceVersion,
          control.payloadHash,
          control.policyVersion,
          control.trustedContextHash ?? null,
          control.requesterPrincipalId,
          control.decidedByPrincipalId ?? null,
          control.status,
        ],
      ),
    );
  }

  async loadControl(workspaceId: string, controlId: string): Promise<PersistedControlShape | undefined> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<OrchGovernanceControlRow>(
        `SELECT * FROM orch_governance_controls WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, controlId],
      ),
    );
    const row = result.rows[0];
    return row ? mapControlRow(row) : undefined;
  }

  async saveIntent(intent: PersistedIntentShape): Promise<void> {
    await this.scoped(intent.workspaceId, (db) =>
      db.query(
        `INSERT INTO orch_governance_intents (
           id, workspace_id, action_type, status, idempotency_key, resource_id,
           resource_version, payload_hash, policy_version, trusted_context_hash, lease_deadline,
           lease_epoch, lease_token, control_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           action_type = EXCLUDED.action_type,
           status = EXCLUDED.status,
           idempotency_key = EXCLUDED.idempotency_key,
           resource_id = EXCLUDED.resource_id,
           resource_version = EXCLUDED.resource_version,
           payload_hash = EXCLUDED.payload_hash,
           policy_version = EXCLUDED.policy_version,
           trusted_context_hash = EXCLUDED.trusted_context_hash,
           lease_deadline = EXCLUDED.lease_deadline,
           lease_epoch = EXCLUDED.lease_epoch,
           lease_token = EXCLUDED.lease_token,
           control_id = EXCLUDED.control_id,
           updated_at = now()`,
        [
          intent.id,
          intent.workspaceId,
          intent.actionType,
          intent.status,
          intent.idempotencyKey,
          intent.resourceId,
          intent.resourceVersion,
          intent.payloadHash,
          intent.policyVersion,
          intent.trustedContextHash ?? null,
          intent.leaseDeadline ?? null,
          intent.leaseEpoch,
          intent.leaseToken ?? null,
          intent.controlId ?? null,
        ],
      ),
    );
  }

  async loadIntent(workspaceId: string, intentId: string): Promise<PersistedIntentShape | undefined> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<OrchGovernanceIntentRow>(
        `SELECT * FROM orch_governance_intents WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, intentId],
      ),
    );
    const row = result.rows[0];
    return row ? mapIntentRow(row) : undefined;
  }

  async listControls(workspaceId: string): Promise<PersistedControlShape[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<OrchGovernanceControlRow>(
        `SELECT * FROM orch_governance_controls WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapControlRow(row));
  }

  async listIntents(workspaceId: string): Promise<PersistedIntentShape[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<OrchGovernanceIntentRow>(
        `SELECT * FROM orch_governance_intents WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapIntentRow(row));
  }
  async getControlsForWorkspace(workspaceId: string): Promise<PersistedControlShape[]> {
    return this.listControls(workspaceId);
  }

  async getIntentsForWorkspace(workspaceId: string): Promise<PersistedIntentShape[]> {
    return this.listIntents(workspaceId);
  }


  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllControls(): Promise<PersistedControlShape[]> {
    const result = await this.db.query<OrchGovernanceControlRow>(
      `SELECT * FROM orch_governance_controls ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapControlRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllIntents(): Promise<PersistedIntentShape[]> {
    const result = await this.db.query<OrchGovernanceIntentRow>(
      `SELECT * FROM orch_governance_intents ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapIntentRow(row));
  }

  /** Current `audit_chain_heads.head_sequence` for a workspace (0 if no row yet). Used by hydrate-on-boot. */
  async getAuditChainHead(workspaceId: string): Promise<number> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<{ head_sequence: string | number }>(
        `SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1`,
        [workspaceId],
      ),
    );
    const row = result.rows[0];
    return row ? Number(row.head_sequence) : 0;
  }

  /**
   * PG-primary audit append (N-08 / D3): allocates contiguous sequence
   * numbers under a row-locked `audit_chain_heads` head (creating the head
   * row on first use), inserts one `audit_events` row per input event
   * chained by `previous_event_hash`/`event_hash`, advances the head to the
   * last sequence/hash written, and enqueues one PENDING `outbox_events` row
   * per event — all inside a single `withWorkspaceScope` transaction so
   * FORCE RLS, the audit_events append-only trigger, and the
   * audit_chain_heads monotonic-head trigger all apply atomically. The
   * `FOR UPDATE` row lock on the head serializes concurrent writers on the
   * same workspace so two overlapping callers still produce a contiguous,
   * gap-free, duplicate-free sequence (each waits for the other's
   * transaction to commit/release the lock before reading the head).
   */
  async appendAuditEvents(
    workspaceId: string,
    events: readonly PersistedAuditEventInput[],
  ): Promise<PersistedAuditEventResult[]> {
    if (events.length === 0) return [];
    return this.scoped(workspaceId, async (db) => {
      await db.query(
        `INSERT INTO audit_chain_heads (workspace_id, head_sequence) VALUES ($1, 0)
         ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId],
      );
      const headResult = await db.query<{ head_sequence: string | number; head_event_hash: string | null }>(
        `SELECT head_sequence, head_event_hash FROM audit_chain_heads WHERE workspace_id = $1 FOR UPDATE`,
        [workspaceId],
      );
      const headRow = headResult.rows[0];
      let sequence = headRow ? Number(headRow.head_sequence) : 0;
      let previousHash = headRow?.head_event_hash ?? GENESIS_AUDIT_HASH;
      let lastEventId = "";
      const results: PersistedAuditEventResult[] = [];
      for (const event of events) {
        sequence += 1;
        const correlationId = event.correlationId ?? randomUUID();
        const payload = { subjectId: event.subjectId, data: event.data ?? {} };
        const eventHash = computeAuditEventHash({
          workspaceId,
          sequence,
          kind: event.kind,
          subjectId: event.subjectId,
          data: payload.data,
          previousHash,
        });
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO audit_events (
             workspace_id, sequence, event_type, payload,
             previous_event_hash, event_hash, correlation_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [workspaceId, sequence, event.kind, JSON.stringify(payload), previousHash, eventHash, correlationId],
        );
        const eventId = inserted.rows[0]!.id;
        await db.query(
          `INSERT INTO outbox_events (workspace_id, audit_event_id, event_type, partition_key, payload, status)
           VALUES ($1,$2,$3,$4,$5,'PENDING')`,
          [workspaceId, eventId, event.kind, workspaceId, JSON.stringify(payload)],
        );
        results.push({ id: eventId, sequence, eventHash });
        previousHash = eventHash;
        lastEventId = eventId;
      }
      await db.query(
        `UPDATE audit_chain_heads SET head_sequence = $2, head_event_id = $3, head_event_hash = $4, updated_at = now()
         WHERE workspace_id = $1`,
        [workspaceId, sequence, lastEventId, previousHash],
      );
      return results;
    });
  }

  /**
   * PG-primary scoped read (N-13 / D3): every persisted `audit_events` row
   * for `workspaceId`, ordered by `sequence` ascending. See interface doc
   * on `GovernanceRepository.getAuditEventsForWorkspace`.
   */
  async getAuditEventsForWorkspace(workspaceId: string): Promise<PersistedAuditEventRow[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<{
        id: string;
        sequence: string | number;
        event_type: string;
        payload: unknown;
        previous_event_hash: string | null;
        event_hash: string;
      }>(
        `SELECT id, sequence, event_type, payload, previous_event_hash, event_hash
         FROM audit_events WHERE workspace_id = $1 ORDER BY sequence ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => {
      const raw = row.payload;
      const parsed =
        typeof raw === "string"
          ? (JSON.parse(raw) as { subjectId?: unknown; data?: unknown })
          : ((raw ?? {}) as { subjectId?: unknown; data?: unknown });
      return {
        id: row.id,
        workspaceId,
        sequence: Number(row.sequence),
        kind: row.event_type,
        subjectId: typeof parsed.subjectId === "string" ? parsed.subjectId : "",
        data: parsed.data ?? {},
        previousHash: row.previous_event_hash ?? GENESIS_AUDIT_HASH,
        hash: row.event_hash,
      };
    });
  }

  /** See `GovernanceRepository.claimPendingOutbox` doc. */
  async claimPendingOutbox(limit: number): Promise<PersistedOutboxEventRow[]> {
    if (this.outboxClaim) {
      throw new Error(
        "claimPendingOutbox: a previous claim is still open — call markOutboxPublished or abortOutboxClaim first",
      );
    }
    const claimSql = `SELECT id, workspace_id, audit_event_id, event_type, partition_key, payload, causation_id, created_at
       FROM outbox_events WHERE status = 'PENDING' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`;

    if (!this.db.connect) {
      // No dedicated-connection support (unit-test mock pool): fall back to
      // a bare autocommit SELECT. SKIP LOCKED still protects against a
      // second claim racing WHILE this one's statement is executing, but
      // NOT across a relay step that runs after it returns (the row lock
      // releases the instant the statement completes) — acceptable only
      // because this path is unit-test-only; the live worker always runs
      // against a real `pg.Pool`, which implements `connect()`.
      const result = await this.db.query<OutboxEventDbRow>(claimSql, [limit]);
      return result.rows.map(mapOutboxRow);
    }

    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OutboxEventDbRow>(claimSql, [limit]);
      if (result.rows.length === 0) {
        await client.query("COMMIT");
        client.release();
        return [];
      }
      const rows = result.rows.map(mapOutboxRow);
      this.outboxClaim = { client, claimedIds: new Set(rows.map((r) => r.id)) };
      return rows;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure; original error is what matters
      }
      client.release();
      throw error;
    }
  }

  /** See `GovernanceRepository.markOutboxPublished` doc. */
  async markOutboxPublished(ids: readonly string[]): Promise<void> {
    if (!this.outboxClaim) {
      // Unit-test fallback path (no held transaction to close) — see
      // `claimPendingOutbox`'s `!this.db.connect` branch doc.
      if (ids.length === 0) return;
      await this.db.query(`UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() WHERE id = ANY($1)`, [
        [...ids],
      ]);
      return;
    }
    const { client } = this.outboxClaim;
    try {
      if (ids.length > 0) {
        await client.query(
          `UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() WHERE id = ANY($1)`,
          [[...ids]],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure; original error is what matters
      }
      throw error;
    } finally {
      client.release();
      this.outboxClaim = undefined;
    }
  }

  /** See `GovernanceRepository.abortOutboxClaim` doc. */
  async abortOutboxClaim(): Promise<void> {
    if (!this.outboxClaim) return;
    const { client } = this.outboxClaim;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
      this.outboxClaim = undefined;
    }
  }
  /** See `GovernanceRepository.listConsumableOutbox` doc. */
  async listConsumableOutbox(consumerName: string, limit: number): Promise<PersistedOutboxEventRow[]> {
    // NOTE: `outbox_consumer_offsets` is an observability/efficiency watermark ONLY — it is
    // NOT used to gate candidate eligibility here. `outbox_events.created_at` is captured at
    // transaction START, but MVCC visibility happens at COMMIT, so a row that started earlier
    // can commit later than a row that started later and already advanced the offset. Gating
    // on `(created_at, id) > offset` would then permanently and silently exclude that
    // never-consumed row (under-delivery, defeating at-least-once). The sole correctness
    // filter is therefore `NOT EXISTS(outbox_consumed_events)`; every PUBLISHED-not-yet-consumed
    // row is eventually eligible regardless of commit order. See docs/ops/worker.md for the
    // resulting scaling trade-off (unbounded anti-join scan until retention/pruning lands).
    const result = await this.db.query<OutboxEventDbRow>(
      `SELECT id, workspace_id, audit_event_id, event_type, partition_key, payload, causation_id, created_at
       FROM outbox_events oe
       WHERE status = 'PUBLISHED'
         AND NOT EXISTS (
           SELECT 1 FROM outbox_consumed_events oce
           WHERE oce.consumer_name = $1 AND oce.outbox_id = oe.id
         )
       ORDER BY oe.created_at, oe.id
       LIMIT $2`,
      [consumerName, limit],
    );
    return result.rows.map(mapOutboxRow);
  }

  /** See `GovernanceRepository.applyOutboxConsumed` doc. */
  async applyOutboxConsumed(
    consumerName: string,
    rows: readonly PersistedOutboxEventRow[],
  ): Promise<{ newlyConsumed: string[] }> {
    if (rows.length === 0) return { newlyConsumed: [] };
    const ids = rows.map((r) => r.id);
    const workspaceIds = rows.map((r) => r.workspaceId);
    const insertResult = await this.db.query<{ outbox_id: string }>(
      `INSERT INTO outbox_consumed_events (consumer_name, outbox_id, workspace_id)
       SELECT $1, unnest($2::uuid[]), unnest($3::uuid[])
       ON CONFLICT (consumer_name, outbox_id) DO NOTHING
       RETURNING outbox_id`,
      [consumerName, ids, workspaceIds],
    );
    const newlyConsumed = insertResult.rows.map((r) => r.outbox_id);

    const last = rows[rows.length - 1]!;
    await this.db.query(
      `INSERT INTO outbox_consumer_offsets (consumer_name, last_consumed_id, last_consumed_created_at, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (consumer_name) DO UPDATE SET
         last_consumed_id = EXCLUDED.last_consumed_id,
         last_consumed_created_at = EXCLUDED.last_consumed_created_at,
         updated_at = now()
       WHERE (outbox_consumer_offsets.last_consumed_created_at, outbox_consumer_offsets.last_consumed_id)
             < (EXCLUDED.last_consumed_created_at, EXCLUDED.last_consumed_id)`,
      [consumerName, last.id, last.createdAt],
    );

    return { newlyConsumed };
  }

  /** See `GovernanceRepository.getOutboxConsumerOffset` doc. */
  async getOutboxConsumerOffset(
    consumerName: string,
  ): Promise<{ lastConsumedId: string; lastConsumedCreatedAt: string } | undefined> {
    const result = await this.db.query<{ last_consumed_id: string; last_consumed_created_at: Date | string }>(
      `SELECT last_consumed_id, last_consumed_created_at FROM outbox_consumer_offsets WHERE consumer_name = $1`,
      [consumerName],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      lastConsumedId: row.last_consumed_id,
      lastConsumedCreatedAt: toIso(row.last_consumed_created_at) ?? new Date().toISOString(),
    };
  }
}
