-- =============================================================================
-- 0003_orchestration.sql
--
-- Orchestration spine (Job / WorkItem / JobEvent) for the AI CRM + Project
-- Manager single-workspace MVP. Follows 0001_foundation.sql patterns for
-- ownership, FORCE RLS, workspace isolation via app_current_workspace_id(),
-- and least-privilege grants to runtime roles. Does not create roles (those
-- already exist from 0001/0002).
--
-- Layout:
--   1. Tables                     (orch_jobs, orch_work_items, orch_job_events)
--   2. Ownership                  (migration owner owns every table)
--   3. Row Level Security         (ENABLE + FORCE, USING/WITH CHECK policies)
--   4. Grants                     (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
--
-- Primary keys are text so opaque in-process orchestration ids (e.g.
-- job-000001) round-trip through the PG adapter without rewriting the
-- OrchestrationService id scheme. workspace_id remains uuid and references
-- workspaces(id), matching the foundation tenant boundary.
-- -----------------------------------------------------------------------------

CREATE TABLE orch_jobs (
  id                        text PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES workspaces (id),
  source                    text NOT NULL,
  raw_text                  text,
  plan_invocation_id        text,
  status                    text NOT NULL,
  created_by_principal_id   text NOT NULL,
  idempotency_key           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orch_jobs_workspace_idempotency_key UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX orch_jobs_workspace_idx ON orch_jobs (workspace_id);

CREATE TABLE orch_work_items (
  id                        text PRIMARY KEY,
  job_id                    text NOT NULL REFERENCES orch_jobs (id) ON DELETE CASCADE,
  workspace_id              uuid NOT NULL REFERENCES workspaces (id),
  sequence                  integer NOT NULL,
  title                     text NOT NULL,
  status                    text NOT NULL,
  suggested_command         text,
  action_type               text,
  assigned_principal_id     text,
  control_id                text,
  intent_id                 text,
  resource_type             text,
  resource_id               text,
  resource_version          integer,
  progress                  integer NOT NULL DEFAULT 0,
  error_code                text,
  result_ref                jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orch_work_items_resource_binding_check CHECK (
    (resource_type IS NULL AND resource_id IS NULL)
    OR (resource_type IS NOT NULL AND resource_id IS NOT NULL)
  )
);
CREATE INDEX orch_work_items_job_id_idx ON orch_work_items (job_id);
CREATE INDEX orch_work_items_workspace_idx ON orch_work_items (workspace_id);

CREATE TABLE orch_job_events (
  id             text PRIMARY KEY,
  job_id         text NOT NULL REFERENCES orch_jobs (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id),
  kind           text NOT NULL,
  payload        jsonb NOT NULL,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orch_job_events_job_id_idx ON orch_job_events (job_id);
CREATE INDEX orch_job_events_workspace_idx ON orch_job_events (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns every table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE orch_jobs        OWNER TO ai_crm_migration_owner;
ALTER TABLE orch_work_items  OWNER TO ai_crm_migration_owner;
ALTER TABLE orch_job_events  OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on every workspace-bound orchestration table. Policies use
-- the guarded app_current_workspace_id() accessor from 0001 (fail-closed when
-- app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  workspace_bound_table text;
BEGIN
  FOREACH workspace_bound_table IN ARRAY ARRAY[
    'orch_jobs', 'orch_work_items', 'orch_job_events'
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
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orch_jobs, orch_work_items, orch_job_events
  TO ai_crm_runtime_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orch_jobs, orch_work_items, orch_job_events
  TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on orchestration tables.
GRANT SELECT ON
  orch_jobs, orch_work_items, orch_job_events
  TO ai_crm_audit_verifier;
