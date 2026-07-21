-- =============================================================================
-- 0001_foundation.sql
--
-- Foundation schema for the AI CRM + Project Manager single-workspace MVP.
-- This migration is self-contained: it does not depend on any TypeScript
-- package, application code or seed data, and can be reviewed/run purely as
-- SQL. Table shape mirrors ../src/schema.ts (Drizzle is a query-typing layer
-- over these definitions, not the source of truth for constraints/roles).
--
-- Layout:
--   1. Extensions
--   2. Roles                      (migration/owner role vs. runtime roles)
--   3. Guarded workspace setting  (fail-closed app.workspace_id accessor)
--   4. Tables                     (workspaces, identity, governance, audit,
--                                  outbox, notifications, imports, model
--                                  invocations)
--   5. Ownership                  (migration owner owns every table)
--   6. Row Level Security         (ENABLE + FORCE, USING/WITH CHECK policies)
--   7. Append-only / immutability triggers
--   8. Grants                     (least-privilege, non-owner, NOBYPASSRLS)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 2. Roles
--
-- Conceptual separation: exactly one migration/owner role creates and owns
-- every table and runs migrations; runtime roles are separate, non-owner,
-- least-privilege, and explicitly NOBYPASSRLS so FORCE ROW LEVEL SECURITY
-- always applies to them. Login credentials for these roles are provisioned
-- out-of-band (secrets manager); this migration only declares role identity
-- and privilege, never a password.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_migration_owner') THEN
    -- Owns every table created below and is the only role permitted to run
    -- migrations (DDL). Deliberately NOLOGIN here: a deployment-time login
    -- role is granted membership out-of-band, keeping this file credential-free.
    CREATE ROLE ai_crm_migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api') THEN
    -- Fastify API runtime. Non-owner, NOBYPASSRLS: FORCE RLS always applies.
    CREATE ROLE ai_crm_runtime_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOINHERIT PASSWORD NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker') THEN
    -- Worker / dispatcher runtime (lease acquire/renew, dispatch,
    -- audit/outbox append). Non-owner, NOBYPASSRLS.
    CREATE ROLE ai_crm_runtime_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOINHERIT PASSWORD NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_audit_verifier') THEN
    -- Read-only audit chain verifier. Non-owner, NOBYPASSRLS, no write grants.
    CREATE ROLE ai_crm_audit_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOINHERIT PASSWORD NULL;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. Guarded workspace setting
--
-- Every RLS policy below calls this function instead of comparing directly
-- against current_setting(...). Missing or malformed workspace context
-- raises (fails closed) rather than silently evaluating to NULL/false-only,
-- so a caller cannot forget SET LOCAL app.workspace_id and instead see an
-- empty result set that looks like "no rows" rather than "no context".
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw_value text := current_setting('app.workspace_id', true);
BEGIN
  IF raw_value IS NULL OR btrim(raw_value) = '' THEN
    RAISE EXCEPTION 'app.workspace_id is not set for this session/transaction; workspace context is required'
      USING ERRCODE = '28000';
  END IF;

  RETURN raw_value::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.workspace_id is malformed (expected uuid): %', raw_value
      USING ERRCODE = '22023';
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Tables
-- -----------------------------------------------------------------------------

-- Tenant boundary root. Not itself workspace-bound.
CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  email         text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_workspace_email_key UNIQUE (workspace_id, email)
);

CREATE TABLE principals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  kind          text NOT NULL CHECK (kind IN ('HUMAN', 'AI', 'SERVICE')),
  user_id       uuid REFERENCES users (id),
  role          text NOT NULL,
  display_name  text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principals_human_has_user CHECK (kind <> 'HUMAN' OR user_id IS NOT NULL)
);
CREATE INDEX principals_workspace_idx ON principals (workspace_id);

CREATE TABLE policy_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id),
  actor_principal_id  uuid NOT NULL REFERENCES principals (id),
  action_type         text NOT NULL,
  resource_kind       text,
  resource_id         uuid,
  decision            text NOT NULL CHECK (decision IN ('ALLOW', 'DENY', 'REQUIRE_APPROVAL')),
  matched_rule        text NOT NULL,
  policy_version      text NOT NULL,
  reason              text NOT NULL,
  inputs_hash         text NOT NULL,
  correlation_id      uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decisions_workspace_idx ON policy_decisions (workspace_id);

