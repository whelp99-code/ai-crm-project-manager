-- =============================================================================
-- 0009_finance_ledger.sql
--
-- Finance journal ledger sidecar table (PG-C1 — F6 double-entry ledger PG
-- proof). Mirrors 0005_crm_customers.sql / 0003_orchestration.sql patterns
-- for ownership, FORCE RLS, workspace isolation via
-- app_current_workspace_id(), and least-privilege grants to runtime roles.
-- Does not create roles (those already exist from 0001/0002).
--
-- Persists `LedgerService`'s in-memory `JournalEntry` shape verbatim
-- (opaque text ids, e.g. "je-1", matching whatever id the request-path
-- caller supplied — LedgerService does not mint its own ids). `lines`
-- (JournalLine[]) is stored as jsonb rather than a child table so a single
-- INSERT/UPDATE covers the whole entry atomically; per-line money strings
-- inside the jsonb stay integer-KRW text (`^\d+$`), matched by top-level
-- debit_total_krw/credit_total_krw kept as unbounded scale-0 numeric
-- (NOT numeric(20,4) — see docs/finance/accounting-standard-pack.md §3 and
-- the goal's money-representation constraint).
--
-- Unlike crm_customers, this table is NOT freely UPDATE/DELETE-able once a
-- row reaches POSTED: `docs/finance/accounting-standard-pack.md` §3 rule 3
-- requires posted-entry immutability (corrections are reversals, never
-- updates/deletes). A status-aware trigger enforces this in PG itself (not
-- just app-level discipline), narrower than audit_events' blanket
-- append-only trigger (0001) because the SAME row legitimately transitions
-- DRAFT -> VERIFIED -> POSTED -> REVERSED, and the one-time
-- POSTED -> REVERSED transition (setting reversed_by_entry_id) must still
-- be allowed on the original entry when its reversal posts
-- (LedgerService.post ~L134/L137, atomic two-row commit).
--
-- Layout:
--   1. Table                       (finance_journal_entries)
--   2. Ownership                   (migration owner owns the table)
--   3. Status-aware immutability trigger (POSTED rows, one-time reversal exception)
--   4. Row Level Security          (ENABLE + FORCE, USING/WITH CHECK policy)
--   5. Grants                      (api/worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Table
--
-- Primary key is text so opaque in-process journal entry ids round-trip
-- through the PG adapter without rewriting LedgerService's id scheme.
-- workspace_id remains uuid and references workspaces(id), matching the
-- foundation tenant boundary. `version` mirrors LedgerService's
-- optimistic-concurrency counter (JournalEntry.version).
--
-- debit_total_krw/credit_total_krw are unbounded (unconstrained precision)
-- `numeric` columns constrained by CHECK to non-negative integers, so
-- amounts up to and beyond 10^30 round-trip exactly with no scale/precision
-- ceiling and no accidental fractional KRW.
-- -----------------------------------------------------------------------------

CREATE TABLE finance_journal_entries (
  id                        text PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES workspaces (id),
  entry_date                text NOT NULL,
  description               text NOT NULL,
  evidence_ref              text NULL,
  lines                     jsonb NOT NULL,
  debit_total_krw           numeric NOT NULL,
  credit_total_krw          numeric NOT NULL,
  status                    text NOT NULL,
  created_by_principal_id   text NOT NULL,
  verified_by_principal_id  text NULL,
  posted_by_principal_id    text NULL,
  reverses_entry_id         text NULL REFERENCES finance_journal_entries (id),
  reversed_by_entry_id      text NULL REFERENCES finance_journal_entries (id),
  import_batch_id           text NULL,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_journal_entries_status_check
    CHECK (status IN ('DRAFT', 'VERIFIED', 'POSTED', 'REVERSED')),
  CONSTRAINT finance_journal_entries_debit_total_nonneg_int_check
    CHECK (debit_total_krw >= 0 AND debit_total_krw = trunc(debit_total_krw)),
  CONSTRAINT finance_journal_entries_credit_total_nonneg_int_check
    CHECK (credit_total_krw >= 0 AND credit_total_krw = trunc(credit_total_krw))
);
CREATE INDEX finance_journal_entries_workspace_idx ON finance_journal_entries (workspace_id);
CREATE INDEX finance_journal_entries_reverses_idx ON finance_journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns the table (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE finance_journal_entries OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Status-aware immutability trigger
--
-- Deliberately narrower than audit_events' blanket append-only trigger:
--   * DELETE: rejected once a row has ever reached POSTED or REVERSED.
--   * UPDATE while OLD.status IN ('DRAFT', 'VERIFIED'): unrestricted — the
--     normal DRAFT -> VERIFIED -> POSTED lifecycle writes go through
--     ordinary UPDATEs (draft/verify never re-lock a row).
--   * UPDATE while OLD.status = 'POSTED': rejected UNLESS the update is
--     EXACTLY the one-time reverse transition — NEW.status = 'REVERSED',
--     NEW.reversed_by_entry_id newly set (was NULL), version/updated_at may
--     advance, and every other column identical to OLD. This is the
--     "reversedOriginal" half of LedgerService.post's atomic two-row commit
--     (~L134/L137): the ORIGINAL posted entry is reassigned to REVERSED
--     with reversed_by_entry_id pointing at its reversal, never edited any
--     other way again.
--   * UPDATE while OLD.status = 'REVERSED': always rejected — terminal.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_posted_journal_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'finance_journal_entries: % entries are immutable (delete rejected) for id %', OLD.status, OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'
  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'finance_journal_entries: REVERSED entry % is immutable' , OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'REVERSED' THEN
      RAISE EXCEPTION 'finance_journal_entries: POSTED entry % is immutable except the one-time transition to REVERSED (attempted status: %)', OLD.id, NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    IF OLD.reversed_by_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'finance_journal_entries: POSTED entry % has already been reversed by %; no further mutation permitted', OLD.id, OLD.reversed_by_entry_id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.reversed_by_entry_id IS NULL THEN
      RAISE EXCEPTION 'finance_journal_entries: POSTED entry % update must set reversed_by_entry_id (the reverse transition)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF (to_jsonb(NEW) - 'status' - 'reversed_by_entry_id' - 'version' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'status' - 'reversed_by_entry_id' - 'version' - 'updated_at') THEN
      RAISE EXCEPTION 'finance_journal_entries: POSTED entry % reverse transition may only change status/reversed_by_entry_id/version/updated_at', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER finance_journal_entries_immutability
  BEFORE UPDATE OR DELETE ON finance_journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION app_reject_posted_journal_mutation();

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
--
-- ENABLE + FORCE on the workspace-bound journal entries table. Policy uses
-- the guarded app_current_workspace_id() accessor from 0001 (fail-closed
-- when app.workspace_id is missing or malformed).
-- -----------------------------------------------------------------------------

ALTER TABLE finance_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_journal_entries
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 5. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
--
-- api/worker retain UPDATE/DELETE grants at the SQL level (least-privilege
-- is still expressed at the row level via the immutability trigger above,
-- which fires regardless of the calling role — including the table owner
-- and superuser sessions, see the N-13-style teardown pattern for tests
-- that must disable the trigger explicitly to clean up fixtures).
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_journal_entries TO ai_crm_runtime_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_journal_entries TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants on the finance ledger table.
GRANT SELECT ON finance_journal_entries TO ai_crm_audit_verifier;
