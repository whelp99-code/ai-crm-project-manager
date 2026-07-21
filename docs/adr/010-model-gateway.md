# ADR-010 — Non-effect Hosted LLM Model Gateway

- **Status:** Accepted — 2026-07-15 (ralplan Architect pass 4 CLEAR/APPROVE, Critic pass 4 OKAY, user post-ralplan confirmation 2026-07-15; execution authorized for goal G001).
- **Deciders:** Architecture Owner (model boundary, DR-10); Security (provider/endpoint allowlist, redaction/retention contract, model-gateway confinement, DR-08/10).
- **Source of truth:** `.gjc/_session-019f664d-ec44-7000-a908-b9002f1f9769/plans/ralplan/019f664d-ec44-7000-a908-b9002f1f9769/pending-approval.md` §ADR-010 and §"Model-invocation confinement (model gateway boundary, ADR-010)"; ADR-001 §2 records the same boundary as one of the two allowlisted egress paths.

## Decision

All LLM inference passes through a dedicated non-effect model gateway (`packages/model-gateway`, exposed to callers via `apps/api`'s `POST /api/model/invoke`) with:

- zero-retention request mode where contractually available, recorded via an explicit `RetentionMode` (`"zero-retention" | "retain"`) on every invocation record;
- a dedicated service principal, distinct from API/worker/dispatcher principals — `ModelGateway.invoke` rejects any caller whose `principalId` does not match the configured `servicePrincipalId` (`PRINCIPAL_DENIED`);
- schema-constrained structured output only — `validateOutput` rejects any output that does not conform to the caller-supplied `OutputFieldSchema` (`SCHEMA_VIOLATION`); free-text provider output is discarded and can never become a command;
- **no effect capability**: no intent lease/dispatch, no import of `packages/connectors`, and no effect-table grants beyond its own `model_invocations` audit rows.

Every invocation is registry-mapped to the single, fixed, non-effect `ActionType` `MODEL_INVOKE` (`MODEL_GATEWAY_ACTION` constant in `packages/model-gateway`), at `allow` control tier (`packages/policy-engine`'s `POLICY_MATRIX`). An injected `OperationResolver` must resolve every operation id to `MODEL_INVOKE`; any other resolution is rejected (`NON_MODEL_OPERATION`) — the gateway itself enforces that it can never be repurposed as a generic dispatch surface.

### Drivers

1. Step 5 (AI execution/review) needs a legal, auditable provider path without weakening the connector-dispatcher confinement boundary (ADR-001 §2 / ADR-008).
2. Least-data handling and auditability: every invocation must be redacted before egress and persisted as an audit record, not merely logged informally.
3. A single bounded, testable exception to the "no raw provider SDK/HTTP outside the dispatcher" rule is easier to review and re-certify than an ad hoc allowlist scattered across packages.

### Alternatives considered

| Option | Why rejected/selected |
|---|---|
| Local/offline inference | Rejected for MVP: structured-output quality and operational cost are unproven for this team. |
| Direct model SDK use inside `packages/ai-orchestrator` | Rejected: destroys capability confinement — any orchestration code could then reach a provider directly, with no single chokepoint to redact, audit, or rate-limit. |
| Route LLM calls through `apps/connector-dispatcher`/`packages/connectors` | Rejected: mixes non-effect inference into the effect-dispatch boundary, weakening the connector-confinement design — a model response would sit inside the same capability surface as a remote payment/CRM write. |
| **Dedicated non-effect model gateway (`packages/model-gateway`, selected)** | **Selected**, user-confirmed. Keeps a single bounded, testable exception; inference only, never effect/dispatch. |

### Consequences

- One extra runtime identity/network policy to operate (model-gateway service principal, distinct from API/worker/dispatcher principals) — not yet separately provisioned in this repository; `apps/api`'s `createApp` accepts an optional `modelClient`/`modelServicePrincipalId` and only constructs the gateway when both are supplied.
- **Fail-closed by construction, verified in code:** `apps/api/src/app.ts` only builds a `ModelGateway` when a `ModelClient` is injected via `CreateAppOptions`. When it is absent, `POST /api/model/invoke` throws `ModelGatewayError("MODEL_GATEWAY_UNSET", ...)`, which the API's shared error handler maps to HTTP `503` — inference is unavailable rather than silently mocked or defaulted. As of this writing, no concrete `ModelClient` (real provider SDK/HTTP adapter) exists in this repository; the gateway package only defines the `ModelClient` interface that a future runtime-only adapter must implement.
- Every model invocation is registry-mapped (`MODEL_INVOKE`, effect `none`) and is intended to persist to a `model_invocations` audit table (`packages/persistence/src/schema.ts` declares `modelInvocations`); the gateway's `getInvocation`/invocation-tracking today is in-memory (`this.invocations` Map inside `ModelGateway`), matching the same "schema exists, durable runtime wiring pending" pattern as the lease/epoch columns described in `docs/governance/control-effect-state-machine.md`.
- Free-text model output can never become a command; only validated structured output mapped to a registered operation may re-enter orchestration.
- Any change to the model provider, the model-endpoint allowlist, or the redaction/retention contract requires an ADR-010 revision and Security re-sign-off — never an ad-hoc allowlist edit.

### Follow-ups

- Security signs the provider, endpoint allowlist, and redaction/retention contract before Step 5 (per the plan's Escalation/Risk Gate).
- Dependency-boundary lint/CI must reject raw model SDK/HTTP imports outside `packages/model-gateway`, and any import of `packages/connectors`/connector-dispatcher modules from `packages/model-gateway` — not yet implemented as an automated CI gate in this repository as of this writing; the confinement is currently enforced only by the absence of such imports in the source tree and by unit tests of `ModelGateway`'s own guards (`PRINCIPAL_DENIED`, `NON_MODEL_OPERATION`, `SCHEMA_VIOLATION`).
- **Connector-enablement precondition (ADR-008/009 follow-up):** before any remote connector (`packages/connectors`) is given a real provider credential, this precondition must be closed — a scheduled `DISPATCHING`-deadline scanner (detects execution intents stuck in `DISPATCHING` past a bounded deadline after a dispatcher process died mid-attempt) and an explicit crash → `UNKNOWN` transition with a named reconciliation owner (a role, not just "operations," that queries the provider's authoritative outcome or a signed receipt by the stable intent/attempt idempotency key before appending a recovered terminal state). This is **not required for MVP** because `packages/connectors`' `ConnectorDispatcher.dispatch` rejects every `RemoteRegistryEntry` unconditionally (`CONNECTOR_DISABLED`) — there is no remote call path today for a dispatcher to crash mid-attempt against. It is recorded here, not only in ADR-001, because the model-gateway boundary and the connector-dispatcher boundary are the two allowlisted egress paths this ADR set governs together, and this precondition gates the sibling boundary's future activation, not the model gateway's.
