-- =============================================================================
-- 0010_finance_recon_dailygate.sql
--
-- PG-C2 — finance reconciliation + daily-gate sidecar tables (Ultragoal P6-b
-- G001 domain-PG core). Mirrors 0005_crm_customers.sql / 0009_finance_ledger
-- patterns for ownership, FORCE RLS, workspace isolation via
-- app_current_workspace_id(), and least-privilege grants to runtime roles.
-- Does not create roles (those already exist from 0001/0002).
--
-- Persists `ReconciliationService` (reconciliation.ts) and `DailyGate`
-- (daily-gate.ts) verbatim:
--   - finance_reconciliations / finance_exceptions: opaque text ids (caller-
--     supplied, same posture as crm_customers). Money is signed integer-KRW
--     — `numeric` with NO declared scale/precision (unbounded, exact,
--     accepts a negative sign) so `^-?\d+$` string amounts round-trip
--     without any decimal-scale truncation risk. `statement_row` is stored
--     as jsonb to preserve `StatementRowRef` verbatim (account/postedAt/
--     amountKrw/rowFingerprint) without inventing extra columns.
--   - finance_daily_gate_state: ONE row per workspace holding the
--     `DailyGate` MACHINE STATE (streak/tier/lastDateEpoch/
--     activatedMatrixVersion) — NOT a replay log. This original migration
--     lacked a persisted pack version; migration 0020 adds nullable
--     `pack_version` and makes missing or mismatched versions fail closed
--     with a drift reset before restoring the remaining machine state.
--   - finance_day_records: read-only day-by-day history for
--     `DailyGate.records`. Composite PRIMARY KEY (workspace_id, date) —
--     NO id, NO version (an already-recorded day is never mutated in place;
--     `historicalCorrection` is a separate audit note, not a row update).
--     `streak_after`/`tier_after` are kept (not just qualifying/reason) so a
--     hydrate-restored gate's day-record listing is bit-for-bit identical to
--     the pre-restart `DayRecord[]`, without requiring a recomputation pass.
--
-- `finance_reconciliations.exception_id` / `finance_exceptions.
-- reconciliation_id` intentionally have NO FK to each other: `reconcile()`
-- creates both rows in the same call and either table may be written first
-- depending on adapter save order, so a cross-referencing FK would force an
-- artificial ordering/deferred-constraint dance for no safety benefit — the
-- app layer (ReconciliationService) is the sole writer and already
-- enforces the pairing invariant in-process.
--
-- Layout:
--   1. Tables                       (finance_reconciliations, finance_exceptions,
--                                     finance_daily_gate_state, finance_day_records)
--   2. Ownership                    (migration owner owns all four tables)
--   3. Row Level Security           (ENABLE + FORCE, USING/WITH CHECK policy, all four)
--   4. Grants                       (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

CREATE TABLE finance_reconciliations (
  id                          text PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  statement_row               jsonb NOT NULL,
  ledger_amount_krw           numeric NOT NULL,
  variance_krw                numeric NOT NULL,
  status                      text NOT NULL,
  reconciled_by_principal_id  text NOT NULL,
  reconciled_at               timestamptz NOT NULL,
  exception_id                text NULL,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_reconciliations_ledger_amount_krw_integer_check
    CHECK (ledger_amount_krw = trunc(ledger_amount_krw)),
  CONSTRAINT finance_reconciliations_variance_krw_integer_check
    CHECK (variance_krw = trunc(variance_krw) AND variance_krw >= 0)
);
CREATE INDEX finance_reconciliations_workspace_idx ON finance_reconciliations (workspace_id);

CREATE TABLE finance_exceptions (
  id                          text PRIMARY KEY,
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  kind                        text NOT NULL,
  reconciliation_id           text NULL,
  variance_krw                numeric NOT NULL,
  status                      text NOT NULL,
  opened_at                   timestamptz NOT NULL,
  resolved_by_principal_id    text NULL,
  resolved_at                 timestamptz NULL,
  resolution_note             text NULL,
  version                     integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_exceptions_variance_krw_integer_check
    CHECK (variance_krw = trunc(variance_krw) AND variance_krw >= 0)
);
CREATE INDEX finance_exceptions_workspace_idx ON finance_exceptions (workspace_id);
CREATE INDEX finance_exceptions_reconciliation_id_idx ON finance_exceptions (reconciliation_id);

-- One row per workspace: current DailyGate machine state (not a log).
CREATE TABLE finance_daily_gate_state (
  workspace_id                uuid PRIMARY KEY REFERENCES workspaces (id),
  streak                      integer NOT NULL,
  tier                        text NOT NULL,
  last_date_epoch              bigint NULL,
  activated_matrix_version     bigint NULL,
  version                      integer NOT NULL DEFAULT 1,
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- Read-only day-by-day history backing DailyGate.records (never replayed
-- through recordDay() on hydrate — see module doc above).
CREATE TABLE finance_day_records (
  workspace_id                uuid NOT NULL REFERENCES workspaces (id),
  date                        date NOT NULL,
  qualifying                  boolean NOT NULL,
  reason                      text NULL,
  streak_after                integer NOT NULL,
  tier_after                  text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_day_records_pkey PRIMARY KEY (workspace_id, date)
);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns all four tables (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE finance_reconciliations  OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_exceptions       OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_daily_gate_state OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_day_records      OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- ENABLE + FORCE on all four workspace-bound tables. Policy uses the
-- guarded app_current_workspace_id() accessor from 0001 (fail-closed when
-- app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE finance_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_reconciliations
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE finance_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_exceptions
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE finance_daily_gate_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_gate_state FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_daily_gate_state
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

ALTER TABLE finance_day_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_day_records FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_day_records
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_reconciliations  TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_exceptions       TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_daily_gate_state TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_day_records      TO ai_crm_runtime_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_reconciliations  TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_exceptions       TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_daily_gate_state TO ai_crm_runtime_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_day_records      TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on any of the four tables.
GRANT SELECT ON finance_reconciliations, finance_exceptions, finance_daily_gate_state, finance_day_records
  TO ai_crm_audit_verifier;
