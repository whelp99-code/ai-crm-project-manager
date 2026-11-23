#!/usr/bin/env bash
# restore-drill.sh — N-15 (D12) live CI restore-drill gate.
#
# Real pg_dump of the ai_crm database -> restore into a scratch database
# (ai_crm_restore_drill) -> verify (table presence + SELECT 1 on key tables:
# orch_jobs, audit_events, crm_customers) -> drop the scratch database.
#
# Idempotent: safe to re-run; always drops/recreates the scratch db first.
# Refuses to run against anything that is not the local ai-crm docker/CI
# Postgres (same guard posture as pg-rls-smoke.sh). Never touches production.
#
# Usage:
#   packages/persistence/scripts/restore-drill.sh
#   PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
#     packages/persistence/scripts/restore-drill.sh
#
# Exit 0 on PASS; non-zero on any FAIL.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DOC_PATH="${ROOT}/docs/ops/backup-restore.md"
LOG_DIR="${TMPDIR:-/tmp}/ai-crm-restore-drill"
mkdir -p "${LOG_DIR}"
RUN_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_LOG="${LOG_DIR}/run-${RUN_TS//[:]/-}.log"
DUMP_FILE="${LOG_DIR}/ai_crm-${RUN_TS//[:]/-}.dump"

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-ai_crm}"
export PGDATABASE="${PGDATABASE:-ai_crm}"
export PGPASSWORD="${PGPASSWORD:-ai_crm_dev}"

SCRATCH_DB="${AI_CRM_RESTORE_DRILL_DB:-ai_crm_restore_drill}"
KEY_TABLES=(orch_jobs audit_events crm_customers)

# Hard guard: refuse anything that is not the ai_crm DB on the expected
# host/port. Mirrors packages/persistence/scripts/pg-rls-smoke.sh.
if [[ "${PGDATABASE}" != "ai_crm" ]]; then
  echo "REFUSE: PGDATABASE must be ai_crm (got ${PGDATABASE}); refusing to touch other DBs" >&2
  exit 2
fi
if [[ "${PGHOST}" != "localhost" && "${PGHOST}" != "127.0.0.1" ]]; then
  if [[ "${AI_CRM_DRILL_ALLOW_NONLOCAL_HOST:-}" != "1" ]]; then
    echo "REFUSE: PGHOST=${PGHOST} is not local. Set AI_CRM_DRILL_ALLOW_NONLOCAL_HOST=1 to override." >&2
    exit 2
  fi
fi
if [[ "${PGPORT}" != "5432" && "${PGPORT}" != "5432/tcp" ]]; then
  if [[ "${AI_CRM_DRILL_ALLOW_NONDEFAULT_PORT:-}" != "1" ]]; then
    echo "REFUSE: PGPORT=${PGPORT} is not 5432 (ai-crm docker/CI). Set AI_CRM_DRILL_ALLOW_NONDEFAULT_PORT=1 to override." >&2
    exit 2
  fi
fi
if [[ "${SCRATCH_DB}" == "ai_crm" || "${SCRATCH_DB}" == "postgres" || "${SCRATCH_DB}" == "template0" || "${SCRATCH_DB}" == "template1" ]]; then
  echo "REFUSE: scratch db name '${SCRATCH_DB}' collides with a protected database" >&2
  exit 2
fi

PASS_N=0
FAIL_N=0
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
  esac
  RESULTS+=("${status} | ${name}${detail:+ — ${detail}}")
  log "[${status}] ${name}${detail:+ — ${detail}}"
}

psql_q() {
  psql -v ON_ERROR_STOP=1 -X -q -t -A "$@"
}

psql_admin() {
  PGDATABASE=postgres psql -v ON_ERROR_STOP=1 -X -q -t -A "$@"
}

require_tools() {
  for tool in psql; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "${tool} not found on PATH" >&2
      exit 127
    fi
  done
}

# pg_dump/pg_restore refuse to talk to a server newer than the client (major
# version skew). Rather than require a host install matching the server
# exactly, detect skew and transparently run pg_dump/pg_restore *inside* the
# running Postgres container via `docker exec` — guaranteed version parity,
# works identically on a local docker/compose Postgres and on a GitHub
# Actions `services: postgres` container (also a real docker container on
# the runner host).
DUMP_MODE="host"
DRILL_CONTAINER=""

server_major_version() {
  psql_q -c "SHOW server_version_num;" | cut -c1-2
}

host_pg_dump_major_version() {
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --version | grep -oE '[0-9]+' | head -1
  else
    echo 0
  fi
}

find_container_for_port() {
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --format '{{.ID}} {{.Ports}}' 2>/dev/null \
    | grep -F ":${PGPORT}->5432/tcp" \
    | awk '{print $1}' \
    | head -1
}

detect_dump_mode() {
  local server_major host_major
  server_major="$(server_major_version)"
  host_major="$(host_pg_dump_major_version)"
  if [[ -n "${server_major}" && -n "${host_major}" && "${host_major}" -eq "${server_major}" ]]; then
    DUMP_MODE="host"
    return
  fi
  DRILL_CONTAINER="$(find_container_for_port || true)"
  if [[ -n "${DRILL_CONTAINER}" ]]; then
    DUMP_MODE="docker"
    log "host pg_dump major=${host_major} != server major=${server_major}; using docker exec ${DRILL_CONTAINER}"
    return
  fi
  echo "REFUSE: host pg_dump (major ${host_major}) does not match server (major ${server_major}) and no matching docker container was found on port ${PGPORT} to exec into." >&2
  exit 3
}