CREATE TABLE control_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES workspaces (id),
  policy_decision_id        uuid NOT NULL REFERENCES policy_decisions (id),
  control_kind              text NOT NULL CHECK (control_kind IN ('APPROVAL', 'CHECKPOINT')),
  action_type               text NOT NULL,
  resource_kind             text,
  resource_id               uuid,
  resource_version          integer,
  payload_hash              text NOT NULL,
  canonical_schema_version  text NOT NULL,
  required_role             text NOT NULL,
  approver_principal_id     uuid REFERENCES principals (id),
  validator_principal_id    uuid REFERENCES principals (id),
  sod_rule                  text,
  status                    text NOT NULL DEFAULT 'REQUESTED' CHECK (
                               status IN (
                                 'REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED',
                                 'EXPIRED', 'CLAIMED', 'CONSUMED', 'REWORK_REQUIRED'
                               )
                             ),
  version                   integer NOT NULL DEFAULT 1,
  decided_at                timestamptz,
  expires_at                timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- Separation of duty: the approver/validator on a control can never be the
  -- same principal that made the underlying policy decision request would be
  -- enforced at the application layer (actor is on policy_decisions, not
  -- here); this constraint only prevents an approver and validator collapsing
  -- into a single principal on the same control row.
  CONSTRAINT control_requests_approver_validator_distinct CHECK (
    approver_principal_id IS NULL
    OR validator_principal_id IS NULL
    OR approver_principal_id <> validator_principal_id
  )
);
CREATE INDEX control_requests_workspace_idx ON control_requests (workspace_id);

CREATE TABLE control_claims (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces (id),
  control_request_id       uuid NOT NULL REFERENCES control_requests (id),
  claimed_by_principal_id  uuid NOT NULL REFERENCES principals (id),
  claimed_at               timestamptz NOT NULL DEFAULT now(),
  consumed_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- One-time consumption: a control request may be claimed at most once.
  CONSTRAINT control_claims_control_request_key UNIQUE (control_request_id)
);
CREATE INDEX control_claims_workspace_idx ON control_claims (workspace_id);

CREATE TABLE execution_intents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES workspaces (id),
  control_claim_id          uuid NOT NULL REFERENCES control_claims (id),
  idempotency_key           text NOT NULL,
  action_type               text NOT NULL,
  resource_kind             text,
  resource_id               uuid,
  resource_version          integer,
  payload_hash              text NOT NULL,
  canonical_schema_version  text NOT NULL,
  state                     text NOT NULL DEFAULT 'QUEUED' CHECK (
                               state IN (
                                 'QUEUED', 'LEASED', 'DISPATCHING', 'SUCCEEDED',
                                 'FAILED', 'UNKNOWN', 'INVALIDATED', 'CANCELLED'
                               )
                             ),
  lease_deadline            timestamptz,
  lease_epoch               integer NOT NULL DEFAULT 0,
  lease_token               text,
  leased_by_principal_id    uuid REFERENCES principals (id),
  dispatch_attempt_count    integer NOT NULL DEFAULT 0,
  result_hash               text,
  failure_reason            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: exactly one intent per workspace per idempotency key.
  CONSTRAINT execution_intents_workspace_idempotency_key UNIQUE (workspace_id, idempotency_key),
  -- Lease fencing: a LEASED/DISPATCHING intent must carry a live lease.
  CONSTRAINT execution_intents_lease_columns_present CHECK (
    state NOT IN ('LEASED', 'DISPATCHING')
    OR (lease_deadline IS NOT NULL AND lease_token IS NOT NULL AND lease_epoch > 0)
  ),
  CONSTRAINT execution_intents_lease_epoch_nonnegative CHECK (lease_epoch >= 0)
);
CREATE INDEX execution_intents_workspace_idx ON execution_intents (workspace_id);
CREATE INDEX execution_intents_lease_deadline_idx ON execution_intents (lease_deadline);

-- -----------------------------------------------------------------------------
-- Audit chain: one totally ordered chain per workspace, append-only.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_chain_heads (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces (id),
  head_sequence     bigint NOT NULL DEFAULT 0,
  head_event_id     uuid,
  head_event_hash   text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_chain_heads_sequence_nonnegative CHECK (head_sequence >= 0)
);

CREATE TABLE audit_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id),
  sequence               bigint NOT NULL,
  event_type             text NOT NULL,
  actor_principal_id     uuid REFERENCES principals (id),
  action_type            text,
  resource_kind          text,
  resource_id            uuid,
  policy_decision_id     uuid REFERENCES policy_decisions (id),
  control_request_id     uuid REFERENCES control_requests (id),
  execution_intent_id    uuid REFERENCES execution_intents (id),
  before_hash            text,
  after_hash             text,
  payload                jsonb NOT NULL,
  schema_version         integer NOT NULL DEFAULT 1,
  previous_event_hash    text,
  event_hash             text NOT NULL,
  correlation_id         uuid NOT NULL,
  causation_id           uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Unique workspace sequence and globally unique event id (via PK) satisfy
  -- the "unique workspace sequence/event ids" requirement together.
  CONSTRAINT audit_events_workspace_sequence_key UNIQUE (workspace_id, sequence),
  CONSTRAINT audit_events_sequence_nonnegative CHECK (sequence >= 0)
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id);

