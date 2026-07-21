-- =============================================================================
-- 0008_pm_delivery.sql
--
-- PM + delivery sub-aggregates sidecar tables (Ultragoal P6-b G001 / PG-B —
-- second and third domain PG proofs after CRM customers). Mirrors
-- 0005_crm_customers.sql's ownership / FORCE RLS / workspace isolation /
-- least-privilege grant pattern.
--
-- This migration persists the in-memory PmService's plans/assignments/
-- targets/observations/exceptions maps AND the in-memory DeliveryService's
-- projects map verbatim (opaque text ids, matching whatever id the
-- request-path caller supplied — neither service mints its own ids).
--
-- Nested arrays (PmPlan.revisions; DeliveryProject.deliverables/tasks/risks/
-- requirementIds) are persisted as jsonb columns rather than child tables —
-- there is no independent access pattern for the nested rows outside their
-- parent aggregate, so a normalized child-table schema would only add
-- join/transaction overhead without a corresponding read benefit. jsonb
-- values are serialized with plain `JSON.stringify` by the adapter (order
-- within nested objects is not hash-verified anywhere in this slice, unlike
-- governance's audit payload hash, so `stableStringify` is not required
-- here — see pg-governance-adapter.ts's doc comment for that contrast).
--
-- Layout:
--   1. Tables                       (pm_plans, pm_assignments, pm_targets,
--                                     pm_target_observations,
--                                     pm_variance_exceptions,
--                                     delivery_projects)
--   2. Ownership                    (migration owner owns every table)
--   3. Row Level Security           (ENABLE + FORCE, USING/WITH CHECK policy)
--   4. Grants                       (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
--
-- Primary keys are text so opaque in-process ids round-trip through the PG
-- adapter without rewriting PmService/DeliveryService's id schemes.
-- workspace_id remains uuid and references workspaces(id), matching the
-- foundation tenant boundary. `version` mirrors each service's optimistic-
-- concurrency counter where the domain type carries one (PmPlan.version,
-- PmTarget.version, DeliveryProject.version); pm_assignments/
-- pm_target_observations/pm_variance_exceptions are append-only-per-id in
-- the domain (no update path), so they carry no version column.
-- -----------------------------------------------------------------------------

CREATE TABLE pm_plans (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  project_id    text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  revisions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pm_plans_workspace_idx ON pm_plans (workspace_id);

CREATE TABLE pm_assignments (
  id                       text PRIMARY KEY,
  workspace_id             uuid NOT NULL REFERENCES workspaces (id),
  project_id               text NOT NULL,
  plan_id                  text NOT NULL,
  task_id                  text NOT NULL,
  assignee_principal_id    text NOT NULL,
  assigned_by_principal_id text NOT NULL,
  status                   text NOT NULL,
  created_at               timestamptz NOT NULL
);
CREATE INDEX pm_assignments_workspace_idx ON pm_assignments (workspace_id);

CREATE TABLE pm_targets (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  project_id    text NOT NULL,
  metric        text NOT NULL,
  target        double precision NOT NULL,
  tolerance     double precision NOT NULL,
  direction     text NOT NULL,
  version       integer NOT NULL DEFAULT 1
);
CREATE INDEX pm_targets_workspace_idx ON pm_targets (workspace_id);

CREATE TABLE pm_target_observations (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  project_id    text NOT NULL,
  target_id     text NOT NULL,
  actual        double precision NOT NULL,
  observed_at   timestamptz NOT NULL,
  evidence_ref  text NOT NULL
);
CREATE INDEX pm_target_observations_workspace_idx ON pm_target_observations (workspace_id);

CREATE TABLE pm_variance_exceptions (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  project_id    text NOT NULL,
  target_id     text NOT NULL,
  metric        text NOT NULL,
  target        double precision NOT NULL,
  actual        double precision NOT NULL,
  variance      double precision NOT NULL,
  severity      text NOT NULL,
  evidence_ref  text NOT NULL
);
CREATE INDEX pm_variance_exceptions_workspace_idx ON pm_variance_exceptions (workspace_id);

CREATE TABLE delivery_projects (
  id               text PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces (id),
  customer_id      text NOT NULL,
  name             text NOT NULL,
  contract_id      text NOT NULL,
  contract_scope   text NOT NULL,
  schedule_start   text NOT NULL,
  schedule_end     text NOT NULL,
  deliverables     jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_rule  text NOT NULL,
  risk_threshold   double precision NOT NULL,
  tasks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  requirement_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL,
  version          integer NOT NULL DEFAULT 1
);
CREATE INDEX delivery_projects_workspace_idx ON delivery_projects (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns every table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE pm_plans OWNER TO ai_crm_migration_owner;
ALTER TABLE pm_assignments OWNER TO ai_crm_migration_owner;
ALTER TABLE pm_targets OWNER TO ai_crm_migration_owner;
ALTER TABLE pm_target_observations OWNER TO ai_crm_migration_owner;
ALTER TABLE pm_variance_exceptions OWNER TO ai_crm_migration_owner;
ALTER TABLE delivery_projects OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on every workspace-bound table. Policies use the guarded
-- app_current_workspace_id() accessor from 0001 (fail-closed when
-- app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE pm_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON pm_plans
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE pm_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON pm_assignments
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE pm_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON pm_targets
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE pm_target_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_target_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON pm_target_observations
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE pm_variance_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_variance_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON pm_variance_exceptions
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE delivery_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON delivery_projects
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON pm_plans TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_plans TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_assignments TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_assignments TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_targets TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_targets TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_target_observations TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_target_observations TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_variance_exceptions TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON pm_variance_exceptions TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_projects TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_projects TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on any PG-B table.
GRANT SELECT ON pm_plans TO ai_crm_audit_verifier;
GRANT SELECT ON pm_assignments TO ai_crm_audit_verifier;
GRANT SELECT ON pm_targets TO ai_crm_audit_verifier;
GRANT SELECT ON pm_target_observations TO ai_crm_audit_verifier;
GRANT SELECT ON pm_variance_exceptions TO ai_crm_audit_verifier;
GRANT SELECT ON delivery_projects TO ai_crm_audit_verifier;
