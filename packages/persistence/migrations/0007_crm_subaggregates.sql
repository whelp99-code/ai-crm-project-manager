-- =============================================================================
-- 0007_crm_subaggregates.sql
--
-- CRM sub-aggregate sidecar tables (PG-A — CRM sub-aggregates PG proof,
-- P6-b G001). Mirrors 0005_crm_customers.sql's pattern for ownership,
-- FORCE RLS, workspace isolation via app_current_workspace_id(), and
-- least-privilege grants to runtime roles. Does not create roles (those
-- already exist from 0001/0002).
--
-- Persists the in-memory CrmService's CustomerContract, Communication,
-- NextAction, and OperationalException shapes verbatim (opaque text ids,
-- matching whatever id the request-path caller supplied — CrmService does
-- not mint its own ids for these either). Closes the residual documented
-- in 0005's header comment and docs/ops/sor-persistence.md.
--
-- Layout:
--   1. Tables                      (crm_contracts, crm_communications,
--                                    crm_next_actions,
--                                    crm_operational_exceptions)
--   2. Ownership                   (migration owner owns each table)
--   3. Row Level Security          (ENABLE + FORCE, USING/WITH CHECK policy)
--   4. Grants                      (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
--
-- Primary keys are text so opaque in-process ids round-trip through the PG
-- adapter without rewriting CrmService's id scheme. workspace_id remains
-- uuid and references workspaces(id), matching the foundation tenant
-- boundary. `version` mirrors the optimistic-concurrency convention used
-- elsewhere (these sub-aggregates are otherwise immutable-once-created in
-- CrmService today except OperationalException.resolve, which is captured
-- via status/resolved_at).
--
-- crm_contracts.value_krw is `numeric` (unbounded precision/scale, i.e. NOT
-- numeric(20,4)) and NULLABLE — integer-KRW amounts only, matching
-- CustomerContract.valueKrw's optional-string contract. The adapter mapper
-- emits a clean integer string and only asserts the ^\d+$ shape when the
-- value is present; NULL round-trips as `undefined`, never as "0" or "null".
-- -----------------------------------------------------------------------------

CREATE TABLE crm_contracts (
  id              text PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces (id),
  customer_id     text NOT NULL,
  title           text NOT NULL,
  scope           text NOT NULL,
  effective_from  text NOT NULL,
  effective_to    text,
  value_krw       numeric,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_contracts_workspace_idx ON crm_contracts (workspace_id);
CREATE INDEX crm_contracts_customer_idx ON crm_contracts (workspace_id, customer_id);

CREATE TABLE crm_communications (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  customer_id   text NOT NULL,
  channel       text NOT NULL,
  summary       text NOT NULL,
  occurred_at   text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_communications_workspace_idx ON crm_communications (workspace_id);
CREATE INDEX crm_communications_customer_idx ON crm_communications (workspace_id, customer_id);

CREATE TABLE crm_next_actions (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  customer_id   text NOT NULL,
  title         text NOT NULL,
  priority      integer NOT NULL,
  due_at        text NOT NULL,
  status        text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_next_actions_workspace_idx ON crm_next_actions (workspace_id);
CREATE INDEX crm_next_actions_customer_idx ON crm_next_actions (workspace_id, customer_id);

CREATE TABLE crm_operational_exceptions (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  customer_id   text NOT NULL,
  title         text NOT NULL,
  severity      text NOT NULL,
  priority      integer NOT NULL,
  occurred_at   text NOT NULL,
  status        text NOT NULL,
  resolved_at   text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_operational_exceptions_workspace_idx ON crm_operational_exceptions (workspace_id);
CREATE INDEX crm_operational_exceptions_customer_idx ON crm_operational_exceptions (workspace_id, customer_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns each table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE crm_contracts OWNER TO ai_crm_migration_owner;
ALTER TABLE crm_communications OWNER TO ai_crm_migration_owner;
ALTER TABLE crm_next_actions OWNER TO ai_crm_migration_owner;
ALTER TABLE crm_operational_exceptions OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on all four workspace-bound tables. Policy uses the
-- guarded app_current_workspace_id() accessor from 0001 (fail-closed when
-- app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE crm_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm_contracts
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE crm_communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_communications FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm_communications
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE crm_next_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_next_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm_next_actions
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE crm_operational_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_operational_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm_operational_exceptions
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_contracts TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_contracts TO ai_crm_runtime_worker;
GRANT SELECT ON crm_contracts TO ai_crm_audit_verifier;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_communications TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_communications TO ai_crm_runtime_worker;
GRANT SELECT ON crm_communications TO ai_crm_audit_verifier;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_next_actions TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_next_actions TO ai_crm_runtime_worker;
GRANT SELECT ON crm_next_actions TO ai_crm_audit_verifier;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_operational_exceptions TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_operational_exceptions TO ai_crm_runtime_worker;
GRANT SELECT ON crm_operational_exceptions TO ai_crm_audit_verifier;
