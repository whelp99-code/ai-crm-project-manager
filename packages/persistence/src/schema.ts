/**
 * Foundation PostgreSQL/Drizzle schema for the AI CRM + Project Manager workspace boundary.
 *
 * Design invariants (enforced jointly here and in
 * `migrations/0001_foundation.sql`, which is the authoritative source for
 * roles, FORCE RLS policies, triggers and grants — this file only declares
 * table/column shape and TypeScript-level types):
 *
 *  - Every business/control/audit table carries a NOT NULL `workspaceId`
 *    foreign key into `workspaces`. `workspaces` itself is the tenant
 *    boundary root and is not workspace-bound.
 *  - `executionIntents` binds `idempotencyKey`, `actionType`, `payloadHash`
 *    and `canonicalSchemaVersion` immutably; only lifecycle/lease columns
 *    (`state`, `leaseDeadline`, `leaseEpoch`, `leaseToken`,
 *    `leasedByPrincipalId`, `dispatchAttemptCount`, `resultHash`,
 *    `failureReason`, `updatedAt`) may change after creation.
 *  - `auditEvents` is append-only (no UPDATE/DELETE at the SQL level) and
 *    unique per `(workspaceId, sequence)`; `auditChainHeads` holds exactly
 *    one row per workspace and only moves its `headSequence` forward.
 *  - This package may import `@ai-crm/contracts` for TypeScript types only;
 *    no contracts SQL/runtime code is imported and no contracts import is
 *    required for the migration to run standalone.
 */
import type { ActionType, IntentState, PolicyDecision } from "@ai-crm/contracts";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Mirrors @ai-crm/contracts `PolicyDecision` ("ALLOW" | "DENY" | "REQUIRE_APPROVAL"). */
export const policyDecisionEnum = pgEnum("policy_decision", [
  "ALLOW",
  "DENY",
  "REQUIRE_APPROVAL",
]);

export const controlKindEnum = pgEnum("control_kind", ["APPROVAL", "CHECKPOINT"]);

export const controlStatusEnum = pgEnum("control_status", [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "CLAIMED",
  "CONSUMED",
  "REWORK_REQUIRED",
]);

/** Mirrors @ai-crm/contracts `IntentState`. */
export const intentStateEnum = pgEnum("intent_state", [
  "QUEUED",
  "LEASED",
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "INVALIDATED",
  "CANCELLED",
]);

export const principalKindEnum = pgEnum("principal_kind", ["HUMAN", "AI", "SERVICE"]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "PENDING",
  "SENT",
  "ACKED",
  "ESCALATED",
  "DEAD_LETTER",
]);

export const importSourceKindEnum = pgEnum("import_source_kind", [
  "CRM",
  "LEDGER",
  "BANK_STATEMENT",
]);

export const importBatchStatusEnum = pgEnum("import_batch_status", [
  "PENDING",
  "VALIDATING",
  "QUARANTINED",
  "COMPLETED",
  "FAILED",
]);

export const importRowStatusEnum = pgEnum("import_row_status", [
  "PENDING",
  "VALID",
  "QUARANTINED",
  "IMPORTED",
]);

export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "PUBLISHED", "FAILED"]);

// ---------------------------------------------------------------------------
// Tenant boundary
// ---------------------------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceEmailUnique: uniqueIndex("users_workspace_email_key").on(
      table.workspaceId,
      table.email,
    ),
  }),
);

/**
 * Every actor capable of triggering a policy decision or audit event —
 * human end users, AI role principals (PM, executor, reviewer, CFO, finance
 * recorder/validator) and service principals (model gateway, workers) — is a
 * distinct, workspace-bound row here so separation-of-duty (independent
 * creator/reviewer, independent finance recorder/verifier/approver) can be
 * enforced by comparing principal ids, never role labels.
 */
export const principals = pgTable(
  "principals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: principalKindEnum("kind").notNull(),
    userId: uuid("user_id").references(() => users.id),
    role: text("role").notNull(),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("principals_workspace_idx").on(table.workspaceId),
  }),
);

