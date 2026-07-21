#!/usr/bin/env bash
# prom-scrape-drill.sh — live D12 proof that a deployed Prometheus actually
# scrapes the AI-CRM API `/metrics` endpoint and ingests it.
#
# Local-only guard, same style as pg-rls-smoke.sh: idempotent, host-only,
# does not touch the ai_crm postgres or any other docker DB, cleans up its
# own containers/process on exit (including on failure).
#
# What it does:
#   1. Boots a real @ai-crm/api Fastify app (createApp() from apps/api/src)
#      via tsx, listening on 0.0.0.0:${AI_CRM_API_PORT} — the SAME app code
#      that serves GET /metrics and GET /metrics/prometheus in production,
#      not a fake/mocked harness.
#   2. Seeds one job through the real POST /api/agent/commands route (an
#      auto-authorized `internal.update` command with a stubbed ModelClient)
#      so ai_crm_agent_jobs_total is non-zero, proving a real counter value
#      round-trips through the scrape, not just a zeroed metric family.
#   3. Starts prom/prometheus (docker-compose.observability.yml) pointed at
#      host.docker.internal:${AI_CRM_API_PORT}.
#   4. Waits for Prometheus to report the target `up == 1`.
#   5. Queries http://localhost:9090/api/v1/query?query=ai_crm_agent_jobs_total
#      and asserts the ai-crm-api series is present with value >= 1.
#   6. Tears everything down (compose down + kill the API process).
#
# Usage:
#   packages/persistence/scripts/prom-scrape-drill.sh
#   AI_CRM_API_PORT=3001 packages/persistence/scripts/prom-scrape-drill.sh
#
# Exit 0 on PASS; non-zero on any FAIL. Appends a run log section to
# docs/ops/observability.md when that path is writable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.observability.yml"
PROM_TEMPLATE="${ROOT}/ops/prometheus/prometheus.yml"
DOC_PATH="${ROOT}/docs/ops/observability.md"

export AI_CRM_API_PORT="${AI_CRM_API_PORT:-3001}"
PROM_PORT="${PROM_PORT:-9090}"

LOG_DIR="${TMPDIR:-/tmp}/ai-crm-prom-scrape-drill"
mkdir -p "${LOG_DIR}"
RUN_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_LOG="${LOG_DIR}/run-${RUN_TS//[:]/-}.log"
RENDERED_PROM_CONFIG="${LOG_DIR}/prometheus.rendered.yml"
API_LOG="${LOG_DIR}/api.log"
API_HARNESS="${LOG_DIR}/api-harness.mjs"

log() { printf '%s\n' "$*" | tee -a "${RUN_LOG}"; }

PASS_N=0
FAIL_N=0
RESULTS=()
record() {
  local status="$1"; shift
  local msg="$*"
  RESULTS+=("${status}: ${msg}")
  if [[ "${status}" == "PASS" ]]; then PASS_N=$((PASS_N + 1)); else FAIL_N=$((FAIL_N + 1)); fi
  log "[${status}] ${msg}"
}

API_PID=""
COMPOSE_UP=0

cleanup() {
  local exit_code=$?
  if [[ "${COMPOSE_UP}" == "1" ]]; then
    log "Tearing down docker compose observability stack..."
    docker compose -p ai-crm-prom-drill -f "${COMPOSE_FILE}" down >>"${RUN_LOG}" 2>&1 || true
  fi
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    log "Stopping AI-CRM API harness (pid ${API_PID})..."
    kill "${API_PID}" 2>/dev/null || true
    wait "${API_PID}" 2>/dev/null || true
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: '$1' is required on PATH." >&2; exit 1; }
}
require docker
require node
require curl

TSX_CLI="$(find "${ROOT}/node_modules/.pnpm" -maxdepth 1 -type d -name 'tsx@*' 2>/dev/null | head -n1)/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "${TSX_CLI}" ]]; then
  echo "FATAL: tsx not found under node_modules/.pnpm (run pnpm install)." >&2
  exit 1
fi

log "=== prom-scrape-drill run ${RUN_TS} ==="
log "AI_CRM_API_PORT=${AI_CRM_API_PORT} PROM_PORT=${PROM_PORT}"

# --- 1. Render the scrape target port into the mounted Prometheus config ---
sed "s/host.docker.internal:3001/host.docker.internal:${AI_CRM_API_PORT}/" "${PROM_TEMPLATE}" >"${RENDERED_PROM_CONFIG}"

# --- 2. Boot the real AI-CRM API (apps/api createApp) via tsx ---
cat >"${API_HARNESS}" <<EOF
import { createApp } from "${ROOT}/apps/api/src/app.js";

function planClient(suggestedCommand) {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            { suggestedCommand, title: "step", resourceType: "", resourceId: "", resourceVersion: 1, payloadJson: "{}" },
          ],
        },
        modelVersion: "prom-scrape-drill",
        retentionHonored: true,
      };
    },
  };
}

const app = createApp({ modelClient: planClient("internal.update") });
await app.listen({ port: ${AI_CRM_API_PORT}, host: "0.0.0.0" });
console.log("AI-CRM API harness listening on :${AI_CRM_API_PORT}");

