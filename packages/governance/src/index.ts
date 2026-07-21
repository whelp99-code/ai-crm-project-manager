import type { ActionType } from "@ai-crm/contracts";
import {
  AUTO_SCHEMA,
  canonicalize,
  evaluatePolicy,
  type CanonicalValue,
} from "@ai-crm/policy-engine";
import {
  computeAuditEventHash,
  controlFromPersisted,
  intentFromPersisted,
  type PersistedAuditEventRow,
  type PersistedControlShape,
  type PersistedIntentShape,
} from "./pg-governance-adapter.js";

export type ControlStatus = "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED" | "EXPIRED" | "CANCELLED";
export type IntentStatus =
  | "QUEUED"
  | "LEASED"
  | "DISPATCHING"
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "INVALIDATED"
  | "CANCELLED";
export type NotificationStatus = "PENDING" | "SENT" | "ACKED" | "ESCALATED" | "DEAD_LETTER";

export interface Binding {
  workspaceId: string;
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  policyVersion: number;
}

export interface AuthorizationRequest {
  command: string;
  workspaceId: string;
  resourceId: string;
  resourceVersion: number;
  payload: unknown;
  requesterPrincipalId: string;
}

export interface ControlRequest extends Binding {
  id: string;
  actionType: ActionType;
  kind: "APPROVAL" | "CHECKPOINT";
  requesterPrincipalId: string;
  decidedByPrincipalId?: string;
  status: ControlStatus;
}

export interface ExecutionIntent extends Binding {
  id: string;
  actionType: ActionType;
  status: IntentStatus;
  controlId?: string;
  idempotencyKey: string;
  leaseDeadline?: string;
  leaseEpoch: number;
  leaseToken?: string;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  sequence: number;
  kind: string;
  subjectId: string;
  data: CanonicalValue;
  previousHash: string;
  hash: string;
}

export interface NotificationRecord {
  id: string;
  workspaceId: string;
  subjectId: string;
  status: NotificationStatus;
  attempts: number;
}

export interface GovernanceState {
  controls: Record<string, ControlRequest>;
  intents: Record<string, ExecutionIntent>;
  audits: AuditEvent[];
  outbox: Array<{ id: string; workspaceId: string; kind: string; subjectId: string }>;
  notifications: Record<string, NotificationRecord>;
  counters: Record<string, number>;
}

export interface AuthorizationResult {
  actionType: ActionType;
  requiredControl: "ALLOW" | "CHECKPOINT" | "REQUIRE_APPROVAL";
  control?: ControlRequest;
  intent?: ExecutionIntent;
}

export class GovernanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

export class ActionRegistry {
  private readonly entries = new Map<string, ActionType>();

  constructor(entries: Readonly<Record<string, ActionType>>) {
    for (const [command, actionType] of Object.entries(entries)) {
      if (!command.trim() || this.entries.has(command)) {
        throw new GovernanceError("INVALID_REGISTRY", `duplicate or empty command: ${command}`);
      }
      this.entries.set(command, actionType);
    }
  }

  resolve(command: string): ActionType {
    const actionType = this.entries.get(command);
    if (!actionType) {
      throw new GovernanceError("UNMAPPED_COMMAND", `command is not registered: ${command}`);
    }
    return actionType;
  }
}

const EMPTY_HASH = "0".repeat(64);


function initialState(): GovernanceState {
  return { controls: {}, intents: {}, audits: [], outbox: [], notifications: {}, counters: {} };
}

export class GovernanceAuthorizationService {
  private state: GovernanceState;

  constructor(
    private readonly registry: ActionRegistry,
    state: GovernanceState = initialState(),
  ) {
    this.state = structuredClone(state);
  }

