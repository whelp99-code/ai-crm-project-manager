-- =============================================================================
-- 0002_model_gateway_and_break_glass_roles.sql
--
-- Follow-up to 0001_foundation.sql. Closes the gap tracked in
-- docs/security/rls-role-model.md §9: creates the two roles that design
-- document marked "Pending" (`ai_crm_runtime_model_gateway`,
-- `ai_crm_break_glass_admin`) and moves `model_invocations` write access from
-- `ai_crm_runtime_api`/`ai_crm_runtime_worker` to the new disjoint
-- model-gateway role only, per ADR-001 §2 and ADR-010.
--
-- This migration is self-contained: it does not depend on any TypeScript
-- package, application code or seed data, and can be reviewed/run purely as
-- SQL.
--
-- Layout:
--   1. Roles                      (model-gateway runtime role, break-glass role)
--   2. Grants                     (model_invocations write reassignment)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Roles
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_model_gateway') THEN
    -- apps/model-gateway runtime. Disjoint credential from
    -- ai_crm_runtime_api/ai_crm_runtime_worker per ADR-001 §2 and ADR-010: this
    -- role is the only writer of model_invocations rows, and it is the
    -- database-level enforcement that the model gateway cannot create/lease/
    -- dispatch execution intents (it receives no grant on execution_intents,
    -- control_requests or control_claims below). Non-owner, NOBYPASSRLS: FORCE
    -- RLS always applies.
    CREATE ROLE ai_crm_runtime_model_gateway LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOINHERIT PASSWORD NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_break_glass_admin') THEN
    -- Offline, time-limited emergency access for incident response only (see
    -- docs/security/rls-role-model.md §6). NOLOGIN by default: this role is
    -- never used for routine operations and carries no standing credential;
    -- an incident runbook grants time-boxed membership/credential out-of-band
    -- when, and only when, a declared incident requires it. Non-owner,
    -- NOBYPASSRLS: break-glass access is audited elevated access via
    -- explicit, logged SET ROLE/session grant, never a standing RLS bypass.
    CREATE ROLE ai_crm_break_glass_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOINHERIT;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Grants — reassign model_invocations access to the model-gateway role.
--
-- 0001_foundation.sql granted SELECT, INSERT on model_invocations to both
-- ai_crm_runtime_api and ai_crm_runtime_worker (bundled with audit_events/
-- outbox_events for the API role, and with audit_events for the worker
-- role). Neither role was ever granted UPDATE on model_invocations. This
-- section revokes BOTH the SELECT and the INSERT that made api/worker able
-- to read/write model_invocations rows, leaving api/worker with NO access
-- to this table at all (matching docs/security/rls-role-model.md §5, which
-- lists no model_invocations grant for either role): this is a disjoint-
-- principal design per ADR-001 §2/ADR-010 — model_invocations is the model
-- gateway's own audit trail of its invocations, and only the gateway role
-- has any reason to read or write it, not just to write it. The equivalent
-- SELECT, INSERT is granted to ai_crm_runtime_model_gateway only, plus the
-- SELECT it needs on principals/workspaces to attribute an invocation to a
-- workspace/principal.
-- -----------------------------------------------------------------------------

REVOKE SELECT, INSERT ON model_invocations FROM ai_crm_runtime_api, ai_crm_runtime_worker;

GRANT USAGE ON SCHEMA public TO ai_crm_runtime_model_gateway;

GRANT SELECT, INSERT ON model_invocations TO ai_crm_runtime_model_gateway;
GRANT SELECT ON principals, workspaces TO ai_crm_runtime_model_gateway;
