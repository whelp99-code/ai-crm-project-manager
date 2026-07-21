#!/usr/bin/env bash
# obs-stack-drill.sh — live D12/PG-F proof that the deployed observability
# stack (Prometheus + alert rules + Grafana datasource/dashboard +
# Alertmanager routing + persistent volumes) actually works end-to-end, on
# top of the narrower scrape-only proof in
# packages/persistence/scripts/prom-scrape-drill.sh.
#
# Local-only guard, same style as pg-rls-smoke.sh / prom-scrape-drill.sh:
# idempotent, host-only, does not touch the ai_crm postgres or any other
# docker DB/volume, cleans up its own containers/process on exit (including
# on failure).
#
# What it does:
#   1. Boots a real @ai-crm/api Fastify app (createApp() from apps/api/src)
#      via tsx, listening on 0.0.0.0:${AI_CRM_API_PORT} — the SAME app code
#      that serves GET /metrics and GET /metrics/prometheus in production.
#   2. Seeds one job through the real POST /api/agent/commands route so
#      ai_crm_agent_jobs_total is non-zero.
#   3. Starts a tiny local webhook-catcher (plain node http server) on
#      :${WEBHOOK_PORT} that records every alert payload Alertmanager sends
#      it — the locally-assertable notification receiver.
#   4. Starts prometheus + grafana + alertmanager
#      (docker-compose.observability.yml) pointed at
#      host.docker.internal:${AI_CRM_API_PORT}.
#   5. Waits for Prometheus to report the target up == 1.
#   6. Asserts Prometheus loaded the alert rules: GET /api/v1/rules shows
#      AiCrmApiDown, AiCrmDualWriteFailures, and the fast test-only
#      AiCrmApiDownFast.
#   7. Asserts Grafana is up (GET /api/health), the Prometheus datasource
#      health-checks OK (GET /api/datasources/uid/<uid>/health via the
#      default admin:admin creds), and the ai-crm dashboard is provisioned
#      (GET /api/dashboards/uid/ai-crm-overview).
#   8. Asserts Alertmanager is up (GET /api/v2/status).
#   9. FORCES an alert to fire: kills the API harness so the scrape target
#      goes down, which trips the fast (`for: 5s`) AiCrmApiDownFast rule.
#      Asserts Alertmanager's GET /api/v2/alerts shows it firing AND the
#      webhook-catcher actually received the notification.
#  10. Asserts PERSISTENCE: creates an Alertmanager silence (state written
#      to the alertmanager_data volume), `docker compose restart
#      alertmanager`, and asserts the silence is still present afterwards
#      (i.e. survives a container restart because it's volume-backed, not
#      ephemeral container storage).
#  11. Tears everything down (compose down + kill the API/webhook
#      processes).
#
# Usage:
#   ops/obs-stack-drill.sh
#   AI_CRM_API_PORT=3001 ops/obs-stack-drill.sh
#
# Exit 0 on PASS; non-zero on any FAIL. Appends a run log section to
# docs/ops/observability.md when that path is writable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.observability.yml"
PROM_TEMPLATE="${ROOT}/ops/prometheus/prometheus.yml"
DOC_PATH="${ROOT}/docs/ops/observability.md"

export AI_CRM_API_PORT="${AI_CRM_API_PORT:-3001}"
PROM_PORT="${PROM_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3005}"
ALERTMANAGER_PORT="${ALERTMANAGER_PORT:-9093}"
WEBHOOK_PORT="${WEBHOOK_PORT:-9099}"
GRAFANA_USER="admin"
GRAFANA_PASS="admin"
DASHBOARD_UID="ai-crm-overview"

