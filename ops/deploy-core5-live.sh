#!/usr/bin/env bash
# Repeatable core5 live deploy. Does not apply migrations or write application data.
# Refuses to switch if the new tree declares a required migration the DB has not applied.
set -euo pipefail

REF="${1:?usage: deploy-core5-live.sh <git-ref>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${CORE5_NODE_BIN:-${HOME}/.nvm/versions/node/v22.23.2/bin/node}"
NODE_DIR="$(dirname "$NODE_BIN")"
PNPM_BIN="${NODE_DIR}/pnpm"
APP_ROOT="${CORE5_APP_ROOT:-${HOME}/.local/share/core5}"
ENV_FILE="${CORE5_ENV_FILE:-${HOME}/.config/core5/app.env}"
BACKUP_DIR="${CORE5_BACKUP_DIR:-${HOME}/.local/state/omonyang/core5-backups}"
UNIT_DIR="${HOME}/.config/systemd/user"
API_UNIT="${UNIT_DIR}/core5-api.service"
WEB_UNIT="${UNIT_DIR}/core5-web.service"
PROXY_UNIT="${UNIT_DIR}/core5-tailscale-proxy.service"
REPO_URL="${CORE5_REPO_URL:-https://github.com/whelp99-code/ai-crm-project-manager.git}"
HEALTH_URL="${CORE5_HEALTH_URL:-http://127.0.0.1:4312}"
WEB_URL="${CORE5_WEB_URL:-http://127.0.0.1:4313}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PG_DUMP="${CORE5_PG_DUMP:-/home/jm/.local/pg-bootstrap/extract16/usr/lib/postgresql/16/bin/pg_dump}"
if [[ ! -x "$PG_DUMP" ]]; then
  PG_DUMP="$(command -v pg_dump || true)"
fi
if [[ -z "$PG_DUMP" || ! -x "$PG_DUMP" ]]; then
  echo "refusing: pg_dump not found" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "refusing: Node 22 binary missing at $NODE_BIN" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "refusing: $NODE_BIN is Node $NODE_MAJOR, engines require 22" >&2
  exit 1
fi
if [[ ! -x "$PNPM_BIN" ]]; then
  echo "refusing: pnpm missing next to Node 22 ($PNPM_BIN)" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "refusing: env file missing" >&2
  exit 1
fi

export PATH="${NODE_DIR}:/usr/bin:/bin:${PATH}"
umask 077

resolve_sha() {
  if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$REF"
    return
  fi
  local line
  line="$(git ls-remote "$REPO_URL" "refs/heads/${REF}" "refs/tags/${REF}" | awk 'NR==1 {print $1}')"
  if [[ -z "$line" ]]; then
    echo "refusing: cannot resolve ref ${REF}" >&2
    exit 1
  fi
  printf '%s\n' "$line"
}

SHA="$(resolve_sha)"
SHORT="${SHA:0:7}"
DEST="${APP_ROOT}/app-${SHORT}"
PREV_API_WD="$(awk -F= '/^WorkingDirectory=/{print $2; exit}' "$API_UNIT")"
PREV_ROOT="$(dirname "$(dirname "$PREV_API_WD")")"
UNIT_BACKUP="${BACKUP_DIR}/units-${STAMP}"

echo "deploy ref=${REF} sha=${SHA} dest=${DEST}"
echo "previous tree=${PREV_ROOT}"

if [[ -d "$DEST" ]]; then
  echo "refusing: ${DEST} already exists" >&2
  exit 1
fi

mkdir -p "$APP_ROOT" "$BACKUP_DIR" "$UNIT_BACKUP"
cp -a "$API_UNIT" "$WEB_UNIT" "$UNIT_BACKUP/"
if [[ -f "$PROXY_UNIT" ]]; then
  cp -a "$PROXY_UNIT" "$UNIT_BACKUP/"
fi

# DB backup before any switch. Custom format, mode 0600. No restore here.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
DUMP_URL="${ADMIN_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$DUMP_URL" ]]; then
  echo "refusing: DATABASE_URL missing in env file" >&2
  exit 1
fi
DUMP_PATH="${BACKUP_DIR}/ai_crm-before-deploy-${SHORT}-${STAMP}.dump"
"$PG_DUMP" --format=custom --no-owner --file="$DUMP_PATH" "$DUMP_URL"
chmod 0600 "$DUMP_PATH"
echo "backup ${DUMP_PATH} bytes=$(wc -c < "$DUMP_PATH") mode=$(stat -c %a "$DUMP_PATH")"

git clone --quiet "$REPO_URL" "$DEST"
git -C "$DEST" checkout --quiet "$SHA"
rm -rf "$DEST/.git"
printf '%s\n' "$SHA" > "$DEST/.deploy-sha"

required_migrations() {
  python3 - "$DEST" << 'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
found = []
for path in root.joinpath("apps/api").rglob("*"):
    if path.suffix not in {".ts", ".mts", ".js"}:
        continue
    text = path.read_text(errors="ignore")
    found.extend(re.findall(r'requiredMigration\s*=\s*"([^"]+)"', text))
extra = root / "ops" / "core5-required-migrations.txt"
if extra.exists():
    found.extend(line.strip() for line in extra.read_text().splitlines() if line.strip() and not line.startswith("#"))
for item in dict.fromkeys(found):
    print(item)
PY
}

