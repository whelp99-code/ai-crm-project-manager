# API authentication (T-017)

Fail-closed API key gate for `apps/api`, layered on top of existing
workspace/principal headers.

## Modes

| Mode | When | Behavior |
|---|---|---|
| **Dev principal headers** | `AUTH_API_KEY` and `API_AUTH_TOKEN` both **unset** | Existing behavior: `x-workspace-id` required on workspace routes; `x-principal-id` required on agent mutating routes. No shared secret. **Local/dev only.** |
| **API key (fail-closed)** | `AUTH_API_KEY` **or** `API_AUTH_TOKEN` is set (non-empty) | Mutating `/api/*` methods (`POST`/`PATCH`/`DELETE`/`PUT`) and **all** `/api/agent/*` routes require a matching key via `x-api-key` **or** `Authorization: Bearer <token>`. Missing/wrong → **401** `UNAUTHENTICATED`. |

`CreateAppOptions.authApiKey` overrides env for tests.

## Headers (always relevant)

| Header | Role |
|---|---|
| `x-workspace-id` | Tenant binding (existing) |
| `x-principal-id` | Operator principal on agent commands/cancel/complete (existing) |
| `x-api-key` | Shared secret when API key mode is on |
| `Authorization: Bearer …` | Alternate shared-secret carrier when API key mode is on |

API key authentication does **not** replace principal/workspace headers. Agent
routes still reject missing `x-principal-id` after the key check.

## Env

| Var | Process | Notes |
|---|---|---|
| `AUTH_API_KEY` | api | Preferred shared secret |
| `API_AUTH_TOKEN` | api | Alias; used if `AUTH_API_KEY` empty |

Production / Gate B pilot should set one of these. Never commit real values.

## Tests

`apps/api/test/authn.integration.test.ts` — key required when configured;
wrong/missing key → 401; agent without principal still fails; dev mode without
key still accepts principal headers.

## Production fail-closed (G-07)

When `NODE_ENV=production` and no `AUTH_API_KEY`/`API_AUTH_TOKEN`/`authApiKey` is configured, `createApp` **throws `[AUTH_REQUIRED_IN_PROD]` and refuses to start** — a production deploy can never silently run unauthenticated. The only escape is an explicit, audited insecure bring-up via `ALLOW_INSECURE_PROD=1` (or `allowInsecureProd: true`), which downgrades to dev header-principal mode and emits `[AUTH_DISABLED_IN_PROD]`. Covered by `apps/api/test/prod-auth.integration.test.ts`.
