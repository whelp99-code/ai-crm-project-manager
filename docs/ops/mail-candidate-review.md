# Mail candidate review (W07)

The owner opens `/v2/mail-candidate-review` and imports the JSON response from
the existing private operator step-up client: `cookie` is the
`cwos_operator_stepup=...` cookie pair and `csrf` is its returned CSRF token.
Import verifies the existing proof before installing an HttpOnly, SameSite
Strict cookie. It does not enroll an operator, issue a proof, or extend its
expiry. An expired proof requires fresh authentication through the existing
operator mechanism.

The web process uses `API_BASE_URL`, `WORKSPACE_ID`,
`OPERATOR_PRINCIPAL_ID`, and `AUTH_API_KEY` for the admitted human API.
Mail writer and JARVIS reader credentials cannot review candidates.
The same-origin review API requires owner proof and CSRF for changes.

Confirm records an existing scoped account link or a new-account candidate;
it does not create an account. Discard records one reason. Undo appends a
compensating record. All three use native snapshot CAS, idempotency and the
existing audit chain; producer candidates and evidence remain unchanged.

Producer metadata (`senderCompany`, `summary`, `receivedAt`, `evidenceUrl`)
is optional. Legacy summaries use the original subject; absent company,
date, or web evidence are shown as unknown, with the original source locator.
No sender company or receipt date is inferred from the mailbox.

Migration memo: reuse the existing web/API configuration and native runtime
snapshot/audit tables; no new DB role, secret file, unit, timer, or fixed port.
This PR does not deploy or change the operating authentication configuration.