const seeded = await fetch("http://127.0.0.1:${AI_CRM_API_PORT}/api/agent/commands", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-workspace-id": "ws-prom-drill",
    "x-principal-id": "operator-prom-drill",
    "idempotency-key": "idem-prom-scrape-drill-1",
  },
  body: JSON.stringify({ text: "internal note" }),
});
if (!seeded.ok) {
  console.error("seed command failed", seeded.status, await seeded.text());
  process.exit(1);
}
console.log("seeded one agent job:", await seeded.text());
EOF

node "${TSX_CLI}" "${API_HARNESS}" >"${API_LOG}" 2>&1 &
API_PID=$!

# Wait for the API to come up and report a non-zero counter.
API_READY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${AI_CRM_API_PORT}/metrics/prometheus" 2>/dev/null | grep -q 'ai_crm_agent_jobs_total 1'; then
    API_READY=1
    break
  fi
  sleep 0.5
done
if [[ "${API_READY}" == "1" ]]; then
  record PASS "AI-CRM API harness up on :${AI_CRM_API_PORT} with ai_crm_agent_jobs_total==1"
else
  cat "${API_LOG}" | tee -a "${RUN_LOG}" || true
  record FAIL "AI-CRM API harness did not reach ready state with a seeded job"
fi

METRICS_TEXT="$(curl -fsS "http://127.0.0.1:${AI_CRM_API_PORT}/metrics/prometheus" || true)"
log "--- /metrics/prometheus (host-run API) ---"
log "${METRICS_TEXT}"

# --- 3. Start Prometheus pointed at the rendered config ---
OVERRIDE_COMPOSE="${LOG_DIR}/docker-compose.override.yml"
cat >"${OVERRIDE_COMPOSE}" <<COMPOSE_OVERRIDE
services:
  prometheus:
    volumes:
      - ${RENDERED_PROM_CONFIG}:/etc/prometheus/prometheus.yml:ro
COMPOSE_OVERRIDE
docker compose -p ai-crm-prom-drill -f "${COMPOSE_FILE}" -f "${OVERRIDE_COMPOSE}" up -d prometheus >>"${RUN_LOG}" 2>&1
COMPOSE_UP=1
record PASS "docker compose observability stack started (prometheus on :${PROM_PORT})"

# --- 4. Wait for the target to report up==1 ---
TARGET_UP=0
for _ in $(seq 1 40); do
  TARGETS_JSON="$(curl -fsS "http://localhost:${PROM_PORT}/api/v1/targets" 2>/dev/null || true)"
  if printf '%s' "${TARGETS_JSON}" | grep -q '"health":"up"'; then
    TARGET_UP=1
    break
  fi
  sleep 0.5
done
if [[ "${TARGET_UP}" == "1" ]]; then
  record PASS "Prometheus target ai-crm-api reports health=up"
else
  log "targets response: ${TARGETS_JSON}"
  record FAIL "Prometheus target never reported up"
fi

# --- 5. Query the ingested series via the Prometheus HTTP API ---
sleep 2
QUERY_JSON="$(curl -fsS "http://localhost:${PROM_PORT}/api/v1/query?query=ai_crm_agent_jobs_total" || true)"
log "--- Prometheus query API result (ai_crm_agent_jobs_total) ---"
log "${QUERY_JSON}"

if printf '%s' "${QUERY_JSON}" | grep -q '"job":"ai-crm-api"' && printf '%s' "${QUERY_JSON}" | grep -qE '"value":\[[0-9.]+,"1"\]'; then
  record PASS "Prometheus ingested ai_crm_agent_jobs_total{job=\"ai-crm-api\"} == 1 via query API"
else
  record FAIL "ai_crm_agent_jobs_total series not found (or not ==1) in Prometheus query API"
fi

UP_QUERY_JSON="$(curl -fsS --get --data-urlencode 'query=up{job="ai-crm-api"}' "http://localhost:${PROM_PORT}/api/v1/query" || true)"
log "--- Prometheus query API result (up{job=\"ai-crm-api\"}) ---"
log "${UP_QUERY_JSON}"
if printf '%s' "${UP_QUERY_JSON}" | grep -qE '"value":\[[0-9.]+,"1"\]'; then
  record PASS "Prometheus up{job=\"ai-crm-api\"} == 1"
else
  record FAIL "up{job=\"ai-crm-api\"} != 1"
fi

log ""
log "=== SUMMARY: ${PASS_N} PASS / ${FAIL_N} FAIL ==="
for r in "${RESULTS[@]}"; do log "  ${r}"; done

if [[ -w "$(dirname "${DOC_PATH}")" || -f "${DOC_PATH}" ]]; then
  {
    echo ""
    echo "## Run ${RUN_TS}"
    echo ""
    echo "- Result: ${PASS_N} PASS / ${FAIL_N} FAIL"
    echo "- API port: ${AI_CRM_API_PORT}, Prometheus port: ${PROM_PORT}"
    echo '```json'
    echo "${QUERY_JSON}"
    echo '```'
  } >>"${DOC_PATH}" 2>/dev/null || true
fi

if [[ "${FAIL_N}" -gt 0 ]]; then
  exit 1
fi
exit 0