LOG_DIR="${TMPDIR:-/tmp}/ai-crm-obs-stack-drill"
mkdir -p "${LOG_DIR}"
RUN_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
RUN_LOG="${LOG_DIR}/run-${RUN_TS//[:]/-}.log"
RENDERED_PROM_CONFIG="${LOG_DIR}/prometheus.rendered.yml"
API_LOG="${LOG_DIR}/api.log"
API_HARNESS="${LOG_DIR}/api-harness.mjs"
WEBHOOK_LOG="${LOG_DIR}/webhook-received.log"
WEBHOOK_HARNESS="${LOG_DIR}/webhook-catcher.mjs"
WEBHOOK_STDOUT="${LOG_DIR}/webhook-catcher.stdout.log"
: >"${WEBHOOK_LOG}"

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
WEBHOOK_PID=""
COMPOSE_UP=0

cleanup() {
  local exit_code=$?
  if [[ "${COMPOSE_UP}" == "1" ]]; then
    log "Tearing down docker compose observability stack..."
    docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" down >>"${RUN_LOG}" 2>&1 || true
  fi
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    log "Stopping AI-CRM API harness (pid ${API_PID})..."
    kill "${API_PID}" 2>/dev/null || true
    wait "${API_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WEBHOOK_PID}" ]] && kill -0 "${WEBHOOK_PID}" 2>/dev/null; then
    log "Stopping webhook-catcher harness (pid ${WEBHOOK_PID})..."
    kill "${WEBHOOK_PID}" 2>/dev/null || true
    wait "${WEBHOOK_PID}" 2>/dev/null || true
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

log "=== obs-stack-drill run ${RUN_TS} ==="
log "AI_CRM_API_PORT=${AI_CRM_API_PORT} PROM_PORT=${PROM_PORT} GRAFANA_PORT=${GRAFANA_PORT} ALERTMANAGER_PORT=${ALERTMANAGER_PORT} WEBHOOK_PORT=${WEBHOOK_PORT}"

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
        modelVersion: "obs-stack-drill",
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
    "x-workspace-id": "ws-obs-drill",
    "x-principal-id": "operator-obs-drill",
    "idempotency-key": "idem-obs-stack-drill-1",
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

# --- 3. Start the local webhook-catcher (the locally-assertable receiver) ---
cat >"${WEBHOOK_HARNESS}" <<'EOF'
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.WEBHOOK_PORT || 9099);
const LOG_PATH = process.env.WEBHOOK_LOG;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      fs.appendFileSync(LOG_PATH, body + "\n");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "received" }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`webhook-catcher listening on :${PORT}`);
});
EOF

WEBHOOK_PORT="${WEBHOOK_PORT}" WEBHOOK_LOG="${WEBHOOK_LOG}" node "${WEBHOOK_HARNESS}" >"${WEBHOOK_STDOUT}" 2>&1 &
WEBHOOK_PID=$!

WEBHOOK_READY=0
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${WEBHOOK_PORT}/webhook" -X POST -d '{}' 2>/dev/null; then
    WEBHOOK_READY=1
    break
  fi
  sleep 0.3
done
if [[ "${WEBHOOK_READY}" == "1" ]]; then
  : >"${WEBHOOK_LOG}"
  record PASS "webhook-catcher harness up on :${WEBHOOK_PORT}"
else
  cat "${WEBHOOK_STDOUT}" | tee -a "${RUN_LOG}" || true
  record FAIL "webhook-catcher harness did not come up"
fi

# --- 3a. Wipe leftover state from a PRIOR drill run before starting fresh.
#      alertmanager_data is a named, persistent volume (by design — it's
#      what makes the within-run "silence survives a container restart"
#      persistence proof in step 10 real). But that same persistence means
#      Alertmanager's on-disk state (silences AND its notification log,
#      nflog) survives across separate drill INVOCATIONS too, not just a
#      single in-run restart. The alert this drill fires always has the
#      exact same labels/fingerprint, so on a re-run within
#      repeat_interval of a prior run's successful send, Alertmanager's
#      persisted nflog correctly (per its own dedup semantics) suppresses
#      re-sending the webhook notification — the alert still shows
#      firing in /api/v2/alerts, but the webhook-catcher never gets a
#      fresh POST. This is the root cause of the "fires + routes
#      reliably, webhook-received flakes on a re-run" flake. Fix: start
#      every run from a clean slate by tearing down any leftover
#      containers/volumes from a previous run first.
docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" down -v --remove-orphans >>"${RUN_LOG}" 2>&1 || true