CREATE TABLE outbox_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id),
  audit_event_id   uuid NOT NULL REFERENCES audit_events (id),
  event_type       text NOT NULL,
  partition_key    text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  causation_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz
);
CREATE INDEX outbox_events_workspace_idx ON outbox_events (workspace_id);
CREATE INDEX outbox_events_status_idx ON outbox_events (status);

CREATE TABLE notifications (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  source_control_request_id   uuid REFERENCES control_requests (id),
  source_execution_intent_id  uuid REFERENCES execution_intents (id),
  channel                     text NOT NULL,
  destination                 text NOT NULL,
  status                      text NOT NULL DEFAULT 'PENDING' CHECK (
                                 status IN ('PENDING', 'SENT', 'ACKED', 'ESCALATED', 'DEAD_LETTER')
                               ),
  idempotency_key             text NOT NULL,
  correlation_id              uuid NOT NULL,
  escalated_at                timestamptz,
  acked_at                    timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_workspace_idempotency_key UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX notifications_workspace_idx ON notifications (workspace_id);

CREATE TABLE import_batches (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces (id),
  source_kind                text NOT NULL CHECK (source_kind IN ('CRM', 'LEDGER', 'BANK_STATEMENT')),
  file_digest                text NOT NULL,
  file_version                integer NOT NULL,
  status                     text NOT NULL DEFAULT 'PENDING' CHECK (
                                status IN ('PENDING', 'VALIDATING', 'QUARANTINED', 'COMPLETED', 'FAILED')
                              ),
  imported_by_principal_id   uuid NOT NULL REFERENCES principals (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  CONSTRAINT import_batches_workspace_source_digest_key UNIQUE (workspace_id, source_kind, file_digest)
);

CREATE TABLE import_rows (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id),
  import_batch_id    uuid NOT NULL REFERENCES import_batches (id),
  row_number         integer NOT NULL,
  row_fingerprint    text NOT NULL,
  raw_payload        jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (
                        status IN ('PENDING', 'VALID', 'QUARANTINED', 'IMPORTED')
                      ),
  error_reason       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_rows_batch_fingerprint_key UNIQUE (import_batch_id, row_fingerprint)
);
CREATE INDEX import_rows_workspace_idx ON import_rows (workspace_id);

CREATE TABLE model_invocations (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                      uuid NOT NULL REFERENCES workspaces (id),
  principal_id                      uuid NOT NULL REFERENCES principals (id),
  registry_operation_id             text NOT NULL,
  model_name                        text NOT NULL,
  model_version                     text,
  prompt_version                    text,
  structured_output_schema_version  text,
  prompt_digest                     text NOT NULL,
  response_digest                   text,
  retention_mode                    text NOT NULL DEFAULT 'zero_retention',
  latency_ms                        integer,
  correlation_id                    uuid NOT NULL,
  created_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_invocations_workspace_idx ON model_invocations (workspace_id);

-- -----------------------------------------------------------------------------
-- 5. Ownership — migration owner owns every table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE workspaces          OWNER TO ai_crm_migration_owner;
ALTER TABLE users               OWNER TO ai_crm_migration_owner;
ALTER TABLE principals          OWNER TO ai_crm_migration_owner;
ALTER TABLE policy_decisions    OWNER TO ai_crm_migration_owner;
ALTER TABLE control_requests    OWNER TO ai_crm_migration_owner;
ALTER TABLE control_claims      OWNER TO ai_crm_migration_owner;
ALTER TABLE execution_intents   OWNER TO ai_crm_migration_owner;
ALTER TABLE audit_chain_heads   OWNER TO ai_crm_migration_owner;
ALTER TABLE audit_events        OWNER TO ai_crm_migration_owner;
ALTER TABLE outbox_events       OWNER TO ai_crm_migration_owner;
ALTER TABLE notifications       OWNER TO ai_crm_migration_owner;
ALTER TABLE import_batches      OWNER TO ai_crm_migration_owner;
ALTER TABLE import_rows         OWNER TO ai_crm_migration_owner;
ALTER TABLE model_invocations   OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
--
-- ENABLE + FORCE on every workspace-bound table. FORCE is required so that
-- even the owning role (ai_crm_migration_owner) is subject to RLS outside of
-- migration/maintenance sessions; only an explicit BYPASSRLS role (none of
-- the roles above have it) or superuser can bypass it, which is why none of
-- the application roles are granted BYPASSRLS. USING and WITH CHECK are both
-- set on every policy so rows can neither be read nor written/moved across
-- workspace boundaries.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  workspace_bound_table text;
BEGIN
  FOREACH workspace_bound_table IN ARRAY ARRAY[
    'users', 'principals', 'policy_decisions', 'control_requests', 'control_claims',
    'execution_intents', 'audit_chain_heads', 'audit_events', 'outbox_events',
    'notifications', 'import_batches', 'import_rows', 'model_invocations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', workspace_bound_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', workspace_bound_table);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id())',
      workspace_bound_table
    );
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 7. Append-only / immutability triggers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION app_reject_audit_mutation();

CREATE TRIGGER audit_chain_heads_no_delete
  BEFORE DELETE ON audit_chain_heads
  FOR EACH ROW
  EXECUTE FUNCTION app_reject_audit_mutation();

-- The chain head row may only ever move forward: head_sequence must
-- strictly increase, and workspace_id can never change.
CREATE OR REPLACE FUNCTION app_enforce_monotonic_audit_head() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'audit_chain_heads.workspace_id is immutable' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.head_sequence <= OLD.head_sequence THEN
    RAISE EXCEPTION 'audit_chain_heads.head_sequence must strictly increase (old=%, new=%)',
      OLD.head_sequence, NEW.head_sequence
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_chain_heads_monotonic
  BEFORE UPDATE ON audit_chain_heads
  FOR EACH ROW
  EXECUTE FUNCTION app_enforce_monotonic_audit_head();

-- Execution intents: binding fields are immutable once created; only
-- lifecycle/lease/result columns may change across state transitions
-- (QUEUED -> LEASED -> DISPATCHING -> SUCCEEDED|FAILED|UNKNOWN, with
-- pre-dispatch INVALIDATED|CANCELLED and LEASED -> QUEUED lease recovery).
CREATE OR REPLACE FUNCTION app_enforce_intent_immutable_binding() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id
     OR NEW.control_claim_id <> OLD.control_claim_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.action_type <> OLD.action_type
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.canonical_schema_version <> OLD.canonical_schema_version
  THEN
    RAISE EXCEPTION 'execution_intents binding fields (workspace_id, control_claim_id, idempotency_key, action_type, payload_hash, canonical_schema_version) are immutable'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_intents_immutable_binding
  BEFORE UPDATE ON execution_intents
  FOR EACH ROW
  EXECUTE FUNCTION app_enforce_intent_immutable_binding();

-- -----------------------------------------------------------------------------
-- 8. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier;

-- API runtime: reads/writes business and governance tables, creates control
-- requests/decisions, but never touches lease/dispatch-only columns in
-- practice (enforced at the application layer, not by column-level grants,
-- to keep the grant surface simple and auditable).
GRANT SELECT, INSERT, UPDATE ON
  users, principals, policy_decisions, control_requests, control_claims,
  execution_intents, notifications, import_batches, import_rows
  TO ai_crm_runtime_api;
GRANT SELECT, INSERT ON audit_events, outbox_events, model_invocations TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO ai_crm_runtime_api;

-- Worker runtime: lease acquisition/renewal/expiry-recovery, dispatch,
-- result recording, audit/outbox append, notification delivery.
GRANT SELECT, INSERT, UPDATE ON
  execution_intents, control_requests, control_claims, notifications,
  import_batches, import_rows
  TO ai_crm_runtime_worker;
GRANT SELECT, INSERT ON audit_events, model_invocations TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_events, audit_chain_heads TO ai_crm_runtime_worker;
GRANT SELECT ON users, principals, policy_decisions TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on any table.
GRANT SELECT ON
  audit_events, audit_chain_heads, outbox_events, execution_intents,
  control_requests, control_claims, policy_decisions, principals, users
  TO ai_crm_audit_verifier;

-- Defense in depth alongside the append-only trigger: runtime roles never
-- receive UPDATE/DELETE on audit_events, and DELETE is revoked everywhere it
-- was not explicitly granted (PostgreSQL grants nothing by default, this is
-- an explicit, auditable statement of intent).
REVOKE UPDATE, DELETE ON audit_events FROM ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier, PUBLIC;
REVOKE DELETE ON audit_chain_heads FROM ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier, PUBLIC;
REVOKE ALL ON workspaces FROM ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier, PUBLIC;
GRANT SELECT ON workspaces TO ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier;
