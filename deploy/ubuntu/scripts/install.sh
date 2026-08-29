#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DEPLOY_DIR/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/install-docker.sh"
fi

bash "$SCRIPT_DIR/generate-env.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/common.sh"

cd "$ROOT_DIR"

echo "[1/6] Building application image"
dc build --pull

echo "[2/6] Starting PostgreSQL"
dc up -d postgres

echo "[3/6] Applying database migrations"
dc run --rm migrate

echo "[4/6] Starting API, Web and Worker"
dc up -d api web worker

for attempt in $(seq 1 60); do
  if dc exec -T api curl --fail --silent http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == "60" ]]; then
    echo "ERROR: API did not become healthy" >&2
    dc logs --tail=200 api
    exit 5
  fi
  sleep 2
done

echo "[5/6] Bootstrapping the workspace"
dc exec -T api bash deploy/ubuntu/scripts/seed.sh

echo "[6/6] Running post-deployment verification"
bash "$SCRIPT_DIR/verify.sh"

server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

Customer Work OS v2.5.0 is running on Ubuntu.

The web port is bound to Ubuntu localhost for safety.
From your Mac, open an SSH tunnel:

  ssh -L ${WEB_PORT:-3000}:127.0.0.1:${WEB_PORT:-3000} ${USER}@${server_ip:-SERVER_IP}

Then open:

  http://localhost:${WEB_PORT:-3000}/capture
  http://localhost:${WEB_PORT:-3000}/review
  http://localhost:${WEB_PORT:-3000}/today

Project directory:
  $ROOT_DIR
EOF
