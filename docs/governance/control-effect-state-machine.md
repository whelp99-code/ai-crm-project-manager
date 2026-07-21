# Control, Intent and Notification State Machines

- **Status:** Accepted — reflects `packages/governance/src/index.ts` (`GovernanceAuthorizationService`, `ControlStatus`, `IntentStatus`, `NotificationStatus`, including `cancelControl` / `expireControl`), `packages/contracts/src/index.ts` (`INTENT_STATES`, `INTENT_STATE_TRANSITIONS`), and `packages/persistence/src/schema.ts` (durable column definitions), cross-referenced against the plan's §"Control, Intent and Approved-effect State Machine".
- **Honesty note:** this document distinguishes **implemented and exercised** behavior (in-memory `GovernanceAuthorizationService`, unit-tested — including `cancelControl` and `expireControl`) from **schema-ready / dual-write-partial** behavior. Columns exist in `packages/persistence`'s Drizzle schema; `createPgGovernanceRepository` / `createPgOrchestrationRepository` are exported and **wired into `createApp` when `databaseUrl` or `pgPool` is provided** (`CreateAppOptions`): request-path SoR remains in-memory `GovernanceAuthorizationService` / `OrchestrationService` per process, with **best-effort PG dual-write of orch job snapshots and governance controls/intents** via those repositories when `databaseUrl`/`pgPool`/`DATABASE_URL` is set (`aiCrm.persistenceMode` is `"memory"` | `"pg"`). Full PostgreSQL-backed governance as the primary SoR is **not** yet cut over. There is currently **no `apps/worker` package and no Temporal dependency in this repo** (ADR-001 Option D pilot uses worker+PG later; Temporal stays out of T-001..T-020); the lease/epoch design below is plain synchronous TypeScript that a future worker is expected to drive, not a running scheduled process today.

## 1. Control lifecycle (`ControlStatus`)

Type (as declared in `packages/governance/src/index.ts`): `"PENDING" | "APPROVED" | "REJECTED" | "CONSUMED" | "EXPIRED" | "CANCELLED"`.

Implemented transitions in `GovernanceAuthorizationService`:

| From | To | Trigger | Guard |
|---|---|---|---|
| *(created)* | `PENDING` | `authorize()` resolves an `ActionType` whose policy control is `CHECKPOINT` or `REQUIRE_APPROVAL` | Policy must not resolve `BLOCK`. |
| `PENDING` | `APPROVED` / `REJECTED` | `decideControl(controlId, principalId, decision, workspaceId)` | Control must exist in the same workspace and be `PENDING` (`CONTROL_NOT_PENDING` otherwise); the deciding principal must not be the requester (`SEPARATION_OF_DUTY` otherwise) — this is the only SoD check implemented for controls today. |
| `APPROVED` | `CONSUMED` | `consumeControl(controlId, binding, idempotencyKey?)` | Control must currently be `APPROVED` (`CONTROL_NOT_APPROVED` otherwise); `workspaceId`, `resourceId`, `resourceVersion`, `payloadHash`, `policyVersion` on the supplied binding must match the control exactly (`STALE_CONTROL_BINDING` on any mismatch) — consumption is single-use: once `CONSUMED`, the control can never be re-consumed or re-decided. |
| `PENDING` \| `APPROVED` | `CANCELLED` | `cancelControl(controlId, workspaceId)` | Control must exist in the same workspace. Terminal statuses (`CANCELLED`, `EXPIRED`, `CONSUMED`, `REJECTED`) are idempotent no-ops (return as-is). Any other non-cancellable status throws `CONTROL_NOT_CANCELLABLE`. Audits `CONTROL_CANCELLED`. **Call path:** job/work-item cancel in `apps/api` natural-command service clears bound controls via this method so an abandoned approval cannot later be consumed. |
| `PENDING` | `EXPIRED` | `expireControl(controlId, workspaceId)` | Control must exist in the same workspace. Already-`EXPIRED` is idempotent. Non-`PENDING` (other than already-expired) throws `CONTROL_NOT_PENDING`. Audits `CONTROL_EXPIRED`. **Call path:** GOV-U-05 TTL/timeout path — exercised in governance unit tests; no scheduled expiry scanner is wired into `createApp` yet, so callers (or a future worker) must invoke it. |

**Not a control status today:** the plan's "Rejection may create a new `REWORK_REQUIRED` business state" remains a design note — `REWORK_REQUIRED` does not exist in `ControlStatus` (the PG adapter maps a legacy DB value `REWORK_REQUIRED` → in-memory `PENDING` only). There is still no automatic control-expiry timer inside `createApp`; `expireControl` is the explicit API.