// ---------------------------------------------------------------------------
// Governance: policy decisions, control requests/claims, execution intents
// ---------------------------------------------------------------------------

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actorPrincipalId: uuid("actor_principal_id")
      .notNull()
      .references(() => principals.id),
    actionType: text("action_type").notNull().$type<ActionType>(),
    resourceKind: text("resource_kind"),
    resourceId: uuid("resource_id"),
    decision: policyDecisionEnum("decision").notNull().$type<PolicyDecision>(),
    matchedRule: text("matched_rule").notNull(),
    policyVersion: text("policy_version").notNull(),
    reason: text("reason").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("policy_decisions_workspace_idx").on(table.workspaceId),
  }),
);

export const controlRequests = pgTable(
  "control_requests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    policyDecisionId: uuid("policy_decision_id")
      .notNull()
      .references(() => policyDecisions.id),
    controlKind: controlKindEnum("control_kind").notNull(),
    actionType: text("action_type").notNull().$type<ActionType>(),
    resourceKind: text("resource_kind"),
    resourceId: uuid("resource_id"),
    resourceVersion: integer("resource_version"),
    payloadHash: text("payload_hash").notNull(),
    canonicalSchemaVersion: text("canonical_schema_version").notNull(),
    requiredRole: text("required_role").notNull(),
    approverPrincipalId: uuid("approver_principal_id").references(() => principals.id),
    validatorPrincipalId: uuid("validator_principal_id").references(() => principals.id),
    sodRule: text("sod_rule"),
    status: controlStatusEnum("status").notNull().default("REQUESTED"),
    version: integer("version").notNull().default(1),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("control_requests_workspace_idx").on(table.workspaceId),
  }),
);

export const controlClaims = pgTable(
  "control_claims",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    controlRequestId: uuid("control_request_id")
      .notNull()
      .references(() => controlRequests.id),
    claimedByPrincipalId: uuid("claimed_by_principal_id")
      .notNull()
      .references(() => principals.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    controlRequestUnique: uniqueIndex("control_claims_control_request_key").on(
      table.controlRequestId,
    ),
    workspaceIdx: index("control_claims_workspace_idx").on(table.workspaceId),
  }),
);

/**
 * Immutable binding (`idempotencyKey`, `actionType`, `payloadHash`,
 * `canonicalSchemaVersion`, `controlClaimId`) plus durable lease fencing
 * columns (`leaseDeadline`, `leaseEpoch`, `leaseToken`). Only the migration
 * trigger `execution_intents_immutable_binding` is authoritative for
 * rejecting binding mutation; this file only declares the columns.
 */
export const executionIntents = pgTable(
  "execution_intents",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    controlClaimId: uuid("control_claim_id")
      .notNull()
      .references(() => controlClaims.id),
    idempotencyKey: text("idempotency_key").notNull(),
    actionType: text("action_type").notNull().$type<ActionType>(),
    resourceKind: text("resource_kind"),
    resourceId: uuid("resource_id"),
    resourceVersion: integer("resource_version"),
    payloadHash: text("payload_hash").notNull(),
    canonicalSchemaVersion: text("canonical_schema_version").notNull(),
    state: intentStateEnum("state").notNull().default("QUEUED").$type<IntentState>(),
    leaseDeadline: timestamp("lease_deadline", { withTimezone: true }),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseToken: text("lease_token"),
    leasedByPrincipalId: uuid("leased_by_principal_id").references(() => principals.id),
    dispatchAttemptCount: integer("dispatch_attempt_count").notNull().default(0),
    resultHash: text("result_hash"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdempotencyUnique: uniqueIndex("execution_intents_workspace_idempotency_key").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    workspaceIdx: index("execution_intents_workspace_idx").on(table.workspaceId),
    leaseDeadlineIdx: index("execution_intents_lease_deadline_idx").on(table.leaseDeadline),
  }),
);

