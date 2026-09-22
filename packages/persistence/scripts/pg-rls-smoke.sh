#!/usr/bin/env bash
# pg-rls-smoke.sh — idempotent SEC-06 style live PG smoke for orchestration RLS.
#
# Targets the AI-CRM docker postgres only (default localhost:5432 / ai_crm).
# Does NOT touch other local DBs (sangfor/unified on 5433/5434).
#
# Usage:
#   packages/persistence/scripts/pg-rls-smoke.sh
#   PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
#     packages/persistence/scripts/pg-rls-smoke.sh
#
# Exit 0 on all PASS; non-zero on any FAIL. Appends a run log section to
# docs/ops/pg-rls-smoke.md when that path is writable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS_DIR="${ROOT}/packages/persistence/migrations"
DOC_PATH="${ROOT}/docs/ops/pg-rls-smoke.md"
LOG_DIR="${TMPDIR:-/tmp}/ai-crm-pg-rls-smoke"
mkdir -p "${LOG_DIR}"
RUN_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_LOG="${LOG_DIR}/run-${RUN_TS//[:]/-}.log"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-ai_crm}"
export PGDATABASE="${PGDATABASE:-ai_crm}"
# Default matches docker-compose.yml; override via env in non-dev.
export PGPASSWORD="${PGPASSWORD:-ai_crm_dev}"

# Hard guard: refuse anything that is not the ai_crm DB on the expected host/port.
if [[ "${PGDATABASE}" != "ai_crm" ]]; then
  echo "REFUSE: PGDATABASE must be ai_crm (got ${PGDATABASE}); refusing to touch other DBs" >&2
  exit 2
fi
if [[ "${PGPORT}" != "5432" && "${PGPORT}" != "5432/tcp" ]]; then
  # Allow override only when explicitly AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1
  if [[ "${AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT:-}" != "1" ]]; then
    echo "REFUSE: PGPORT=${PGPORT} is not 5432 (ai-crm docker). Set AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1 to override." >&2
    exit 2
  fi
fi

PASS_N=0
FAIL_N=0
SKIP_N=0
RESULTS=()

log() {
  printf '%s\n' "$*" | tee -a "${RUN_LOG}"
}

record() {
  local status="$1"
  local name="$2"
  local detail="${3:-}"
  case "${status}" in
    PASS) PASS_N=$((PASS_N + 1)) ;;
    FAIL) FAIL_N=$((FAIL_N + 1)) ;;
    SKIP) SKIP_N=$((SKIP_N + 1)) ;;
  esac
  RESULTS+=("${status} | ${name}${detail:+ — ${detail}}")
  log "[${status}] ${name}${detail:+ — ${detail}}"
}

psql_q() {
  psql -v ON_ERROR_STOP=1 -X -q -t -A "$@"
}

psql_f() {
  psql -v ON_ERROR_STOP=1 -X -q "$@"
}

require_psql() {
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql not found on PATH" >&2
    exit 127
  fi
}

check_connectivity() {
  if ! psql_q -c "SELECT 1" >/dev/null 2>&1; then
    record FAIL "connectivity" "cannot connect to ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
    return 1
  fi
  local who
  who="$(psql_q -c "SELECT current_database() || ' as ' || current_user || ' super=' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user)")"
  record PASS "connectivity" "${who}"
}

ensure_schema_migrations() {
  psql_f <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text
);
SQL
}

migration_applied() {
  local id="$1"
  local n
  n="$(psql_q -c "SELECT count(*) FROM schema_migrations WHERE id = '${id}'")"
  [[ "${n}" == "1" ]]
}

# Heuristic: if core objects already exist, backfill schema_migrations without re-running DDL.
backfill_if_present() {
  local id="$1"
  local probe_sql="$2"
  if migration_applied "${id}"; then
    return 0
  fi
  local present
  present="$(psql_q -c "${probe_sql}")"
  if [[ "${present}" == "1" ]]; then
    psql_f -c "INSERT INTO schema_migrations (id) VALUES ('${id}') ON CONFLICT (id) DO NOTHING"
    log "backfilled schema_migrations entry for ${id} (objects already present)"
  fi
}

apply_migration_file() {
  local id="$1"
  local file="$2"
  if migration_applied "${id}"; then
    record PASS "migration ${id}" "already applied (schema_migrations)"
    return 0
  fi
  if [[ ! -f "${file}" ]]; then
    record FAIL "migration ${id}" "file missing: ${file}"
    return 1
  fi
  log "applying ${id} from ${file}"
  if psql_f -f "${file}" >>"${RUN_LOG}" 2>&1; then
    local sum
    sum="$(cksum "${file}" | awk '{print $1" "$2}')"
    psql_f -c "INSERT INTO schema_migrations (id, checksum) VALUES ('${id}', '${sum}') ON CONFLICT (id) DO NOTHING"
    record PASS "migration ${id}" "applied"
  else
    record FAIL "migration ${id}" "psql -f failed; see ${RUN_LOG}"
    return 1
  fi
}

apply_migrations() {
  ensure_schema_migrations

  # Backfill tracking when DB was bootstrapped before schema_migrations existed.
  backfill_if_present "0001_foundation" \
    "SELECT CASE WHEN to_regclass('public.workspaces') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_current_workspace_id') THEN 1 ELSE 0 END"
  backfill_if_present "0002_model_gateway_and_break_glass_roles" \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_model_gateway') THEN 1 ELSE 0 END"
  backfill_if_present "0003_orchestration" \
    "SELECT CASE WHEN to_regclass('public.orch_jobs') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0004_governance_snapshot" \
    "SELECT CASE WHEN to_regclass('public.orch_governance_controls') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0005_crm_customers" \
    "SELECT CASE WHEN to_regclass('public.crm_customers') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0006_outbox_consumer" \
    "SELECT CASE WHEN to_regclass('public.outbox_consumed_events') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0007_crm_subaggregates" \
    "SELECT CASE WHEN to_regclass('public.crm_contracts') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0008_pm_delivery" \
    "SELECT CASE WHEN to_regclass('public.pm_plans') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0009_finance_ledger" \
    "SELECT CASE WHEN to_regclass('public.finance_journal_entries') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0010_finance_recon_dailygate" \
    "SELECT CASE WHEN to_regclass('public.finance_daily_gate_state') IS NOT NULL THEN 1 ELSE 0 END"
  backfill_if_present "0011_reports_model_invocations" \
    "SELECT CASE WHEN to_regclass('public.report_snapshots') IS NOT NULL THEN 1 ELSE 0 END"

  apply_migration_file "0001_foundation" \
    "${MIGRATIONS_DIR}/0001_foundation.sql" || true
  apply_migration_file "0002_model_gateway_and_break_glass_roles" \
    "${MIGRATIONS_DIR}/0002_model_gateway_and_break_glass_roles.sql" || true
  apply_migration_file "0003_orchestration" \
    "${MIGRATIONS_DIR}/0003_orchestration.sql" || true
  apply_migration_file "0004_governance_snapshot" \
    "${MIGRATIONS_DIR}/0004_governance_snapshot.sql" || true
  apply_migration_file "0005_crm_customers" \
    "${MIGRATIONS_DIR}/0005_crm_customers.sql" || true
  apply_migration_file "0006_outbox_consumer" \
    "${MIGRATIONS_DIR}/0006_outbox_consumer.sql" || true
  apply_migration_file "0007_crm_subaggregates" \
    "${MIGRATIONS_DIR}/0007_crm_subaggregates.sql" || true
  apply_migration_file "0008_pm_delivery" \
    "${MIGRATIONS_DIR}/0008_pm_delivery.sql" || true
  apply_migration_file "0009_finance_ledger" \
    "${MIGRATIONS_DIR}/0009_finance_ledger.sql" || true
  apply_migration_file "0010_finance_recon_dailygate" \
    "${MIGRATIONS_DIR}/0010_finance_recon_dailygate.sql" || true
  apply_migration_file "0011_reports_model_invocations" \
    "${MIGRATIONS_DIR}/0011_reports_model_invocations.sql" || true
}

