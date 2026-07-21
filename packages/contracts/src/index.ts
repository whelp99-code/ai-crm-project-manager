import { z } from "zod";

/**
 * @ai-crm/contracts
 *
 * Dependency-light shared contracts (Zod schemas + inferred types) for the
 * AI-CRM/PM workspace: identifiers, principals, the action registry, the
 * policy/control/intent lifecycle, notifications, audit events, import
 * provenance, model invocation, and common errors.
 *
 * Every action/intent/audit binding requires an explicit workspaceId +
 * resourceId + actionType triple; schemas reject payloads missing any leg
 * of that binding.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const uuid = () => z.string().uuid();

export const WorkspaceIdSchema = uuid().brand<"WorkspaceId">();
export const ResourceIdSchema = uuid().brand<"ResourceId">();
export const PrincipalIdSchema = uuid().brand<"PrincipalId">();
export const ActionIdSchema = uuid().brand<"ActionId">();
export const IntentIdSchema = uuid().brand<"IntentId">();
export const PolicyIdSchema = uuid().brand<"PolicyId">();
export const ControlIdSchema = uuid().brand<"ControlId">();
export const NotificationIdSchema = uuid().brand<"NotificationId">();
export const AuditEventIdSchema = uuid().brand<"AuditEventId">();
export const ImportRecordIdSchema = uuid().brand<"ImportRecordId">();
export const ModelInvocationIdSchema = uuid().brand<"ModelInvocationId">();

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type ResourceId = z.infer<typeof ResourceIdSchema>;
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type IntentId = z.infer<typeof IntentIdSchema>;
export type PolicyId = z.infer<typeof PolicyIdSchema>;
export type ControlId = z.infer<typeof ControlIdSchema>;
export type NotificationId = z.infer<typeof NotificationIdSchema>;
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;
export type ImportRecordId = z.infer<typeof ImportRecordIdSchema>;
export type ModelInvocationId = z.infer<typeof ModelInvocationIdSchema>;

const isoTimestamp = () => z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

export const PRINCIPAL_ROLES = [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "SERVICE",
  "SYSTEM",
] as const;

export const PrincipalRoleSchema = z.enum(PRINCIPAL_ROLES);
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;

export const PrincipalSchema = z
  .object({
    id: PrincipalIdSchema,
    workspaceId: WorkspaceIdSchema,
    role: PrincipalRoleSchema,
    displayName: z.string().min(1).max(200),
    isActive: z.boolean(),
  })
  .strict();
export type Principal = z.infer<typeof PrincipalSchema>;

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

export const ACTION_TYPES = [
  "INTERNAL_REVERSIBLE_UPDATE",
  "CUSTOMER_SEND",
  "SCOPE_CHANGE",
  "SCHEDULE_CHANGE",
  "CONTRACT_CHANGE",
  "INVOICE_ISSUE",
  "PAYMENT_EXECUTE",
  "DELETE_RECORD",
  "PERMISSION_CHANGE",
  "MODEL_INVOKE",
  "PM_PLAN_CREATE",
  "PM_PLAN_REVISE",
  "PM_TASK_ASSIGN",
  "PM_TARGET_SET",
  "CRM_IMPORT",
  "ACCOUNTING_IMPORT",
  "BANK_STATEMENT_IMPORT",
  "FINANCE_DRAFT",
  "FINANCE_VERIFY",
  "LEDGER_POST",
] as const;

export const ActionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** Binding every action/intent/audit record must carry: workspace + resource + action. */
export const ActionBindingSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    actionType: ActionTypeSchema,
  })
  .strict();
export type ActionBinding = z.infer<typeof ActionBindingSchema>;

// ---------------------------------------------------------------------------
// Policy decisions and controls
// ---------------------------------------------------------------------------

export const POLICY_DECISIONS = ["ALLOW", "DENY", "REQUIRE_APPROVAL"] as const;
export const PolicyDecisionSchema = z.enum(POLICY_DECISIONS);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const CONTROL_KINDS = [
  "HUMAN_APPROVAL",
  "RATE_LIMIT",
  "BUDGET_CAP",
  "KILL_SWITCH",
  "DRY_RUN",
  "SCOPE_LOCK",
] as const;
export const ControlKindSchema = z.enum(CONTROL_KINDS);
export type ControlKind = z.infer<typeof ControlKindSchema>;