mapfile -t REQUIRED < <(required_migrations)
if [[ ${#REQUIRED[@]} -eq 0 ]]; then
  echo "refusing: no required migrations declared in ${DEST}" >&2
  exit 1
fi
echo "required migrations: ${REQUIRED[*]}"

(
  cd "$DEST"
  # app.env sets NODE_ENV=production, which would omit the TypeScript next build needs.
  NODE_ENV=development pnpm install --frozen-lockfile
)

MISSING="$(cd "$DEST/apps/api" && node --input-type=module - "$DUMP_URL" "${REQUIRED[@]}" << 'JS'
import pg from "pg";
const url = process.argv[2];
const required = process.argv.slice(3);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const result = await pool.query("SELECT id FROM schema_migrations");
  const applied = new Set(result.rows.map((row) => row.id));
  for (const item of required) {
    if (!applied.has(item)) console.log(item);
  }
} finally {
  await pool.end();
}
JS
)"
if [[ -n "$MISSING" ]]; then
  echo "refusing: unapplied required migrations:" >&2
  echo "$MISSING" >&2
  echo "tree left at ${DEST}; units not switched" >&2
  exit 1
fi
echo "migration check ok"

(
  cd "$DEST"
  pnpm --filter @ai-crm/web build
)

switched=0
rollback() {
  local status=$?
  if [[ "$switched" != "1" ]]; then
    exit "$status"
  fi
  echo "health failed; rolling back to ${PREV_ROOT}" >&2
  cp -a "${UNIT_BACKUP}/core5-api.service" "$API_UNIT"
  cp -a "${UNIT_BACKUP}/core5-web.service" "$WEB_UNIT"
  if [[ -f "${UNIT_BACKUP}/core5-tailscale-proxy.service" ]]; then
    cp -a "${UNIT_BACKUP}/core5-tailscale-proxy.service" "$PROXY_UNIT"
  fi
  systemctl --user daemon-reload
  systemctl --user restart core5-api.service core5-web.service
  if [[ -f "$PROXY_UNIT" ]]; then
    systemctl --user restart core5-tailscale-proxy.service
  fi
  sleep 2
  curl -fsS "${HEALTH_URL}/health" >/dev/null || echo "rollback health check failed" >&2
  exit 1
}
trap rollback ERR

python3 - "$API_UNIT" "$WEB_UNIT" "$PROXY_UNIT" "$DEST" "$SHORT" "$NODE_DIR" << 'PY'
import pathlib, sys
api, web, proxy, dest, short, node_dir = sys.argv[1:]
pnpm = f"{node_dir}/pnpm"
node = f"{node_dir}/node"

path_env = f"Environment=PATH={node_dir}:/usr/bin:/bin"

def rewrite(path, description, workdir, execstart):
    file = pathlib.Path(path)
    if not file.exists():
        return
    lines = []
    saw_path = False
    for line in file.read_text().splitlines():
        if line.startswith("Description="):
            line = f"Description={description}"
        elif line.startswith("WorkingDirectory="):
            line = f"WorkingDirectory={workdir}"
        elif line.startswith("ExecStart="):
            line = f"ExecStart={execstart}"
        elif line.startswith("Environment=PATH="):
            line = path_env
            saw_path = True
        lines.append(line)
        if line.startswith("EnvironmentFile=") and not saw_path:
            lines.append(path_env)
            saw_path = True
    if not saw_path:
        lines.append(path_env)
    file.write_text("\n".join(lines) + "\n")

# Invoke node directly so pnpm's `#!/usr/bin/env node` cannot pick v24 from the manager PATH.
rewrite(
    api,
    f"core5 API ({short}) on localhost",
    f"{dest}/apps/api",
    f"{node} {pnpm} exec tsx ops-boot.mts",
)
rewrite(
    web,
    f"core5 web ({short}) on localhost",
    f"{dest}/apps/web",
    f"{node} {pnpm} exec next start -H 127.0.0.1 -p 4313",
)
proxy_path = pathlib.Path(proxy)
if proxy_path.exists():
    text = proxy_path.read_text().splitlines()
    exec_line = next((line for line in text if line.startswith("ExecStart=")), "")
    rest = exec_line.split("/bin/node ", 1)[1] if "/bin/node " in exec_line else "/home/jm/.config/core5/bind-proxy.mjs"
    rewrite(proxy, "core5 Tailscale bind proxy (100.87.81.57 only)", "", f"{node} {rest}")
    # proxy has no WorkingDirectory requirement; drop an empty assignment if rewrite added one
    fixed = []
    for line in pathlib.Path(proxy).read_text().splitlines():
        if line == "WorkingDirectory=":
            continue
        fixed.append(line)
    pathlib.Path(proxy).write_text("\n".join(fixed) + "\n")
PY

systemctl --user daemon-reload
switched=1
systemctl --user restart core5-api.service core5-web.service
if [[ -f "$PROXY_UNIT" ]]; then
  systemctl --user restart core5-tailscale-proxy.service
fi
sleep 3

wait_http() {
  local url="$1"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "refusing: ${url} did not become ready" >&2
  return 1
}
wait_http "${HEALTH_URL}/health"
curl -fsS "${HEALTH_URL}/health" | grep -q '"status":"ok"'
curl -fsS "${HEALTH_URL}/ready" | grep -q '"status":"ready"'
COUNT="$(curl -fsS \
  -H "authorization: Bearer ${AUTH_API_KEY}" \
  -H "x-workspace-id: ${WORKSPACE_ID}" \
  "${HEALTH_URL}/api/cwos/accounts" | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])')"
echo "accounts count=${COUNT}"
wait_http "${WEB_URL}/accounts"
curl -fsS "${WEB_URL}/accounts" | python3 -c 'import re,sys; count=sys.argv[1]; html=re.sub(r"<!--.*?-->", "", sys.stdin.read());
raise SystemExit(0 if f"계정 {count}" in html else 1)' "$COUNT"
trap - ERR
echo "deploy ok sha=${SHA} count=${COUNT} backup=${DUMP_PATH}"