The `packages/contracts` `ControlSchema`/`CONTROL_KINDS` (`HUMAN_APPROVAL`, `RATE_LIMIT`, `BUDGET_CAP`, `KILL_SWITCH`, `DRY_RUN`, `SCOPE_LOCK`) describe a separate, more general configurable-control concept (`Control.kind: ControlKindSchema`, `isEnabled`, `configuration`). This is **not** the same type as `packages/governance`'s runtime `ControlRequest.kind: "APPROVAL" | "CHECKPOINT"`, which is a narrower, hardcoded binding to the two policy tiers actually enforced (§policy-matrix.md). The `CONTROL_KINDS` enum is validated by `ControlSchema` in the contracts package but is not yet consumed by `GovernanceAuthorizationService` — rate limits, budget caps, kill switches, dry-run mode, and scope locks are declared as a contract shape but have no runtime enforcement path today.

## 2. Intent lifecycle (`IntentStatus` / `INTENT_STATES`)

Type (`packages/contracts`): `INTENT_STATES = ["QUEUED", "LEASED", "DISPATCHING", "SUCCEEDED", "FAILED", "UNKNOWN", "INVALIDATED", "CANCELLED"]`. `INTENT_STATE_TRANSITIONS` (also `packages/contracts`) is the authoritative forward-transition table, checked by `isValidIntentTransition(from, to)`:

```
QUEUED:      [LEASED, CANCELLED, INVALIDATED]
LEASED:      [DISPATCHING, QUEUED, CANCELLED, INVALIDATED]
DISPATCHING: [SUCCEEDED, FAILED, UNKNOWN]
SUCCEEDED:   []
FAILED:      [QUEUED, INVALIDATED]
UNKNOWN:     [QUEUED, INVALIDATED]
INVALIDATED: []
CANCELLED:   []
```

`packages/governance`'s `GovernanceAuthorizationService` implements exactly this table via distinct methods, each an atomic in-memory transaction (`transact`, structured-clone + commit):

| Method | Transition | Guard / audit emitted |
|---|---|---|
| `createIntent` (via `authorize`/`consumeControl`) | *(created)* → `QUEUED` | Deduplicates by idempotency key (`workspaceId:resourceId:actionType:payloadHash:resourceVersion` unless an explicit key is supplied); duplicate key throws `DUPLICATE_INTENT`. Audits `INTENT_QUEUED`. |
| `leaseIntent(intentId, nowIso, deadlineIso)` | `QUEUED → LEASED` | Requires current state `QUEUED` (`INTENT_NOT_QUEUED` otherwise) and a future deadline (`INVALID_LEASE` otherwise). Increments `leaseEpoch`, mints `leaseToken = "<intentId>:epoch:<leaseEpoch>"`, sets `leaseDeadline`. Audits `LEASE_ACQUIRED` with epoch + deadline. |
| `recoverExpiredLeases(nowIso)` | `LEASED → QUEUED` (only for intents whose `leaseDeadline` has passed) | Deletes the (now-stale) `leaseToken`/`leaseDeadline`; **does not** decrement or reset `leaseEpoch` — the epoch keeps monotonically increasing, so no epoch is ever reused. Audits `LEASE_EXPIRED_RECOVERED` per recovered intent. |
| `startDispatch(intentId, token, nowIso)` | `LEASED → DISPATCHING` | Calls `requireActiveLease`: intent must be `LEASED`, `leaseToken` must equal the caller's `token`, `leaseDeadline` must exist and not have passed (`STALE_LEASE_TOKEN` on any failure) — this is the fencing check that rejects a stale/expired worker attempting to dispatch. Audits `DISPATCH_STARTED`. |
| `finishIntent(intentId, token, outcome)` | `DISPATCHING → SUCCEEDED\|FAILED\|UNKNOWN` | Requires current state `DISPATCHING` and the caller's `token` to still equal `leaseToken` (`STALE_LEASE_TOKEN` otherwise — the same fencing guard applied to result writes, not just dispatch starts). Clears lease fields. Audits `INTENT_<OUTCOME>`. |
| `invalidateIntent(intentId, status?)` | `QUEUED\|LEASED → INVALIDATED\|CANCELLED` | Refuses if the intent is already past `LEASED` (`INTENT_ALREADY_EFFECTING` — once dispatch has begun, cancellation/mutation can no longer claim "no effect occurred"). Clears lease fields. Audits `INTENT_<STATUS>`. |
| `markIntentApplied(workspaceId, intentId)` | `QUEUED → SUCCEEDED` (single-use synchronous internal effect) | Requires current state `QUEUED` (`INTENT_NOT_QUEUED` otherwise) — this is the single-use consume/bind path for `allow`-tier internal effects applied synchronously in the same HTTP request that consumed the control, so a consumed authorization cannot be replayed for a second internal effect. Audits `INTENT_SUCCEEDED` with `applied: true`. |

Note that `FAILED`/`UNKNOWN → QUEUED` (re-queue for retry) is declared in `INTENT_STATE_TRANSITIONS` but has no dedicated `GovernanceAuthorizationService` method yet distinct from the initial `createIntent` path — a future retry/redispatch flow would need to add it explicitly, and per the plan, redispatch from `UNKNOWN` must never be automatic.