  snapshot(): GovernanceState {
    return structuredClone(this.state);
  }
  /**
   * Restart-consistency hydrate-on-boot: rebuild in-memory controls/intents
   * maps from persisted shapes (e.g. read back from PG at process start).
   * Replaces the current state wholesale; counters are advanced past the
   * highest existing numeric suffix per id prefix so newly minted ids never
   * collide with hydrated ones.
   *
   * `audits` (N-13 / D3, closes the N-08 residual): when supplied, replays
   * every persisted `audit_events` row (per workspace, ordered by
   * `sequence`, via `GovernanceRepository.getAuditEventsForWorkspace`)
   * into `state.audits` VERBATIM — including the PG-computed
   * `hash`/`previousHash` columns — so GET /api/governance/audit and
   * `verifyAuditChain` reflect the persisted history and continue
   * validating the SAME hash chain across restart instead of resetting to
   * empty. `appendAudit` below and PG's `appendAuditEvents` both compute
   * hashes via the shared `computeAuditEventHash` (pg-governance-adapter.js),
   * so a hydrated event's hash is independently re-derivable from its own
   * `(workspaceId, sequence, kind, subjectId, data, previousHash)` fields —
   * a directly-tampered PG row (data or hash column) is detected as a
   * broken chain by `verifyAuditChain` after hydrate, the same way tampering
   * an in-memory event is detected today. Omitting `audits` (or passing an
   * empty array) leaves the in-memory audit array empty, matching prior
   * (N-08) behavior. Notifications/outbox are still not dual-written/replayed.
   */
  hydrate(data: {
    controls: readonly PersistedControlShape[];
    intents: readonly PersistedIntentShape[];
    audits?: readonly PersistedAuditEventRow[];
  }): void {
    const state = initialState();
    for (const shape of data.controls) {
      const control = controlFromPersisted(shape);
      state.controls[control.id] = control;
      this.bumpCounter(state, control.id);
    }
    for (const shape of data.intents) {
      const intent = intentFromPersisted(shape);
      state.intents[intent.id] = intent;
      this.bumpCounter(state, intent.id);
    }
    if (data.audits) {
      const sorted = [...data.audits].sort((a, b) =>
        a.workspaceId === b.workspaceId ? a.sequence - b.sequence : a.workspaceId.localeCompare(b.workspaceId),
      );
      for (const row of sorted) {
        state.audits.push({
          id: row.id,
          workspaceId: row.workspaceId,
          sequence: row.sequence,
          kind: row.kind,
          subjectId: row.subjectId,
          data: row.data as CanonicalValue,
          previousHash: row.previousHash,
          hash: row.hash,
        });
      }
    }
    this.state = state;
  }

  private bumpCounter(state: GovernanceState, id: string): void {
    const idx = id.lastIndexOf("-");
    if (idx < 0) return;
    const prefix = id.slice(0, idx);
    const suffix = Number(id.slice(idx + 1));
    if (!Number.isFinite(suffix)) return;
    if ((state.counters[prefix] ?? 0) < suffix) {
      state.counters[prefix] = suffix;
    }
  }

  private nextId(draft: GovernanceState, prefix: string): string {
    const value = (draft.counters[prefix] ?? 0) + 1;
    draft.counters[prefix] = value;
    return `${prefix}-${value.toString().padStart(6, "0")}`;
  }

  private transact<T>(operation: (draft: GovernanceState) => T): T {
    const draft = structuredClone(this.state);
    const result = operation(draft);
    this.state = draft;
    return structuredClone(result);
  }

  private appendAudit(
    draft: GovernanceState,
    workspaceId: string,
    kind: string,
    subjectId: string,
    data: unknown,
  ): AuditEvent {
    const workspaceEvents = draft.audits.filter((event) => event.workspaceId === workspaceId);
    const previous = workspaceEvents.at(-1);
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.hash ?? EMPTY_HASH;
    const canonicalData = canonicalize(data, AUTO_SCHEMA);
    const hash = computeAuditEventHash({ workspaceId, sequence, kind, subjectId, data: canonicalData, previousHash });
    const event: AuditEvent = {
      id: this.nextId(draft, "audit"),
      workspaceId,
      sequence,
      kind,
      subjectId,
      data: canonicalData,
      previousHash,
      hash,
    };
    draft.audits.push(event);
    draft.outbox.push({ id: this.nextId(draft, "outbox"), workspaceId, kind, subjectId });
    return event;
  }

