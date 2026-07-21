# Backup / restore drill (Postgres 16)

Pilot ops template for the AI-CRM docker Postgres volume. This is a **drill
checklist**, not an automated HA runbook. Target is the compose service defined
in repo-root `docker-compose.yml` (`postgres:16`, db/user `ai_crm`).

## One-command Postgres up

```bash
# from repo root
docker compose up -d
```

See `docs/ops/compose.md` for ports, credentials, and healthcheck.

Default connection (local only — never commit real production secrets):

| Item | Value |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `ai_crm` |
| User | `ai_crm` |
| Password | `ai_crm_dev` |
| URL | `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm` |

Container name is typically `ai-crmprojectmanager-postgres-1` (compose project
prefix may vary). Prefer `docker compose exec postgres …` over hard-coded names.

## Backup (`pg_dump`)

Logical dump of the `ai_crm` database (schema + data). Run from a machine that
can reach the compose Postgres port.

```bash
# Ensure Postgres is up
docker compose up -d
docker compose exec postgres pg_isready -U ai_crm -d ai_crm

# Timestamped custom-format dump (recommended)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="./backups/ai_crm-${STAMP}.dump"
mkdir -p ./backups

docker compose exec -T postgres \
  pg_dump -U ai_crm -d ai_crm -Fc --no-owner --no-acl \
  > "$OUT"

ls -lh "$OUT"
```

Plain SQL alternative (human-readable, larger):

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres \
  pg_dump -U ai_crm -d ai_crm --no-owner --no-acl \
  > "./backups/ai_crm-${STAMP}.sql"
```

### What to capture in the drill log

| Field | Example |
|---|---|
| Date (UTC) | `2026-07-19T15:00:00Z` |
| Operator | |
| Compose project / host | |
| Dump path + bytes | |
| `pg_dump` exit code | `0` |
| Notes | migrations applied, app quiesced? |

## Restore drill

**Destructive to the target database.** Prefer a scratch database or a disposable
compose volume. Do not point this at shared/prod without change control.

### A. Restore into a scratch database (safer)

```bash
DUMP=./backups/ai_crm-YYYYMMDDTHHMMSSZ.dump

docker compose exec -T postgres \
  psql -U ai_crm -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ai_crm_restore_drill;" \
  -c "CREATE DATABASE ai_crm_restore_drill OWNER ai_crm;"

# custom format
cat "$DUMP" | docker compose exec -T postgres \
  pg_restore -U ai_crm -d ai_crm_restore_drill --no-owner --no-acl --exit-on-error

docker compose exec -T postgres \
  psql -U ai_crm -d ai_crm_restore_drill -c '\dt' -c 'SELECT count(*) FROM schema_migrations;'
```

### B. Full replace of `ai_crm` (lab only)

```bash
DUMP=./backups/ai_crm-YYYYMMDDTHHMMSSZ.dump

# Stop API/worker writers first (manual).
docker compose exec -T postgres \
  psql -U ai_crm -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ai_crm' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE ai_crm;" \
  -c "CREATE DATABASE ai_crm OWNER ai_crm;"

cat "$DUMP" | docker compose exec -T postgres \
  pg_restore -U ai_crm -d ai_crm --no-owner --no-acl --exit-on-error
```

Plain SQL restore:

```bash
cat ./backups/ai_crm-YYYYMMDDTHHMMSSZ.sql | docker compose exec -T postgres \
  psql -U ai_crm -d ai_crm -v ON_ERROR_STOP=1
```

### Post-restore checks

1. `pg_isready -U ai_crm -d ai_crm`
2. `SELECT version_id FROM schema_migrations ORDER BY 1;` matches expected migrations
3. Optional: `./packages/persistence/scripts/pg-rls-smoke.sh` (FORCE RLS still on)
4. API: `GET /health` → `{ "status": "ok" }`, `GET /ready` → `{ "status": "ready" }` with `DATABASE_URL` set
5. Spot-check one workspace-scoped row count vs pre-dump note

## Drill log template

```text
Date (UTC):
Operator:
Host / compose project:
Pre-dump notes (migration heads, row samples):
Dump command:
Dump path / size:
pg_dump exit:
Restore target (scratch db name or full replace):
pg_restore/psql exit:
Post-checks (migrations / RLS smoke /ready):
PASS|FAIL:
Follow-ups:
```

## Boundaries

| In scope | Out of scope (v2) |
|---|---|
| Logical `pg_dump` / `pg_restore` | PITR, WAL shipping, multi-region |
| Compose local volume | Managed cloud snapshots |
| Documented operator drill | — |
| Automated CI restore-drill gate (N-15/D12, `restore-drill.sh`) | Nightly/scheduled drift-detection drill |

## Related

- Compose — `docs/ops/compose.md`, `docker-compose.yml`
- RLS smoke — `docs/ops/pg-rls-smoke.md`
- Health/ready — `GET /health`, `GET /ready` on `apps/api`

## Automated restore-drill (N-15/D12)

`packages/persistence/scripts/restore-drill.sh` automates the scratch-db
restore drill above for CI (and local use): real `pg_dump` of `ai_crm` ->
`CREATE DATABASE ai_crm_restore_drill` -> `pg_restore` into it -> verify
(`SELECT count(*)` on `orch_jobs`, `audit_events`, `crm_customers`, plus
`schema_migrations` row count) -> `DROP DATABASE` the scratch db. Idempotent
(safe to re-run; pre-drops any leftover scratch db) and refuses to run
against anything that is not `PGDATABASE=ai_crm` on a local host/5432 (same
guard posture as `pg-rls-smoke.sh`).

Client/server major-version skew is handled automatically: if the host's
`pg_dump`/`pg_restore` are older than the live server, the script transparently
execs into the running Postgres container (`docker exec`) that publishes
`PGPORT`, so the dump/restore always run at matching version — this works
the same way locally and inside the GitHub Actions `services: postgres`
container.

```bash
packages/persistence/scripts/restore-drill.sh
# or against a non-default local port/host:
PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
  packages/persistence/scripts/restore-drill.sh
