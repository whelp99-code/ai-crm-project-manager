#!/usr/bin/env bash
# pilot-preflight.sh — honest pre-bring-up gate for a SINGLE pilot instance.
#
# Verifies (against the environment this script is run in, and against
# whatever DSNs DATABASE_URL/ADMIN_DATABASE_URL/MODEL_GATEWAY_DATABASE_URL
# currently point at) that a pilot bring-up is not silently reusing dev-mode
# shortcuts. This is a GATE, not a fix-it script: it never mutates config,
# roles, or the database. It only inspects and reports PASS/FAIL/WARN/SKIP.
#
# Exit 0 only when every check PASSes (WARNs are allowed to exit 0 — they are
# advisory, not blocking). Exit 1 if any check FAILs.
#
# This is expected, CORRECT behavior to FAIL/WARN when run against the local
# dev environment: dev deliberately uses the docker `ai_crm` superuser DSN,
# the drill webhook-catcher receiver, and Grafana admin/admin. See
# docs/ops/pilot-runbook.md for the full narrative these checks summarize.
#
# Usage:
#   packages/persistence/scripts/pilot-preflight.sh
#   (reads DATABASE_URL / ADMIN_DATABASE_URL / MODEL_GATEWAY_DATABASE_URL /
#    AUTH_API_KEY|API_AUTH_TOKEN / MODEL_PROVIDER / AZURE_OPENAI_* /
#    GRAFANA_ADMIN_PASSWORD-style vars from the calling shell's env, exactly
#    like apps/api/apps/worker do — this script does not read .env itself)
#
# Exit codes: 0 = all required checks PASS (WARNs allowed). 1 = at least one
# required check FAILed.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ALERTMANAGER_YML="${ROOT}/ops/alertmanager/alertmanager.yml"

PASS_N=0
FAIL_N=0
WARN_N=0
SKIP_N=0
FAIL_LINES=()
WARN_LINES=()

