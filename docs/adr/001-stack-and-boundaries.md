# ADR-001 — Stack and Execution Boundaries

- **Status:** Accepted — 2026-07-15 (ralplan Architect pass 4 CLEAR/APPROVE, Critic pass 4 OKAY, user post-ralplan confirmation 2026-07-15; execution authorized for goal G001).
- **Deciders:** Architecture Owner (stack, DR-01/04/06/08/09/10); Security (connector/model-gateway confinement, DR-08/10); DBA/Security (RLS, DR-05, see `docs/security/rls-role-model.md`).
- **Source of truth:** `.gjc/_session-019f664d-ec44-7000-a908-b9002f1f9769/plans/ralplan/019f664d-ec44-7000-a908-b9002f1f9769/pending-approval.md`, ADR-001/002/003/010 and the ADR-008/009 follow-up. This file is the durable repo record; the plan document remains the negotiation history.

## 1. Decision — Stack

Build the entire system as a **TypeScript pnpm modular monolith**: Next.js (`apps/web`), Fastify (`apps/api`), PostgreSQL 16 (system of record: ledger, governance, audit, RLS) and Temporal (`apps/worker`, durable human-control/AI workflows).

### Drivers

1. Shared, typed contracts across UI/API/worker (`packages/contracts`) eliminate cross-language DTO drift.
2. PostgreSQL gives transactional integrity for ledger double-entry, governance state machines and RLS in one engine.
3. Temporal gives durable long-lived approval waits, retries, lease/epoch fencing and compensation without bespoke saga code.

### Alternatives considered

| Option | Benefit | Cost/risk | Decision |
|---|---|---|---|
| **A. TypeScript pnpm monorepo + Next.js + Fastify + PostgreSQL + Temporal** | shared contracts, RLS/ledger integrity, durable control workflow | Temporal + Node operational surface | **Selected** |
| B. NestJS + React + PostgreSQL + BullMQ | familiar DI/queue tooling | long-lived control/saga semantics must be hand-built | not selected |
| C. Django/DRF + React + Celery + PostgreSQL | mature CRUD/admin tooling | type/domain contract split across languages; workflow semantics self-built | not selected |
| D. PostgreSQL-only workflow (no Temporal) | fewer moving infrastructure pieces | durable timers/signals/compensation reimplemented by hand | documented fallback only if Temporal operations are later rejected |

Redis is optional cache/rate-limit infrastructure only, gated behind a stated SLO; it is never a durable queue or approval-wait mechanism.

### Consequences

- The team operates Temporal and Node in production; on-call/runbook ownership must exist before Step 1 traffic.
- Option D remains the documented fallback if Temporal operations prove untenable; switching requires a new ADR revision, not a silent substitution.
- All later packages/apps in `docs/architecture/capability-matrix.md`, `packages/persistence`, `packages/governance` assume this stack; no parallel framework may be introduced without revising this ADR.
### Pilot activation — Option D for merge tickets T-001..T-020 (2026-07-19)

**Status:** Activated for the CORP-shell merge plan (ralplan revision stage_n=3; ADR-011). Does **not** silently replace the long-term selected stack above.

Pilot / Gate B activation for merge tickets **T-001..T-020** uses **Option D** — PostgreSQL + `apps/worker` (lease recovery, notifications, outbox) as the durable control and agent-job workflow path. **Temporal remains the long-term selected stack** in §1 but is **out of scope** for those merge tickets and Gate B. Introducing Temporal activities for agent jobs requires an **ADR-001 revision** and must **not** dual-queue with the worker+PG path.

Rationale: shortest trusted pilot path for `@ai-crm/orchestration` Job/WorkItem without operating Temporal before merge Gate B. Option D was already the documented fallback in the alternatives table; this paragraph activates it for the bounded merge window only.

### Follow-ups

- Record Temporal operational SLOs and on-call ownership in Step 1 runbooks before any workflow carries production approval state.

## 2. Decision — Two allowlisted egress boundaries, no third path

The implementation must expose exactly two allowlisted egress boundaries for anything leaving the transactional core; no other package may reach either endpoint:

1. **Planned `apps/connector-dispatcher` + `packages/connector-dispatcher`** — the sole permitted future remote **effect** dispatch path. It remains disabled in MVP: no provider credential may be configured, and every `remote` registry entry must be rejected as disabled.
2. **Planned `apps/model-gateway` + `packages/model-gateway`** — the sole permitted **non-effect** LLM inference path. It requires a dedicated service principal/credential, model-endpoint-only egress, zero-retention request mode, and schema-constrained output. It must have **no effect capability**: no intent lease/dispatch, no connector imports, and no effect-table grants beyond its own `model_invocations` audit rows.

