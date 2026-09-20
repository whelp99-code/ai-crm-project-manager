# Core5 C02 — bind principal, bot human-spoof, RLS

## Auth principal

CWOS v2 actor is bound in `actor()` (`apps/api/src/customer-work-os-v2-routes.ts`):

- `x-principal-id` required
- `x-workspace-id` required
- `x-principal-kind` **required** (`human` | `ai` | `service`). Omitted kind is `INVALID_HEADER` (400). Kind is **not** defaulted to `human`.
- `x-step-up: true` for bootstrap / step-up commands

After load, `principalForActor` (`customer-work-os-v2-runtime-commands.ts`) requires an active registered principal whose `kind` matches the header (`PRINCIPAL_KIND_MISMATCH` otherwise).

This path does **not** reuse v1 `customer-work-os-identity.ts` or the app-base API-key principal helper. API-key `onRequest` in `app-base.ts` still gates mutating `/api/*` when `AUTH_API_KEY` is set, including `/api/cwos/v2/commands`.

## Bot human-spoof

If `x-bot-id` is present and `x-principal-kind` is `human`, the route fails closed with `HUMAN_SPOOF` (403). Bots must use `ai` or `service`.

## RLS (non-owner)

Migration `0019` FORCE RLS on `cwos_v2_runtime_snapshots` / `cwos_v2_audit_events` using `app.workspace_id`.

No Testcontainers suite existed in this repo. Regression added instead:

- Always-on: `apps/api/test/customer-work-os-v2-auth.security.test.ts`
- Live PG (`LIVE_PG_TEST=1`): `FORCE RLS hides snapshots from a NOBYPASSRLS non-owner without the workspace GUC` in `customer-work-os-v2.livepg.integration.test.ts` (creates `cwos_v2_rls_probe` when permitted; no-ops on permission denied)
- SQL contract: `packages/persistence/test/customer-work-os-v2-runtime.security.test.ts`

## Tests

```bash
pnpm --filter @ai-crm/api exec vitest run test/customer-work-os-v2-auth.security.test.ts test/customer-work-os-v2-runtime.integration.test.ts
```
