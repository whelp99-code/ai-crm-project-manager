# Core5 C01 — live CWOS v2 storage / command path

Traced 2026-09-20 on branch `core5-c01-c02` from `pilot/cwos-pilot-01`. Operational path is Customer Work OS **v2 only**. v1 CWOS HTTP modules exist as test-only dead code.

## Operational call chain

```
createApp (apps/api/src/app.ts)
  └─ createBaseApp (apps/api/src/app-base.ts)   # v1 auth/pools/hooks; not the CWOS v2 SoR
  └─ registerCustomerWorkOsV2Routes(app, { databaseUrl? })
       apps/api/src/customer-work-os-v2-routes.ts
         actor(request)  ← x-principal-id, x-workspace-id, x-principal-kind, x-step-up
         GET  /api/cwos/v2/state
         GET  /api/cwos/v2/readiness
         POST /api/cwos/v2/commands
              └─ CustomerWorkOsV2RuntimeManager
                   apps/api/src/customer-work-os-v2-runtime-manager.ts
                   read / readAuthorized / command
                     ├─ assertV2ActorCanRead / assertV2ActorCanCommand / executeV2Command
                     │    apps/api/src/customer-work-os-v2-runtime-commands.ts
                     │    → CustomerWorkOsV2Platform (@ai-crm/domain/customer-work-os-v2)
                     └─ CwosV2StateStore.compareAndSwap
                          InMemoryCwosV2StateStore  (default; tests / no DSN)
                          PgCwosV2StateStore        (onReady when databaseUrl set and store not injected)
                            apps/api/src/customer-work-os-v2-runtime-store.ts
                            tables: cwos_v2_runtime_snapshots, cwos_v2_audit_events
                            GUC: set_config('app.workspace_id', workspaceId, true) in withWorkspaceScope
```

Barrel: `apps/api/src/customer-work-os-v2-runtime.ts` re-exports core, store, commands, manager.

Envelope / hash helpers: `apps/api/src/customer-work-os-v2-runtime-core.ts`
(`V2RuntimeEnvelope.schemaVersion = 1`, nested `state.schemaVersion = 2`).

Domain: `packages/domain/src/customer-work-os-v2/{platform,identity,psa,inbox,connectors,graphs,ai,portal,admin,operations,shared}.ts`.

## Custom store injection

`CustomerWorkOsV2RouteOptions` (`customer-work-os-v2-routes.ts`):

| Option | Effect |
| --- | --- |
| `store` | If set, **always** used. PG pool is **not** opened even when `databaseUrl` is present. |
| `databaseUrl` | Used only when `store` is omitted. Route registration does **not** read `DATABASE_URL` itself. |
| `now` | Clock for envelope `updatedAt` / audit `createdAt`. |

`createApp` (`app.ts`) passes `options.databaseUrl` or `process.env.DATABASE_URL` into route registration. Tests inject `InMemoryCwosV2StateStore` or a scoped `PgCwosV2StateStore`.

`createStandaloneCustomerWorkOsV2App` builds a Fastify app with **only** v2 routes (no app-base auth gate).

PG wiring: `onReady` constructs `pg.Pool` + `scopedPool` (`BEGIN` / `set_config('app.workspace_id')` / `COMMIT`) / `PgCwosV2StateStore` / new `CustomerWorkOsV2RuntimeManager`. `onClose` closes the manager and pool.

PostgreSQL workspaces **must** be UUID (`UUID_PATTERN` in store); in-memory store accepts any string workspace id.

## v1 vs operational (do not treat as live)

Imported **only by tests**, not by `app.ts`:

- `apps/api/src/customer-work-os-routes.ts`
- `customer-work-os-routes-durable.ts`
- `customer-work-os-runtime.ts`
- `customer-work-os-identity.ts` (`StaticCustomerWorkOsIdentityResolver`, `PgCustomerWorkOsIdentityResolver` on `principals` table)
- `customer-work-os-policy.ts`, `customer-work-os-controls.ts`
- `customer-work-os-ai-store.ts`, `customer-work-os-notion.ts`

