-- =============================================================================
-- 0011_reports_model_invocations.sql
--
-- Q2 (D2) — ports the remaining two in-memory domain aggregates to
-- PostgreSQL: ReportService's immutable final-report snapshots
-- (packages/reports) and ModelGateway's MODEL_INVOKE audit trail
-- (packages/model-gateway). Mirrors 0005_crm_customers.sql /
-- 0009_finance_ledger.sql for ownership, FORCE RLS, workspace isolation,
-- and least-privilege grants. Does not create roles (those already exist
-- from 0001/0002).
--
-- IMPORTANT — model_invocations already exists (0001_foundation.sql) and
-- its write grants were deliberately moved from ai_crm_runtime_api/worker
-- to the disjoint ai_crm_runtime_model_gateway role in
-- 0002_model_gateway_and_break_glass_roles.sql (ADR-010 disjoint-principal
-- boundary; schema.security.test.ts asserts no later migration ever
-- re-grants it to api/worker). This migration does NOT touch that grant —
-- it only ALTERs the existing table's column shapes so it can hold the
-- real `ModelInvocationRecord` shape `packages/model-gateway` produces
-- (opaque text ids/principal/correlation, not the uuid/principals-FK shape
-- 0001 originally speculated), and does not create a second, colliding
-- sidecar table. `report_snapshots` is a genuinely new table and mirrors
-- crm_customers exactly (api/worker read-write grants — no ADR-010
-- boundary applies to reports).
--
-- Layout:
--   1. report_snapshots table               (new)
--   2. report_snapshots ownership
--   3. report_snapshots immutability trigger (snapshot/snapshot_hash/identity columns frozen; delete rejected)
--   4. report_snapshots Row Level Security
--   5. report_snapshots grants
--   6. model_invocations column-shape ALTERs (existing table; grants untouched)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. report_snapshots table
--
-- Primary key is text so opaque in-process report ids round-trip through
-- the PG adapter without rewriting ReportService's id scheme (mirrors
-- crm_customers/finance_journal_entries). `snapshot` (FinalReportSnapshot)
-- is stored as jsonb verbatim — the adapter never recomputes
-- `snapshot_hash` from it, only stores + returns both exactly as
-- ReportService produced them, so the SHA-256 hash always round-trips
-- byte-identical. `status`/`decided_*`/`rejection_reason` legitimately
-- change value across the SUBMITTED -> APPROVED|REJECTED lifecycle (see
-- trigger below); every other column is frozen once the row is inserted.
-- Follow-up actions (FollowUpAction) remain in-memory only — out of scope
-- for this slice (documented residual, see docs/ops/sor-persistence.md).
-- -----------------------------------------------------------------------------

