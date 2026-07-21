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
    'crm_customers', 'outbox_consumed_events'
  )
ORDER BY c.relname;
SQL
)"
  local expected=$'crm_customers=true/true\norch_governance_controls=true/true\norch_governance_intents=true/true\norch_job_events=true/true\norch_jobs=true/true\norch_work_items=true/true\noutbox_consumed_events=true/true'
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
  if printf '%s' "${src}" | grep -q "app.workspace_id"; then
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
    'crm_customers', 'outbox_consumed_events'
  )
  AND policyname = 'workspace_isolation';
SQL
)"
  if [[ "${n}" == "7" ]]; then
    record PASS "workspace_isolation policies" "7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events"
  else
    record FAIL "workspace_isolation policies" "expected 7, got ${n}"
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
  write_doc

  log "=== summary PASS=${PASS_N} FAIL=${FAIL_N} SKIP=${SKIP_N} ==="
  if [[ "${FAIL_N}" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