pass() { PASS_N=$((PASS_N + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL_N=$((FAIL_N + 1)); FAIL_LINES+=("$1"); printf 'FAIL  %s\n' "$1"; }
warn() { WARN_N=$((WARN_N + 1)); WARN_LINES+=("$1"); printf 'WARN  %s\n' "$1"; }
skip() { SKIP_N=$((SKIP_N + 1)); printf 'SKIP  %s\n' "$1"; }

is_placeholder() {
  # True if the value is unset, empty, or still literally a CHANGE_ME-style
  # placeholder (matches the .env.example convention).
  local v="${1:-}"
  [[ -z "${v}" ]] && return 0
  [[ "${v}" == *"CHANGE_ME"* ]] && return 0
  return 1
}

echo "=== pilot-preflight: 1) required env present + non-placeholder ==="

for var in DATABASE_URL ADMIN_DATABASE_URL MODEL_GATEWAY_DATABASE_URL; do
  val="${!var:-}"
  if is_placeholder "${val}"; then
    fail "${var} is unset or still a CHANGE_ME placeholder — see docs/ops/runtime-dsn.md"
  else
    pass "${var} is set to a non-placeholder value"
  fi
done

if is_placeholder "${AUTH_API_KEY:-}" && is_placeholder "${API_AUTH_TOKEN:-}"; then
  fail "neither AUTH_API_KEY nor API_AUTH_TOKEN is set (or both are CHANGE_ME) — createApp fails closed to dev-mode auth, see docs/ops/authn.md"
else
  pass "AUTH_API_KEY or API_AUTH_TOKEN is set to a non-placeholder value"
fi

MODEL_PROVIDER_VAL="${MODEL_PROVIDER:-}"
if [[ -z "${MODEL_PROVIDER_VAL}" || "${MODEL_PROVIDER_VAL}" == "mock" || "${MODEL_PROVIDER_VAL}" == "none" ]]; then
  skip "MODEL_PROVIDER unset/mock/none — offline model path, AZURE_OPENAI_* not required (see docs/ops/live-model.md)"
elif [[ "${MODEL_PROVIDER_VAL}" == "azure" || "${MODEL_PROVIDER_VAL}" == "openai_compatible" ]]; then
  pass "MODEL_PROVIDER=${MODEL_PROVIDER_VAL} recognized"
  if is_placeholder "${AZURE_OPENAI_ENDPOINT:-}"; then
    fail "MODEL_PROVIDER=${MODEL_PROVIDER_VAL} but AZURE_OPENAI_ENDPOINT is unset/CHANGE_ME"
  else
    pass "AZURE_OPENAI_ENDPOINT is set to a non-placeholder value"
  fi
  if is_placeholder "${AZURE_OPENAI_API_KEY:-}"; then
    fail "MODEL_PROVIDER=${MODEL_PROVIDER_VAL} but AZURE_OPENAI_API_KEY is unset/CHANGE_ME"
  else
    pass "AZURE_OPENAI_API_KEY is set to a non-placeholder value"
  fi
else
  fail "MODEL_PROVIDER=${MODEL_PROVIDER_VAL} is not azure/openai_compatible/mock/none/unset — createApp() throws MODEL_PROVIDER_UNSUPPORTED at boot"
fi

echo
echo "=== pilot-preflight: 2) runtime role NOBYPASSRLS (ai_crm_runtime_api) ==="

# This check proves the role the request path actually runs under cannot
# bypass RLS. It targets the ai_crm_runtime_api role specifically (the role
# DATABASE_URL MUST point at in prod, per docs/ops/runtime-dsn.md), not
# merely "whatever role DATABASE_URL's DSN names" — this way the check is
# meaningful even when run by an operator connecting via the bootstrap
# superuser to inspect role attributes (dev's actual, honest posture).
RUNTIME_ROLE="ai_crm_runtime_api"
PSQL_DSN="${DATABASE_URL:-postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm}"

if command -v psql >/dev/null 2>&1; then
  ROLBYPASSRLS="$(psql "${PSQL_DSN}" -v ON_ERROR_STOP=1 -X -q -t -A \
    -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}'" 2>&1)"
  PSQL_STATUS=$?
  if [[ ${PSQL_STATUS} -ne 0 ]]; then
    fail "could not connect/query via psql against DATABASE_URL to inspect role '${RUNTIME_ROLE}': ${ROLBYPASSRLS}"
  elif [[ -z "${ROLBYPASSRLS}" ]]; then
    fail "role '${RUNTIME_ROLE}' does not exist on this database — DATABASE_URL should point at it (see docs/ops/runtime-dsn.md)"
  elif [[ "${ROLBYPASSRLS}" == "f" ]]; then
    pass "role '${RUNTIME_ROLE}' has rolbypassrls=false (NOBYPASSRLS, correct)"
  else
    fail "role '${RUNTIME_ROLE}' has rolbypassrls=true — this role BYPASSES RLS and must never be the runtime role"
  fi

  # Also check whether DATABASE_URL's *own* connection role bypasses RLS —
  # this is what actually protects a live request, distinct from the named
  # role's catalog attribute above (an operator could point DATABASE_URL at
  # the superuser while ai_crm_runtime_api itself is correctly NOBYPASSRLS).
  CURRENT_BYPASS="$(psql "${PSQL_DSN}" -v ON_ERROR_STOP=1 -X -q -t -A \
    -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user" 2>&1)"
  if [[ $? -ne 0 ]]; then
    fail "could not determine current_user's rolbypassrls via DATABASE_URL: ${CURRENT_BYPASS}"
  elif [[ "${CURRENT_BYPASS}" == "t" ]]; then
    fail "DATABASE_URL's own connection role bypasses RLS (rolbypassrls=true) — DATABASE_URL must point at ${RUNTIME_ROLE} (NOBYPASSRLS), not an admin/superuser role"
  elif [[ "${CURRENT_BYPASS}" == "f" ]]; then
    pass "DATABASE_URL's own connection role has rolbypassrls=false (NOBYPASSRLS, correct)"
  else
    fail "could not read DATABASE_URL's current_user rolbypassrls value (got '${CURRENT_BYPASS}')"
  fi
else
  skip "psql not found on PATH — cannot verify rolbypassrls live; install postgresql-client or run with psql on PATH"
fi

echo
echo "=== pilot-preflight: 3) MODEL_GATEWAY_DATABASE_URL distinct from DATABASE_URL (ADR-010) ==="

