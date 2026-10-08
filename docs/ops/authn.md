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

### CWOS v2 human operator binding and per-request step-up

The maintained Core5 H boot (`apps/api/src/ops-boot.ts`) uses a fail-closed
human operator binding and `OperatorStepUpService`. It requires an API key,
server-bound workspace/principal, distinct API/admin/model-gateway database
roles, and the existing private authentication files described below.
`WORKSPACE_ID` must match `CWOS_V2_OPERATOR_WORKSPACE_ID`; missing production
actor binding fails with `CWOS_V2_ACTOR_BINDING_REQUIRED_IN_PROD`.

In this mode every `/api/cwos/v2/*` request requires the API key, including
GETs. `x-workspace-id`, `x-principal-id`, and `x-principal-kind: human` must
match the server binding exactly; mismatches fail with 403
`ACTOR_BINDING_MISMATCH`. The server rejects any caller-supplied `x-step-up`
with 403 `UNTRUSTED_STEP_UP`. Step-up authority comes from the authenticated
server session, not an environment flag or a request-header assertion.

The old pilot `CWOS_V2_OPERATOR_STEP_UP_VERIFIED=1` instruction is obsolete:
H boot explicitly rejects it with `OPS_BOOT_STEP_UP_ENV_FORBIDDEN`. Unset
that flag; setting it to `0` also does not authenticate an operator.
An API key and matching headers alone do not establish personal step-up.
The server verifies the existing password and current TOTP through
`POST /api/cwos/v2/operator-step-up`, then issues a short-lived scoped
cookie/proof. Later requests are authorized individually; mutating requests
also require the matching CSRF token. Do not forge a cookie, set `x-step-up`,
or weaken the guard to make readiness or bootstrap succeed.

`CWOS_V2_OPERATOR_AUTH_STATE_PATH` must identify an existing regular,
non-symlink private authentication file. `operator-auth-store.ts` validates
its pre-enrolled record (`enrolled: true`, `totpPending: false`, password/TOTP
material and rate-limit state). A missing or malformed record fails closed;
boot does not enroll an owner or repair it with fake credentials.
`CWOS_V2_OPERATOR_SESSION_SECRET_FILE` must identify an existing private
regular file containing the session secret. These files must not be readable
by group/other, and the session secret must be at least 32 characters.
Do not publish their contents, infer their paths, or create replacement
authentication material as part of a documentation or deployment check.

One owner step, only after the actual access path is prepared: the owner
submits the existing password and current TOTP once through the operator's
verified HTTPS endpoint and private HTTP client/input path. The POST API
contract is not a shipped GET login screen. If the real endpoint/client or
pre-enrolled files are unconfirmed, report preparation incomplete instead
of inventing a login URL/button. Keep credentials out of chat, issues and logs.

This is an explicit one-key/one-human/one-workspace pilot boundary, not OIDC
and not a multi-user identity system. Deliberate test/development standalone
fixtures retain their explicit-header behavior; that is not a production
step-up grant or evidence of a prepared operating H profile.

## Env

| Var | Process | Notes |
|---|---|---|
| `AUTH_API_KEY` | api | Preferred shared secret |
| `API_AUTH_TOKEN` | api | Alias; used if `AUTH_API_KEY` empty |
| `CORE5_API_MODE` | api boot | `human` for H; this is a mode, not authentication proof |
| `DATABASE_URL` / `ADMIN_DATABASE_URL` / `MODEL_GATEWAY_DATABASE_URL` | api boot | Distinct PostgreSQL profiles and roles; never alias them to bypass missing inputs |
| `WORKSPACE_ID` / `CWOS_V2_OPERATOR_WORKSPACE_ID` | api boot | Same actual workspace, bound to the human API key |
| `CWOS_V2_OPERATOR_PRINCIPAL_ID` | api | Human principal bound to the pilot API key |
| `CWOS_V2_OPERATOR_AUTH_STATE_PATH` | api boot | Confirmed path of the existing private pre-enrolled authentication record |
| `CWOS_V2_OPERATOR_SESSION_SECRET_FILE` | api boot | Confirmed path of the existing private session-secret file |
| `CWOS_V2_OPERATOR_STEP_UP_VERIFIED` | legacy pilot only | Obsolete for operating H; `1` is rejected by H boot, and `0` grants no authority |

Production H requires the admitted inputs above and real per-request proof.
Never commit real credentials or treat a path/permission observation as proof
that authentication or an operating transition has completed.

## Tests

### Dedicated Mail account-master admission

After approval and deployment, set `CWOS_V2_MAIL_READER_ACCOUNT_MASTER_GET=1`
only in the admitted BLRO Mail reader profile. Its existing dedicated key,
`WORKSPACE_ID` and `CWOS_V2_MAIL_READER_PRINCIPAL_ID` remain unchanged.
This permits only `GET /api/cwos/accounts` with matching workspace, service
principal and kind headers. The response and parameterized workspace-scoped
transaction remain the maintained account-master contract. HEAD, writes,
engagement/finance routes and other workspace/principal claims remain denied.
Without explicit admission the machine credential still rejects legacy routes.

The maintained v2 Mail reader consumes `/api/cwos/v2/state` and
`/api/cwos/v2/normalized-projections/:planId`. An existing APPLIED source plan
can be linked using native `business.reconcileNormalized` with only `planId`;
the server binds original hashes/version and preserves
`ARCHIVE_PROJECTION_ONLY`/`approved=false`. This is archive context for
read-only mailbox intake and candidates, not mailbox-send/write permission.

`apps/api/test/authn.integration.test.ts` — key required when configured;
wrong/missing key → 401; agent without principal still fails; dev mode without
key still accepts principal headers.

`apps/api/test/customer-work-os-v2-auth.security.test.ts` — a bound pilot key
rejects forged principal/workspace and caller-asserted step-up, refuses
production API-key boot without a binding, and exercises explicit
test/development bindings. Its programmatic fixture proof is not the
operating H environment contract.

`apps/api/test/ops-boot.unit.test.ts` covers the H boot rejection of global
step-up. Missing/unregistered auth-file refusal: 테스트 미검증. `operator-step-up.security.test.ts`
covers password/TOTP, scoped sessions, CSRF, expiry/replay and boot without an auth mechanism, not
missing/unregistered auth files. Some cases create isolated temporary auth fixtures; do not
run those as an operating-profile preparation step or claim they enrolled
the real owner.

## Production fail-closed (G-07)

When `NODE_ENV=production` and no `AUTH_API_KEY`/`API_AUTH_TOKEN`/`authApiKey` is configured, `createApp` **throws `[AUTH_REQUIRED_IN_PROD]` and refuses to start** — a production deploy can never silently run unauthenticated. The only escape is an explicit, audited insecure bring-up via `ALLOW_INSECURE_PROD=1` (or `allowInsecureProd: true`), which downgrades to dev header-principal mode and emits `[AUTH_DISABLED_IN_PROD]`. Covered by `apps/api/test/prod-auth.integration.test.ts`.

That library escape is not an authorization or supported workaround for
Core5 operating H. Missing profile/auth inputs must remain fail-closed.
