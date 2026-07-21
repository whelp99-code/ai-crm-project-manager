-- =============================================================================
-- 0005_crm_customers.sql
--
-- CRM customers sidecar table (N-12 / D2 — first CRM domain PG proof).
-- Mirrors 0003_orchestration.sql / 0004_governance_snapshot.sql patterns for
-- ownership, FORCE RLS, workspace isolation via app_current_workspace_id(),
-- and least-privilege grants to runtime roles. Does not create roles (those
-- already exist from 0001/0002).
--
-- This table persists the in-memory CrmService's Customer shape verbatim
-- (opaque text ids, e.g. "customer-1", matching whatever id the request-path
-- caller supplied — CrmService does not mint its own ids). Scoped to
-- CUSTOMERS only for this slice; contracts/communications/nextActions/
-- exceptions remain in-memory-only (documented residual — see
-- docs/ops/sor-persistence.md).
--
-- Layout:
--   1. Table                       (crm_customers)
--   2. Ownership                   (migration owner owns the table)
--   3. Row Level Security          (ENABLE + FORCE, USING/WITH CHECK policy)
--   4. Grants                      (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table
--
-- Primary key is text so opaque in-process customer ids round-trip through
-- the PG adapter without rewriting CrmService's id scheme. workspace_id
-- remains uuid and references workspaces(id), matching the foundation
-- tenant boundary. `version` mirrors CrmService's optimistic-concurrency
-- counter (Customer.version).
-- -----------------------------------------------------------------------------

CREATE TABLE crm_customers (
  id            text PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces (id),
  name          text NOT NULL,
  status        text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_customers_workspace_idx ON crm_customers (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns the table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE crm_customers OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on the workspace-bound customers table. Policy uses the
-- guarded app_current_workspace_id() accessor from 0001 (fail-closed when
-- app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE crm_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON crm_customers
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_customers TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_customers TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on the CRM customers table.
GRANT SELECT ON crm_customers TO ai_crm_audit_verifier;