  authorize(request: AuthorizationRequest): AuthorizationResult {
    return this.transact((draft) => {
      const actionType = this.registry.resolve(request.command);
      const policy = evaluatePolicy({ actionType, payload: request.payload });
      if (policy.requiredControl === "BLOCK") {
        throw new GovernanceError("POLICY_BLOCKED", policy.reason);
      }
      const binding: Binding = {
        workspaceId: request.workspaceId,
        resourceId: request.resourceId,
        resourceVersion: request.resourceVersion,
        payloadHash: policy.canonicalHash,
        policyVersion: policy.policyVersion,
      };
      this.appendAudit(draft, request.workspaceId, "POLICY_DECIDED", request.resourceId, {
        actionType,
        requiredControl: policy.requiredControl,
        payloadHash: policy.canonicalHash,
      });
      if (policy.requiredControl === "REQUIRE_APPROVAL" || policy.requiredControl === "CHECKPOINT") {
        const id = this.nextId(draft, "control");
        const control: ControlRequest = {
          ...binding,
          id,
          actionType,
          kind: policy.requiredControl === "REQUIRE_APPROVAL" ? "APPROVAL" : "CHECKPOINT",
          requesterPrincipalId: request.requesterPrincipalId,
          status: "PENDING",
        };
        draft.controls[id] = control;
        this.appendAudit(draft, request.workspaceId, "CONTROL_REQUESTED", id, { actionType, kind: control.kind });
        return { actionType, requiredControl: policy.requiredControl, control };
      }
      const intent = this.createIntent(draft, actionType, binding);
      return { actionType, requiredControl: "ALLOW", intent };
    });
  }

  decideControl(controlId: string, principalId: string, decision: "APPROVE" | "REJECT", workspaceId: string): ControlRequest {
    return this.transact((draft) => {
      const control = draft.controls[controlId];
      if (!control || control.workspaceId !== workspaceId) {
        throw new GovernanceError("CONTROL_NOT_FOUND", `control not found: ${controlId}`);
      }
      if (control.status !== "PENDING") {
        throw new GovernanceError("CONTROL_NOT_PENDING", `control is not pending: ${controlId}`);
      }
      if (control.requesterPrincipalId === principalId) {
        throw new GovernanceError("SEPARATION_OF_DUTY", "requester cannot decide their own control");
      }
      control.status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      control.decidedByPrincipalId = principalId;
      this.appendAudit(draft, control.workspaceId, `CONTROL_${decision}D`, control.id, { principalId });
      return control;
    });
  }
  /** Terminalize a control that will not be consumed (job/work-item cancel). */
  cancelControl(controlId: string, workspaceId: string): ControlRequest {
    return this.transact((draft) => {
      const control = draft.controls[controlId];
      if (!control || control.workspaceId !== workspaceId) {
        throw new GovernanceError("CONTROL_NOT_FOUND", `control not found: ${controlId}`);
      }
      if (control.status === "CANCELLED" || control.status === "EXPIRED" || control.status === "CONSUMED" || control.status === "REJECTED") {
        return control;
      }
      if (control.status !== "PENDING" && control.status !== "APPROVED") {
        throw new GovernanceError("CONTROL_NOT_CANCELLABLE", `control cannot be cancelled: ${controlId}`);
      }
      control.status = "CANCELLED";
      this.appendAudit(draft, control.workspaceId, "CONTROL_CANCELLED", control.id, {});
      return control;
    });
  }


  /** Terminalize a PENDING control as EXPIRED (timeout / TTL path). GOV-U-05. */
  expireControl(controlId: string, workspaceId: string): ControlRequest {
    return this.transact((draft) => {
      const control = draft.controls[controlId];
      if (!control || control.workspaceId !== workspaceId) {
        throw new GovernanceError("CONTROL_NOT_FOUND", `control not found: ${controlId}`);
      }
      if (control.status === "EXPIRED") {
        return control;
      }
      if (control.status !== "PENDING") {
        throw new GovernanceError(
          "CONTROL_NOT_PENDING",
          `control cannot be expired from status ${control.status}: ${controlId}`,
        );
      }
      control.status = "EXPIRED";
      this.appendAudit(draft, control.workspaceId, "CONTROL_EXPIRED", control.id, {});
      return control;
    });
  }