// ---------------------------------------------------------------------------
// Audit chain (append-only, one total order per workspace)
// ---------------------------------------------------------------------------

export const auditChainHeads = pgTable("audit_chain_heads", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  headSequence: bigint("head_sequence", { mode: "bigint" }).notNull().default(0n),
  headEventId: uuid("head_event_id"),
  headEventHash: text("head_event_hash"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only: rejected at the SQL level by the
 * `audit_events_append_only` trigger (BEFORE UPDATE OR DELETE) declared in
 * `migrations/0001_foundation.sql`; runtime roles additionally have
 * UPDATE/DELETE revoked as defense in depth.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    eventType: text("event_type").notNull(),
    actorPrincipalId: uuid("actor_principal_id").references(() => principals.id),
    actionType: text("action_type").$type<ActionType>(),
    resourceKind: text("resource_kind"),
    resourceId: uuid("resource_id"),
    policyDecisionId: uuid("policy_decision_id").references(() => policyDecisions.id),
    controlRequestId: uuid("control_request_id").references(() => controlRequests.id),
    executionIntentId: uuid("execution_intent_id").references(() => executionIntents.id),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    payload: jsonb("payload").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSequenceUnique: uniqueIndex("audit_events_workspace_sequence_key").on(
      table.workspaceId,
      table.sequence,
    ),
    workspaceIdx: index("audit_events_workspace_idx").on(table.workspaceId),
  }),
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditEvents.id),
    eventType: text("event_type").notNull(),
    partitionKey: text("partition_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    causationId: uuid("causation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceIdx: index("outbox_events_workspace_idx").on(table.workspaceId),
    statusIdx: index("outbox_events_status_idx").on(table.status),
  }),
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sourceControlRequestId: uuid("source_control_request_id").references(
      () => controlRequests.id,
    ),
    sourceExecutionIntentId: uuid("source_execution_intent_id").references(
      () => executionIntents.id,
    ),
    channel: text("channel").notNull(),
    destination: text("destination").notNull(),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdempotencyUnique: uniqueIndex("notifications_workspace_idempotency_key").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    workspaceIdx: index("notifications_workspace_idx").on(table.workspaceId),
  }),
);

// ---------------------------------------------------------------------------
// Imports (versioned CRM/ledger/bank-statement provenance)
// ---------------------------------------------------------------------------

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sourceKind: importSourceKindEnum("source_kind").notNull(),
    fileDigest: text("file_digest").notNull(),
    fileVersion: integer("file_version").notNull(),
    status: importBatchStatusEnum("status").notNull().default("PENDING"),
    importedByPrincipalId: uuid("imported_by_principal_id")
      .notNull()
      .references(() => principals.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceDigestUnique: uniqueIndex("import_batches_workspace_source_digest_key").on(
      table.workspaceId,
      table.sourceKind,
      table.fileDigest,
    ),
  }),
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    importBatchId: uuid("import_batch_id")
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer("row_number").notNull(),
    rowFingerprint: text("row_fingerprint").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    status: importRowStatusEnum("status").notNull().default("PENDING"),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    batchFingerprintUnique: uniqueIndex("import_rows_batch_fingerprint_key").on(
      table.importBatchId,
      table.rowFingerprint,
    ),
    workspaceIdx: index("import_rows_workspace_idx").on(table.workspaceId),
  }),
);

// ---------------------------------------------------------------------------
// Model invocations (non-effect model-gateway audit boundary)
// ---------------------------------------------------------------------------

/**
 * Column shapes match 0011_reports_model_invocations.sql's ALTERs, not
 * 0001_foundation.sql's original speculative shape (P2-2 drift fix):
 *  - `externalId` is the new lookup key (ModelGateway's own opaque
 *    `ModelInvocationRecord.id`), unique + NOT NULL.
 *  - `actionType` is new, NOT NULL, defaults to 'MODEL_INVOKE'.
 *  - `principalId`/`correlationId` are opaque text (0011 dropped the
 *    `principals` FK and widened uuid -> text — the gateway's service
 *    principal and caller-supplied correlation id are never `principals` rows).
 *  - `modelName` is nullable (0011 dropped NOT NULL; ModelInvocationRecord
 *    carries no field distinct from `modelVersion`).
 * Ownership/RLS/grants are untouched by 0011 (ADR-010 boundary preserved
 * verbatim — model_invocations write grants stay ai_crm_runtime_model_gateway
 * ONLY, never re-granted to api/worker; see schema.security.test.ts).
 */
