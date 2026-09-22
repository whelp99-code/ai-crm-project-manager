# API authentication (T-017)

Fail-closed API key gate for `apps/api`, layered on top of existing
workspace/principal headers.

## Modes

| Mode | When | Behavior |
|---|---|---|
| **Dev principal headers** | `AUTH_API_KEY` and `API_AUTH_TOKEN` both **unset** | Existing behavior: `x-workspace-id` required on workspace routes; `x-principal-id` required on agent mutating routes. No shared secret. **Local/dev only.** |
| **API key (fail-closed)** | `AUTH_API_KEY` **or** `API_AUTH_TOKEN` is set (non-empty) | Mutating `/api/*` methods (`POST`/`PATCH`/`DELETE`/`PUT`), **all** `/api/agent/*`, and **all** `/api/cwos/v2/*` routes require a matching key via `x-api-key` **or** `Authorization: Bearer <token>`. Missing/wrong → **401** `UNAUTHENTICATED`. |

`CreateAppOptions.authApiKey` overrides env for tests.

## Headers (always relevant)

| Header | Role |
|---|---|
| `x-workspace-id` | Tenant binding (existing) |
| `x-principal-id` | Operator principal on agent commands/cancel/complete (existing) |
| `x-api-key` | Shared secret when API key mode is on |
| `Authorization: Bearer …` | Alternate shared-secret carrier when API key mode is on |

API key authentication does **not** replace principal/workspace headers on the
legacy API surfaces. Agent routes still reject missing `x-principal-id` after
the key check.

### CWOS v2 pilot operator binding

CWOS v2 supports a stricter single-operator pilot mode. Configure all three
server-side values together with the API key:

```bash
CWOS_V2_OPERATOR_WORKSPACE_ID=<workspace UUID>
CWOS_V2_OPERATOR_PRINCIPAL_ID=<human principal id>
CWOS_V2_OPERATOR_STEP_UP_VERIFIED=1
```

In this mode every `/api/cwos/v2/*` request requires the API key, including
GETs. `x-workspace-id`, `x-principal-id`, and `x-principal-kind: human` must
match the server binding exactly; mismatches fail with 403
`ACTOR_BINDING_MISMATCH`. The server rejects any caller-supplied `x-step-up`
with 403 `UNTRUSTED_STEP_UP`. `stepUpVerified` comes only from
`CWOS_V2_OPERATOR_STEP_UP_VERIFIED`, so the bootstrap command can use step-up
authority without trusting a request header.

This is an explicit one-key/one-human/one-workspace pilot boundary, not OIDC
and not a multi-user identity system. A binding without an API key fails boot;
a partial environment binding also fails boot. Dev mode without a binding
retains the existing explicit-header behavior for tests and local development.

## Env

| Var | Process | Notes |
|---|---|---|
| `AUTH_API_KEY` | api | Preferred shared secret |
| `API_AUTH_TOKEN` | api | Alias; used if `AUTH_API_KEY` empty |
| `CWOS_V2_OPERATOR_WORKSPACE_ID` | api | Workspace bound to the pilot API key; set with both values below |
| `CWOS_V2_OPERATOR_PRINCIPAL_ID` | api | Human principal bound to the pilot API key |
| `CWOS_V2_OPERATOR_STEP_UP_VERIFIED` | api | Server-side `0` or `1`; caller headers cannot override it |

Production / Gate B pilot should set one of these. Never commit real values.

## Tests

`apps/api/test/authn.integration.test.ts` — key required when configured;
wrong/missing key → 401; agent without principal still fails; dev mode without
key still accepts principal headers.

`apps/api/test/customer-work-os-v2-auth.security.test.ts` — a bound pilot key
rejects forged principal/workspace and caller-asserted step-up, while a
header-matched bootstrap succeeds using only the server-side step-up value.

## Production fail-closed (G-07)

When `NODE_ENV=production` and no `AUTH_API_KEY`/`API_AUTH_TOKEN`/`authApiKey` is configured, `createApp` **throws `[AUTH_REQUIRED_IN_PROD]` and refuses to start** — a production deploy can never silently run unauthenticated. The only escape is an explicit, audited insecure bring-up via `ALLOW_INSECURE_PROD=1` (or `allowInsecureProd: true`), which downgrades to dev header-principal mode and emits `[AUTH_DISABLED_IN_PROD]`. Covered by `apps/api/test/prod-auth.integration.test.ts`.