check_connectivity() {
  if psql_q -c "SELECT 1" >/dev/null 2>&1; then
    record PASS "connectivity" "${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
    return 0
  fi
  record FAIL "connectivity" "cannot reach ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
  return 1
}

drop_scratch_if_exists() {
  # Idempotent pre-clean: terminate any lingering backends, then drop.
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH_DB}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  psql_admin -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null
}

do_dump() {
  local ok=0
  if [[ "${DUMP_MODE}" == "docker" ]]; then
    if docker exec -e PGPASSWORD="${PGPASSWORD}" "${DRILL_CONTAINER}" \
        pg_dump -U "${PGUSER}" -d "${PGDATABASE}" -Fc --no-owner --no-acl > "${DUMP_FILE}" 2>>"${RUN_LOG}"; then
      ok=1
    fi
  else
    if pg_dump -Fc --no-owner --no-acl -f "${DUMP_FILE}" 2>>"${RUN_LOG}"; then
      ok=1
    fi
  fi
  if [[ "${ok}" -eq 1 ]]; then
    local bytes
    bytes="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
    if [[ "${bytes}" -gt 0 ]]; then
      record PASS "pg_dump" "mode=${DUMP_MODE} ${DUMP_FILE} (${bytes} bytes)"
      return 0
    fi
    record FAIL "pg_dump" "dump file is empty"
    return 1
  fi
  record FAIL "pg_dump" "pg_dump exited non-zero (mode=${DUMP_MODE}, see ${RUN_LOG})"
  return 1
}

do_restore() {
  psql_admin -c "CREATE DATABASE ${SCRATCH_DB} OWNER ${PGUSER};" >/dev/null
  local ok=0
  if [[ "${DUMP_MODE}" == "docker" ]]; then
    if docker exec -i -e PGPASSWORD="${PGPASSWORD}" "${DRILL_CONTAINER}" \
        pg_restore -U "${PGUSER}" -d "${SCRATCH_DB}" --no-owner --no-acl --exit-on-error < "${DUMP_FILE}" >>"${RUN_LOG}" 2>&1; then
      ok=1
    fi
  else
    if pg_restore -d "${SCRATCH_DB}" --no-owner --no-acl --exit-on-error "${DUMP_FILE}" >>"${RUN_LOG}" 2>&1; then
      ok=1
    fi
  fi
  if [[ "${ok}" -eq 1 ]]; then
    record PASS "pg_restore" "mode=${DUMP_MODE} restored into ${SCRATCH_DB}"
    return 0
  fi
  record FAIL "pg_restore" "pg_restore exited non-zero (mode=${DUMP_MODE}, see ${RUN_LOG})"
  return 1
}

verify_restore() {
  local ok=1
  local table
  for table in "${KEY_TABLES[@]}"; do
    local count
    if count="$(PGDATABASE="${SCRATCH_DB}" psql_q -c "SELECT count(*) FROM ${table};" 2>>"${RUN_LOG}")"; then
      record PASS "verify:${table}" "SELECT 1 ok, row count=${count}"
    else
      record FAIL "verify:${table}" "query failed"
      ok=0
    fi
  done
  local mig_present
  mig_present="$(PGDATABASE="${SCRATCH_DB}" psql_q -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL;" 2>>"${RUN_LOG}" || echo f)"
  if [[ "${mig_present}" == "t" ]]; then
    local mig_count
    mig_count="$(PGDATABASE="${SCRATCH_DB}" psql_q -c "SELECT count(*) FROM schema_migrations;" 2>>"${RUN_LOG}" || echo 0)"
    record PASS "verify:schema_migrations" "count=${mig_count}"
  fi
  [[ "${ok}" -eq 1 ]]
}

cleanup_scratch() {
  # Verify-then-drop: restore drill must not leave the scratch db behind.
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${SCRATCH_DB}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  if psql_admin -c "DROP DATABASE IF EXISTS ${SCRATCH_DB};" >/dev/null 2>>"${RUN_LOG}"; then
    record PASS "cleanup" "dropped ${SCRATCH_DB}"
  else
    record FAIL "cleanup" "failed to drop ${SCRATCH_DB} (see ${RUN_LOG})"
  fi
  rm -f "${DUMP_FILE}"
}

write_doc() {
  if [ "${AI_CRM_DRILL_WRITE_DOC:-0}" != "1" ]; then return 0; fi
  local overall="$1"
  {
    echo ""
    echo "### ${RUN_TS} — restore-drill ${overall}"
    echo ""
    echo "- Host: \`${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}\`"
    echo "- Scratch db: \`${SCRATCH_DB}\`"
    echo "- Script: \`packages/persistence/scripts/restore-drill.sh\`"
    echo "- Counts: PASS=${PASS_N} FAIL=${FAIL_N}"
    echo "- Full transcript: \`${RUN_LOG}\`"
    echo ""
    echo '```'
    local line
    for line in "${RESULTS[@]}"; do
      echo "${line}"
    done
    echo '```'
    echo ""
  } >> "${DOC_PATH}"
  log "wrote run section to ${DOC_PATH}"
}

main() {
  log "=== restore-drill ${RUN_TS} ==="
  log "target ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE} -> scratch ${SCRATCH_DB}"
  require_tools
  check_connectivity || {
    write_doc "FAIL"
    exit 1
  }
  detect_dump_mode
  drop_scratch_if_exists
  do_dump && do_restore && verify_restore
  cleanup_scratch

  local overall="PASS"
  if [[ "${FAIL_N}" -ne 0 ]]; then
    overall="FAIL"
  fi
  write_doc "${overall}"

  log "=== summary PASS=${PASS_N} FAIL=${FAIL_N} ==="
  if [[ "${FAIL_N}" -ne 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
