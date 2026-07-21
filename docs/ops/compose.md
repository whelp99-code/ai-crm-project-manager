# Docker Compose — Postgres 16

Local system-of-record dependency for AI-CRM pilot work. API and worker stay
process-local; compose only brings up Postgres.

## One command

```bash
# from repo root
docker compose up -d
```

Stop / reset volume (destructive):

```bash
docker compose down
# wipe data volume
docker compose down -v
```

## Service

| Item | Value |
|---|---|
| File | repo-root `docker-compose.yml` |
| Image | `postgres:16` |
| Service name | `postgres` |
| Host port | `5432` |
| Database | `ai_crm` |
| User | `ai_crm` |
| Password | `ai_crm_dev` |
| Volume | `pgdata` → `/var/lib/postgresql/data` |
| Healthcheck | `pg_isready -U ai_crm -d ai_crm` |

## Connection string

```bash
export DATABASE_URL=postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm
```

Use only for this host's local pilot. Do not point smokes at unrelated compose
stacks (other project ports).

## Verify

```bash
docker compose ps
docker compose exec postgres pg_isready -U ai_crm -d ai_crm
psql "$DATABASE_URL" -c 'select 1'
```

API readiness (after API boot with `DATABASE_URL`):

```bash
curl -sS http://127.0.0.1:3001/health   # { "status": "ok" }
curl -sS http://127.0.0.1:3001/ready    # { "status": "ready" } or 503 not_ready
```

(Port depends on how you start `apps/api`; probes are path-based.)

## Related

- Backup/restore drill — `docs/ops/backup-restore.md`
- PG RLS smoke — `docs/ops/pg-rls-smoke.md`