Docs/samples that describe CWOS conceptually but are **not** the live HTTP SoR: `docs/customer-work-os/releases/v2.0.0-implementation.md` (handoff; matches this path), older v1 identity/role samples, planning under `docs/planning/customer-work-os-v3/`.

v1 `app-base.ts` still owns API-key `onRequest`, CRM/PM/finance routes, and header `x-principal-id` for **those** surfaces. CWOS v2 actor binding is **separate** (route-local `actor()`).

## Persistence schema (authoritative)

Migration: `packages/persistence/migrations/0019_customer_work_os_v2_runtime.sql`

- `cwos_v2_runtime_snapshots`: PK `workspace_id uuid`; `version`, `schema_version=1`, `state jsonb` (domain aggregate), `idempotency jsonb`, `state_hash`, `updated_by_principal_id`, `updated_at`. FORCE RLS on `app.workspace_id`. No DELETE (trigger).
- `cwos_v2_audit_events`: PK `(workspace_id, sequence)`; unique `(workspace_id, operation_id)`, `(workspace_id, idempotency_key)`; hash-chain columns; FORCE RLS; UPDATE/DELETE denied.

Grants (if roles exist): `ai_crm_runtime_api` / `ai_crm_runtime_worker` SELECT/INSERT(/UPDATE snapshots); `ai_crm_audit_verifier` SELECT. **No** `ai_crm_runtime_model_gateway`.

There is **no** first-class `customers` / `projects` / `work_items` table on this path. CRM customers and PM projects live on v1/domain adapters. CWOS v2 SoR is the snapshot JSON + audit chain.

## Locked baseline IDs (C01)

Use these in Core5 follow-on work unless a later doc supersedes them.

| Kind | ID | Notes |
| --- | --- | --- |
| Workspace (PG / livepg) | `b1111111-1111-4111-8111-111111111111` | `apps/api/test/customer-work-os-v2.livepg.integration.test.ts` |
| Workspace (in-memory tests) | `workspace-v2` | not valid for `PgCwosV2StateStore` |
| Bootstrap human principal | `owner-livepg` / `owner-1` | livepg vs in-memory |
| Customer entity | **n/a on v2 runtime path** | not a snapshot column; do not invent a CRM customer UUID as SoR |
| Project entity | **n/a on v2 runtime path** | PSA `projectId` is a string inside `state.psa` after `psa.assign`, not a table PK |
| Work / command operation | `operationId` on audit row (manager-generated) | plus HTTP `Idempotency-Key` |

Domain state shape (`CustomerWorkOsV2State`): `schemaVersion: 2`, `workspaceId`, nested `identity`, `psa`, `inbox`, `connectors`, `graphs`, `ai`, `portal`, `admin`, `operations`, `milestones`, `findings`, `releaseManifests`.

Runtime envelope: `schemaVersion: 1`, `workspaceId`, `version` (CAS), `state`, `idempotency[]`, `stateHash`, `updatedByPrincipalId`, `updatedAt`.

## HTTP actor (pre-C02)

Headers: `x-principal-id` (required), `x-workspace-id` (required), `x-principal-kind` (defaults to `human` if omitted), `x-step-up` (`true` for bootstrap/step-up), `idempotency-key` on POST.

Authz after load: `principalForActor` matches registered `IdentityPrincipal.kind`; empty workspace requires step-up human + `identity.registerPrincipal` of that same human.

## Tests that prove this path

- `apps/api/test/customer-work-os-v2-runtime.integration.test.ts` — in-memory CAS, idempotency, audit chain
- `apps/api/test/customer-work-os-v2.livepg.integration.test.ts` — `LIVE_PG_TEST=1`; Pg store + migration 0019
- `packages/persistence/test/customer-work-os-v2-runtime.security.test.ts` — SQL FORCE RLS / append-only contract
