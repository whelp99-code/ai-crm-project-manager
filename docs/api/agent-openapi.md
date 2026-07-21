# Agent + Governance API contract (G-04)

This is the authoritative, human-readable contract for the `/api/agent/*` and
the governance checkpoint-inbox + audit surface (`/api/governance/*`). It
documents each route, required header,
and error/response code actually enforced in `apps/api/src/app.ts`.
`apps/api/test/agent-contract.test.ts` asserts the implementation enforces
the documented routes and error codes — every route below is registered, and
every listed required-header/error-code pair is enforced. (It checks
documented→registered, not markdown prose.)

The domain surface (`/api/customers`, `/api/pm/*`, `/api/finance/*`, ...) is
out of scope for this document; agents MUST reach domain effects only through
`/api/agent/commands` (see `docs/governance/action-registry.md` for the S0
`COMMAND_MAP` whitelist).

## Conventions

### Headers

| Header | Required on | Notes |
| --- | --- | --- |
| `x-workspace-id` | Every `/api/*` route (agent + governance) | Missing/blank → `400 WORKSPACE_REQUIRED`. Never inferred from auth. |
| `x-principal-id` | Every `/api/agent/*` route | Missing/blank → `400 PRINCIPAL_REQUIRED`. Identifies the human/service operator; never trusted from the request body. |
| `Idempotency-Key` | `POST /api/agent/commands` | Header wins over `body.idempotencyKey` when both are present but must match (`400 IDEMPOTENCY_MISMATCH` on conflict). Missing both → `400 IDEMPOTENCY_REQUIRED`. |
| `x-api-key` **or** `Authorization: Bearer <token>` | Every `/api/agent/*` route (any method) + any mutating `/api/*` route, **only when** `AUTH_API_KEY` / `API_AUTH_TOKEN` (or `CreateAppOptions.authApiKey`) is configured | Fail-closed: missing/wrong key → `401 UNAUTHENTICATED`. When unset (dev/local mode), the header is not required — see `docs/ops/authn.md`. |

`GET /health`, `GET /ready`, and `GET /metrics` never require the API key,
matching the operational-probe posture documented in `docs/ops/authn.md`.

### Error envelope

Every 4xx/5xx response is `{ "error": "<CODE>", "message": "<human text>" }`.

## `/api/agent/*` — natural-language agent commands (S0)

### `POST /api/agent/commands`

Submit a natural-language command for orchestration. Every mutating domain
effect is reached only through this endpoint (never `/api/pm/*` etc. directly
from an agent caller).

- Headers: `x-workspace-id` (required), `x-principal-id` (required),
  `Idempotency-Key` (required; or `body.idempotencyKey`).
- Body: `{ text: string, idempotencyKey?: string, resourceBinding?: { resourceType: string, resourceId: string } }`.
  `resourceBinding` fields are required together — a half pair →
  `400 INVALID_RESOURCE_BINDING`.
- Success: `202 { jobId, workItemIds, status, needsApproval }`.
- Errors:
  - `400 WORKSPACE_REQUIRED` — missing `x-workspace-id`.
  - `400 PRINCIPAL_REQUIRED` — missing `x-principal-id`.
  - `400 IDEMPOTENCY_REQUIRED` — no `Idempotency-Key` header or `body.idempotencyKey`.
  - `400 IDEMPOTENCY_MISMATCH` — header and body idempotency keys disagree.
  - `400 INVALID_RESOURCE_BINDING` — half `resourceBinding` pair.
  - `503 MODEL_UNAVAILABLE` — no `ModelClient` configured (fail-closed inference).
  - `401 UNAUTHENTICATED` — API key mode on, missing/wrong key.

### `GET /api/agent/jobs/:id`

Read the full job snapshot (job + work items + events).

- Headers: `x-workspace-id` (required).
- Success: `200` job snapshot.
- Errors: `400 WORKSPACE_REQUIRED`; `404 NOT_FOUND` (cross-workspace or unknown id).

### `GET /api/agent/jobs/:id/events`

Job event feed. Two response modes on the same route:

- **JSON mode** (default, or `Accept` without `text/event-stream` and no
  `?stream=1|true`): `200 { jobId, events: JobEvent[] }`.
- **SSE mode** (`Accept: text/event-stream`, or `?stream=1|true`): burst-then-close
  by default — emits `job.updated` / `work_item.updated` / `control.updated`
  frames for the current snapshot, then `stream.end` and closes.
  - `?live=1|true` additionally keeps the connection open and subscribes to
    the in-process `EventHub` for `(workspaceId, jobId)`; every subsequent
    agent mutation on that job re-reads the snapshot and pushes a follow-up
    frame. Idle-closes after `sseLiveTimeoutMs` (default 30s) with no
    activity. Single-process fanout only — see `docs/ops/eventing.md`.