The LLM provider is an explicit, bounded exception to the "no raw provider SDK/HTTP outside the dispatcher" rule — reachable only through the model gateway, never through the connector dispatcher, and never granted dispatch/effect capability.

### Drivers

- **Capability confinement (Architecture Principle 4):** no package with general business/AI/API execution may directly hold a provider SDK, outbound provider HTTP client, or provider credential.
- Step 5 (AI execution/review) needs a legal, auditable provider path without weakening ADR-008 connector confinement.
- Mixing non-effect inference into the effect-dispatch boundary (routing LLM calls through the connector dispatcher) was rejected: it would let a model response sit inside the same capability surface as a remote payment/CRM write.

### Alternatives considered (model-invocation boundary)

| Option | Why rejected/selected |
|---|---|
| Local/offline inference | Rejected for MVP: structured-output quality and operational cost are unproven for this team. |
| Direct model SDK use inside `packages/ai-orchestrator` | Rejected: destroys capability confinement — any orchestration code could then reach a provider directly. |
| Route LLM calls through `apps/connector-dispatcher` | Rejected: mixes non-effect inference into the effect-dispatch boundary, weakening ADR-008. |
| **Dedicated non-effect model gateway (`apps/model-gateway`)** | **Selected**, user-confirmed. Keeps a single bounded, testable exception; inference only, never effect/dispatch. |

### Consequences

- One extra runtime identity and network policy to operate (model-gateway service principal, distinct from API/worker/dispatcher principals).
- Every model invocation is registry-mapped (`MODEL_INVOKE`, effect `none`) and persisted to `model_invocations` (registry operation id, redacted prompt/response digests, model/prompt versions, structured-output schema version, principal, retention mode, latency, correlation id).
- Free-text model output can never become a command; only validated structured output mapped to a registered operation may re-enter orchestration.
- Dependency-boundary lint/CI must reject: raw provider SDK/HTTP imports outside `packages/connector-dispatcher`; raw model SDK/HTTP imports outside `packages/model-gateway`; any import of `packages/connectors`/dispatcher modules from `packages/model-gateway`.
- Any change to the connector provider, the model provider, or the model-endpoint allowlist requires an ADR revision and Security re-sign-off — never an ad-hoc allowlist edit.

### Follow-up — pending, non-blocking for MVP: remote connector `DISPATCHING` deadline scan and crash→`UNKNOWN` ownership

**Status: open, does not block MVP** (MVP has no remote call path; `apps/connector-dispatcher` rejects all `remote` registry entries).

Before any remote connector is enabled, this ADR must be revised to add, on top of the existing `LEASED → QUEUED` lease-expiry recovery (ADR-009):

1. A **`DISPATCHING`-deadline scanner**: a scheduled process that detects execution intents stuck in `DISPATCHING` past a bounded deadline (a dispatcher process died mid-attempt, after acquiring the active lease token but before recording a result).
2. An explicit **crash → `UNKNOWN` transition** with a **named reconciliation owner** (role, not just "operations"): the owner queries the provider's authoritative outcome (or a signed receipt) by the stable intent/attempt idempotency key, and only then appends a recovered terminal state + audit in one transaction. Until that commit the intent stays `UNKNOWN`, alerted, and excluded from automatic business projections and automatic redispatch.

Rationale: relying solely on `UNKNOWN` transitions initiated by the dispatcher itself is insufficient — a dispatcher can die before recording anything, leaving an intent in `DISPATCHING` with no writer left to move it. A scanner plus a named owner closes that otherwise-unowned crash window.

This follow-up is a **mandatory connector-enablement precondition** (see Escalation/Risk Gate in the plan), not a Step 0–8 MVP acceptance item. It must be tracked to closure before `apps/connector-dispatcher` is given a real provider credential.

## 3. Related decisions

Detailed decisions this ADR depends on or hands off to are recorded in their own artifacts rather than duplicated here:

- MVP source of truth (native CRM/native ledger/OFX-CSV import, no external connector) — `docs/architecture/capability-matrix.md`.
- Accounting environment and standards pack — `docs/finance/accounting-standard-pack.md`.
- Production RLS role/grant model — `docs/security/rls-role-model.md`.
- Total action registry, canonicalization and finance control matrix — `packages/policy-engine` (`POLICY_MATRIX`, `ACTION_TYPES`) and its accompanying `docs/policy-matrix.md` once populated by the governance workstream.

## 4. Scope discipline

This ADR does not authorize: any external CRM/accounting/bank/payment connector with a live credential, any relaxation of `FORCE ROW LEVEL SECURITY`/non-owner runtime roles, or any bypass of the registry-before-execution rule for API commands, Temporal activities, model-gateway invocations, or connector methods. Any such change requires a new ADR revision and the sign-offs listed in the plan's Escalation/Risk Gate, not an edit to this file alone.