# --- 4. Start Prometheus + Grafana + Alertmanager pointed at the rendered config ---
OVERRIDE_COMPOSE="${LOG_DIR}/docker-compose.override.yml"
cat >"${OVERRIDE_COMPOSE}" <<COMPOSE_OVERRIDE
services:
  prometheus:
    volumes:
      - ${RENDERED_PROM_CONFIG}:/etc/prometheus/prometheus.yml:ro
COMPOSE_OVERRIDE
docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" -f "${OVERRIDE_COMPOSE}" up -d prometheus grafana alertmanager >>"${RUN_LOG}" 2>&1
COMPOSE_UP=1
record PASS "docker compose observability stack started (prometheus :${PROM_PORT}, grafana :${GRAFANA_PORT}, alertmanager :${ALERTMANAGER_PORT})"

# --- 5. Wait for the Prometheus target to report up==1 ---
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

# --- 6. Assert Prometheus loaded the alert rules (production + fast test-only) ---
RULES_JSON=""
RULES_LOADED=0
for _ in $(seq 1 20); do
  RULES_JSON="$(curl -fsS "http://localhost:${PROM_PORT}/api/v1/rules" 2>/dev/null || true)"
  if printf '%s' "${RULES_JSON}" | grep -q '"name":"AiCrmApiDown"' && printf '%s' "${RULES_JSON}" | grep -q '"name":"AiCrmDualWriteFailures"' && printf '%s' "${RULES_JSON}" | grep -q '"name":"AiCrmApiDownFast"' && printf '%s' "${RULES_JSON}" | grep -q '"type":"alerting"'; then
    RULES_LOADED=1
    break
  fi
  sleep 0.5
done
log "--- Prometheus /api/v1/rules ---"
log "${RULES_JSON}"
if [[ "${RULES_LOADED}" == "1" ]]; then
  record PASS "Prometheus loaded alert rules AiCrmApiDown, AiCrmDualWriteFailures, AiCrmApiDownFast"
else
  record FAIL "Prometheus did not report all three alert rules in /api/v1/rules"
fi

# --- 6a. Grafana up ---
GRAFANA_UP=0
for _ in $(seq 1 60); do
  HEALTH_JSON="$(curl -fsS "http://localhost:${GRAFANA_PORT}/api/health" 2>/dev/null || true)"
  if printf '%s' "${HEALTH_JSON}" | grep -Eq '"database":[[:space:]]*"ok"'; then
    GRAFANA_UP=1
    break
  fi
  sleep 1
done
log "--- Grafana /api/health ---"
log "${HEALTH_JSON}"
if [[ "${GRAFANA_UP}" == "1" ]]; then
  record PASS "Grafana is up (GET /api/health database=ok)"
else
  record FAIL "Grafana never reported healthy"
fi

# --- 6b. Prometheus datasource health check (via Grafana API, admin creds) ---
DS_HEALTH_JSON=""
DS_HEALTHY=0
for _ in $(seq 1 30); do
  DS_HEALTH_JSON="$(curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASS}" "http://localhost:${GRAFANA_PORT}/api/datasources/uid/ai-crm-prometheus/health" 2>/dev/null || true)"
  if printf '%s' "${DS_HEALTH_JSON}" | grep -q '"status":"OK"'; then
    DS_HEALTHY=1
    break
  fi
  sleep 1
done
log "--- Grafana datasource health (ai-crm-prometheus) ---"
log "${DS_HEALTH_JSON}"
if [[ "${DS_HEALTHY}" == "1" ]]; then
  record PASS "Grafana Prometheus datasource health-checks OK"
else
  record FAIL "Grafana Prometheus datasource did not report status=OK"
fi

