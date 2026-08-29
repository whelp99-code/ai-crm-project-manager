#!/usr/bin/env bash
set -Eeuo pipefail

: "${AUTH_API_KEY:?AUTH_API_KEY is required}"
: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
: "${OPERATOR_PRINCIPAL_ID:?OPERATOR_PRINCIPAL_ID is required}"

API_URL="${API_URL:-http://127.0.0.1:3001}"
AUTH_HEADERS=(
  -H "Authorization: Bearer $AUTH_API_KEY"
  -H "x-workspace-id: $WORKSPACE_ID"
  -H "x-principal-id: $OPERATOR_PRINCIPAL_ID"
  -H "x-principal-kind: human"
  -H "x-step-up: true"
)

json_value() {
  local expression="$1"
  node -e "const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(0,'utf8')); const v=($expression); process.stdout.write(String(v));"
}

state_v2="$(curl --fail-with-body --silent --show-error "${AUTH_HEADERS[@]}" "$API_URL/api/cwos/v2/state")"
version_v2="$(printf '%s' "$state_v2" | json_value 'x.version')"
principal_count="$(printf '%s' "$state_v2" | json_value 'x.state.identity.principals.length')"

if [[ "$principal_count" == "0" ]]; then
  response="$(curl --fail-with-body --silent --show-error -X POST \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ubuntu-bootstrap-principal-v1" \
    --data-binary @- \
    "$API_URL/api/cwos/v2/commands" <<EOF
{"command":"identity.registerPrincipal","expectedVersion":$version_v2,"payload":{"id":"$OPERATOR_PRINCIPAL_ID","kind":"human","displayName":"Owner","active":true}}
EOF
  )"
  version_v2="$(printf '%s' "$response" | json_value 'x.runtimeVersion')"
  echo "Created bootstrap principal $OPERATOR_PRINCIPAL_ID"
fi

state_v2="$(curl --fail-with-body --silent --show-error "${AUTH_HEADERS[@]}" "$API_URL/api/cwos/v2/state")"
version_v2="$(printf '%s' "$state_v2" | json_value 'x.version')"
membership_count="$(printf '%s' "$state_v2" | PRINCIPAL="$OPERATOR_PRINCIPAL_ID" node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(x.state.identity.memberships.filter((m)=>m.principalId===process.env.PRINCIPAL&&m.status==="ACTIVE").length));')"

if [[ "$membership_count" == "0" ]]; then
  response="$(curl --fail-with-body --silent --show-error -X POST \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ubuntu-bootstrap-membership-v1" \
    --data-binary @- \
    "$API_URL/api/cwos/v2/commands" <<EOF
{"command":"identity.addMembership","expectedVersion":$version_v2,"payload":{"id":"membership-$OPERATOR_PRINCIPAL_ID","principalId":"$OPERATOR_PRINCIPAL_ID"}}
EOF
  )"
  version_v2="$(printf '%s' "$response" | json_value 'x.runtimeVersion')"
  echo "Created active workspace membership"
fi

state_v25="$(curl --fail-with-body --silent --show-error "${AUTH_HEADERS[@]}" "$API_URL/api/cwos/v2.5/state")"
version_v25="$(printf '%s' "$state_v25" | json_value 'x.version')"
if [[ "$version_v25" == "0" ]]; then
  as_of="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  curl --fail-with-body --silent --show-error -X POST \
    "${AUTH_HEADERS[@]}" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ubuntu-bootstrap-manager-v1" \
    --data-binary @- \
    "$API_URL/api/cwos/v2.5/manager/run" >/dev/null <<EOF
{"expectedVersion":0,"snapshot":{"workspaceId":"$WORKSPACE_ID","asOf":"$as_of","engagements":[],"commitments":[],"financialItems":[],"changeRequests":[],"assets":[],"clarifications":[]},"thresholds":{"staleDays":7,"marginFloorBps":1500,"clarificationAgeDays":1}}
EOF
  echo "Initialized the v2.5 Today briefing"
fi

echo "Bootstrap completed."
