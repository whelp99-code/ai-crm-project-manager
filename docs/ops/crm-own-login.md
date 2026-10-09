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
| Brute force | Cost-12 bcrypt, password plus TOTP, persisted global/per-peer 10-attempt/15-minute limit and lockout; generic denials. |
| Session theft/fixation | Fresh random CSRF and incremented persistent generation on every login; signed workspace/principal-bound proof, HttpOnly, SameSite=Strict, Secure outside explicit loopback development, five-minute expiry; previous generation rejected. |
| OTP reuse | Persisted consumed TOTP period, monotonic rejection of equal/older periods, synchronous single-owner verification and write; enrollment also consumes its period. |
| Recovery bypass | No network recovery or default factors; owner-only offline re-enrollment plus signing-secret rotation, private state/input files, no overwrite or credential output. |

No database migration, listener/port change, mail send, external business write
or payment is part of this authentication change.
