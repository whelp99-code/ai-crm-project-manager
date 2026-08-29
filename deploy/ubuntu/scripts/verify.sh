#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

failures=0
check() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name" >&2
    failures=$((failures + 1))
  fi
}

check "API health" dc exec -T api curl --fail --silent http://127.0.0.1:3001/healthz
check "Web capture page" curl --fail --silent "http://127.0.0.1:${WEB_PORT:-3000}/capture" -o /dev/null
check "Web review page" curl --fail --silent "http://127.0.0.1:${WEB_PORT:-3000}/review" -o /dev/null
check "Web Today page" curl --fail --silent "http://127.0.0.1:${WEB_PORT:-3000}/today" -o /dev/null

migration_count="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc 'SELECT count(*) FROM public.schema_migrations')"
if [[ "$migration_count" =~ ^[0-9]+$ ]] && (( migration_count >= 20 )); then
  echo "PASS  SQL migrations ($migration_count applied)"
else
  echo "FAIL  SQL migrations ($migration_count applied)" >&2
  failures=$((failures + 1))
fi

state="$(dc exec -T api curl --fail --silent \
  -H "Authorization: Bearer $AUTH_API_KEY" \
  -H "x-workspace-id: $WORKSPACE_ID" \
  -H "x-principal-id: $OPERATOR_PRINCIPAL_ID" \
  -H "x-principal-kind: human" \
  -H "x-step-up: true" \
  http://127.0.0.1:3001/api/cwos/v2.5/state)"
state_workspace="$(printf '%s' "$state" | node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(x.workspaceId);')"
state_version="$(printf '%s' "$state" | node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(String(x.version));')"
if [[ "$state_workspace" == "$WORKSPACE_ID" ]] && [[ "$state_version" =~ ^[0-9]+$ ]] && (( state_version >= 1 )); then
  echo "PASS  v2.5 durable state (workspace=$state_workspace version=$state_version)"
else
  echo "FAIL  v2.5 durable state" >&2
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  echo "$failures verification check(s) failed." >&2
  dc ps
  exit 1
fi

echo "All deployment checks passed."
dc ps