  consumeControl(controlId: string, binding: Binding, idempotencyKey?: string): ExecutionIntent {
    return this.transact((draft) => {
      const control = draft.controls[controlId];
      if (!control || control.status !== "APPROVED") {
        throw new GovernanceError("CONTROL_NOT_APPROVED", `control cannot be consumed: ${controlId}`);
      }
      for (const key of ["workspaceId", "resourceId", "resourceVersion", "payloadHash", "policyVersion"] as const) {
        if (control[key] !== binding[key]) {
          throw new GovernanceError("STALE_CONTROL_BINDING", `control binding mismatch: ${key}`);
        }
      }
      control.status = "CONSUMED";
      const intent = this.createIntent(draft, control.actionType, binding, control.id, idempotencyKey);
      this.appendAudit(draft, binding.workspaceId, "CONTROL_CONSUMED", control.id, { intentId: intent.id });
      return intent;
    });
  }

  private createIntent(
    draft: GovernanceState,
    actionType: ActionType,
    binding: Binding,
    controlId?: string,
    idempotencyKey?: string,
  ): ExecutionIntent {
    const key = idempotencyKey ?? `${binding.workspaceId}:${binding.resourceId}:${actionType}:${binding.payloadHash}:${binding.resourceVersion}`;
    const existing = Object.values(draft.intents).find(
      (intent) => intent.workspaceId === binding.workspaceId && intent.idempotencyKey === key,
    );
    if (existing) throw new GovernanceError("DUPLICATE_INTENT", `intent idempotency key already exists: ${key}`);
    const intent: ExecutionIntent = {
      ...binding,
      id: this.nextId(draft, "intent"),
      actionType,
      status: "QUEUED",
      idempotencyKey: key,
      leaseEpoch: 0,
      ...(controlId ? { controlId } : {}),
    };
    draft.intents[intent.id] = intent;
    this.appendAudit(draft, binding.workspaceId, "INTENT_QUEUED", intent.id, { actionType, controlId: controlId ?? null });
    return intent;
  }

  leaseIntent(intentId: string, nowIso: string, deadlineIso: string): ExecutionIntent {
    return this.transact((draft) => {
      const intent = this.requireIntent(draft, intentId);
      if (intent.status !== "QUEUED") throw new GovernanceError("INTENT_NOT_QUEUED", `cannot lease ${intent.status}`);
      if (Date.parse(deadlineIso) <= Date.parse(nowIso)) throw new GovernanceError("INVALID_LEASE", "deadline must be future");
      intent.status = "LEASED";
      intent.leaseEpoch += 1;
      intent.leaseToken = `${intent.id}:epoch:${intent.leaseEpoch}`;
      intent.leaseDeadline = deadlineIso;
      this.appendAudit(draft, intent.workspaceId, "LEASE_ACQUIRED", intent.id, {
        epoch: intent.leaseEpoch,
        deadline: deadlineIso,
      });
      return intent;
    });
  }

  recoverExpiredLeases(nowIso: string): ExecutionIntent[] {
    return this.transact((draft) => {
      const recovered: ExecutionIntent[] = [];
      for (const intent of Object.values(draft.intents)) {
        if (intent.status === "LEASED" && intent.leaseDeadline && Date.parse(intent.leaseDeadline) <= Date.parse(nowIso)) {
          intent.status = "QUEUED";
          delete intent.leaseToken;
          delete intent.leaseDeadline;
          this.appendAudit(draft, intent.workspaceId, "LEASE_EXPIRED_RECOVERED", intent.id, { epoch: intent.leaseEpoch });
          recovered.push(intent);
        }
      }
      return recovered;
    });
  }