CREATE TABLE report_snapshots (
  id                          text PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  project_id                  text NOT NULL,
  submitted_by_principal_id   text NOT NULL,
  submitted_at                text NOT NULL,
  status                      text NOT NULL,
  snapshot                    jsonb NOT NULL,
  snapshot_hash               text NOT NULL,
  decided_by_principal_id     text NULL,
  decided_at                  text NULL,
  rejection_reason            text NULL,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_snapshots_status_check
    CHECK (status IN ('SUBMITTED', 'APPROVED', 'REJECTED'))
);
CREATE INDEX report_snapshots_workspace_idx ON report_snapshots (workspace_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns the table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE report_snapshots OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Immutability trigger
--
-- Report snapshots are immutable once submitted (AC-13/AC-14 domain
-- invariant, see packages/reports/src/index.ts module doc): `snapshot` and
-- `snapshot_hash` — and every identity/submission column — may never
-- change value after INSERT. Only the decision lifecycle
-- (status/decided_by_principal_id/decided_at/rejection_reason) legitimately
-- mutates via ReportService.approveReport/rejectReport, plus
-- version/updated_at bookkeeping. Rows are never deleted (append-only,
-- narrower than the blanket audit_events trigger but same intent).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_report_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'report_snapshots: rows are append-only immutable (delete rejected) for id %', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'report_snapshots: snapshot is immutable once submitted for id %', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash THEN
    RAISE EXCEPTION 'report_snapshots: snapshot_hash is immutable once submitted for id %', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.submitted_by_principal_id IS DISTINCT FROM OLD.submitted_by_principal_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'report_snapshots: identity/submission columns are immutable for id %', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER report_snapshots_immutability
  BEFORE UPDATE OR DELETE ON report_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION app_reject_report_snapshot_mutation();

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
--
-- ENABLE + FORCE on the workspace-bound report snapshots table. Policy uses
-- the guarded app_current_workspace_id() accessor from 0001 (fail-closed
-- when app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON report_snapshots
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 5. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
--
-- UPDATE/DELETE grants are retained at the SQL level (least-privilege is
-- still expressed at the row level via the immutability trigger above,
-- which fires regardless of the calling role — mirrors
-- finance_journal_entries' status-aware trigger pattern) so the
-- decision-lifecycle UPDATE (approve/reject) can go through ordinary SQL.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON report_snapshots TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_snapshots TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on the report snapshots table.
GRANT SELECT ON report_snapshots TO ai_crm_audit_verifier;

-- -----------------------------------------------------------------------------
-- 6. model_invocations column-shape ALTERs (existing table from 0001)
--
-- 0001_foundation.sql originally speculated a uuid-keyed shape
-- (id uuid default gen_random_uuid(), principal_id uuid FK -> principals,
-- correlation_id uuid, model_name text NOT NULL) that predates
-- `packages/model-gateway`'s actual `ModelInvocationRecord` shape, which
-- mints its own opaque text ids ("model-invocation-000001"), an opaque
-- text service-principal id ("principal-model-gateway", never a
-- `principals` table row), an opaque text correlation id, and carries no
-- separate "model name" distinct from modelVersion. These ALTERs bring the
-- column shapes in line with that real shape WITHOUT touching table
-- ownership, RLS, or grants (still ai_crm_runtime_model_gateway ONLY,
-- exactly as 0002 left it — ADR-010 boundary preserved verbatim).
--
-- `external_id` is the new lookup key: it holds ReportService-sibling
-- ModelGateway's own `ModelInvocationRecord.id` verbatim, so
-- GET /api/model/invocations round-trips the exact same id after restart.
-- The pre-existing `id uuid` stays as an internal surrogate PK (unused by
-- the adapter beyond insertion) so no destructive PK-type rewrite is
-- needed on a table another migration might later reference by uuid.
-- -----------------------------------------------------------------------------

ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE model_invocations ADD COLUMN IF NOT EXISTS action_type text NOT NULL DEFAULT 'MODEL_INVOKE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'model_invocations_external_id_key'
  ) THEN
    ALTER TABLE model_invocations ALTER COLUMN external_id SET NOT NULL;
    ALTER TABLE model_invocations ADD CONSTRAINT model_invocations_external_id_key UNIQUE (external_id);
  END IF;
END
$$;

-- principal_id: drop the principals(id) FK + widen uuid -> text (the
-- gateway's dedicated service principal is an opaque string, never a row
-- in `principals`).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'model_invocations' AND column_name = 'principal_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE model_invocations DROP CONSTRAINT IF EXISTS model_invocations_principal_id_fkey;
    ALTER TABLE model_invocations ALTER COLUMN principal_id TYPE text USING principal_id::text;
  END IF;
END
$$;

-- correlation_id: widen uuid -> text (callers supply an opaque
-- correlation id, not necessarily a uuid).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'model_invocations' AND column_name = 'correlation_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE model_invocations ALTER COLUMN correlation_id TYPE text USING correlation_id::text;
  END IF;
END
$$;

-- model_name: ModelInvocationRecord carries no field distinct from
-- modelVersion; relax NOT NULL rather than inventing a value.
ALTER TABLE model_invocations ALTER COLUMN model_name DROP NOT NULL;