# --- 6c. Dashboard provisioned ---
DASHBOARD_JSON="$(curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASS}" "http://localhost:${GRAFANA_PORT}/api/dashboards/uid/${DASHBOARD_UID}" 2>/dev/null || true)"
log "--- Grafana dashboard (uid=${DASHBOARD_UID}) ---"
log "${DASHBOARD_JSON}"
if printf '%s' "${DASHBOARD_JSON}" | grep -q '"title":"AI-CRM Overview"'; then
  record PASS "Grafana dashboard ai-crm-overview is provisioned (title=AI-CRM Overview)"
else
  record FAIL "Grafana dashboard ai-crm-overview not found via API"
fi
# --- 7. Alertmanager up ---
ALERTMANAGER_UP=0
for _ in $(seq 1 40); do
  AM_STATUS_JSON="$(curl -fsS "http://localhost:${ALERTMANAGER_PORT}/api/v2/status" 2>/dev/null || true)"
  if printf '%s' "${AM_STATUS_JSON}" | grep -q '"cluster"'; then
    ALERTMANAGER_UP=1
    break
  fi
  sleep 0.5
done
log "--- Alertmanager /api/v2/status ---"
log "${AM_STATUS_JSON}"
if [[ "${ALERTMANAGER_UP}" == "1" ]]; then
  record PASS "Alertmanager is up (GET /api/v2/status)"
else
  record FAIL "Alertmanager never reported healthy"
fi

# --- 7a. Reachability precheck: can the alertmanager container reach the
#      host-run webhook-catcher over host.docker.internal? Diagnose this
#      explicitly instead of letting it surface later as a mysterious
#      webhook-received flake.
WEBHOOK_REACHABLE=0
WEBHOOK_REACHABLE_OUT="$(docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" -f "${OVERRIDE_COMPOSE}" exec -T alertmanager \
  wget -q -O - --header="content-type: application/json" \
  --post-data='{}' "http://host.docker.internal:${WEBHOOK_PORT}/webhook" 2>&1 || true)"
if printf '%s' "${WEBHOOK_REACHABLE_OUT}" | grep -q '"status":"received"'; then
  WEBHOOK_REACHABLE=1
fi
log "--- alertmanager -> host.docker.internal:${WEBHOOK_PORT}/webhook reachability precheck ---"
log "${WEBHOOK_REACHABLE_OUT}"
if [[ "${WEBHOOK_REACHABLE}" == "1" ]]; then
  record PASS "alertmanager container can reach host webhook-catcher via host.docker.internal:${WEBHOOK_PORT}"
else
  record FAIL "alertmanager container CANNOT reach host webhook-catcher via host.docker.internal:${WEBHOOK_PORT} (check extra_hosts host-gateway and that the catcher is bound to 0.0.0.0)"
fi
: >"${WEBHOOK_LOG}" # the precheck probe above lands a harmless '{}' payload in the log; clear it before the real assertion

# --- 7b. Clear any stale Alertmanager silences left over from a PRIOR drill
#      run. alertmanager_data is a named, persistent volume (by design, so
#      the persistence-survives-restart proof in step 10 is real) — but that
#      also means a silence created by a previous run's persistence check
#      (matcher alertname=AiCrmApiDownFast, endsAt +10m) can still be ACTIVE
#      when this run starts. An active matching silence makes Alertmanager
#      suppress notifications for AiCrmApiDownFast (it still shows as
#      firing/suppressed in /api/v2/alerts) — this is the root cause of the
#      "alert fires but webhook-received flakes on a re-run" flake. Expire
#      any such leftover silences before forcing the alert so every run
#      starts from a clean slate regardless of prior runs.
STALE_SILENCES_JSON="$(curl -fsS "http://localhost:${ALERTMANAGER_PORT}/api/v2/silences" 2>/dev/null || true)"
log "--- Alertmanager silences present at run start (pre-existing, expired below if still active) ---"
log "${STALE_SILENCES_JSON}"
STALE_IDS="$(printf '%s' "${STALE_SILENCES_JSON}" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  try {
    const silences = JSON.parse(d);
    for (const s of silences) {
      const matchesAlert = (s.matchers || []).some((m) => m.name === "alertname" && m.value === "AiCrmApiDownFast");
      if (matchesAlert && s.status && s.status.state !== "expired") {
        console.log(s.id);
      }
    }
  } catch {}
});
' 2>/dev/null || true)"
if [[ -n "${STALE_IDS}" ]]; then
  while IFS= read -r sid; do
    [[ -z "${sid}" ]] && continue
    log "Expiring stale pre-existing silence ${sid} (from a previous drill run) before forcing the alert..."
    curl -fsS -X DELETE "http://localhost:${ALERTMANAGER_PORT}/api/v2/silence/${sid}" >>"${RUN_LOG}" 2>&1 || true
  done <<<"${STALE_IDS}"
  record PASS "expired stale pre-existing AiCrmApiDownFast silence(s) from a previous run (would have suppressed webhook delivery)"