MG_URL="${MODEL_GATEWAY_DATABASE_URL:-}"
DB_URL="${DATABASE_URL:-}"
if [[ -z "${MG_URL}" ]]; then
  fail "MODEL_GATEWAY_DATABASE_URL is unset — falls back to DATABASE_URL, which the prod guard (MODEL_GATEWAY_DSN_REQUIRED_IN_PROD) rejects unless ALLOW_INSECURE_PROD=1 is explicitly set"
elif [[ "${MG_URL}" == "${DB_URL}" ]]; then
  fail "MODEL_GATEWAY_DATABASE_URL equals DATABASE_URL — ADR-010 requires a disjoint principal; this collapses the write-boundary (see docs/adr/010-model-gateway.md)"
else
  pass "MODEL_GATEWAY_DATABASE_URL is distinct from DATABASE_URL"
fi

echo
echo "=== pilot-preflight: 4) Grafana admin credentials ==="

# GF_SECURITY_ADMIN_PASSWORD is the docker-compose.observability.yml env var
# name; GRAFANA_ADMIN_PASSWORD is accepted as an operator-friendly alias if a
# deployment wires it through under that name instead. We never fabricate a
# value or attempt to log into Grafana here — this is an env-inspection
# check only, honestly SKIPped when neither var is present to inspect.
GRAFANA_PW="${GF_SECURITY_ADMIN_PASSWORD:-${GRAFANA_ADMIN_PASSWORD:-}}"
if [[ -z "${GRAFANA_PW}" ]]; then
  skip "no GF_SECURITY_ADMIN_PASSWORD/GRAFANA_ADMIN_PASSWORD in this shell's env — cannot inspect; verify manually that docker-compose.observability.yml's Grafana admin password was rotated off 'admin'"
elif [[ "${GRAFANA_PW}" == "admin" ]]; then
  fail "Grafana admin password is still the shipped dev default 'admin' — rotate GF_SECURITY_ADMIN_PASSWORD before any real pilot (see docs/ops/pilot-runbook.md)"
else
  pass "Grafana admin password env var is set and is not the literal default 'admin'"
fi

echo
echo "=== pilot-preflight: 5) Alertmanager receiver ==="

if [[ -f "${ALERTMANAGER_YML}" ]]; then
  if grep -q "host.docker.internal:9099" "${ALERTMANAGER_YML}" 2>/dev/null; then
    warn "ops/alertmanager/alertmanager.yml still routes to the drill webhook-catcher (host.docker.internal:9099) — wire a real Slack/email/PagerDuty receiver before a real pilot, see docs/ops/pilot-runbook.md"
  else
    pass "ops/alertmanager/alertmanager.yml does not reference the drill webhook-catcher endpoint"
  fi
else
  skip "ops/alertmanager/alertmanager.yml not found at ${ALERTMANAGER_YML} — cannot inspect receiver config"
fi

echo
echo "=== pilot-preflight: 6) single-instance operator acknowledgment ==="

cat <<'EOF'
ACK REQUIRED (operator, not automatically checkable): this pilot's
withWorkspaceMutex serialization (governance/ledger/recon/daily-gate),
in-process circuit breaker (AzureOpenAiClient), and in-process EventHub /
outbox drainer/consumer are ALL single-process state. Running more than ONE
apps/api replica (or more than one apps/worker process) breaks per-workspace
ordering guarantees, double-drains the outbox, and splits circuit-breaker
state across replicas with no coordination. Bring up EXACTLY ONE api
instance and ONE worker instance for this pilot. See docs/ops/pilot-runbook.md
section (a) for the full residual and what lifting it later requires.
EOF
pass "single-instance constraint printed for operator acknowledgment"

echo
echo "PREFLIGHT: ${PASS_N} PASS, ${FAIL_N} FAIL, ${WARN_N} WARN (${SKIP_N} SKIP)"

if [[ ${FAIL_N} -gt 0 ]]; then
  echo
  echo "FAILING CHECKS:"
  for line in "${FAIL_LINES[@]}"; do
    printf '  - %s\n' "${line}"
  done
  exit 1
fi

exit 0