### Durable lease/epoch fencing: schema-ready vs runtime-pending

**Schema-ready (columns exist and are exercised by the persistence security tests):** `packages/persistence/src/schema.ts` declares `executionIntents.leaseDeadline` (`timestamp`), `executionIntents.leaseEpoch` (`integer`, default `0`), `executionIntents.leaseToken` (`text`), `executionIntents.leasedByPrincipalId`, `executionIntents.dispatchAttemptCount`, `executionIntents.resultHash`, `executionIntents.failureReason`, plus an index on `leaseDeadline` for scan efficiency. `packages/persistence/test/schema.security.test.ts` asserts (as SQL text, without connecting to PostgreSQL) that a migration trigger (`execution_intents_immutable_binding`) protects the immutable binding columns while allowing lifecycle/lease columns to change.

**Runtime-pending:**
- The **lease-expiry recovery scan** is implemented as `GovernanceAuthorizationService.recoverExpiredLeases(nowIso)` — a plain method that must be called by something. There is no scheduled process, cron, or Temporal workflow in this repo that calls it periodically; it is invoked directly by callers/tests only.
- The plan's `DISPATCHING`-deadline scanner and crash→`UNKNOWN` named-reconciliation-owner flow (ADR-008/009 follow-up) is **not implemented at all** — `packages/governance` has no method that scans stuck `DISPATCHING` intents. This is explicitly non-blocking for MVP because there is no remote dispatch path yet (see `docs/adr/010-model-gateway.md` and `docs/architecture/capability-matrix.md`); it is recorded here as a required precondition before any future connector is enabled with a live credential.
- There is no `apps/worker`/Temporal package in the repository. ADR-001 names Temporal as the durable-workflow engine for lease/epoch fencing and long-lived approval waits; as implemented, `GovernanceAuthorizationService` performs the same fencing logic synchronously and in-memory per API process, with no durability across process restarts (the service holds `GovernanceState` in memory; `apps/api`'s `createApp` constructs a fresh instance unless a caller injects prior state).

## 3. Notification lifecycle (`NotificationStatus`)

Type (`packages/governance`): `"PENDING" | "SENT" | "ACKED" | "ESCALATED" | "DEAD_LETTER"`.

`GovernanceAuthorizationService.transitionNotification(id, next, workspaceId)` enforces this allowed-transition table exactly:

```
PENDING:    [SENT, DEAD_LETTER]
SENT:       [ACKED, ESCALATED, DEAD_LETTER]
ACKED:      []
ESCALATED:  [ACKED, DEAD_LETTER]
DEAD_LETTER: []
```

`createNotification(workspaceId, subjectId)` creates a `PENDING` record with `attempts: 0`; `transitionNotification` increments `attempts` only on transition to `SENT` or `DEAD_LETTER`, and rejects any transition not present in the table above (`INVALID_NOTIFICATION_TRANSITION`). As with controls and intents, this is workspace-scoped in-memory state (`GovernanceState.notifications`) — the plan's 60-second SENT SLO / 5-minute escalation SLO and outage/retry/dead-letter-triage ownership are **design targets**, not currently measured or enforced by any running timer in this codebase; no notification worker exists yet to drive retries or measure SLO compliance.

## 4. Single-use consume/bind semantics (as implemented)

Two independent single-use mechanisms exist today, both enforced by `GovernanceAuthorizationService`:

1. **Control consumption** (`consumeControl`): an `APPROVED` control can be consumed exactly once. The transition to `CONSUMED` and the creation of the resulting `ExecutionIntent` happen inside one `transact()` call (one atomic in-memory commit), so there is no window in which the same approved control could be consumed twice. A second `consumeControl` call against the same `controlId` fails `CONTROL_NOT_APPROVED` because the status is no longer `APPROVED`.
2. **Synchronous internal-effect application** (`markIntentApplied`): for `allow`-tier `ActionType`s that apply their effect synchronously inside the same request that authorized them, the resulting `QUEUED` intent is marked `SUCCEEDED` exactly once; a second call against the same intent fails `INTENT_NOT_QUEUED`. This is the "single-use consume/bind" path referenced by the plan for internal-reversible effects that do not go through the full lease/dispatch lifecycle (they never become `LEASED`/`DISPATCHING`).

Both mechanisms rely on the same underlying guarantee: `GovernanceAuthorizationService.transact()` clones the current state, applies the operation, and only then commits it back as the new `this.state` — there is no interleaving of two concurrent transactions against the same in-memory service instance in the current single-process implementation. A future PostgreSQL-backed implementation is expected to replace this with `SELECT ... FOR UPDATE` row locking (per the plan's fixed lock order **resource → control request → intent**), which is not yet implemented; the in-memory model does not need row locks because JavaScript's single-threaded event loop already serializes calls into `transact()`.