else
  record PASS "no stale pre-existing AiCrmApiDownFast silences found"
fi

# --- 8. FORCE an alert: kill the API so the scrape target goes down ---
if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
  log "Killing AI-CRM API harness (pid ${API_PID}) to force the ai-crm-api scrape target down..."
  kill "${API_PID}" 2>/dev/null || true
  wait "${API_PID}" 2>/dev/null || true
  API_PID=""
fi

# --- 9. Assert the fast test alert FIRES in Alertmanager and the webhook-catcher RECEIVES it ---
ALERT_FIRED=0
AM_ALERTS_JSON=""
for _ in $(seq 1 60); do
  AM_ALERTS_JSON="$(curl -fsS "http://localhost:${ALERTMANAGER_PORT}/api/v2/alerts" 2>/dev/null || true)"
  if printf '%s' "${AM_ALERTS_JSON}" | grep -q '"alertname":"AiCrmApiDownFast"'; then
    ALERT_FIRED=1
    break
  fi
  sleep 1
done
log "--- Alertmanager /api/v2/alerts ---"
log "${AM_ALERTS_JSON}"
if [[ "${ALERT_FIRED}" == "1" ]]; then
  record PASS "Alertmanager /api/v2/alerts shows AiCrmApiDownFast firing"
else
  record FAIL "Alertmanager never reported AiCrmApiDownFast firing"
fi

# Bounded, deterministic poll: alertmanager applies group_wait (1s) then
# group_interval (5s) before it POSTs to the webhook receiver. Poll well
# beyond that (45s, checked every 1s) to absorb docker networking / scheduler
# jitter — this is a real retry window, not a weakened assertion: if the
# webhook truly never receives the notification within the window, this
# still FAILs.
WEBHOOK_RECEIVED=0
WEBHOOK_RECEIVED_LOG=""
WEBHOOK_POLL_MAX=45
for _ in $(seq 1 "${WEBHOOK_POLL_MAX}"); do
  if [[ -s "${WEBHOOK_LOG}" ]] && grep -q 'AiCrmApiDownFast' "${WEBHOOK_LOG}"; then
    WEBHOOK_RECEIVED=1
    WEBHOOK_RECEIVED_LOG="$(cat "${WEBHOOK_LOG}")"
    break
  fi
  sleep 1
done
log "--- webhook-catcher received payloads (${WEBHOOK_LOG}) after up to ${WEBHOOK_POLL_MAX}s bounded poll ---"
log "${WEBHOOK_RECEIVED_LOG}"
if [[ "${WEBHOOK_RECEIVED}" == "1" ]]; then
  record PASS "webhook-catcher received the routed AiCrmApiDownFast notification"
else
  log "--- diagnostics: webhook-catcher never received it within ${WEBHOOK_POLL_MAX}s; recent alertmanager container logs ---"
  docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" -f "${OVERRIDE_COMPOSE}" logs --tail=60 alertmanager >>"${RUN_LOG}" 2>&1 || true
  record FAIL "webhook-catcher never received a notification for AiCrmApiDownFast"
fi