  startDispatch(intentId: string, token: string, nowIso: string): ExecutionIntent {
    return this.transact((draft) => {
      const intent = this.requireActiveLease(draft, intentId, token, nowIso);
      intent.status = "DISPATCHING";
      this.appendAudit(draft, intent.workspaceId, "DISPATCH_STARTED", intent.id, { epoch: intent.leaseEpoch });
      return intent;
    });
  }

  finishIntent(
    intentId: string,
    token: string,
    outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
  ): ExecutionIntent {
    return this.transact((draft) => {
      const intent = this.requireIntent(draft, intentId);
      if (intent.status !== "DISPATCHING" || intent.leaseToken !== token) {
        throw new GovernanceError("STALE_LEASE_TOKEN", "result writer does not own active dispatch token");
      }
      intent.status = outcome;
      this.appendAudit(draft, intent.workspaceId, `INTENT_${outcome}`, intent.id, { epoch: intent.leaseEpoch });
      delete intent.leaseDeadline;
      delete intent.leaseToken;
      return intent;
    });
  }

  invalidateIntent(intentId: string, status: "INVALIDATED" | "CANCELLED" = "INVALIDATED"): ExecutionIntent {
    return this.transact((draft) => {
      const intent = this.requireIntent(draft, intentId);
      if (intent.status !== "QUEUED" && intent.status !== "LEASED") {
        throw new GovernanceError("INTENT_ALREADY_EFFECTING", `cannot invalidate ${intent.status}`);
      }
      intent.status = status;
      delete intent.leaseDeadline;
      delete intent.leaseToken;
      this.appendAudit(draft, intent.workspaceId, `INTENT_${status}`, intent.id, {});
      return intent;
    });
  }

  createNotification(workspaceId: string, subjectId: string): NotificationRecord {
    return this.transact((draft) => {
      const notification: NotificationRecord = {
        id: this.nextId(draft, "notification"),
        workspaceId,
        subjectId,
        status: "PENDING",
        attempts: 0,
      };
      draft.notifications[notification.id] = notification;
      this.appendAudit(draft, workspaceId, "NOTIFICATION_PENDING", notification.id, { subjectId });
      return notification;
    });
  }

  transitionNotification(id: string, next: Exclude<NotificationStatus, "PENDING">, workspaceId: string): NotificationRecord {
    const allowed: Record<NotificationStatus, NotificationStatus[]> = {
      PENDING: ["SENT", "DEAD_LETTER"],
      SENT: ["ACKED", "ESCALATED", "DEAD_LETTER"],
      ACKED: [],
      ESCALATED: ["ACKED", "DEAD_LETTER"],
      DEAD_LETTER: [],
    };
    return this.transact((draft) => {
      const notification = draft.notifications[id];
      if (!notification || notification.workspaceId !== workspaceId) {
        throw new GovernanceError("NOTIFICATION_NOT_FOUND", `notification not found: ${id}`);
      }
      if (!allowed[notification.status].includes(next)) {
        throw new GovernanceError("INVALID_NOTIFICATION_TRANSITION", `${notification.status} -> ${next}`);
      }
      notification.status = next;
      if (next === "SENT" || next === "DEAD_LETTER") notification.attempts += 1;
      this.appendAudit(draft, notification.workspaceId, `NOTIFICATION_${next}`, id, {});
      return notification;
    });
  }

  /**
   * Marks a QUEUED internal-effect intent as applied (single-use), so a
   * consumed authorization cannot be replayed for a second synchronous
   * internal effect. Fails closed on workspace mismatch or non-QUEUED state.
   */
  markIntentApplied(workspaceId: string, intentId: string): ExecutionIntent {
    return this.transact((draft) => {
      const intent = draft.intents[intentId];
      if (!intent || intent.workspaceId !== workspaceId) {
        throw new GovernanceError("INTENT_NOT_FOUND", `intent not found: ${intentId}`);
      }
      if (intent.status !== "QUEUED") {
        throw new GovernanceError("INTENT_NOT_QUEUED", `intent is not a fresh consumed authorization: ${intentId}`);
      }
      intent.status = "SUCCEEDED";
      delete intent.leaseDeadline;
      delete intent.leaseToken;
      this.appendAudit(draft, intent.workspaceId, "INTENT_SUCCEEDED", intent.id, { applied: true });
      return intent;
    });
  }

