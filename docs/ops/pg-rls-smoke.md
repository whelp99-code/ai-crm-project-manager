# PG RLS smoke (SEC-06 live)

Live verification that orchestration + governance snapshot + CRM + outbox
consumer tables on the AI-CRM docker Postgres enforce `ENABLE` +
`FORCE ROW LEVEL SECURITY` and workspace isolation via
`app_current_workspace_id()` / GUC `app.workspace_id`.

## Procedure

### Prerequisites

- Docker compose Postgres for this host only:
  - container: `ai-crmprojectmanager-postgres-1`
  - port: `localhost:5432`
  - db/user/password: `ai_crm` / `ai_crm` / `ai_crm_dev`
- Do **not** point this smoke at sangfor (`:5434`) or unified (`:5433`).
- `psql` on PATH.

### Run

```bash
# from repo root
./packages/persistence/scripts/pg-rls-smoke.sh
```

Optional env overrides (still must target `ai_crm` on `:5432` unless
`AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1`):

```bash
PGHOST=localhost PGPORT=5432 PGUSER=ai_crm PGPASSWORD=ai_crm_dev PGDATABASE=ai_crm \
  ./packages/persistence/scripts/pg-rls-smoke.sh
```

### What it does

1. Connects only to `ai_crm` on the configured host/port (refuses other DB names).
2. Ensures `schema_migrations` exists; backfills entries when objects already
   exist; applies `0001`..`0006` only when not yet recorded (`0004` adds the
   governance snapshot tables, `0005` adds `crm_customers`, `0006` adds the
   outbox consumer's `outbox_consumer_offsets` / `outbox_consumed_events` —
   see `docs/ops/sor-persistence.md` and `docs/ops/worker.md`).
3. Asserts `relrowsecurity` + `relforcerowsecurity` on all seven RLS-enabled
   tables: `orch_jobs`, `orch_work_items`, `orch_job_events`,
   `orch_governance_controls`, `orch_governance_intents`, `crm_customers`,
   `outbox_consumed_events`.
4. Asserts `app_current_workspace_id()` exists, reads GUC `app.workspace_id`,
   and fails closed when unset.
5. Asserts `workspace_isolation` policies on all seven of those tables.
6. When `SET ROLE ai_crm_runtime_api` is possible (dev bootstrap superuser is
   granted membership for the smoke), inserts `orch_jobs`,
   `orch_governance_controls`, and `crm_customers` rows under two workspace
   UUIDs and proves select isolation + cross-workspace insert denial (all
   three tables) + missing-GUC raise. When `SET ROLE ai_crm_runtime_worker`
   is possible (the role that actually holds `outbox_consumed_events`'
   grants — `ai_crm_runtime_api` has none), does the same select isolation +
   cross-workspace insert denial proof for `outbox_consumed_events`.
7. Appends a **Last run** section below with PASS/FAIL lines and timestamps.

### Limitation

Migration SQL creates runtime roles with `PASSWORD NULL` and does not store
credentials. On the stock docker bootstrap user (`ai_crm`, superuser), the smoke
uses `SET ROLE ai_crm_runtime_api` / `SET ROLE ai_crm_runtime_worker`
(both NOBYPASSRLS) after one-shot `GRANT <role> TO CURRENT_USER` calls. If
membership cannot be granted for a role, FORCE RLS flags and function checks
still run; that role's isolation DML is marked SKIP.

### Reset (optional, destructive to ai_crm only)

```bash
docker exec -i ai-crmprojectmanager-postgres-1 \
  psql -U ai_crm -d ai_crm -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ai_crm; GRANT ALL ON SCHEMA public TO public;'
# then re-run the smoke script to apply 0001..0006 cleanly
./packages/persistence/scripts/pg-rls-smoke.sh
```

## Last run log


