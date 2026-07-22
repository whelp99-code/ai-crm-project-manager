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


## D10: node build matrix + branch protection (P6-b PG-G)

### node build matrix (DONE, observed-green)
`.github/workflows/ci.yml` runs the `test` job as a matrix over **node [20, 22]** on `ubuntu-latest` with `fail-fast: false`, so every push gets a cross-node-version signal (offline suites + web tsc + playwright e2e + pg-rls-smoke + live-pg gated + restore-drill on each leg). Observed-green on the real GitHub Actions runner:
- Run `29842406397` — conclusion **success**, both legs green:
  - `Package tests + web typecheck + e2e (node 20)` — success
  - `Package tests + web typecheck + e2e (node 22)` — success
- URL: https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29842406397

### branch protection required status check (HUMAN-BLOCKED — GitHub plan)
Configuring a required-status-check on `master` (so a PR cannot merge unless both matrix legs pass) is **blocked by a GitHub platform limitation**, not by this repo:

```
PUT /repos/whelp99-code/ai-crm-project-manager/branches/master/protection
-> HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."
```

The repo is **private** on the **free** plan; branch protection (classic) and rulesets are Pro-gated for private repos. This is a **user decision** (the agent kept the repo private to protect the code and will not change visibility or purchase a plan unilaterally). To enable it, the user must EITHER:
1. Upgrade the GitHub account to **Pro** (keeps the repo private), OR
2. Make the repo **public** (branch protection then works on the free plan — exposes the code).

Once enabled, set it with:
```bash
gh api -X PUT repos/whelp99-code/ai-crm-project-manager/branches/master/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=Package tests + web typecheck + e2e (node 20)' \
  -f 'required_status_checks[contexts][]=Package tests + web typecheck + e2e (node 22)' \
  -f 'enforce_admins=false' -f 'required_pull_request_reviews=' -f 'restrictions='
```

**Honest status:** the node matrix (the substantive D10 lift) is delivered + observed-green; the required-status-check *enforcement* is human-blocked on the GitHub plan/visibility decision.