export const modelInvocations = pgTable(
  "model_invocations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    externalId: text("external_id").notNull(),
    principalId: text("principal_id").notNull(),
    registryOperationId: text("registry_operation_id").notNull(),
    actionType: text("action_type").notNull().default("MODEL_INVOKE"),
    modelName: text("model_name"),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),
    structuredOutputSchemaVersion: text("structured_output_schema_version"),
    promptDigest: text("prompt_digest").notNull(),
    responseDigest: text("response_digest"),
    retentionMode: text("retention_mode").notNull().default("zero_retention"),
    latencyMs: integer("latency_ms"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("model_invocations_workspace_idx").on(table.workspaceId),
    externalIdUnique: uniqueIndex("model_invocations_external_id_key").on(table.externalId),
  }),
);

// ---------------------------------------------------------------------------
// Report snapshots (Q2 / D2) — see 0011_reports_model_invocations.sql
// ---------------------------------------------------------------------------

/**
 * Immutable final-report snapshots (ReportService's SoR). `snapshot`/
 * `snapshotHash` and every identity/submission column are frozen after
 * INSERT by the 0011 `report_snapshots_immutability` trigger; only the
 * decision lifecycle (`status`/`decidedByPrincipalId`/`decidedAt`/
 * `rejectionReason`) plus `version`/`updatedAt` legitimately mutate. Unlike
 * `modelInvocations`, no ADR-010 boundary applies — api/worker both get
 * ordinary read-write grants (mirrors `crm_customers`).
 */
export const reportSnapshots = pgTable(
  "report_snapshots",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: text("project_id").notNull(),
    submittedByPrincipalId: text("submitted_by_principal_id").notNull(),
    submittedAt: text("submitted_at").notNull(),
    status: text("status").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    decidedByPrincipalId: text("decided_by_principal_id"),
    decidedAt: text("decided_at"),
    rejectionReason: text("rejection_reason"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("report_snapshots_workspace_idx").on(table.workspaceId),
    statusCheck: check("report_snapshots_status_check", sql`${table.status} IN ('SUBMITTED', 'APPROVED', 'REJECTED')`),
  }),
);


// ---------------------------------------------------------------------------
// Orchestration spine (Job / WorkItem / JobEvent) — see 0003_orchestration.sql
// ---------------------------------------------------------------------------

/**
 * Orchestration job header. PK is text so opaque in-process ids
 * (e.g. job-000001) round-trip via the PG adapter without rewriting the
 * OrchestrationService id scheme. Binding uniqueness is
 * (workspace_id, idempotency_key) when an idempotency key is present.
 */
export const orchJobs = pgTable(
  "orch_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    source: text("source").notNull(),
    rawText: text("raw_text"),
    planInvocationId: text("plan_invocation_id"),
    status: text("status").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdempotencyUnique: uniqueIndex("orch_jobs_workspace_idempotency_key").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    workspaceIdx: index("orch_jobs_workspace_idx").on(table.workspaceId),
  }),
);

/**
 * Work items belonging to an orch_jobs row. resource_type and resource_id
 * must be set together (CHECK enforced in 0003_orchestration.sql).
 */