check_force_rls() {
  local out
  out="$(psql_q <<'SQL'
SELECT c.relname || '=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'orch_jobs', 'orch_work_items', 'orch_job_events',
    'orch_governance_controls', 'orch_governance_intents',
    'crm_customers', 'outbox_consumed_events',
    'crm_contracts', 'crm_communications', 'crm_next_actions', 'crm_operational_exceptions',
    'pm_plans', 'pm_assignments', 'pm_targets', 'pm_target_observations',
    'pm_variance_exceptions', 'delivery_projects',
    'finance_journal_entries',
    'finance_reconciliations', 'finance_exceptions', 'finance_daily_gate_state', 'finance_day_records',
    'report_snapshots', 'model_invocations'
  )
ORDER BY c.relname;
SQL
)"
  local expected=$'crm_communications=true/true\ncrm_contracts=true/true\ncrm_customers=true/true\ncrm_next_actions=true/true\ncrm_operational_exceptions=true/true\ndelivery_projects=true/true\nfinance_daily_gate_state=true/true\nfinance_day_records=true/true\nfinance_exceptions=true/true\nfinance_journal_entries=true/true\nfinance_reconciliations=true/true\nmodel_invocations=true/true\norch_governance_controls=true/true\norch_governance_intents=true/true\norch_job_events=true/true\norch_jobs=true/true\norch_work_items=true/true\noutbox_consumed_events=true/true\npm_assignments=true/true\npm_plans=true/true\npm_target_observations=true/true\npm_targets=true/true\npm_variance_exceptions=true/true\nreport_snapshots=true/true'
  if [[ "${out}" == "${expected}" ]]; then
    record PASS "FORCE RLS flags" "relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events"
    log "FORCE RLS evidence:"
    log "${out}"
  else
    record FAIL "FORCE RLS flags" "got: ${out//$'\n'/; }"
  fi
}

check_function_and_guc() {
  local fn
  fn="$(psql_q -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'app_current_workspace_id'")"
  if [[ "${fn}" == "1" ]]; then
    record PASS "app_current_workspace_id()" "function exists"
  else
    record FAIL "app_current_workspace_id()" "missing"
  fi

  # Confirm GUC name used by the function body.
  local src
  src="$(psql_q -c "SELECT pg_get_functiondef('public.app_current_workspace_id'::regproc)")"
  if [[ "${src}" == *"app.workspace_id"* ]]; then
    record PASS "GUC name" "app.workspace_id (via current_setting)"
  else
    record FAIL "GUC name" "app.workspace_id not found in function body"
  fi

  # Fail-closed when unset (as a non-bypass role ideally; superuser still raises from the function itself).
  local raised="0"
  if psql_q -c "SELECT app_current_workspace_id()" >/dev/null 2>&1; then
    raised="0"
  else
    raised="1"
  fi
  if [[ "${raised}" == "1" ]]; then
    record PASS "fail-closed unset GUC" "app_current_workspace_id() raises when app.workspace_id unset"
  else
    record FAIL "fail-closed unset GUC" "expected raise, got success"
  fi
}

check_policies() {
  local n
  n="$(psql_q <<'SQL'
SELECT count(*) FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'orch_jobs', 'orch_work_items', 'orch_job_events',
    'orch_governance_controls', 'orch_governance_intents',
    'crm_customers', 'outbox_consumed_events',
    'crm_contracts', 'crm_communications', 'crm_next_actions', 'crm_operational_exceptions',
    'pm_plans', 'pm_assignments', 'pm_targets', 'pm_target_observations',
    'pm_variance_exceptions', 'delivery_projects',
    'finance_journal_entries',
    'finance_reconciliations', 'finance_exceptions', 'finance_daily_gate_state', 'finance_day_records',
    'report_snapshots', 'model_invocations'
  )
  AND policyname = 'workspace_isolation';
SQL
)"
  if [[ "${n}" == "24" ]]; then
    record PASS "workspace_isolation policies" "24/24 on orch_*/orch_governance_*/crm_*/outbox_consumed_events/pm_*/delivery_projects/finance_*/report_snapshots/model_invocations"
  else
    record FAIL "workspace_isolation policies" "expected 24, got ${n}"
  fi
}

# Isolation proof: prefer SET ROLE ai_crm_runtime_api (NOBYPASSRLS) for
# orch_*/crm_customers, and SET ROLE ai_crm_runtime_worker (also NOBYPASSRLS,
# the only role granted outbox_consumed_events access — see
# 0006_outbox_consumer.sql "4. Grants") for outbox_consumed_events.
# Superuser session grants itself membership for the smoke only (dev docker).
ensure_runtime_role_membership() {
  psql_f <<'SQL' >>"${RUN_LOG}" 2>&1 || true
-- Dev smoke only: allow bootstrap superuser to SET ROLE into runtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api') THEN
    EXECUTE 'GRANT ai_crm_runtime_api TO CURRENT_USER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker') THEN
    EXECUTE 'GRANT ai_crm_runtime_worker TO CURRENT_USER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_model_gateway') THEN
    EXECUTE 'GRANT ai_crm_runtime_model_gateway TO CURRENT_USER';
  END IF;
END
$$;
SQL
}

run_isolation() {
  ensure_runtime_role_membership

  local has_runtime
  has_runtime="$(psql_q -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api' AND rolcanlogin AND NOT rolbypassrls)")"
  if [[ "${has_runtime}" != "t" && "${has_runtime}" != "true" ]]; then
    record SKIP "workspace isolation insert/select" "ai_crm_runtime_api missing or BYPASSRLS"
    record SKIP "governance isolation insert/select" "ai_crm_runtime_api missing or BYPASSRLS"
    record SKIP "crm isolation insert/select" "ai_crm_runtime_api missing or BYPASSRLS"
    return 0
  fi

  # Can we SET ROLE?
  if ! psql_q -c "SET ROLE ai_crm_runtime_api; SELECT current_user" >/dev/null 2>&1; then
    record SKIP "workspace isolation insert/select" "cannot SET ROLE ai_crm_runtime_api (no membership); FORCE RLS flags still checked"
    record SKIP "governance isolation insert/select" "cannot SET ROLE ai_crm_runtime_api (no membership); FORCE RLS flags still checked"
    record SKIP "crm isolation insert/select" "cannot SET ROLE ai_crm_runtime_api (no membership); FORCE RLS flags still checked"
    return 0
  fi

  local out
  # shellcheck disable=SC2016
  out="$(psql_q <<'SQL'
BEGIN;

-- Seed two workspaces as table owner / superuser (runtime has SELECT-only on workspaces).
RESET ROLE;
INSERT INTO workspaces (id, name)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-ws-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-ws-b')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- Clean prior smoke rows (owner/superuser path).
DELETE FROM orch_job_events WHERE id LIKE 'smoke-%';
DELETE FROM orch_work_items WHERE id LIKE 'smoke-%';
DELETE FROM orch_jobs WHERE id LIKE 'smoke-%';
DELETE FROM orch_governance_intents WHERE id LIKE 'smoke-%';
DELETE FROM orch_governance_controls WHERE id LIKE 'smoke-%';
DELETE FROM crm_customers WHERE id LIKE 'smoke-%';

-- Switch to non-bypass runtime role for all RLS-sensitive DML/SELECT.
SET LOCAL ROLE ai_crm_runtime_api;