# --- 10. PERSISTENCE: write a silence, restart alertmanager, assert it survives ---
SILENCE_ID=""
SILENCE_CREATE_JSON="$(curl -fsS -X POST "http://localhost:${ALERTMANAGER_PORT}/api/v2/silences" \
  -H "content-type: application/json" \
  -d "{\"matchers\":[{\"name\":\"alertname\",\"value\":\"AiCrmApiDownFast\",\"isRegex\":false}],\"startsAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"endsAt\":\"$(date -u -v+10M +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%S.000Z)\",\"createdBy\":\"obs-stack-drill\",\"comment\":\"persistence-proof silence, restart-survival check\"}" \
  2>/dev/null || true)"
log "--- Alertmanager silence create response ---"
log "${SILENCE_CREATE_JSON}"
SILENCE_ID="$(printf '%s' "${SILENCE_CREATE_JSON}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).silenceID||"")}catch{console.log("")}})' 2>/dev/null || true)"
if [[ -n "${SILENCE_ID}" ]]; then
  record PASS "Created Alertmanager silence ${SILENCE_ID} (pre-restart persistence state)"
else
  record FAIL "Failed to create an Alertmanager silence for the persistence check"
fi

log "Restarting alertmanager container (docker compose restart alertmanager)..."
docker compose -p ai-crm-obs-drill -f "${COMPOSE_FILE}" restart alertmanager >>"${RUN_LOG}" 2>&1 || true

SILENCE_SURVIVED=0
SILENCE_AFTER_JSON=""
for _ in $(seq 1 40); do
  SILENCE_AFTER_JSON="$(curl -fsS "http://localhost:${ALERTMANAGER_PORT}/api/v2/silences" 2>/dev/null || true)"
  if [[ -n "${SILENCE_ID}" ]] && printf '%s' "${SILENCE_AFTER_JSON}" | grep -q "\"id\":\"${SILENCE_ID}\""; then
    SILENCE_SURVIVED=1
    break
  fi
  sleep 1
done
log "--- Alertmanager /api/v2/silences after restart ---"
log "${SILENCE_AFTER_JSON}"
if [[ "${SILENCE_SURVIVED}" == "1" ]]; then
  record PASS "Alertmanager silence ${SILENCE_ID} survived 'docker compose restart alertmanager' (volume-backed persistence)"
else
  record FAIL "Alertmanager silence did not survive the restart (persistence not proven)"
fi

log ""
log "=== SUMMARY: ${PASS_N} PASS / ${FAIL_N} FAIL ==="
for r in "${RESULTS[@]}"; do log "  ${r}"; done

if [[ -w "$(dirname "${DOC_PATH}")" || -f "${DOC_PATH}" ]]; then
  {
    echo ""
    echo "## obs-stack-drill run ${RUN_TS}"
    echo ""
    echo "- Result: ${PASS_N} PASS / ${FAIL_N} FAIL"
    echo "- API port: ${AI_CRM_API_PORT}, Prometheus port: ${PROM_PORT}, Grafana port: ${GRAFANA_PORT}, Alertmanager port: ${ALERTMANAGER_PORT}, webhook-catcher port: ${WEBHOOK_PORT}"
    echo '```json'
    echo "${RULES_JSON}"
    echo '```'
    echo '```json'
    echo "${DASHBOARD_JSON}"
    echo '```'
    echo "Alertmanager /api/v2/alerts (firing AiCrmApiDownFast):"
    echo '```json'
    echo "${AM_ALERTS_JSON}"
    echo '```'
    echo "webhook-catcher received payload:"
    echo '```json'
    echo "${WEBHOOK_RECEIVED_LOG}"
    echo '```'
    echo "Alertmanager silence ${SILENCE_ID} after 'docker compose restart alertmanager' (persistence proof):"
    echo '```json'
    echo "${SILENCE_AFTER_JSON}"
    echo '```'
  } >>"${DOC_PATH}" 2>/dev/null || true
fi

if [[ "${FAIL_N}" -gt 0 ]]; then
  exit 1
fi
exit 0