  /** Approval/checkpoint inbox: controls for a workspace, optionally filtered by status. */
  listControls(workspaceId: string, status?: ControlStatus): ControlRequest[] {
    return Object.values(this.state.controls)
      .filter((control) => control.workspaceId === workspaceId && (status === undefined || control.status === status))
      .map((control) => structuredClone(control));
  }

  getControl(workspaceId: string, controlId: string): ControlRequest {
    const control = this.state.controls[controlId];
    if (!control || control.workspaceId !== workspaceId) {
      throw new GovernanceError("CONTROL_NOT_FOUND", `control not found: ${controlId}`);
    }
    return structuredClone(control);
  }

  getIntent(workspaceId: string, intentId: string): ExecutionIntent {
    const intent = this.state.intents[intentId];
    if (!intent || intent.workspaceId !== workspaceId) {
      throw new GovernanceError("INTENT_NOT_FOUND", `intent not found: ${intentId}`);
    }
    return structuredClone(intent);
  }

  /** Notification inbox for a workspace, optionally filtered by status. */
  listNotifications(workspaceId: string, status?: NotificationStatus): NotificationRecord[] {
    return Object.values(this.state.notifications)
      .filter((notification) => notification.workspaceId === workspaceId && (status === undefined || notification.status === status))
      .map((notification) => structuredClone(notification));
  }

  /** Ordered audit view for a workspace (AC-12/AC-14 audit surface). */
  listAuditEvents(workspaceId: string): AuditEvent[] {
    return this.state.audits
      .filter((event) => event.workspaceId === workspaceId)
      .map((event) => structuredClone(event));
  }

  verifyAuditChain(workspaceId: string): boolean {
    let previousHash = EMPTY_HASH;
    let sequence = 1;
    for (const event of this.state.audits.filter((item) => item.workspaceId === workspaceId)) {
      if (event.sequence !== sequence || event.previousHash !== previousHash) return false;
      const hash = computeAuditEventHash({
        workspaceId: event.workspaceId,
        sequence: event.sequence,
        kind: event.kind,
        subjectId: event.subjectId,
        data: event.data,
        previousHash: event.previousHash,
      });
      if (hash !== event.hash) return false;
      sequence += 1;
      previousHash = event.hash;
    }
    return true;
  }

  private requireIntent(draft: GovernanceState, intentId: string): ExecutionIntent {
    const intent = draft.intents[intentId];
    if (!intent) throw new GovernanceError("INTENT_NOT_FOUND", `intent not found: ${intentId}`);
    return intent;
  }

  private requireActiveLease(
    draft: GovernanceState,
    intentId: string,
    token: string,
    nowIso: string,
  ): ExecutionIntent {
    const intent = this.requireIntent(draft, intentId);
    if (
      intent.status !== "LEASED" ||
      intent.leaseToken !== token ||
      !intent.leaseDeadline ||
      Date.parse(intent.leaseDeadline) <= Date.parse(nowIso)
    ) {
      throw new GovernanceError("STALE_LEASE_TOKEN", "lease is absent, expired, or fenced");
    }
    return intent;
  }
}

export {
  InMemoryGovernanceRepository,
  computeAuditEventHash,
  controlFromPersisted,
  controlToPersisted,
  createPgGovernanceRepository,
  intentFromPersisted,
  intentToPersisted,
  mapControlRow,
  mapIntentRow,
  type GovernanceRepository,
  type PersistedAuditEventInput,
  type PersistedAuditEventResult,
  type PersistedAuditEventRow,
  type PersistedControlShape,
  type PersistedOutboxEventRow,
  type PersistedIntentShape,
  type PgQueryable as GovernancePgQueryable,
  type PgQueryResult as GovernancePgQueryResult,
} from "./pg-governance-adapter.js";

