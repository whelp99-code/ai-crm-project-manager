# Runtime-role DSN, admin DSN split, and production auth/finance requirements (G-05)

See `docs/ops/pilot-runbook.md` section (b) for the exact, copy-paste pilot
env block (with `CHANGE_ME` placeholders) that applies this DSN split, plus
`packages/persistence/scripts/pilot-preflight.sh`, which verifies it live.

This doc is the operator-facing summary of "what DSN goes where, and what
must be configured before `apps/api` runs in production." It ties together
three already-implemented contracts:

- G-01 admin/runtime DSN role separation (`docs/ops/sor-persistence.md`).
- `ai_crm_runtime_api` (`NOBYPASSRLS`) isolation, proven live by
  `packages/persistence/scripts/pg-rls-smoke.sh` (`docs/ops/pg-rls-smoke.md`).
- T-017 fail-closed API-key auth (`docs/ops/authn.md`) and the S3 finance
  pack fail-closed gate (`docs/ops/finance-pack-pilot.md`).

See `.env.example` (repo root) and `apps/web/.env.example` for copy-paste
templates of every variable named below.

## Two DSNs, two roles, two purposes

| Env var | `CreateAppOptions` field | Role it MUST point at | Used for |
|---|---|---|---|
| `DATABASE_URL` | `databaseUrl` | `ai_crm_runtime_api` (`NOBYPASSRLS`) | Every per-request, workspace-scoped read/write. Runs through `createScopedPgQueryable` (`SET LOCAL`-equivalent `app.workspace_id` GUC per connection, per request) so FORCE RLS on `orch_jobs` / `orch_work_items` / `orch_job_events` / `orch_governance_controls` / `orch_governance_intents` actually isolates workspaces. |
| `ADMIN_DATABASE_URL` | `adminDatabaseUrl` | Cross-workspace-capable role (bootstrap superuser in dev, a dedicated `BYPASSRLS` role in production) | Hydrate-on-boot ONLY: `listAllControls()` / `listAllIntents()` / `listJobSnapshots()` (no workspace arg). Never used for per-request traffic. |

**Why two roles**: the runtime role is `NOBYPASSRLS` by design (see
`0001_foundation.sql` / `0003_orchestration.sql` /
`0004_governance_snapshot.sql`) so a bug in request-path code cannot read or
write another workspace's rows even if the workspace-scoping GUC is somehow
wrong. Only the boot-time hydrate path — which by definition must see every
workspace's rows to rebuild in-memory state — gets a role that can bypass
RLS, and that role is never on the hot path for a live request.

`ADMIN_DATABASE_URL` unset falls back to the main `DATABASE_URL` pool (dev
default: the docker bootstrap `ai_crm` superuser bypasses RLS incidentally).
**Production must not rely on this fallback** — set both DSNs explicitly to
different roles. Full narrative: `docs/ops/sor-persistence.md`.

## Proving `ai_crm_runtime_api` isolation

`packages/persistence/scripts/pg-rls-smoke.sh` (see `docs/ops/pg-rls-smoke.md`
for the exact procedure and the latest run log) is the live proof this split
is real, not just documented:

1. Asserts FORCE RLS flags on all five orch/governance tables.
2. Asserts `app_current_workspace_id()` raises when the GUC is unset
   (fail-closed).
3. Under `SET ROLE ai_crm_runtime_api` (the same `NOBYPASSRLS` role
   `DATABASE_URL` should point at), inserts under two workspace UUIDs and
   proves: workspace A cannot select workspace B's rows, and a
   cross-workspace insert is denied.

Run it against the `ai_crm` docker database (not sangfor/unified) whenever
the runtime-role grants or RLS policies change:

```bash
./packages/persistence/scripts/pg-rls-smoke.sh
```

## Production requirements checklist (G-05 fail-closed contract)

A production deployment of `apps/api` MUST have all of the following, or it
is running in a documented dev-mode gap:

1. **`DATABASE_URL` points at `ai_crm_runtime_api` (`NOBYPASSRLS`)** — not
   the bootstrap/admin role. Verified live by pg-rls-smoke.sh.
2. **`ADMIN_DATABASE_URL` points at a separate cross-workspace-capable
   role**, distinct from the runtime role — see the table above.
3. **`AUTH_API_KEY` (or `API_AUTH_TOKEN`) is set.** When set, `createApp`'s
   `aiCrm.authMode` resolves to `"apikey"` and mutating `/api/*` +
   all `/api/agent/*` routes fail closed (401 `UNAUTHENTICATED`) without a
   matching `x-api-key`/`Authorization: Bearer` — see `docs/ops/authn.md`.
   **When `NODE_ENV=production` and no key is configured**, `createApp`
   still boots in dev header-principal mode (`aiCrm.authMode === "dev"`) so
   it never breaks existing non-prod callers/tests that construct
   `createApp()` with no auth options — but it logs a structured
   `console.warn("[AUTH_DISABLED_IN_PROD] ...")` on boot so this
   misconfiguration is observable in logs/alerts rather than silent. Treat
   that warning as a deploy-blocking signal in production, not a soft
   suggestion.
4. **`DEV_UNSIGNED_FINANCE_PACK` is NOT set**, and no unsigned
   `financePack`/`allowUnsignedFinancePack: true` is passed to `createApp`.
   Without a signed finance pack, `/api/finance/*` routes stay fail-closed
   (503 `FINANCE_PACK_UNSET`) — see `docs/ops/finance-pack-pilot.md`. This
   holds regardless of `NODE_ENV`; production is expected to always be in
   this posture unless a signed pack is supplied.

Tests: `apps/api/test/prod-auth.integration.test.ts` asserts (1) `authMode`
resolves to `"apikey"` and 401 without a key when `authApiKey` is
configured under `NODE_ENV=production`; (2) `authMode` stays `"dev"` and the
`[AUTH_DISABLED_IN_PROD]` warning fires when no key is configured under
`NODE_ENV=production` (and does NOT fire outside production, or when a key
is configured); (3) finance routes stay 503 `FINANCE_PACK_UNSET` under
`NODE_ENV=production` with no signed pack. `apps/api/test/authn.integration.test.ts`
and `apps/api/test/s3-finance.integration.test.ts` cover the underlying
non-prod-framed behavior these tests build on.

## Web app envs

`apps/web` is a pure read-mostly Next.js shell: every server component fails
closed (renders an "unavailable" panel, never fabricated data) when its
required env is unset. See `apps/web/.env.example`:

- `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL` — base URL of the `apps/api`
  instance.
- `WORKSPACE_ID` / `NEXT_PUBLIC_WORKSPACE_ID` — tenant binding sent as
  `x-workspace-id`.
- `DEMO_CUSTOMER_ID` — the 360 overview page's fixed demo customer id.

The web app never issues a domain `PATCH`/`POST` directly; all mutations go
through `POST /api/agent/commands` (see `work/work-client.tsx`,
`s1-create-work-client.tsx`) or the governance decide endpoint
(`approvals/decide-client.tsx`, `POST .../decide`, not a domain PATCH). The
pilot monitor page (`apps/web/app/monitor/page.tsx`) is read-only: it only
calls `GET /metrics`, which requires no API key (same posture as `/health`
— see `apps/api/src/app.ts`) and exposes counts, not tenant data.

## Prod auth is fail-closed (G-07)

`createApp` refuses to start (`[AUTH_REQUIRED_IN_PROD]`) when `NODE_ENV=production` and no API key is configured. Set `AUTH_API_KEY` (preferred) or, for an audited insecure bring-up only, `ALLOW_INSECURE_PROD=1`.
