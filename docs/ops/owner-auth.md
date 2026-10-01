# Owner session (not deployed)

Single-owner password + TOTP. JARVIS WebAuthn stays on the remote-approval ceremony; this app does not take that dependency.

Off unless `OWNER_AUTH=1`. Listen address and port are unchanged.

## Threat note

- Session cookie is `HttpOnly; SameSite=Strict`. `Secure` is set only when `OWNER_COOKIE_SECURE=1` (HTTPS). The current tailnet is HTTP, so `Secure` stays off until a TLS front is in place. Do not publish the port without TLS and `OWNER_COOKIE_SECURE=1`.
- CSRF: mutating requests must send `x-csrf-token` equal to the token inside the signed session. The readable `core5_csrf` cookie exists so the browser can copy it; it is not proof by itself.
- Login and enrollment are rate-limited per process (10 attempts / 15 minutes / client IP). This is not a cluster limiter.
- Sessions expire 8 hours after login. Logout bumps a generation counter in the state file so the API rejects copied cookies. There is no default password. The enrollment code is single-use, hashed, and expires in 15 minutes.
- `/health` stays unauthenticated for the existing probe. Other routes require a session when owner auth is on. The existing API key gate still applies where it already did.
- State file and env file are mode 0600. Do not commit them.

## Enrollment (owner, on the host)

```bash
pnpm exec tsx packages/owner-auth/src/cli.ts \
  --state "$HOME/.config/core5/owner-auth.json" \
  --env-out "$HOME/.config/core5/owner-auth.env"
```

Copy the env file into the API and web process environments (same `OWNER_SESSION_SECRET` and `OWNER_AUTH_STATE_PATH`). Restart is a deploy step and is not part of this change.

Open `/login`, submit the printed code and a new password (12+), add the returned `otpauth` URI to an authenticator, confirm the 6-digit code, then log in with password + TOTP.
