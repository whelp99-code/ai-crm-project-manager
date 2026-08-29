#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: RESTORE_CONFIRM=RESTORE_AI_CRM_PM bash deploy/ubuntu/scripts/restore.sh <backup.dump>" >&2
  exit 2
fi
if [[ "${RESTORE_CONFIRM:-}" != "RESTORE_AI_CRM_PM" ]]; then
  echo "ERROR: set RESTORE_CONFIRM=RESTORE_AI_CRM_PM to acknowledge destructive restore" >&2
  exit 3
fi

DUMP="$(realpath "$1")"
if [[ ! -f "$DUMP" ]]; then
  echo "ERROR: backup not found: $DUMP" >&2
  exit 4
fi
if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum --check "$(basename "$DUMP").sha256")
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

echo "Stopping application services"
dc stop web api worker

echo "Recreating database $POSTGRES_DB"
dc exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v dbname="$POSTGRES_DB" <<'SQL'
SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
 WHERE datname = :'dbname'
   AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'dbname') \gexec
SELECT format('CREATE DATABASE %I', :'dbname') \gexec
SQL

echo "Restoring $DUMP"
# ACLs are restored with the data so the runtime API, worker, model gateway and
# auditor recover their exact least-privilege grants. Object ownership remains
# portable because the backup was produced with --no-owner.
cat "$DUMP" | dc exec -T postgres pg_restore \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --no-owner \
  --exit-on-error

echo "Reapplying migration checks and role credentials"
dc run --rm migrate

echo "Restarting services"
dc up -d api web worker
for attempt in $(seq 1 60); do
  if dc exec -T api curl --fail --silent http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    echo "ERROR: API did not recover after restore" >&2
    dc logs --tail=200 api
    exit 5
  fi
  sleep 2
done

dc exec -T api bash deploy/ubuntu/scripts/seed.sh
bash "$SCRIPT_DIR/verify.sh"
echo "Restore completed successfully."