### 2026-07-19T12:56:04Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=10 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T12-56-04Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T12:56:10Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=10 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T12-56-10Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T12:58:01Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=10 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T12-58-01Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T12:58:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=10 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T12-58-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T13:06:53Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=10 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T13-06-53Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:21:42Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-21-42Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — applied
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:22:56Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-22-56Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:23:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-23-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:23:59Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-23-59Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:25:17Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-25-17Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:27:24Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=11 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-27-24Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 3/3 on orch_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events')
ORDER BY 1;
```

Result (this run):

```
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:39:59Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-39-59Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:40:04Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-40-04Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:42:03Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-42-03Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:42:07Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-42-07Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:42:56Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-42-56Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:42:58Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-42-58Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:45:06Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-45-06Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:45:06Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-45-06Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:49:57Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-49-57Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:51:25Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-51-25Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:52:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-52-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:58:31Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-58-31Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T14:59:50Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T14-59-50Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T16:35:03Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T16-35-03Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T16:35:05Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T16-35-05Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T16:35:05Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T16-35-05Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:46:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-46-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:48:45Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-48-45Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:49:21Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-49-21Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:49:49Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-49-49Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:49:54Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-49-54Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-19T23:49:54Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-49-54Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:50:17Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-50-17Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-19T23:50:17Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-50-17Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:50:25Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-50-25Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:51:32Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-51-32Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-19T23:51:32Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-51-32Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:51:33Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-51-33Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-19T23:52:42Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-19T23-52-42Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:22:45Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-22-45Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:22:46Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-22-46Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:31:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-31-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T00:31:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-31-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:35:57Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-35-57Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:37:26Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-37-26Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:38:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-38-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:39:33Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-39-33Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:39:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-39-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T00:39:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-39-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:39:39Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-39-39Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:39:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-39-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:40:02Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-40-02Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T00:40:02Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-40-02Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:40:02Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-40-02Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:40:10Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-40-10Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:40:52Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-40-52Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:51:59Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-51-59Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:53:29Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-53-29Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T00:53:31Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=12 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T00-53-31Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 5/5 on orch_*/orch_governance_*
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:21:13Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-21-13Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — applied
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:22:39Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-22-39Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:23:48Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-23-48Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:23:52Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-23-52Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T01:23:52Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-23-52Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:23:52Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-23-52Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:23:53Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-23-53Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:25:40Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-25-40Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T01:25:40Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-25-40Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:25:40Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-25-40Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:25:41Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-25-41Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:25:43Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-25-43Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:27:03Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-27-03Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:27:04Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-27-04Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:35:18Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-35-18Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:35:19Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-35-19Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:42:12Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-42-12Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:42:12Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-42-12Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:42:12Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-42-12Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T01:42:13Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T01-42-13Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:18Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-18Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T05:59:18Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-18Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:18Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-18Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:18Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-18Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T05:59:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T05:59:37Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T05-59-37Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:00:53Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-00-53Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:00:55Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-00-55Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:00:56Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-00-56Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:00:57Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-00-57Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:01:19Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-01-19Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:15:42Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-15-42Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:15:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-15-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:15:45Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-15-45Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:15:46Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-15-46Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:55:00Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-55-00Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:57:24Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-57-24Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:58:58Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-58-58Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T06:59:13Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T06-59-13Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:00:56Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-00-56Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T07:00:56Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-00-56Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:01:03Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-01-03Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:19:21Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-19-21Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T07:19:21Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-19-21Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:20:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-20-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T07:20:38Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-20-38Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:22:28Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-22-28Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T07:22:28Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-22-28Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T07:30:44Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=14 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T07-30-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 6/6 on orch_*/orch_governance_*/crm_customers
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:02:10Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-02-10Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — applied
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:02:15Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-02-15Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:02:22Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-02-22Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T14:02:22Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-02-22Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:04:07Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-04-07Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```

### 2026-07-20T14:04:07Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-04-07Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:04:07Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-04-07Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:05:52Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-05-52Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:05:58Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-05-58Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:06:27Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-06-27Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:06:28Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-06-28Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:06:30Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-06-30Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:06:30Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-06-30Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:07:47Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-07-47Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-20T14:07:48Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-20T14-07-48Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-21T04:32:43Z — FAIL

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=1 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-32-43Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
FAIL | outbox_consumed_events isolation insert/select — unexpected output
```


### 2026-07-21T04:32:45Z — FAIL

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=1 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-32-45Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
FAIL | outbox_consumed_events isolation insert/select — unexpected output
```


### 2026-07-21T04:33:10Z — FAIL

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=1 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-33-10Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
FAIL | outbox_consumed_events isolation insert/select — unexpected output
```


### 2026-07-21T04:34:44Z — FAIL

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=15 FAIL=1 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-34-44Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
FAIL | outbox_consumed_events isolation insert/select — unexpected output
```


### 2026-07-21T04:35:10Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=16 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-35-10Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
PASS | outbox_consumed_events isolation insert/select — SET ROLE ai_crm_runtime_worker; A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```

### 2026-07-21T04:35:11Z — PASS

- Host: `ai_crm@localhost:5432/ai_crm`
- Script: `packages/persistence/scripts/pg-rls-smoke.sh`
- Counts: PASS=16 FAIL=0 SKIP=0
- Full transcript: `/var/folders/f0/tbqwy3mn7rj7vy2j7ts0gxhr0000gn/T//ai-crm-pg-rls-smoke/run-2026-07-21T04-35-11Z.log`

```
PASS | connectivity — ai_crm as ai_crm super=true
PASS | migration 0001_foundation — already applied (schema_migrations)
PASS | migration 0002_model_gateway_and_break_glass_roles — already applied (schema_migrations)
PASS | migration 0003_orchestration — already applied (schema_migrations)
PASS | migration 0004_governance_snapshot — already applied (schema_migrations)
PASS | migration 0005_crm_customers — already applied (schema_migrations)
PASS | migration 0006_outbox_consumer — already applied (schema_migrations)
PASS | FORCE RLS flags — relrowsecurity/relforcerowsecurity true/true on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | app_current_workspace_id() — function exists
PASS | GUC name — app.workspace_id (via current_setting)
PASS | fail-closed unset GUC — app_current_workspace_id() raises when app.workspace_id unset
PASS | workspace_isolation policies — 7/7 on orch_*/orch_governance_*/crm_customers/outbox_consumed_events
PASS | workspace isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; A/B isolated; cleanup done
PASS | governance isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; orch_governance_controls A/B isolated + cross-workspace insert denied; cleanup done
PASS | crm isolation insert/select — runtime role SET ROLE ai_crm_runtime_api; crm_customers A/B isolated + cross-workspace insert denied; cleanup done
PASS | outbox_consumed_events isolation insert/select — SET ROLE ai_crm_runtime_worker; A/B isolated + cross-workspace insert denied; cleanup done
```

FORCE RLS evidence query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('orch_jobs','orch_work_items','orch_job_events','orch_governance_controls','orch_governance_intents')
ORDER BY 1;
```

Result (this run):

```
orch_governance_controls relrowsecurity=true relforcerowsecurity=true
orch_governance_intents relrowsecurity=true relforcerowsecurity=true
orch_job_events relrowsecurity=true relforcerowsecurity=true
orch_jobs relrowsecurity=true relforcerowsecurity=true
orch_work_items relrowsecurity=true relforcerowsecurity=true
```
