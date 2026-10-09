# CRM self-entry login (draft, not deployed)

This source-only web flow reuses the maintained `OperatorStepUpService` and
`POST /api/cwos/v2/operator-step-up`. PR41 is historical context; its old
`packages/owner-auth` implementation is not present on the current master.
No new authentication system, owner enrollment or credential is created.

The browser collects the password first and TOTP second, then submits both
once through the existing gate. There is no password-only verification
endpoint and no assertion that the first screen authenticates the owner.
The existing signed, workspace/principal-bound proof is relayed as an
HttpOnly, SameSite=Strict web-origin cookie. Production requires Secure.
The protected `/self-entry` page verifies that proof through the read-only
`GET /api/cwos/v2/operator-session`; it does not trust a browser flag.
The session-check route returns only `authenticated: true`, is not cacheable,
and reads no business data or authentication material beyond the existing gate.

## OWNER_DECISION_REQUIRED

Seven operating decisions/prerequisites remain unassigned:

1. Confirm the actual admitted **HTTPS API origin** serving the maintained H
   gate and session-check route. An Action Hub root or an old HTTP endpoint
   is not a substitute. Key: `CRM_SELF_ENTRY_API_ORIGIN`.
2. Confirm the actual **HTTPS web origin**, approved domain and access path.
   The login POST requires that exact Origin, never a wildcard.
   Key: `CRM_SELF_ENTRY_WEB_ORIGIN`.
3. Select the admitted **company/workspace mapping**. No company or workspace
   has been chosen by this implementation. Key: `CRM_SELF_ENTRY_WORKSPACE_ID`.
4. Confirm the admitted **human principal** matching the server binding.
   Key: `CRM_SELF_ENTRY_PRINCIPAL_ID`.
5. Arrange the existing bound **server-side API key** through the approved
   private provisioning path. It never becomes a public browser setting.
   Do not create a replacement credential. Key: `CRM_SELF_ENTRY_API_KEY`.
6. Approve a **session age ceiling** consistent with the existing API policy.
   Key: `CRM_SELF_ENTRY_SESSION_MAX_AGE_SECONDS`, required integer 1–300.
   This is not a new TTL or an override: the web rejects a returned cookie
   whose existing API lifetime exceeds the approved ceiling.
7. Privately confirm the existing **pre-enrolled H profile and supported
   operating release** before an owner login. Missing enrollment, unavailable
   API/configuration or the model-gateway credential HOLD remain blockers.
   Never inspect or publish private authentication files as part of this task.

All six configuration keys are required and have no operating defaults.
Missing/invalid configuration shows “설정 필요” with key names only, disables
credential entry and returns HTTP 503 before parsing the login body.
Only explicitly configured loopback HTTP origins are accepted in test/dev;
production HTTP, URL credentials and non-origin URLs are rejected.
Rate limiting, replay consumption, session generation, expiry and scope stay
the existing server's policy; no authentication/production configuration
is changed by this feature.

## Owner-only steps (after the prerequisites are verified)

1. The responsible operator confirms the actual protected endpoint, H
   pre-enrollment and the seven decisions above. This draft does not deploy
   the new source or change production `app-f6e251d`.
2. Jaemin opens the confirmed web origin's relative `/login` path. No operating
   URL is invented here. If “설정 필요” appears, stop without entering credentials.
3. Jaemin alone enters the existing password, chooses the next step, then
   enters the current six-digit TOTP and confirms entry.
4. A successful existing gate proof admits `/self-entry`. Denial, lockout
   and expiry show Korean messages without reflecting server bodies.

Never send credentials in chat/issues/mail, a URL, argv, screenshots or logs.
The UI clears transient fields on submission/cancellation/failure and never
uses browser local/session storage. Actual owner input was not attempted.

## Validation boundary

Related memory-only tests cover password/TOTP verification, replay, lockout,
scope, expiry, unconfigured/origin denial and response/log leak prevention.
Local screenshots use a separately owned loopback fixture and synthetic
inputs only. That fixture is not an operating identity or production access.

No production/auth config, DB credential, deployment, service restart,
DNS/cert/proxy/firewall change or production write is included.