```

Exit 0 = PASS, non-zero = FAIL. Every run appends a timestamped PASS/FAIL
section (with the transcript path) below in this file. Wired into
`.github/workflows/ci.yml` as the `Restore drill (N-15/D12)` step, gated on
the same `postgres:16` service used by the live-pg tests.

## Automated restore-drill run log

### 2026-07-20T01:38:48Z — restore-drill FAIL

- Host: `ai_crm@localhost:5432/ai_crm`
- Scratch db: `ai_crm_restore_drill`
- Script: `packages/persistence/scripts/restore-drill.sh`
- Counts: PASS=2 FAIL=1
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/run-2026-07-20T01-38-48Z.log`

```
PASS | connectivity — ai_crm@localhost:5432/ai_crm
FAIL | pg_dump — pg_dump exited non-zero
PASS | cleanup — dropped ai_crm_restore_drill
```


### 2026-07-20T01:40:13Z — restore-drill PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Scratch db: `ai_crm_restore_drill`
- Script: `packages/persistence/scripts/restore-drill.sh`
- Counts: PASS=8 FAIL=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/run-2026-07-20T01-40-13Z.log`

```
PASS | connectivity — ai_crm@localhost:5432/ai_crm
PASS | pg_dump — mode=docker /var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/ai_crm-2026-07-20T01-40-13Z.dump (80096 bytes)
PASS | pg_restore — mode=docker restored into ai_crm_restore_drill
PASS | verify:orch_jobs — SELECT 1 ok, row count=0
PASS | verify:audit_events — SELECT 1 ok, row count=0
PASS | verify:crm_customers — SELECT 1 ok, row count=0
PASS | verify:schema_migrations — count=5
PASS | cleanup — dropped ai_crm_restore_drill
```


### 2026-07-20T01:40:17Z — restore-drill PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Scratch db: `ai_crm_restore_drill`
- Script: `packages/persistence/scripts/restore-drill.sh`
- Counts: PASS=8 FAIL=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/run-2026-07-20T01-40-17Z.log`

```
PASS | connectivity — ai_crm@localhost:5432/ai_crm
PASS | pg_dump — mode=docker /var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/ai_crm-2026-07-20T01-40-17Z.dump (80096 bytes)
PASS | pg_restore — mode=docker restored into ai_crm_restore_drill
PASS | verify:orch_jobs — SELECT 1 ok, row count=0
PASS | verify:audit_events — SELECT 1 ok, row count=0
PASS | verify:crm_customers — SELECT 1 ok, row count=0
PASS | verify:schema_migrations — count=5
PASS | cleanup — dropped ai_crm_restore_drill
```


### 2026-07-20T01:43:57Z — restore-drill PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Scratch db: `ai_crm_restore_drill`
- Script: `packages/persistence/scripts/restore-drill.sh`
- Counts: PASS=8 FAIL=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/run-2026-07-20T01-43-57Z.log`

```
PASS | connectivity — ai_crm@localhost:5432/ai_crm
PASS | pg_dump — mode=docker /var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/ai_crm-2026-07-20T01-43-57Z.dump (80096 bytes)
PASS | pg_restore — mode=docker restored into ai_crm_restore_drill
PASS | verify:orch_jobs — SELECT 1 ok, row count=0
PASS | verify:audit_events — SELECT 1 ok, row count=0
PASS | verify:crm_customers — SELECT 1 ok, row count=0
PASS | verify:schema_migrations — count=5
PASS | cleanup — dropped ai_crm_restore_drill
```


### 2026-07-20T01:45:18Z — restore-drill PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Scratch db: `ai_crm_restore_drill`
- Script: `packages/persistence/scripts/restore-drill.sh`
- Counts: PASS=8 FAIL=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/run-2026-07-20T01-45-18Z.log`

```
PASS | connectivity — ai_crm@localhost:5432/ai_crm
PASS | pg_dump — mode=docker /var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-restore-drill/ai_crm-2026-07-20T01-45-18Z.dump (80096 bytes)
PASS | pg_restore — mode=docker restored into ai_crm_restore_drill
PASS | verify:orch_jobs — SELECT 1 ok, row count=0
PASS | verify:audit_events — SELECT 1 ok, row count=0
PASS | verify:crm_customers — SELECT 1 ok, row count=0
PASS | verify:schema_migrations — count=5
PASS | cleanup — dropped ai_crm_restore_drill
```

