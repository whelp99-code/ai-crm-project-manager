# CRM-owned password and TOTP

The admitted human API retains its existing operator proof, scope, CSRF,
five-minute expiry and generation-based revocation. Password verification now
uses bcrypt cost 12 with independent salts. Passwords must be at least 12
characters and at most 72 UTF-8 bytes; suffixes are never silently truncated.
TOTP uses RFC 6238 SHA-1, six digits, 30-second periods and one period of clock
skew. A successful enrollment or login consumes the period.

## Owner-run first enrollment

Only the owner performs this procedure on an approved private host. In an
offline authenticator, create a 20-byte Base32 TOTP secret and register it
directly, without chat, screenshots or logs. Prepare an owner-only mode-600
JSON input file outside the repository with keys `password`, `totpSecret` and
`totp` (the authenticator's current code). Run
`pnpm exec tsx apps/api/src/operator-auth-enroll.mts --input <private-input> --state <new-private-auth-state>`.
The command refuses public/symlink input and existing output, verifies the
authenticator and prints only `OPERATOR_ENROLLED` or a fixed rejection code.
Securely remove the temporary input afterward. Wait for the authenticator's
next code before logging in. Point the separately approved human composition's
`CWOS_V2_OPERATOR_AUTH_STATE_PATH` at this state and provide a private session
signing secret and admitted workspace/principal through the existing runbook.
This PR does not enroll the owner's actual credentials or activate production.

## Compatibility and recovery

Legacy scrypt records fail closed. There is no silent login upgrade or fallback:
before an approved rollout the owner must enroll a new private bcrypt state.
Keep the previous release and previous private state together for rollback;
neither is changed by this task. Never deploy the new reader against a legacy
record and call it ready.

There is no public password-reset endpoint, default password or OTP bypass.
If the owner loses either factor, stop the admitted human composition, prove
local administrative ownership, enroll a new state at a new private path and
rotate the session signing secret before restarting. Do not edit rate/replay
fields to bypass a lock or reuse a code. Retain private backups with the same
access boundary as the live state. One human process owns the auth file;
multiple concurrent replicas are not supported by the existing store contract.

| Threat | Mitigation |
| --- | --- |
| Brute force | Cost-12 bcrypt, password plus TOTP, separate account/client failure windows with bounded non-renewing penalties and valid-owner recovery; generic denials. |
| Session theft/fixation | Fresh random CSRF and incremented persistent generation on every login; signed workspace/principal-bound proof, HttpOnly, SameSite=Strict, Secure outside explicit loopback development, five-minute expiry; previous generation rejected. |
| OTP reuse | Persisted consumed TOTP period, monotonic rejection of equal/older periods, synchronous single-owner verification and write; enrollment also consumes its period. |
| Recovery bypass | No network recovery or default factors; owner-only offline rate unlock preserving replay state, or re-enrollment plus signing-secret rotation, private state/input files, no overwrite or credential output. |

No database migration, listener/port change, mail send, external business write
or payment is part of this authentication change.

## Web registration

`/login/enroll` is the browser form for the same first enrollment the CLI writes.
It is served only when the request URL is loopback (`127.0.0.1`, `localhost`,
`::1`) or HTTPS on port 8446 or 8447. Any other host renders a closed notice
and the POST is refused with `ENROLLMENT_HOST_DENIED`. The form posts password,
TOTP secret and the current code to the same-origin `/api/self-entry/enroll`
route, which calls `writeNewOperatorEnrollment` and stores the CLI record
(`generation`, `enrolled`, `totpPending`, bcrypt cost 12, `totpSecret`,
`lastTotpStep`) with mode 0600 and `wx`. Responses, errors and this page do not
return the password or the TOTP secret.

Set `CWOS_V2_OPERATOR_AUTH_STATE_PATH` to a new private path that does not exist
yet. If the variable is unset the form stays closed (`CONFIGURATION_REQUIRED`)
and nothing is written.
If the path already exists, including a symlink, the form does not render and a
second POST returns `ALREADY_ENROLLED` without reading or replacing the file.
Opening the form again requires the existing offline recovery: stop the
service, enroll a new private path, rotate the session signing secret, then
restart. There is no web reset.

## Web entry

The web server reuses `API_BASE_URL`, `WORKSPACE_ID`, `OPERATOR_PRINCIPAL_ID`
and its private `AUTH_API_KEY`; set `CRM_WEB_ORIGIN` to the exact browser
origin. Production origins must be HTTPS, without credentials or URL paths.
The browser never receives the API key or a caller-selected principal.
`/login` stages masked password and OTP and submits only to its same-origin
`/api/self-entry` proxy. Missing configuration fails closed. All web pages and
non-login web APIs require the existing admitted proof through middleware;
static framework assets remain public. Successful login rotates the existing
generation, clears a stale imported narrow-path cookie and enters the actual
Mail candidate review screen. Its CSRF is loaded automatically from verified
claims, not a manually exported credential file.

The standalone API retains its existing API-key and v2 human-proof contracts;
this change does not advertise legacy v1 API reads as a new public endpoint.
Keep the admitted API reachable only through the existing private deployment
boundary. No reverse proxy, machine identity or legacy business contract is
changed here.

## Failed attempts, trusted proxy addresses and offline unlock

The private enrollment is the account bucket. Only authenticated gateway
addresses create client buckets; raw X-Forwarded-For and X-Real-IP are ignored.
Configure CWOS_V2_OPERATOR_PROXY_SECRET privately on ingress, Next and human API
(at least 32 characters, never NEXT_PUBLIC). The ingress strips caller-supplied
x-cwos-client-ip/x-cwos-client-token, then sets the actual IP and private token.
Without that boundary the client is unknown, not an inferred forwarded address.

Failed factors have exponential retry hints capped at 30 seconds. Rejected
retries cannot renew a lock or keep rewriting state. Valid password plus fresh
TOTP remains admissible despite hostile account/client failures. Wrong factors
and replay have one client code/status; logs retain only a secret-free reason.

Stop the single owning API before offline recovery:

```sh
pnpm exec tsx apps/api/src/operator-auth-unlock.mts \
  --state "$CWOS_V2_OPERATOR_AUTH_STATE_PATH"
```

This clears only rate metadata: password hash, TOTP secret, consumed period and
generation remain. It cannot admit a replay or issue a proof. Existing no-symlink,
owner and mode-600 checks remain mandatory.

POST /api/self-entry/logout requires configured web Origin and x-csrf-token
from authenticated session details. The API verifies its Origin, actor and CSRF,
then increments generation and clears the cookie. All older proofs fail at once.
OPERATOR_AUTH_API_BASE_URL can isolate the private identity API from unavailable
business configuration; default API_BASE_URL and all middleware guards remain.