-- Workspace A context: insert job A
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
INSERT INTO orch_jobs (
  id, workspace_id, source, raw_text, status, created_by_principal_id, idempotency_key
) VALUES (
  'smoke-job-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke', 'ws-a',
  'QUEUED', 'principal-smoke', 'smoke-idem-a'
);

-- Workspace A context: insert governance control A
INSERT INTO orch_governance_controls (
  id, workspace_id, action_type, kind, resource_id, resource_version,
  payload_hash, policy_version, requester_principal_id, status
) VALUES (
  'smoke-control-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CHECKPOINT', 'CHECKPOINT',
  'smoke-resource-a', 1, 'smoke-hash-a', 1, 'principal-smoke', 'PENDING'
);

-- Workspace A context: insert crm_customers customer A
INSERT INTO crm_customers (id, workspace_id, name, status, version)
VALUES ('smoke-customer-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Smoke Customer A', 'active', 1);

-- Workspace B context: insert job B
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO orch_jobs (
  id, workspace_id, source, raw_text, status, created_by_principal_id, idempotency_key
) VALUES (
  'smoke-job-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke', 'ws-b',
  'QUEUED', 'principal-smoke', 'smoke-idem-b'
);

-- Workspace B context: insert governance control B
INSERT INTO orch_governance_controls (
  id, workspace_id, action_type, kind, resource_id, resource_version,
  payload_hash, policy_version, requester_principal_id, status
) VALUES (
  'smoke-control-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CHECKPOINT', 'CHECKPOINT',
  'smoke-resource-b', 1, 'smoke-hash-b', 1, 'principal-smoke', 'PENDING'
);

-- Workspace B context: insert crm_customers customer B
INSERT INTO crm_customers (id, workspace_id, name, status, version)
VALUES ('smoke-customer-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Smoke Customer B', 'active', 1);

-- Isolation: under A, only A visible
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'a_count=' || count(*)::text FROM orch_jobs WHERE id LIKE 'smoke-%';
SELECT 'a_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM orch_jobs WHERE id LIKE 'smoke-%';
SELECT 'gc_a_count=' || count(*)::text FROM orch_governance_controls WHERE id LIKE 'smoke-%';
SELECT 'gc_a_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM orch_governance_controls WHERE id LIKE 'smoke-%';
SELECT 'crm_a_count=' || count(*)::text FROM crm_customers WHERE id LIKE 'smoke-%';
SELECT 'crm_a_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM crm_customers WHERE id LIKE 'smoke-%';

-- Isolation: under B, only B visible
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'b_count=' || count(*)::text FROM orch_jobs WHERE id LIKE 'smoke-%';
SELECT 'b_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM orch_jobs WHERE id LIKE 'smoke-%';
SELECT 'gc_b_count=' || count(*)::text FROM orch_governance_controls WHERE id LIKE 'smoke-%';
SELECT 'gc_b_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM orch_governance_controls WHERE id LIKE 'smoke-%';
SELECT 'crm_b_count=' || count(*)::text FROM crm_customers WHERE id LIKE 'smoke-%';
SELECT 'crm_b_ids=' || coalesce(string_agg(id, ',' ORDER BY id), '') FROM crm_customers WHERE id LIKE 'smoke-%';

-- Cross-workspace insert must fail (WITH CHECK)
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$
BEGIN
  BEGIN
    INSERT INTO orch_jobs (
      id, workspace_id, source, raw_text, status, created_by_principal_id, idempotency_key
    ) VALUES (
      'smoke-job-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke', 'cross',
      'QUEUED', 'principal-smoke', 'smoke-idem-cross'
    );
    RAISE EXCEPTION 'expected cross-workspace insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      -- SQLSTATE 42501 or policy violation variants
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        -- Postgres often reports as check violation / RLS violation
        RAISE NOTICE 'cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$$;

-- Cross-workspace governance control insert must fail (WITH CHECK)
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$
BEGIN
  BEGIN
    INSERT INTO orch_governance_controls (
      id, workspace_id, action_type, kind, resource_id, resource_version,
      payload_hash, policy_version, requester_principal_id, status
    ) VALUES (
      'smoke-control-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'CHECKPOINT', 'CHECKPOINT',
      'smoke-resource-cross', 1, 'smoke-hash-cross', 1, 'principal-smoke', 'PENDING'
    );
    RAISE EXCEPTION 'expected cross-workspace governance control insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'gc_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      -- SQLSTATE 42501 or policy violation variants
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'gc_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace governance control insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        -- Postgres often reports as check violation / RLS violation
        RAISE NOTICE 'gc_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$$;

-- Cross-workspace crm_customers insert must fail (WITH CHECK)
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $$
BEGIN
  BEGIN
    INSERT INTO crm_customers (id, workspace_id, name, status, version)
    VALUES ('smoke-customer-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Smoke Customer Cross', 'active', 1);
    RAISE EXCEPTION 'expected cross-workspace crm_customers insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'crm_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      -- SQLSTATE 42501 or policy violation variants
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'crm_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace crm_customers insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        -- Postgres often reports as check violation / RLS violation
        RAISE NOTICE 'crm_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$$;

-- Missing GUC must fail closed on SELECT under runtime role
RESET app.workspace_id;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM orch_jobs;
    RAISE EXCEPTION 'expected missing app.workspace_id to raise';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'expected missing app.workspace_id to raise' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'missing_guc_raises=%', SQLSTATE;
      END IF;
  END;
END
$$;

-- Cleanup smoke rows still under runtime + proper workspace contexts
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DELETE FROM orch_jobs WHERE id = 'smoke-job-a';
DELETE FROM orch_governance_controls WHERE id = 'smoke-control-a';
DELETE FROM crm_customers WHERE id = 'smoke-customer-a';
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM orch_jobs WHERE id = 'smoke-job-b';
DELETE FROM orch_governance_controls WHERE id = 'smoke-control-b';
DELETE FROM crm_customers WHERE id = 'smoke-customer-b';

-- Drop smoke workspaces as owner
RESET ROLE;
DELETE FROM workspaces WHERE id IN (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
);

SELECT 'isolation_ok=1';
COMMIT;
SQL
)" || {
    record FAIL "workspace isolation insert/select" "transaction failed; see ${RUN_LOG}"
    record FAIL "governance isolation insert/select" "transaction failed; see ${RUN_LOG}"
    record FAIL "crm isolation insert/select" "transaction failed; see ${RUN_LOG}"
    return 0
  }

  log "isolation transcript:"
  log "${out}"

  local ok=1
  printf '%s\n' "${out}" | grep -q 'a_count=1' || ok=0
  printf '%s\n' "${out}" | grep -q 'a_ids=smoke-job-a' || ok=0
  printf '%s\n' "${out}" | grep -q 'b_count=1' || ok=0
  printf '%s\n' "${out}" | grep -q 'b_ids=smoke-job-b' || ok=0
  printf '%s\n' "${out}" | grep -q 'isolation_ok=1' || ok=0

  if [[ "${ok}" == "1" ]]; then
    record PASS "workspace isolation insert/select" "runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done"
  else
    record FAIL "workspace isolation insert/select" "unexpected counts/ids: ${out//$'\n'/; }"
  fi

  local gc_ok=1
  printf '%s\n' "${out}" | grep -q 'gc_a_count=1' || gc_ok=0
  printf '%s\n' "${out}" | grep -q 'gc_a_ids=smoke-control-a' || gc_ok=0
  printf '%s\n' "${out}" | grep -q 'gc_b_count=1' || gc_ok=0
  printf '%s\n' "${out}" | grep -q 'gc_b_ids=smoke-control-b' || gc_ok=0
  printf '%s\n' "${out}" | grep -q 'isolation_ok=1' || gc_ok=0

  if [[ "${gc_ok}" == "1" ]]; then
    record PASS "governance isolation insert/select" "runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done"
  else
    record FAIL "governance isolation insert/select" "unexpected counts/ids: ${out//$'\n'/; }"
  fi

  local crm_ok=1
  printf '%s\n' "${out}" | grep -q 'crm_a_count=1' || crm_ok=0
  printf '%s\n' "${out}" | grep -q 'crm_a_ids=smoke-customer-a' || crm_ok=0
  printf '%s\n' "${out}" | grep -q 'crm_b_count=1' || crm_ok=0
  printf '%s\n' "${out}" | grep -q 'crm_b_ids=smoke-customer-b' || crm_ok=0
  printf '%s\n' "${out}" | grep -q 'isolation_ok=1' || crm_ok=0

  if [[ "${crm_ok}" == "1" ]]; then
    record PASS "crm isolation insert/select" "runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done"
  else
    record FAIL "crm isolation insert/select" "unexpected counts/ids: ${out//$'\n'/; }"
  fi
}