export const orchWorkItems = pgTable(
  "orch_work_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => orchJobs.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sequence: integer("sequence").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    suggestedCommand: text("suggested_command"),
    actionType: text("action_type"),
    assignedPrincipalId: text("assigned_principal_id"),
    controlId: text("control_id"),
    intentId: text("intent_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    resourceVersion: integer("resource_version"),
    progress: integer("progress").notNull().default(0),
    errorCode: text("error_code"),
    resultRef: jsonb("result_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdIdx: index("orch_work_items_job_id_idx").on(table.jobId),
    workspaceIdx: index("orch_work_items_workspace_idx").on(table.workspaceId),
    resourceBindingCheck: check(
      "orch_work_items_resource_binding_check",
      sql`(resource_type IS NULL AND resource_id IS NULL) OR (resource_type IS NOT NULL AND resource_id IS NOT NULL)`,
    ),
  }),
);

/** Append-style job event log rows for an orch_jobs row. */
export const orchJobEvents = pgTable(
  "orch_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => orchJobs.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    jobIdIdx: index("orch_job_events_job_id_idx").on(table.jobId),
    workspaceIdx: index("orch_job_events_workspace_idx").on(table.workspaceId),
  }),
);

/**
 * Governance snapshot/sidecar table for controls — see
 * 0004_governance_snapshot.sql. Persists PersistedControlShape verbatim from
 * the in-memory GovernanceAuthorizationService. NOT the foundation
 * control_requests table (which requires policy_decision_id/control_claim
 * FKs the in-memory model does not carry).
 */
export const orchGovernanceControls = pgTable(
  "orch_governance_controls",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actionType: text("action_type").notNull(),
    kind: text("kind").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    policyVersion: integer("policy_version").notNull(),
    requesterPrincipalId: text("requester_principal_id").notNull(),
    decidedByPrincipalId: text("decided_by_principal_id"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdx: index("orch_governance_controls_workspace_idx").on(table.workspaceId),
  }),
);

/**
 * Governance snapshot/sidecar table for execution intents — see
 * 0004_governance_snapshot.sql. Persists PersistedIntentShape verbatim.
 */
export const orchGovernanceIntents = pgTable(
  "orch_governance_intents",
  {
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actionType: text("action_type").notNull(),
    status: text("status").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceVersion: integer("resource_version").notNull(),
    payloadHash: text("payload_hash").notNull(),
    policyVersion: integer("policy_version").notNull(),
    leaseDeadline: timestamp("lease_deadline", { withTimezone: true }),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseToken: text("lease_token"),
    controlId: text("control_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdempotencyUnique: uniqueIndex("orch_governance_intents_workspace_idempotency_key").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    workspaceIdx: index("orch_governance_intents_workspace_idx").on(table.workspaceId),
  }),
);

// ---------------------------------------------------------------------------
// Relations (typed convenience joins; no runtime behavior beyond query typing)
// ---------------------------------------------------------------------------

export const controlRequestsRelations = relations(controlRequests, ({ one }) => ({
  policyDecision: one(policyDecisions, {
    fields: [controlRequests.policyDecisionId],
    references: [policyDecisions.id],
  }),
}));

export const controlClaimsRelations = relations(controlClaims, ({ one }) => ({
  controlRequest: one(controlRequests, {
    fields: [controlClaims.controlRequestId],
    references: [controlRequests.id],
  }),
}));

export const executionIntentsRelations = relations(executionIntents, ({ one }) => ({
  controlClaim: one(controlClaims, {
    fields: [executionIntents.controlClaimId],
    references: [controlClaims.id],
  }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  executionIntent: one(executionIntents, {
    fields: [auditEvents.executionIntentId],
    references: [executionIntents.id],
  }),
}));

export const orchJobsRelations = relations(orchJobs, ({ many }) => ({
  workItems: many(orchWorkItems),
  events: many(orchJobEvents),
}));

export const orchWorkItemsRelations = relations(orchWorkItems, ({ one }) => ({
  job: one(orchJobs, {
    fields: [orchWorkItems.jobId],
    references: [orchJobs.id],
  }),
}));

export const orchJobEventsRelations = relations(orchJobEvents, ({ one }) => ({
  job: one(orchJobs, {
    fields: [orchJobEvents.jobId],
    references: [orchJobs.id],
  }),
}));

