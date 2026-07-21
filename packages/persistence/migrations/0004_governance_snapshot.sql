-- =============================================================================
-- 0004_governance_snapshot.sql
--
-- Governance snapshot/sidecar tables for the AI CRM + Project Manager
-- single-workspace MVP. Mirrors 0003_orchestration.sql patterns for
-- ownership, FORCE RLS, workspace isolation via app_current_workspace_id(),
-- and least-privilege grants to runtime roles. Does not create roles (those
-- already exist from 0001/0002).
--
-- These tables persist the in-memory GovernanceAuthorizationService's
-- PersistedControlShape / PersistedIntentShape verbatim (opaque text ids
-- like control-000001 / intent-000001). They are intentionally NOT the
-- foundation control_requests / execution_intents tables from 0001, which
-- require policy_decision_id / control_claim_id foreign keys the in-memory
-- governance model does not carry. Full dual-write cutover onto the
-- foundation tables remains future work; these are a restart-consistency
-- snapshot layer for the P1.5 in-memory SoR.
--
-- Layout:
--   1. Tables                     (orch_governance_controls, orch_governance_intents)
--   2. Ownership                  (migration owner owns every table)
--   3. Row Level Security         (ENABLE + FORCE, USING/WITH CHECK policies)
--   4. Grants                     (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
--
-- Primary keys are text so opaque in-process governance ids (e.g.
-- control-000001 / intent-000001) round-trip through the PG adapter without
-- rewriting the GovernanceAuthorizationService id scheme. workspace_id
-- remains uuid and references workspaces(id), matching the foundation
-- tenant boundary.
-- -----------------------------------------------------------------------------

CREATE TABLE orch_governance_controls (
  id                          text PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  action_type                 text NOT NULL,
  kind                        text NOT NULL,
  resource_id                 text NOT NULL,
  resource_version            integer NOT NULL,
  payload_hash                text NOT NULL,
  policy_version              integer NOT NULL,
  requester_principal_id      text NOT NULL,
  decided_by_principal_id     text,
  status                      text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orch_governance_controls_workspace_idx ON orch_governance_controls (workspace_id);

CREATE TABLE orch_governance_intents (
  id                          text PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  action_type                 text NOT NULL,
  status                      text NOT NULL,
  idempotency_key             text NOT NULL,
  resource_id                 text NOT NULL,
  resource_version            integer NOT NULL,
  payload_hash                text NOT NULL,
  policy_version              integer NOT NULL,
  lease_deadline              timestamptz,
  lease_epoch                 integer NOT NULL DEFAULT 0,
  lease_token                 text,
  control_id                  text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orch_governance_intents_workspace_idempotency_key UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX orch_governance_intents_workspace_idx ON orch_governance_intents (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns every table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE orch_governance_controls  OWNER TO ai_crm_migration_owner;
ALTER TABLE orch_governance_intents   OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on every workspace-bound governance snapshot table. Policies
-- use the guarded app_current_workspace_id() accessor from 0001 (fail-closed
-- when app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  workspace_bound_table text;
BEGIN
  FOREACH workspace_bound_table IN ARRAY ARRAY[
    'orch_governance_controls', 'orch_governance_intents'
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
  orch_governance_controls, orch_governance_intents
  TO ai_crm_runtime_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  orch_governance_controls, orch_governance_intents
  TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on governance snapshot tables.
GRANT SELECT ON
  orch_governance_controls, orch_governance_intents
  TO ai_crm_audit_verifier;