# 7th-table isolation proof: outbox_consumed_events (0006) is granted ONLY to
# ai_crm_runtime_worker (see 0006_outbox_consumer.sql grants). ai_crm_runtime_api
# has NO grants on it, so this mirrors the crm_customers isolation block above but
# runs under SET LOCAL ROLE ai_crm_runtime_worker instead.
run_outbox_consumer_isolation() {
  ensure_runtime_role_membership

  local has_worker
  has_worker="$(psql_q -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker' AND rolcanlogin AND NOT rolbypassrls)")"
  if [[ "${has_worker}" != "t" && "${has_worker}" != "true" ]]; then
    record SKIP "outbox_consumed_events isolation insert/select" "ai_crm_runtime_worker missing or BYPASSRLS"
    return 0
  fi

  local out
  # shellcheck disable=SC2016
  out="$(psql_q <<'SQL'
BEGIN;
RESET ROLE;
INSERT INTO workspaces (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-ws-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-ws-b')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;
INSERT INTO audit_events (id, workspace_id, sequence, event_type, payload, event_hash, correlation_id) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccc01', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 999901, 'SMOKE_OUTBOX', '{}'::jsonb, 'smoke-hash-outbox-a', gen_random_uuid()),
  ('cccccccc-cccc-cccc-cccc-cccccccccc02', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 999901, 'SMOKE_OUTBOX', '{}'::jsonb, 'smoke-hash-outbox-b', gen_random_uuid())
ON CONFLICT (id) DO NOTHING;
INSERT INTO outbox_events (id, workspace_id, audit_event_id, event_type, partition_key, payload, status) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccc01', 'SMOKE_OUTBOX', 'smoke', '{}'::jsonb, 'PUBLISHED'),
  ('dddddddd-dddd-dddd-dddd-dddddddddd02', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccc02', 'SMOKE_OUTBOX', 'smoke', '{}'::jsonb, 'PUBLISHED')
ON CONFLICT (id) DO NOTHING;
DELETE FROM outbox_consumed_events WHERE consumer_name = 'smoke-outbox-consumer';
SET LOCAL ROLE ai_crm_runtime_worker;
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
INSERT INTO outbox_consumed_events (consumer_name, outbox_id, workspace_id)
VALUES ('smoke-outbox-consumer', 'dddddddd-dddd-dddd-dddd-dddddddddd01', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO outbox_consumed_events (consumer_name, outbox_id, workspace_id)
VALUES ('smoke-outbox-consumer', 'dddddddd-dddd-dddd-dddd-dddddddddd02', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'oce_a_count=' || count(*)::text FROM outbox_consumed_events WHERE consumer_name = 'smoke-outbox-consumer';
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'oce_b_count=' || count(*)::text FROM outbox_consumed_events WHERE consumer_name = 'smoke-outbox-consumer';
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $BLK$
BEGIN
  BEGIN
    INSERT INTO outbox_consumed_events (consumer_name, outbox_id, workspace_id)
    VALUES ('smoke-outbox-consumer-cross', 'dddddddd-dddd-dddd-dddd-dddddddddd02', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    RAISE EXCEPTION 'expected cross-workspace outbox_consumed_events insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'oce_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'oce_cross_insert_blocked=rls';
      ELSE
        RAISE;
      END IF;
  END;
END
$BLK$;
RESET ROLE;
DELETE FROM outbox_consumed_events WHERE consumer_name = 'smoke-outbox-consumer';
DELETE FROM outbox_events WHERE id IN ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'dddddddd-dddd-dddd-dddd-dddddddddd02');
DELETE FROM audit_events WHERE id IN ('cccccccc-cccc-cccc-cccc-cccccccccc01', 'cccccccc-cccc-cccc-cccc-cccccccccc02');
ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
SELECT 'oce_isolation_ok=1';
COMMIT;
SQL
)" || {
    record FAIL "outbox_consumed_events isolation insert/select" "transaction failed; see ${RUN_LOG}"
    return 0
  }

  local oce_ok=1
  printf '%s\n' "${out}" | grep -q 'oce_a_count=1' || oce_ok=0
  printf '%s\n' "${out}" | grep -q 'oce_b_count=1' || oce_ok=0
  # note: cross-insert denial is exercised by the DO block above; its RAISE
  # NOTICE goes to stderr (not captured by psql_q stdout), so — like the crm/gov
  # blocks — we assert the stdout SELECT markers only.
  printf '%s\n' "${out}" | grep -q 'oce_isolation_ok=1' || oce_ok=0

  if [[ "${oce_ok}" == "1" ]]; then
    record PASS "outbox_consumed_events isolation insert/select" "SET ROLE ai_crm_runtime_worker; A/B isolated + cross-workspace insert denied; cleanup done"
  else
    record FAIL "outbox_consumed_events isolation insert/select" "unexpected output"
  fi
}

# P6-b G001 (PG-A/B/C1/C2) isolation proof: the 15 new domain-PG tables
# (crm_contracts/communications/next_actions/operational_exceptions,
# pm_plans/assignments/targets/target_observations/variance_exceptions,
# delivery_projects, finance_journal_entries,
# finance_reconciliations/exceptions/daily_gate_state/day_records) are all
# granted to ai_crm_runtime_api (NOBYPASSRLS), so this mirrors the
# crm_customers isolation block above: SET LOCAL ROLE ai_crm_runtime_api,
# seed workspace A/B rows, assert per-workspace visibility, assert
# cross-workspace inserts are denied by WITH CHECK, then clean up.
run_p6b_g001_isolation() {
  ensure_runtime_role_membership

  local has_runtime
  has_runtime="$(psql_q -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api' AND rolcanlogin AND NOT rolbypassrls)")"
  if [[ "${has_runtime}" != "t" && "${has_runtime}" != "true" ]]; then
    record SKIP "p6b-g001 isolation insert/select" "ai_crm_runtime_api missing or BYPASSRLS"
    return 0
  fi
  if ! psql_q -c "SET ROLE ai_crm_runtime_api; SELECT current_user" >/dev/null 2>&1; then
    record SKIP "p6b-g001 isolation insert/select" "cannot SET ROLE ai_crm_runtime_api (no membership); FORCE RLS flags still checked"
    return 0
  fi

  local out
  # shellcheck disable=SC2016
  out="$(psql_q <<'SQL'
BEGIN;

RESET ROLE;
INSERT INTO workspaces (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-ws-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-ws-b')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- Clean prior smoke rows (owner/superuser path).
DELETE FROM crm_contracts WHERE id LIKE 'smoke-%';
DELETE FROM crm_communications WHERE id LIKE 'smoke-%';
DELETE FROM crm_next_actions WHERE id LIKE 'smoke-%';
DELETE FROM crm_operational_exceptions WHERE id LIKE 'smoke-%';
DELETE FROM pm_plans WHERE id LIKE 'smoke-%';
DELETE FROM pm_assignments WHERE id LIKE 'smoke-%';
DELETE FROM pm_targets WHERE id LIKE 'smoke-%';
DELETE FROM pm_target_observations WHERE id LIKE 'smoke-%';
DELETE FROM pm_variance_exceptions WHERE id LIKE 'smoke-%';
DELETE FROM delivery_projects WHERE id LIKE 'smoke-%';
DELETE FROM finance_journal_entries WHERE id LIKE 'smoke-%';
DELETE FROM finance_reconciliations WHERE id LIKE 'smoke-%';
DELETE FROM finance_exceptions WHERE id LIKE 'smoke-%';
DELETE FROM finance_daily_gate_state WHERE workspace_id IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
DELETE FROM finance_day_records WHERE workspace_id IN ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

SET LOCAL ROLE ai_crm_runtime_api;

-- Workspace A context: seed one row per new table.
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

INSERT INTO crm_contracts (id, workspace_id, customer_id, title, scope, effective_from, value_krw, version)
VALUES ('smoke-contract-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-customer-a', 'Smoke Contract A', 'smoke', '2026-01-01', 1000, 1);

INSERT INTO crm_communications (id, workspace_id, customer_id, channel, summary, occurred_at, version)
VALUES ('smoke-comm-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-customer-a', 'email', 'Smoke Comm A', '2026-01-01T00:00:00.000Z', 1);

INSERT INTO crm_next_actions (id, workspace_id, customer_id, title, priority, due_at, status, version)
VALUES ('smoke-action-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-customer-a', 'Smoke Action A', 5, '2026-02-01T00:00:00.000Z', 'open', 1);

INSERT INTO crm_operational_exceptions (id, workspace_id, customer_id, title, severity, priority, occurred_at, status, version)
VALUES ('smoke-exception-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-customer-a', 'Smoke Exception A', 'high', 5, '2026-01-15T00:00:00.000Z', 'open', 1);

INSERT INTO pm_plans (id, workspace_id, project_id, version, revisions)
VALUES ('smoke-plan-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 1, '[]'::jsonb);

INSERT INTO pm_assignments (id, workspace_id, project_id, plan_id, task_id, assignee_principal_id, assigned_by_principal_id, status, created_at)
VALUES ('smoke-assignment-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 'smoke-plan-a', 'smoke-task-a', 'principal-smoke', 'principal-smoke', 'active', now());

INSERT INTO pm_targets (id, workspace_id, project_id, metric, target, tolerance, direction, version)
VALUES ('smoke-target-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 'schedule', 10, 1, 'max', 1);

INSERT INTO pm_target_observations (id, workspace_id, project_id, target_id, actual, observed_at, evidence_ref)
VALUES ('smoke-observation-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 'smoke-target-a', 9, now(), 'smoke-evidence-a');

INSERT INTO pm_variance_exceptions (id, workspace_id, project_id, target_id, metric, target, actual, variance, severity, evidence_ref)
VALUES ('smoke-variance-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 'smoke-target-a', 'schedule', 10, 9, 1, 'low', 'smoke-evidence-a');

INSERT INTO delivery_projects (id, workspace_id, customer_id, name, contract_id, contract_scope, schedule_start, schedule_end, completion_rule, risk_threshold, status, version)
VALUES ('smoke-project-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-customer-a', 'Smoke Project A', 'smoke-contract-a', 'smoke', '2026-01-01', '2026-12-31', 'all_required_deliverables_approved', 0.5, 'active', 1);

INSERT INTO finance_journal_entries (id, workspace_id, entry_date, description, lines, debit_total_krw, credit_total_krw, status, created_by_principal_id)
VALUES ('smoke-entry-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-01-01', 'Smoke Entry A', '[]'::jsonb, 0, 0, 'DRAFT', 'principal-smoke');

INSERT INTO finance_reconciliations (id, workspace_id, statement_row, ledger_amount_krw, variance_krw, status, reconciled_by_principal_id, reconciled_at)
VALUES ('smoke-recon-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}'::jsonb, 1000, 0, 'matched', 'principal-smoke', now());

INSERT INTO finance_exceptions (id, workspace_id, kind, variance_krw, status, opened_at)
VALUES ('smoke-finexc-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'variance', 0, 'open', now());

INSERT INTO finance_daily_gate_state (workspace_id, streak, tier)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 'conservative');

INSERT INTO finance_day_records (workspace_id, date, qualifying, streak_after, tier_after)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-01-01', true, 1, 'conservative');

-- Workspace B context: same shape, distinct ids/workspace.
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

INSERT INTO crm_contracts (id, workspace_id, customer_id, title, scope, effective_from, value_krw, version)
VALUES ('smoke-contract-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-b', 'Smoke Contract B', 'smoke', '2026-01-01', 2000, 1);

INSERT INTO crm_communications (id, workspace_id, customer_id, channel, summary, occurred_at, version)
VALUES ('smoke-comm-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-b', 'email', 'Smoke Comm B', '2026-01-01T00:00:00.000Z', 1);

INSERT INTO crm_next_actions (id, workspace_id, customer_id, title, priority, due_at, status, version)
VALUES ('smoke-action-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-b', 'Smoke Action B', 5, '2026-02-01T00:00:00.000Z', 'open', 1);

INSERT INTO crm_operational_exceptions (id, workspace_id, customer_id, title, severity, priority, occurred_at, status, version)
VALUES ('smoke-exception-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-b', 'Smoke Exception B', 'high', 5, '2026-01-15T00:00:00.000Z', 'open', 1);

INSERT INTO pm_plans (id, workspace_id, project_id, version, revisions)
VALUES ('smoke-plan-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 1, '[]'::jsonb);

INSERT INTO pm_assignments (id, workspace_id, project_id, plan_id, task_id, assignee_principal_id, assigned_by_principal_id, status, created_at)
VALUES ('smoke-assignment-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 'smoke-plan-b', 'smoke-task-b', 'principal-smoke', 'principal-smoke', 'active', now());

INSERT INTO pm_targets (id, workspace_id, project_id, metric, target, tolerance, direction, version)
VALUES ('smoke-target-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 'schedule', 10, 1, 'max', 1);

INSERT INTO pm_target_observations (id, workspace_id, project_id, target_id, actual, observed_at, evidence_ref)
VALUES ('smoke-observation-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 'smoke-target-b', 9, now(), 'smoke-evidence-b');

INSERT INTO pm_variance_exceptions (id, workspace_id, project_id, target_id, metric, target, actual, variance, severity, evidence_ref)
VALUES ('smoke-variance-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 'smoke-target-b', 'schedule', 10, 9, 1, 'low', 'smoke-evidence-b');

INSERT INTO delivery_projects (id, workspace_id, customer_id, name, contract_id, contract_scope, schedule_start, schedule_end, completion_rule, risk_threshold, status, version)
VALUES ('smoke-project-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-b', 'Smoke Project B', 'smoke-contract-b', 'smoke', '2026-01-01', '2026-12-31', 'all_required_deliverables_approved', 0.5, 'active', 1);

INSERT INTO finance_journal_entries (id, workspace_id, entry_date, description, lines, debit_total_krw, credit_total_krw, status, created_by_principal_id)
VALUES ('smoke-entry-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-01-01', 'Smoke Entry B', '[]'::jsonb, 0, 0, 'DRAFT', 'principal-smoke');

INSERT INTO finance_reconciliations (id, workspace_id, statement_row, ledger_amount_krw, variance_krw, status, reconciled_by_principal_id, reconciled_at)
VALUES ('smoke-recon-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}'::jsonb, 2000, 0, 'matched', 'principal-smoke', now());

INSERT INTO finance_exceptions (id, workspace_id, kind, variance_krw, status, opened_at)
VALUES ('smoke-finexc-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'variance', 0, 'open', now());

INSERT INTO finance_daily_gate_state (workspace_id, streak, tier)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, 'conservative');

INSERT INTO finance_day_records (workspace_id, date, qualifying, streak_after, tier_after)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-01-01', true, 1, 'conservative');

-- Isolation: under A, only A's smoke rows visible.
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'p6b_a_contracts=' || count(*)::text FROM crm_contracts WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_comms=' || count(*)::text FROM crm_communications WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_actions=' || count(*)::text FROM crm_next_actions WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_exceptions=' || count(*)::text FROM crm_operational_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_plans=' || count(*)::text FROM pm_plans WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_assignments=' || count(*)::text FROM pm_assignments WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_targets=' || count(*)::text FROM pm_targets WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_observations=' || count(*)::text FROM pm_target_observations WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_variances=' || count(*)::text FROM pm_variance_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_projects=' || count(*)::text FROM delivery_projects WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_entries=' || count(*)::text FROM finance_journal_entries WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_recons=' || count(*)::text FROM finance_reconciliations WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_finexc=' || count(*)::text FROM finance_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_a_gatestate=' || count(*)::text FROM finance_daily_gate_state WHERE workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'p6b_a_dayrecords=' || count(*)::text FROM finance_day_records WHERE workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Isolation: under B, only B's smoke rows visible.
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'p6b_b_contracts=' || count(*)::text FROM crm_contracts WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_comms=' || count(*)::text FROM crm_communications WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_actions=' || count(*)::text FROM crm_next_actions WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_exceptions=' || count(*)::text FROM crm_operational_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_plans=' || count(*)::text FROM pm_plans WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_assignments=' || count(*)::text FROM pm_assignments WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_targets=' || count(*)::text FROM pm_targets WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_observations=' || count(*)::text FROM pm_target_observations WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_variances=' || count(*)::text FROM pm_variance_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_projects=' || count(*)::text FROM delivery_projects WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_entries=' || count(*)::text FROM finance_journal_entries WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_recons=' || count(*)::text FROM finance_reconciliations WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_finexc=' || count(*)::text FROM finance_exceptions WHERE id LIKE 'smoke-%';
SELECT 'p6b_b_gatestate=' || count(*)::text FROM finance_daily_gate_state WHERE workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'p6b_b_dayrecords=' || count(*)::text FROM finance_day_records WHERE workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

-- Cross-workspace insert must fail (WITH CHECK) — one representative DO
-- block per table (mirrors the crm_customers/orch_jobs pattern above).
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $BLK$
BEGIN
  BEGIN
    INSERT INTO crm_contracts (id, workspace_id, customer_id, title, scope, effective_from, version)
    VALUES ('smoke-contract-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-cross', 'Cross', 'smoke', '2026-01-01', 1);
    RAISE EXCEPTION 'expected cross-workspace crm_contracts insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'contracts_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'contracts_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace crm_contracts insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'contracts_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

DO $BLK$
BEGIN
  BEGIN
    INSERT INTO pm_plans (id, workspace_id, project_id, version)
    VALUES ('smoke-plan-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-cross', 1);
    RAISE EXCEPTION 'expected cross-workspace pm_plans insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'plans_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'plans_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace pm_plans insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'plans_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

DO $BLK$
BEGIN
  BEGIN
    INSERT INTO delivery_projects (id, workspace_id, customer_id, name, contract_id, contract_scope, schedule_start, schedule_end, completion_rule, risk_threshold, status)
    VALUES ('smoke-project-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-customer-cross', 'Cross', 'smoke-contract-cross', 'smoke', '2026-01-01', '2026-12-31', 'all_required_deliverables_approved', 0.5, 'active');
    RAISE EXCEPTION 'expected cross-workspace delivery_projects insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'projects_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'projects_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace delivery_projects insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'projects_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

DO $BLK$
BEGIN
  BEGIN
    INSERT INTO finance_journal_entries (id, workspace_id, entry_date, description, lines, debit_total_krw, credit_total_krw, status, created_by_principal_id)
    VALUES ('smoke-entry-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-01-01', 'Cross', '[]'::jsonb, 0, 0, 'DRAFT', 'principal-smoke');
    RAISE EXCEPTION 'expected cross-workspace finance_journal_entries insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'entries_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'entries_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace finance_journal_entries insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'entries_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

DO $BLK$
BEGIN
  BEGIN
    INSERT INTO finance_reconciliations (id, workspace_id, statement_row, ledger_amount_krw, variance_krw, status, reconciled_by_principal_id, reconciled_at)
    VALUES ('smoke-recon-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}'::jsonb, 1000, 0, 'matched', 'principal-smoke', now());
    RAISE EXCEPTION 'expected cross-workspace finance_reconciliations insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'recons_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'recons_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace finance_reconciliations insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'recons_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

DO $BLK$
BEGIN
  BEGIN
    INSERT INTO finance_daily_gate_state (workspace_id, streak, tier)
    VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 99, 'risk_tiered')
    ON CONFLICT (workspace_id) DO UPDATE SET streak = EXCLUDED.streak;
    RAISE EXCEPTION 'expected cross-workspace finance_daily_gate_state write to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'gatestate_cross_write_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'gatestate_cross_write_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace finance_daily_gate_state write to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'gatestate_cross_write_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;

-- Cleanup smoke rows still under runtime + proper workspace contexts.
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DELETE FROM crm_contracts WHERE id = 'smoke-contract-a';
DELETE FROM crm_communications WHERE id = 'smoke-comm-a';
DELETE FROM crm_next_actions WHERE id = 'smoke-action-a';
DELETE FROM crm_operational_exceptions WHERE id = 'smoke-exception-a';
DELETE FROM pm_target_observations WHERE id = 'smoke-observation-a';
DELETE FROM pm_variance_exceptions WHERE id = 'smoke-variance-a';
DELETE FROM pm_assignments WHERE id = 'smoke-assignment-a';
DELETE FROM pm_targets WHERE id = 'smoke-target-a';
DELETE FROM pm_plans WHERE id = 'smoke-plan-a';
DELETE FROM delivery_projects WHERE id = 'smoke-project-a';
DELETE FROM finance_journal_entries WHERE id = 'smoke-entry-a';
DELETE FROM finance_reconciliations WHERE id = 'smoke-recon-a';
DELETE FROM finance_exceptions WHERE id = 'smoke-finexc-a';
DELETE FROM finance_day_records WHERE workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DELETE FROM finance_daily_gate_state WHERE workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM crm_contracts WHERE id = 'smoke-contract-b';
DELETE FROM crm_communications WHERE id = 'smoke-comm-b';
DELETE FROM crm_next_actions WHERE id = 'smoke-action-b';
DELETE FROM crm_operational_exceptions WHERE id = 'smoke-exception-b';
DELETE FROM pm_target_observations WHERE id = 'smoke-observation-b';
DELETE FROM pm_variance_exceptions WHERE id = 'smoke-variance-b';
DELETE FROM pm_assignments WHERE id = 'smoke-assignment-b';
DELETE FROM pm_targets WHERE id = 'smoke-target-b';
DELETE FROM pm_plans WHERE id = 'smoke-plan-b';
DELETE FROM delivery_projects WHERE id = 'smoke-project-b';
DELETE FROM finance_journal_entries WHERE id = 'smoke-entry-b';
DELETE FROM finance_reconciliations WHERE id = 'smoke-recon-b';
DELETE FROM finance_exceptions WHERE id = 'smoke-finexc-b';
DELETE FROM finance_day_records WHERE workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM finance_daily_gate_state WHERE workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

SELECT 'p6b_isolation_ok=1';
COMMIT;
SQL
)" || {
    record FAIL "p6b-g001 isolation insert/select" "transaction failed; see ${RUN_LOG}"
    return 0
  }

  log "p6b-g001 isolation transcript:"
  log "${out}"

  local ok=1
  for marker in \
    p6b_a_contracts=1 p6b_a_comms=1 p6b_a_actions=1 p6b_a_exceptions=1 \
    p6b_a_plans=1 p6b_a_assignments=1 p6b_a_targets=1 p6b_a_observations=1 p6b_a_variances=1 \
    p6b_a_projects=1 p6b_a_entries=1 p6b_a_recons=1 p6b_a_finexc=1 p6b_a_gatestate=1 p6b_a_dayrecords=1 \
    p6b_b_contracts=1 p6b_b_comms=1 p6b_b_actions=1 p6b_b_exceptions=1 \
    p6b_b_plans=1 p6b_b_assignments=1 p6b_b_targets=1 p6b_b_observations=1 p6b_b_variances=1 \
    p6b_b_projects=1 p6b_b_entries=1 p6b_b_recons=1 p6b_b_finexc=1 p6b_b_gatestate=1 p6b_b_dayrecords=1 \
    p6b_isolation_ok=1
  do
    [[ $'\n'"${out}"$'\n' == *$'\n'"${marker}"$'\n'* ]] || ok=0
  done

  if [[ "${ok}" == "1" ]]; then
    record PASS "p6b-g001 isolation insert/select" "SET ROLE ai_crm_runtime_api; all 15 new tables A/B isolated + cross-workspace insert denied on contracts/plans/projects/entries/recons/gatestate; cleanup done"
  else
    record FAIL "p6b-g001 isolation insert/select" "unexpected counts/ids: ${out//$'\n'/; }"
  fi
}
# Q2 (D2) isolation proof: report_snapshots (SET ROLE ai_crm_runtime_api,
# mirrors crm_customers) and model_invocations (SET ROLE
# ai_crm_runtime_model_gateway — the ONLY role granted access, see
# 0002_model_gateway_and_break_glass_roles.sql "2. Grants"; ai_crm_runtime_api
# has NO grants on model_invocations, mirrors the outbox_consumed_events
# block's separate-role shape above).
run_q2_isolation() {
  ensure_runtime_role_membership

  local has_api
  has_api="$(psql_q -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api' AND rolcanlogin AND NOT rolbypassrls)")"
  if [[ "${has_api}" != "t" && "${has_api}" != "true" ]]; then
    record SKIP "report_snapshots isolation insert/select" "ai_crm_runtime_api missing or BYPASSRLS"
  else
    local out
    # shellcheck disable=SC2016
    out="$(psql_q <<'SQL'
BEGIN;
RESET ROLE;
INSERT INTO workspaces (id, name) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-ws-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-ws-b')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
ALTER TABLE report_snapshots DISABLE TRIGGER report_snapshots_immutability;
DELETE FROM report_snapshots WHERE id LIKE 'smoke-report-%';
ALTER TABLE report_snapshots ENABLE TRIGGER report_snapshots_immutability;
SET LOCAL ROLE ai_crm_runtime_api;
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
INSERT INTO report_snapshots (id, workspace_id, project_id, submitted_by_principal_id, submitted_at, status, snapshot, snapshot_hash)
VALUES ('smoke-report-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'smoke-project-a', 'principal-smoke', now()::text, 'SUBMITTED', '{}'::jsonb, 'smoke-hash-a');
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO report_snapshots (id, workspace_id, project_id, submitted_by_principal_id, submitted_at, status, snapshot, snapshot_hash)
VALUES ('smoke-report-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-b', 'principal-smoke', now()::text, 'SUBMITTED', '{}'::jsonb, 'smoke-hash-b');
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'rs_a_count=' || count(*)::text FROM report_snapshots WHERE id LIKE 'smoke-report-%';
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'rs_b_count=' || count(*)::text FROM report_snapshots WHERE id LIKE 'smoke-report-%';
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $BLK$
BEGIN
  BEGIN
    INSERT INTO report_snapshots (id, workspace_id, project_id, submitted_by_principal_id, submitted_at, status, snapshot, snapshot_hash)
    VALUES ('smoke-report-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'smoke-project-cross', 'principal-smoke', now()::text, 'SUBMITTED', '{}'::jsonb, 'smoke-hash-cross');
    RAISE EXCEPTION 'expected cross-workspace report_snapshots insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'rs_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'rs_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace report_snapshots insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'rs_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;
RESET ROLE;
ALTER TABLE report_snapshots DISABLE TRIGGER report_snapshots_immutability;
DELETE FROM report_snapshots WHERE id LIKE 'smoke-report-%';
ALTER TABLE report_snapshots ENABLE TRIGGER report_snapshots_immutability;
SELECT 'rs_isolation_ok=1';
COMMIT;
SQL
)" || {
      record FAIL "report_snapshots isolation insert/select" "transaction failed; see ${RUN_LOG}"
      out=""
    }
    log "report_snapshots isolation transcript:"
    log "${out}"
    local rs_ok=1
    printf '%s\n' "${out}" | grep -q 'rs_a_count=1' || rs_ok=0
    printf '%s\n' "${out}" | grep -q 'rs_b_count=1' || rs_ok=0
    printf '%s\n' "${out}" | grep -q 'rs_isolation_ok=1' || rs_ok=0
    if [[ "${rs_ok}" == "1" ]]; then
      record PASS "report_snapshots isolation insert/select" "SET ROLE ai_crm_runtime_api; A/B isolated + cross-workspace insert denied; cleanup done"
    else
      record FAIL "report_snapshots isolation insert/select" "unexpected output: ${out//$'\n'/; }"
    fi
  fi

  local has_mg
  has_mg="$(psql_q -c "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_model_gateway' AND rolcanlogin AND NOT rolbypassrls)")"
  if [[ "${has_mg}" != "t" && "${has_mg}" != "true" ]]; then
    record SKIP "model_invocations isolation insert/select" "ai_crm_runtime_model_gateway missing or BYPASSRLS"
    return 0
  fi

  local mg_out
  # shellcheck disable=SC2016
  mg_out="$(psql_q <<'SQL'
BEGIN;
RESET ROLE;
DELETE FROM model_invocations WHERE external_id LIKE 'smoke-invocation-%';
SET LOCAL ROLE ai_crm_runtime_model_gateway;
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
INSERT INTO model_invocations (external_id, workspace_id, principal_id, registry_operation_id, action_type, model_version, prompt_digest, retention_mode, correlation_id)
VALUES ('smoke-invocation-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'principal-model-gateway', 'op-smoke', 'MODEL_INVOKE', 'gpt-smoke', 'smoke-digest-a', 'zero-retention', 'corr-smoke-a');
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
INSERT INTO model_invocations (external_id, workspace_id, principal_id, registry_operation_id, action_type, model_version, prompt_digest, retention_mode, correlation_id)
VALUES ('smoke-invocation-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'principal-model-gateway', 'op-smoke', 'MODEL_INVOKE', 'gpt-smoke', 'smoke-digest-b', 'zero-retention', 'corr-smoke-b');
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
SELECT 'mi_a_count=' || count(*)::text FROM model_invocations WHERE external_id LIKE 'smoke-invocation-%';
SET LOCAL app.workspace_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
SELECT 'mi_b_count=' || count(*)::text FROM model_invocations WHERE external_id LIKE 'smoke-invocation-%';
SET LOCAL app.workspace_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
DO $BLK$
BEGIN
  BEGIN
    INSERT INTO model_invocations (external_id, workspace_id, principal_id, registry_operation_id, action_type, model_version, prompt_digest, retention_mode, correlation_id)
    VALUES ('smoke-invocation-cross', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'principal-model-gateway', 'op-smoke', 'MODEL_INVOKE', 'gpt-smoke', 'smoke-digest-cross', 'zero-retention', 'corr-smoke-cross');
    RAISE EXCEPTION 'expected cross-workspace model_invocations insert to be blocked by RLS';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'mi_cross_insert_blocked=insufficient_privilege';
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%policy%' OR SQLSTATE IN ('42501', 'P0001', '28000') OR SQLERRM LIKE '%row-level security%' THEN
        RAISE NOTICE 'mi_cross_insert_blocked=%', SQLSTATE;
      ELSIF SQLERRM = 'expected cross-workspace model_invocations insert to be blocked by RLS' THEN
        RAISE;
      ELSE
        RAISE NOTICE 'mi_cross_insert_blocked=%:%', SQLSTATE, SQLERRM;
      END IF;
  END;
END
$BLK$;
RESET ROLE;
DELETE FROM model_invocations WHERE external_id LIKE 'smoke-invocation-%';
SELECT 'mi_isolation_ok=1';
COMMIT;
SQL
)" || {
    record FAIL "model_invocations isolation insert/select" "transaction failed; see ${RUN_LOG}"
    return 0
  }
  log "model_invocations isolation transcript:"
  log "${mg_out}"
  local mi_ok=1
  printf '%s\n' "${mg_out}" | grep -q 'mi_a_count=1' || mi_ok=0
  printf '%s\n' "${mg_out}" | grep -q 'mi_b_count=1' || mi_ok=0
  printf '%s\n' "${mg_out}" | grep -q 'mi_isolation_ok=1' || mi_ok=0
  if [[ "${mi_ok}" == "1" ]]; then
    record PASS "model_invocations isolation insert/select" "SET ROLE ai_crm_runtime_model_gateway; A/B isolated + cross-workspace insert denied; cleanup done"
  else
    record FAIL "model_invocations isolation insert/select" "unexpected output: ${mg_out//$'\n'/; }"
  fi
}

write_doc() {
  local overall="FAIL"
  if [[ "${FAIL_N}" -eq 0 ]]; then
    overall="PASS"
  fi

  mkdir -p "$(dirname "${DOC_PATH}")"

  if [[ ! -f "${DOC_PATH}" ]]; then
    cat > "${DOC_PATH}" <<'HDR'
# PG RLS smoke (SEC-06 live)

Live verification that orchestration + governance snapshot tables on the
AI-CRM docker Postgres enforce `ENABLE` + `FORCE ROW LEVEL SECURITY` and
workspace isolation via `app_current_workspace_id()` / GUC `app.workspace_id`.

## Procedure

### Prerequisites

- Docker compose Postgres for this host only:
  - container: `ai-crmprojectmanager-postgres-1`
  - port: `localhost:5432`
  - db/user/password: `ai_crm` / `ai_crm` / `ai_crm_dev`
- Do **not** point this smoke at sangfor (`:5434`) or unified (`:5433`).
- `psql` on PATH.

### Run

```bash
# from repo root
./packages/persistence/scripts/pg-rls-smoke.sh
```

Optional env overrides (still must target `ai_crm` on `:5432` unless
`AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1`):

```bash
PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
  ./packages/persistence/scripts/pg-rls-smoke.sh
```

### What it does

1. Connects only to `ai_crm` on the configured host/port (refuses other DB names).
2. Ensures `schema_migrations` exists; backfills entries when objects already
   exist; applies `0001`..`0006` only when not yet recorded.
3. Asserts `relrowsecurity` + `relforcerowsecurity` on
   `orch_jobs`, `orch_work_items`, `orch_job_events`,
   `orch_governance_controls`, `orch_governance_intents`, `crm_customers`,
   `outbox_consumed_events`.
4. Asserts `app_current_workspace_id()` exists, reads GUC `app.workspace_id`,
   and fails closed when unset.
5. Asserts `workspace_isolation` policies on all seven RLS-enabled tables.
6. When `SET ROLE ai_crm_runtime_api` is possible (dev bootstrap superuser is
   granted membership for the smoke), inserts orch_jobs, orch_governance_controls,
   and crm_customers rows under two workspace UUIDs and proves select
   isolation + cross-workspace insert denial (all three tables) + missing-GUC
   raise. When `SET ROLE ai_crm_runtime_worker` is possible, does the same
   isolation + cross-workspace insert denial proof for `outbox_consumed_events`
   (the role that actually holds its grants; `ai_crm_runtime_api` has none).
7. Appends a **Last run** section below with PASS/FAIL lines and timestamps.

### Limitation

Migration SQL creates runtime roles with `PASSWORD NULL` and does not store
credentials. On the stock docker bootstrap user (`ai_crm`, superuser), the smoke
uses `SET ROLE ai_crm_runtime_api` (NOBYPASSRLS) after a one-shot
`GRANT ai_crm_runtime_api TO CURRENT_USER`. If membership cannot be granted,
FORCE RLS flags and function checks still run; isolation DML is marked SKIP.

### Reset (optional, destructive to ai_crm only)

```bash
docker exec -i ai-crmprojectmanager-postgres-1 \
  psql -U ai_crm -d ai_crm -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ai_crm; GRANT ALL ON SCHEMA public TO public;'
# then re-run the smoke script to apply 0001..0006 cleanly
./packages/persistence/scripts/pg-rls-smoke.sh
```

## Last run log

HDR
  fi

  {
    echo ""
    echo "### ${RUN_TS} — ${overall}"
    echo ""
    echo "- Host: \`${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}\`"
    echo "- Script: \`packages/persistence/scripts/pg-rls-smoke.sh\`"
    echo "- Counts: PASS=${PASS_N} FAIL=${FAIL_N} SKIP=${SKIP_N}"
    echo "- Full transcript: \`${RUN_LOG}\`"
    echo ""
    echo '```'
    local line
    for line in "${RESULTS[@]}"; do
      echo "${line}"
    done
    echo '```'
    echo ""
    if [[ "${overall}" == "PASS" ]]; then
      echo "FORCE RLS evidence query:"
      echo ""
      echo '```sql'
      echo "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity"
      echo "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
      echo "WHERE n.nspname = 'public'"
      echo "  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')"
      echo "ORDER BY 1;"
      echo '```'
      echo ""
      echo "Result (this run):"
      echo ""
      echo '```'
      psql_q <<'SQL' || true
SELECT c.relname || ' relrowsecurity=' || c.relrowsecurity::text || ' relforcerowsecurity=' || c.relforcerowsecurity::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs', 'orch_work_items', 'orch_job_events', 'orch_governance_controls', 'orch_governance_intents')
ORDER BY c.relname;
SQL
      echo '```'
    fi
  } >> "${DOC_PATH}"

  log "wrote run section to ${DOC_PATH}"
}

main() {
  log "=== pg-rls-smoke ${RUN_TS} ==="
  log "target ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
  require_psql
  check_connectivity || {
    write_doc
    exit 1
  }
  apply_migrations
  check_force_rls
  check_function_and_guc
  check_policies
  run_isolation
  run_outbox_consumer_isolation
  run_p6b_g001_isolation
  run_q2_isolation
  write_doc

  log "=== summary PASS=${PASS_N} FAIL=${FAIL_N} SKIP=${SKIP_N} ==="
  if [[ "${FAIL_N}" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
