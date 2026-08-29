#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"

if [[ -f "$ENV_FILE" && "${FORCE_REGENERATE_ENV:-0}" != "1" ]]; then
  echo "Environment already exists: $ENV_FILE"
  exit 0
fi

random_hex() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

workspace_id="$(cat /proc/sys/kernel/random/uuid)"
umask 077
cat > "$ENV_FILE" <<EOF
POSTGRES_DB=ai_crm
POSTGRES_USER=ai_crm
POSTGRES_PASSWORD=$(random_hex)
RUNTIME_API_DB_PASSWORD=$(random_hex)
RUNTIME_WORKER_DB_PASSWORD=$(random_hex)
MODEL_GATEWAY_DB_PASSWORD=$(random_hex)
AUDIT_VERIFIER_DB_PASSWORD=$(random_hex)
AUTH_API_KEY=$(random_hex)
WORKSPACE_ID=$workspace_id
OPERATOR_PRINCIPAL_ID=owner-1
WEB_PORT=3000
WORKER_INTERVAL_MS=60000
MODEL_PROVIDER=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_AUTH_MODE=api-key
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=2024-08-01-preview
AZURE_OPENAI_ASSUME_ZERO_RETENTION=0
EOF
chmod 600 "$ENV_FILE"

echo "Created secure environment: $ENV_FILE"
echo "Workspace: $workspace_id"