- Headers: `x-workspace-id` (required).
- Errors: `400 WORKSPACE_REQUIRED`; `404 NOT_FOUND`.

### `POST /api/agent/jobs/:id/cancel`

Cancel an in-flight job (queued / running without control / waiting_control
work items).

- Headers: `x-workspace-id` (required), `x-principal-id` (required).
- Success: `200 { jobId, workItemIds, status, needsApproval }`.
- Errors: `400 WORKSPACE_REQUIRED`; `400 PRINCIPAL_REQUIRED`; `404 NOT_FOUND`;
  `400 INVALID_WORK_ITEM_TRANSITION` when a non-terminal work item is not cancellable.

### `POST /api/agent/jobs/:id/work-items/:workItemId/complete`

Apply a governed effect after a checkpoint/approval was decided + consumed:
dereferences `body.intentId` against governance state (single-use QUEUED
authorization) and marks the work item done.

- Headers: `x-workspace-id` (required), `x-principal-id` (required).
- Body: `{ intentId: string }`.
- Success: `200 { jobId, workItemIds, status, needsApproval }`.
- Errors: `400 WORKSPACE_REQUIRED`; `400 PRINCIPAL_REQUIRED`;
  `404 NOT_FOUND` (job or work item) / `404 INTENT_NOT_FOUND`;
  `409 STALE_INTENT` — intent is not a fresh QUEUED authorization bound to
  this exact action/resource/version.

## `/api/governance/*` — approval/checkpoint inbox

### `GET /api/governance/controls`

List checkpoint controls for the workspace, optionally `?status=PENDING|APPROVED|REJECTED|CONSUMED|EXPIRED|CANCELLED`.

- Headers: `x-workspace-id` (required).
- Success: `200 ControlRequest[]`.
- Errors: `400 WORKSPACE_REQUIRED`.

### `GET /api/governance/controls/:controlId`

- Headers: `x-workspace-id` (required).
- Success: `200 ControlRequest`.
- Errors: `400 WORKSPACE_REQUIRED`; `404 CONTROL_NOT_FOUND`.

### `POST /api/governance/controls/:controlId/decide`

Approve or reject a checkpoint. Separation-of-duty is enforced: the
requester who created the underlying job cannot decide their own control.

- Headers: `x-workspace-id` (required).
- Body: `{ principalId: string, decision: "APPROVE" | "REJECT" }`.
- Success: `200` decided `ControlRequest`.
- Errors: `400 WORKSPACE_REQUIRED`; `400 INVALID_DECISION` (decision not
  APPROVE/REJECT); `400 SEPARATION_OF_DUTY`; `404 CONTROL_NOT_FOUND`;
  `400 CONTROL_NOT_PENDING` when the control is no longer PENDING.

### `POST /api/governance/controls/:controlId/consume`

Consume an APPROVED control into a single-use QUEUED `ExecutionIntent`
(the only receipt `complete` accepts).

- Headers: `x-workspace-id` (required).
- Body: `{ resourceId: string, resourceVersion: number, payloadHash: string, policyVersion: number, idempotencyKey?: string }`
  — must exactly match the control's binding.
- Success: `201` `ExecutionIntent`.
- Errors: `400 WORKSPACE_REQUIRED`; `400 CONTROL_NOT_APPROVED` (control missing
  or not APPROVED); `409 STALE_CONTROL_BINDING` when a binding field mismatches.


### `POST /api/governance/authorize`

Resolves an `ActionType` through policy and either returns an ALLOW intent or
creates a CHECKPOINT/REQUIRE_APPROVAL control. Requires `x-workspace-id`.
Errors: `400` on invalid input; `409 STALE_*`/`DUPLICATE_*` on binding
conflicts.

### `GET /api/governance/audit`

Returns the append-only audit events for the workspace. Requires
`x-workspace-id`.

### `GET /api/governance/audit/verify`

Returns `{ valid: boolean }` for the workspace audit-chain integrity check.
Requires `x-workspace-id`.

## Operational probes (no `/api` prefix, never require the API key)

- `GET /health` → `200 { status: "ok" }`.
- `GET /ready` → `200 { status: "ready" }` in memory mode, or once the PG pool
  answers `select 1`; `503 { status: "not_ready" }` otherwise.
- `GET /metrics` → `200` JSON counters (see `docs/ci/README.md` and
  `apps/api/test/metrics.integration.test.ts` for the exact shape): agent job
  counts by status, governance control/intent counts by status,
  `dualWriteFailures`, and live SSE `activeJobSubscriptions`.
