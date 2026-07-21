# CI (G-04)

`.github/workflows/ci.yml` runs on every `push` and `pull_request`, on a
single `ubuntu-latest` job named `test`, with a `postgres:16` service
container (`ai_crm` / `ai_crm` / `ai_crm_dev` on `localhost:5432`,
health-checked with `pg_isready` before later steps run).

## Job steps (in order)

1. Checkout, `pnpm/action-setup` (pinned pnpm version), `actions/setup-node`
   (Node 22, pnpm cache).
2. `pnpm install --frozen-lockfile=false`.
3. Package test suites, one `pnpm --filter <pkg> test` step each, in this
   order: `@ai-crm/persistence`, `@ai-crm/governance`, `@ai-crm/orchestration`,
   `@ai-crm/api`, `@ai-crm/worker`. These run in memory-backed mode (no
   `DATABASE_URL`/`LIVE_PG_TEST`) — the Postgres service container is up but
   unused by this pass, so PG-gated tests stay skipped here and the suite
   stays fast and deterministic.
4. `pnpm --filter @ai-crm/web exec tsc --noEmit` — web typecheck.
5. `pnpm --filter @ai-crm/web exec playwright install --with-deps chromium`,
   then `pnpm --filter @ai-crm/web test:e2e`.
6. **Live-pg gate**: `./packages/persistence/scripts/pg-rls-smoke.sh` against
   the service container (`DATABASE_URL`/`PGHOST`/`PGPORT`/`PGUSER`/
   `PGPASSWORD`/`PGDATABASE` all pointed at `ai_crm`@`localhost:5432`). This
   script is idempotent: it applies migrations `0001`..`0004` under a
   `schema_migrations` tracking table (skipping any already applied) and then
   asserts FORCE RLS flags, the `app_current_workspace_id()` GUC contract,
   `workspace_isolation` policies, and cross-workspace insert/select
   isolation on the `orch_*` / `orch_governance_*` tables.
7. With migrations now applied and `LIVE_PG_TEST=1` + `DATABASE_URL` set,
   re-run `pnpm --filter @ai-crm/api test` and `pnpm --filter @ai-crm/worker
   test` so the `*.live-pg.integration.test.ts` suites (skipped in step 3)
   execute against the real Postgres instance: `apps/api/test/
   sor-restart-livepg.integration.test.ts` (G-01 restart-consistent SoR) and
   `apps/worker/test/worker-durable.live-pg.integration.test.ts` (G-02 durable
   lease recovery).

## Running the same checks locally

```bash
# 1. package suites (memory mode, no postgres needed)
pnpm --filter @ai-crm/persistence test
pnpm --filter @ai-crm/governance test
pnpm --filter @ai-crm/orchestration test
pnpm --filter @ai-crm/api test
pnpm --filter @ai-crm/worker test

# 2. web typecheck
pnpm --filter @ai-crm/web exec tsc --noEmit

# 3. web e2e (installs Chromium the first time)
pnpm --filter @ai-crm/web exec playwright install --with-deps chromium
pnpm --filter @ai-crm/web test:e2e

# 4. bring up the AI-CRM postgres (docker-compose.yml, port 5432, db ai_crm)
docker compose up -d postgres

# 5. live-pg RLS smoke (applies migrations 0001..0004 idempotently)
PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
  ./packages/persistence/scripts/pg-rls-smoke.sh

# 6. live-pg gated tests (skipped by default; opt in explicitly)
DATABASE_URL=postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm LIVE_PG_TEST=1 \
  pnpm --filter @ai-crm/api test
DATABASE_URL=postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm LIVE_PG_TEST=1 \
  pnpm --filter @ai-crm/worker test
```

## Honest limitations

- Every test file whose name contains `live-pg` (and `apps/api/test/
  sor-restart-livepg.integration.test.ts`) uses `describe.skipIf(!LIVE)` where
  `LIVE = process.env.LIVE_PG_TEST === "1"`. Without a running Postgres +
  `LIVE_PG_TEST=1`, those suites report as **skipped**, not failed — a green
  `pnpm --filter @ai-crm/api test` run alone does **not** prove the real-SoR
  restart or RLS isolation paths work; only the CI job's dedicated live-pg
  step (or the local step 6 above) proves that.
- `pg-rls-smoke.sh` refuses to run against anything except a database named
  `ai_crm` on port `5432` (override the port only via
  `AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1`) — this is a deliberate guard against
  pointing it at an unrelated local Postgres instance.
- The workspace-isolation DML assertions inside the smoke script require the
  `ai_crm_runtime_api` role to exist and be grantable to the connecting user
  (true for the docker-compose bootstrap and the CI service container); if
  that role is missing those specific checks report `SKIP`, not `PASS`, while
  the FORCE RLS/policy/function checks still run and can still fail the
  script.
