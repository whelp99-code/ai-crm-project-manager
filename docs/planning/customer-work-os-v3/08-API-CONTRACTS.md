# 08 — API Contracts

## Shared request boundary

- AuthN/AuthZ: existing API authentication plus workspace/principal context; no client-supplied workspace override after authentication.
- Mutation headers: `Idempotency-Key` required; `Content-Type: application/json`.
- Mutation body concurrency: `expectedVersion` is required for an existing resource.
- Success headers: echo `Idempotency-Key` for mutations; include request ID through existing middleware.
- Error body: `09-ERROR-CONTRACTS.md`.

## Endpoints

### `GET /api/cwos/v3/overview`

AuthZ: workspace member with CWOS read. Query: `asOf` optional ISO-8601. Success `200`: the exact `CwosV3Overview` in `07-DATA-CONTRACTS.md`. Errors: 401, 403, 422, 503. Idempotency: N/A — read. Timeout: 5 s; no implicit write.

### `GET /api/cwos/v3/action-items`

AuthZ: CWOS read. Query: `status`, `engagementId`, `cursor`, `limit`. Success `200`: `{items, nextCursor}` ordered by status, priority descending, due date, ID. Errors: 401, 403, 422. Cursor is opaque and workspace-bound.

### `POST /api/cwos/v3/action-items/:actionId/complete`

AuthZ: owner/operator; assigned team member also requires `cwos.action.complete`. Body: `{expectedVersion:number, completionNote:string(1..1000), evidenceRefs:string[1..20]}`. Success `200`: completed action. Errors: 401, 403, 404, 409, 422. Replay with the same idempotency key returns the first success.

### `POST /api/cwos/v3/action-items/:actionId/dismiss`

AuthZ: owner/operator only. Body: `{expectedVersion:number, reason:string(1..1000), evidenceRefs:string[1..20]}`. Success `200`: DISMISSED action. Errors: 401, 403, 404, 409, 422. Dismissal is irreversible through the API; a later canonical event creates a new action only with a new source ID.

### `POST /api/cwos/v3/engagements/:engagementId/transition`

AuthZ: owner/operator. Body: `{expectedVersion:number, targetState:string, evidenceRefs:string[1..20]}`. Processing: call a shared transition service also used by the existing canonical transition route; the shared guard requires an OPEN due commitment/action before ACTIVE and writes canonical transition plus outbox atomically. The outbox projector upserts the v3 action idempotently. Success `200`: canonical engagement plus source version. Errors: 401, 403, 404, 409, 422. The existing `/api/cwos/engagements/:engagementId/transition` route must use the same guard so it cannot bypass REQ-GOLD-002.

### `POST /api/cwos/v3/proposals`

AuthZ: AI/service or owner with proposal permission. Body: `{engagementId, kind, evidenceRefs, confidence, modelRef, promptVersion, budgetUsd}`. Success `201`: existing `cwos_ai_suggestions` representation in PROPOSED. Errors: 401, 403, 404, 422, 429. This endpoint cannot review, accept, or execute.

### `POST /api/cwos/v3/proposals/:proposalId/submit`

AuthZ: human owner. Body: `{expectedVersion, decision:'ACCEPT'|'REJECT', reason, controlId}`. Success `200`: canonical ACCEPTED or REJECTED suggestion plus decided control. Errors: 401, 403, 404, 409, 422. This route decides but does not consume the control. Existing `POST /api/governance/controls/:controlId/consume` performs the single-use consume and creates the effect intent; adapter execution remains downstream.

### `GET /api/cwos/v3/cutover/:planId/reconciliation`

AuthZ: import operator or owner. Success `200`: latest immutable `CwosV3ReconciliationReport` row and canonical plan status. Errors: 401, 403, 404. No source secrets or raw rows are returned.

### `POST /api/cwos/v3/cutover/:planId/validate`

AuthZ: import operator. Body: `{expectedVersion, sourceManifestHash, sourceCounts, sourceMoneyMinor, requiredFieldFailures, rejectedRows}`. Processing: calculate target counts/money through existing repositories, insert an append-only reconciliation report row, and append the ordinary APPROVED plan event; `matched=true` transitions PLANNED→APPROVED. Success `200`: report and plan. Errors: 401, 403, 404, 409, 422. Retry requires identical body and idempotency key.

### `POST /api/cwos/v3/cutover/:planId/apply`

AuthZ: human owner. Body: `{expectedVersion, reconciliationReportHash, controlId}`. Processing: verify APPROVED plan, exact latest report hash, and approved unconsumed control; execute existing apply service once and transition APPROVED→APPLIED. Success `200`: plan and reconciliation report reference. Errors: 401, 403, 404, 409, 422.

### `POST /api/cwos/v3/pilot-runs`

AuthZ: release reviewer. Body: `{scenarioKey, commitSha}`. Success `201`: RUNNING pilot record. Conflict `409` if the same workspace/scenario/commit already exists. No production approval is implied.

### `POST /api/cwos/v3/pilot-runs/:runId/complete`

AuthZ: release reviewer. Body: `{expectedVersion, requestedStatus:'PASSED'|'FAILED'|'BLOCKED', evidenceRefs, metrics, gateResults:CwosV3GateResult[], openCriticalHigh}`. Server derives final status from V0..V9 using `07-DATA-CONTRACTS.md`; requested status must match. Success `200` only when invariants hold. A requested PASSED with a missing/non-PASS V0..V9 returns `409 RELEASE_GATE_INCOMPLETE`. V10/V11 are rejected in `gateResults`.

## OpenAPI

PR-003 extends `apps/api/src/openapi.ts` and `apps/api/test/openapi-contract.test.ts` so the generator consumes Fastify route schema metadata for `/api/cwos/v3/*`. Every v3 registrar supplies operation ID, tags, security, params/query/body, success response, and shared error references. Later ordered PRs add route schema metadata and append exact path/schema assertions. The served surface remains `GET /api/agent/openapi.json`.