export const PolicySchema = z
  .object({
    id: PolicyIdSchema,
    workspaceId: WorkspaceIdSchema,
    actionType: ActionTypeSchema,
    decision: PolicyDecisionSchema,
    reason: z.string().min(1).max(2000),
    createdAt: isoTimestamp(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export const ControlSchema = z
  .object({
    id: ControlIdSchema,
    workspaceId: WorkspaceIdSchema,
    kind: ControlKindSchema,
    actionType: ActionTypeSchema,
    isEnabled: z.boolean(),
    configuration: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Control = z.infer<typeof ControlSchema>;

// ---------------------------------------------------------------------------
// Intent lifecycle
// ---------------------------------------------------------------------------

export const INTENT_STATES = [
  "QUEUED",
  "LEASED",
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "INVALIDATED",
  "CANCELLED",
] as const;

export const IntentStateSchema = z.enum(INTENT_STATES);
export type IntentState = z.infer<typeof IntentStateSchema>;

/** Immutable identity of an intent: fixed at creation, never rewritten by transitions. */
export const IntentIdentitySchema = z
  .object({
    id: IntentIdSchema,
    workspaceId: WorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    actionType: ActionTypeSchema,
    principalId: PrincipalIdSchema,
    createdAt: isoTimestamp(),
  })
  .strict();
export type IntentIdentity = z.infer<typeof IntentIdentitySchema>;

export const IntentSchema = IntentIdentitySchema.extend({
  state: IntentStateSchema,
  attempt: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()),
  leaseExpiresAt: isoTimestamp().nullable(),
  updatedAt: isoTimestamp(),
}).strict();
export type Intent = z.infer<typeof IntentSchema>;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ["EMAIL", "IN_APP", "WEBHOOK"] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationSchema = z
  .object({
    id: NotificationIdSchema,
    workspaceId: WorkspaceIdSchema,
    recipientPrincipalId: PrincipalIdSchema,
    channel: NotificationChannelSchema,
    subject: z.string().min(1).max(300),
    body: z.string().min(1),
    relatedIntentId: IntentIdSchema.nullable(),
    createdAt: isoTimestamp(),
  })
  .strict();
export type Notification = z.infer<typeof NotificationSchema>;

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    workspaceId: WorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    actionType: ActionTypeSchema,
    actorPrincipalId: PrincipalIdSchema,
    decision: PolicyDecisionSchema.nullable(),
    occurredAt: isoTimestamp(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// Import provenance
// ---------------------------------------------------------------------------

export const ImportProvenanceSchema = z
  .object({
    id: ImportRecordIdSchema,
    workspaceId: WorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    sourceSystem: z.string().min(1).max(100),
    sourceRecordId: z.string().min(1).max(300),
    checksum: z.string().min(1).max(200),
    importedAt: isoTimestamp(),
  })
  .strict();
export type ImportProvenance = z.infer<typeof ImportProvenanceSchema>;

// ---------------------------------------------------------------------------
// Model invocation
// ---------------------------------------------------------------------------

export const ModelInvocationSchema = z
  .object({
    id: ModelInvocationIdSchema,
    workspaceId: WorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    principalId: PrincipalIdSchema,
    model: z.string().min(1).max(200),
    promptHash: z.string().min(1).max(200),
    tokensIn: z.number().int().min(0),
    tokensOut: z.number().int().min(0),
    startedAt: isoTimestamp(),
    completedAt: isoTimestamp().nullable(),
    resultActionId: ActionIdSchema.nullable(),
  })
  .strict();
export type ModelInvocation = z.infer<typeof ModelInvocationSchema>;

// ---------------------------------------------------------------------------
// Common errors
// ---------------------------------------------------------------------------

export const CONTRACT_ERROR_CODES = [
  "INVALID_BINDING",
  "UNKNOWN_ACTION_TYPE",
  "INVALID_STATE_TRANSITION",
  "VALIDATION_FAILED",
] as const;
export const ContractErrorCodeSchema = z.enum(CONTRACT_ERROR_CODES);
export type ContractErrorCode = z.infer<typeof ContractErrorCodeSchema>;

export class ContractError extends Error {
  readonly code: ContractErrorCode;
  readonly details?: unknown;

  constructor(code: ContractErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.details = details;
  }
}

/** Parses input against `ActionBindingSchema`, throwing `ContractError` on failure. */
export function assertActionBinding(input: unknown): ActionBinding {
  const result = ActionBindingSchema.safeParse(input);
  if (!result.success) {
    throw new ContractError(
      "INVALID_BINDING",
      "Action binding requires workspaceId, resourceId, and actionType.",
      result.error.flatten(),
    );
  }
  return result.data;
}

/** Valid forward transitions for the intent lifecycle state machine. */
export const INTENT_STATE_TRANSITIONS: Readonly<
  Record<IntentState, readonly IntentState[]>
> = {
  QUEUED: ["LEASED", "CANCELLED", "INVALIDATED"],
  LEASED: ["DISPATCHING", "QUEUED", "CANCELLED", "INVALIDATED"],
  DISPATCHING: ["SUCCEEDED", "FAILED", "UNKNOWN"],
  SUCCEEDED: [],
  FAILED: ["QUEUED", "INVALIDATED"],
  UNKNOWN: ["QUEUED", "INVALIDATED"],
  INVALIDATED: [],
  CANCELLED: [],
};

export function isValidIntentTransition(
  from: IntentState,
  to: IntentState,
): boolean {
  return INTENT_STATE_TRANSITIONS[from].includes(to);
}
