# SoR persistence (G-01): governance + orchestration dual-write, RLS scoping, hydrate-on-boot

Real-postgres design and honest scope for the G-01 restart-consistent
system-of-record. Request-path SoR stays in-memory (`OrchestrationService` /
`GovernanceAuthorizationService`); an optional Postgres pool mirrors a
snapshot on every mutation and rebuilds the in-memory state from Postgres on
boot (hydrate-on-boot, fail-closed).

## Tables

- `orch_jobs`, `orch_work_items`, `orch_job_events` — `0003_orchestration.sql`.
- `orch_governance_controls`, `orch_governance_intents` —
  `0004_governance_snapshot.sql`.
- `crm_customers` — `0005_crm_customers.sql` (N-12 / D2, first CRM domain PG
  proof; CUSTOMERS ONLY — see the N-12 section below).

`orch_governance_controls` / `orch_governance_intents` are **sidecar
snapshot tables**, not the foundation `control_requests` /
`execution_intents` tables from `0001_foundation.sql`. The foundation tables
require `policy_decision_id` / `control_claim_id` foreign keys that the
in-memory `GovernanceAuthorizationService` model does not carry (no
`PolicyDecision` row, no `ControlClaim` row per control). Persisting
`PersistedControlShape` / `PersistedIntentShape` verbatim into a dedicated
table — mirroring the `0003_orchestration.sql` pattern (text PK, workspace
FK, FORCE RLS, workspace isolation policy, runtime grants) — avoids
inventing FK values the in-memory model has no source of truth for. Full
dual-write cutover onto the foundation governance tables is a distinct,
larger migration (schema alignment + backfill of policy decisions) and is
out of scope here.

Both governance tables are `ENABLE + FORCE ROW LEVEL SECURITY` with a
`workspace_isolation` policy against `app_current_workspace_id()`, matching
`0001`/`0003`; `crm_customers` (`0005`) follows the identical pattern.
Verify live with `packages/persistence/scripts/pg-rls-smoke.sh`, which now
applies and checks `0001`..`0005`.

## RLS workspace scoping on the PG adapters

`packages/orchestration/src/pg-store.ts` and
`packages/governance/src/pg-governance-adapter.ts` expose an optional
`PgQueryable.withWorkspaceScope(workspaceId, fn)` method. Per-workspace
repository ops (`saveSnapshot`, `getJob`, `getByIdempotency`,
`listJobSnapshots(ws)`, `saveControl`, `loadControl`, `saveIntent`,
`loadIntent`, `listControls`, `listIntents`) run through
`this.scoped(workspaceId, fn)`, which calls `withWorkspaceScope` when the
injected pool implements it and falls back to running directly against the
pool otherwise.

This exists because a plain `pg.Pool.query()` call checks out a **different**
connection from the pool on every invocation. Running `SET LOCAL
app.workspace_id = ...` on one `pool.query()` call and the actual
INSERT/SELECT on the next would silently not scope anything — the GUC set on
connection A has no effect on the unrelated connection B that serves the
next query. That was the real RLS gap: without a shared connection/txn, FORCE
RLS on `orch_jobs` / `orch_governance_controls` etc. would either reject the
write (`app.workspace_id is not set`) or, worse, allow it to slip past a
policy that silently evaluates against a stale/wrong GUC value from a
different session.

`apps/api/src/app.ts` closes this gap for real Postgres via
`createScopedPgQueryable(pool)`: `withWorkspaceScope` checks out a single
connection with `pool.connect()`, runs `BEGIN`, sets the GUC with
`SELECT set_config('app.workspace_id', $1, true)` (the parameterized
equivalent of `SET LOCAL app.workspace_id = $1` — Postgres does not accept
bind parameters directly in `SET`/`SET LOCAL` syntax), executes the scoped
callback against that connection, then `COMMIT`s and releases the connection
back to the pool. Unit-test mocks (`pg-store.unit.test.ts`,
`pg-governance-adapter.unit.test.ts`, `sor-restart.integration.test.ts`) do
not implement `withWorkspaceScope`, so `scoped()` falls back to calling the
mock's `query()` directly — the exact SQL the mocks already assert on is
unchanged.

## Hydrate-on-boot: the admin/cross-workspace path

`listAllControls()`, `listAllIntents()`, and `listJobSnapshots()` (no
workspace argument) read **across every workspace** and deliberately do
**not** go through `withWorkspaceScope` — there is no single workspace to
scope to. `apps/api/src/app.ts`'s `onReady` hook calls these three during
hydrate-on-boot and hydrates `OrchestrationService` /
`GovernanceAuthorizationService` from the result, fail-closed: any hydrate
error throws and aborts boot rather than silently serving stale/empty
in-memory state as authoritative.

**This is an admin/cross-workspace read path and must run under a
connection that can see every workspace's rows despite FORCE RLS.** The
local docker bootstrap user (`ai_crm`) is a Postgres **superuser**, which
bypasses RLS entirely — that is why hydrate-on-boot works out of the box in
dev/pilot. **Production must not reuse the bootstrap superuser for the
running application.** Options for production:

- `CreateAppOptions.adminDatabaseUrl` (env `ADMIN_DATABASE_URL`) — **G-01
  MEDIUM 4 role separation, implemented.** When set, `createApp`'s `onReady`
  hook opens a **second**, separate `pg.Pool` against this DSN and uses it
  ONLY for the three hydrate-on-boot admin reads
  (`listAllControls()` / `listAllIntents()` / `listJobSnapshots()` no-arg).
  Point it at a dedicated `BYPASSRLS` (or otherwise cross-workspace-capable)
  role, separate from `ai_crm_runtime_api` / `ai_crm_runtime_worker` (both
  `NOBYPASSRLS` by design — see `0001_foundation.sql` /
  `0003_orchestration.sql` / `0004_governance_snapshot.sql`). The
  per-request scoped pool (`createScopedPgQueryable`, used for every
  workspace-scoped mutation/read after boot) always uses the main
  `databaseUrl`/`pgPool`, never the admin pool — role separation is boot-time
  only, matching the "no single connection needs both bypass-RLS admin
  power and live request traffic" goal.
- Or: iterate known workspace ids and call the scoped per-workspace
  `listJobSnapshots(ws)` / `listControls(ws)` / `listIntents(ws)` variants
  once per workspace instead of the unscoped admin reads, if a
  `BYPASSRLS`/superuser connection is not acceptable in a given deployment.

**When `adminDatabaseUrl`/`ADMIN_DATABASE_URL` is unset**, hydrate-on-boot
falls back to the main pool/DSN — the documented dev behavior where the
docker `ai_crm` bootstrap superuser bypasses RLS by design. This fallback
keeps existing dev/pilot/test behavior unchanged; no production deployment
should rely on it once a real `ai_crm_runtime_api`-equivalent, non-superuser
application role is in front of Postgres.
## Reports/ledger/model-invocation hydrate-on-boot also use the admin pool (Q2 architect P2-1)

`listAllReports()` (reports), `listAllEntries()` (ledger), and
`listAllInvocations()` (model-invocation) are the same shape of problem as
`listAllControls()`/`listAllIntents()`/`listJobSnapshots()` above: unscoped,
cross-workspace reads with no single workspace to `SET LOCAL app.workspace_id`
to. Before this fix they always ran on the per-request runtime pool/store
(`reportsRepo`/`ledgerRepo`/`modelInvocationRepo`, backed by
`ai_crm_runtime_api`/`ai_crm_runtime_worker`/`ai_crm_runtime_model_gateway`
respectively — all `NOBYPASSRLS` by design). In dev/CI that's masked by the
docker bootstrap superuser (same reason the controls/intents/job-snapshot
hydrate worked before G-01 MEDIUM 4), but a role-separated production deploy
running those roles for real would hit the fail-closed
`app_current_workspace_id()` RAISE on hydrate and abort boot (`onReady`
rethrows every hydrate error, per the fail-closed contract above).

**Fix:** `onReady` now prefers `hydrateReportsRepo`/`hydrateLedgerRepo`/
`hydrateModelInvocationRepo` — sourced from the same `adminDatabaseUrl`
`pg.Pool` as the orch/gov/crm hydrate reads above — falling back to the
per-request repo only when `adminDatabaseUrl` is unset (the same documented
dev fallback shape). No new admin connection is opened for this; it reuses
the single admin pool already opened for controls/intents/job-snapshot
hydrate.

**ADR-010 nuance for model-invocation:** the disjoint-principal boundary
(`model_invocations` WRITES only through `ai_crm_runtime_model_gateway`,
never re-granted to api/worker) is about writes and is untouched here — see
`docs/adr/010-model-gateway.md` and `docs/security/rls-role-model.md`. The
hydrate-on-boot `listAllInvocations()` call is a READ, and an unscoped,
cross-workspace read at that; ADR-010 does not require it to run under the
model-gateway role specifically, only that it never uses a role that can
write `model_invocations` outside the gateway. Routing this one read through
the admin/cross-workspace pool (same pool used for reports/ledger/controls)
satisfies both: it never touches `model_invocations` WRITE grants, and it
avoids requiring the model-gateway role itself to also be
cross-workspace-capable (`ai_crm_runtime_model_gateway` stays `NOBYPASSRLS`
and workspace-scoped for its own per-request inserts, unchanged).

**Boot-time assertion (fails loudly, not silently):** there is no separate
synchronous "is this pool cross-workspace-capable?" check beyond the
existing `select 1 as ok` connectivity probe on `adminDatabaseUrl` (see
above) — that would only prove the DSN can connect, not that its role
bypasses RLS. The real assertion is structural: `hydrateReportsRepo`/
`hydrateLedgerRepo`/`hydrateModelInvocationRepo`'s unscoped reads run
`SELECT ... FROM report_snapshots|finance_journal_entries|model_invocations`
with no `app.workspace_id` GUC set. Under FORCE RLS + `NOBYPASSRLS`, that
either returns zero rows (silently wrong — but ruled out because the
underlying `workspace_isolation` policy's `USING` clause calls
`app_current_workspace_id()`, which itself `RAISE`s when the GUC is unset)
or raises. Either way, `onReady`'s per-hydrate try/catch (ledger/reports/
model-invocation each have their own, independent of the orch/gov/crm block)
rethrows as `Error("... hydrate-on-boot failed; restart-consistent SoR
could not be established: ...")`, which aborts `app.ready()` — a misconfigured
admin role (wrong DSN, `NOBYPASSRLS` role, missing grants) fails boot
loudly with that message, it can never silently start serving
stale/empty state.


## PG-primary scoped governance reads (N-08 / D4)

`GET /api/governance/controls` and `GET /api/governance/controls/:controlId`
in `apps/api/src/app.ts` route to **PG-primary** reads whenever a `govRepo`
(PG pool) is present: they call the new
`GovernanceRepository.getControlsForWorkspace(workspaceId)` /
`loadControl(workspaceId, controlId)` methods, which run a workspace-scoped
`SELECT` against `orch_governance_controls` through
`withWorkspaceScope` (so FORCE RLS enforces the boundary), and convert the
returned `PersistedControlShape` rows back to `ControlRequest` via
`controlFromPersisted`. The in-memory
`GovernanceAuthorizationService` snapshot is **not consulted** on this path
— a row written directly into PG (bypassing the app entirely) is visible on
the very next read. Memory mode (no pool/`govRepo`) is unchanged: both
routes fall back to `governance.listControls`/`getControl` exactly as
before, so every existing memory-mode test stays green.

`getIntentsForWorkspace(workspaceId)` exists on the same repository (PG +
in-memory) for symmetry and future use; there is currently no
`GET /api/governance/intents` HTTP route to wire it to.

## Audit chain dual-write: `audit_events` / `audit_chain_heads` / `outbox_events` (N-08 / D3)

**PG-D (D3) update — audit write is now PG-PRIMARY fail-closed for
governance-bearing mutations, closing the N-08/§3F "audit write
memory-primary" residual.** `POST /api/governance/authorize`,
`.../controls/:id/decide`, and `.../controls/:id/consume` no longer call
the in-memory `governance.authorize`/`decideControl`/`consumeControl`
directly. They mirror the PG-C1 ledger `previewDraft`/PG-write/`commitDraft`
split (`apps/api/src/app.ts` ledger routes, `packages/finance/src/ledger.ts`):

1. `governance.previewAuthorize` / `previewDecideControl` /
   `previewConsumeControl` (`packages/governance/src/index.ts`) compute the
   FULLY VALIDATED transition — including the new audit event(s) — into a
   detached `{ draft, result }` handle WITHOUT touching the service's
   committed `this.state`.
2. `pgFirstAuditAppend(workspaceId, preview.draft)`
   (`apps/api/src/app.ts`) is `await`ed next: it appends ONLY the audit
   event(s) new since the last flush (`draft.audits` filtered/sliced against
   the same `dualWrittenAuditCount` cursor `dualWriteAudit` uses) onto PG's
   `audit_events`/`audit_chain_heads`/`outbox_events` via
   `GovernanceRepository.appendAuditEvents`. **This call is NEVER wrapped in
   a swallowing try/catch** — a PG failure (dropped connection, constraint
   violation, RLS denial) throws straight out of the route handler, which
   Fastify's default error path turns into a 5xx response.
3. Only after that PG write resolves does the route call
   `governance.commitAuthorize` / `commitDecideControl` /
   `commitConsumeControl`, which assigns `preview.draft` onto the service's
   `this.state` — this is the ONLY place the in-memory governance mutation
   becomes visible (`GET /api/governance/controls`, `listAuditEvents`,
   `verifyAuditChain`, etc.).

Because the preview draft is a `structuredClone` detached from `this.state`
(see `GovernanceAuthorizationService.previewTransact`/`commitTransact` in
`packages/governance/src/index.ts`), a PG audit-write failure that throws
before `commit*` runs leaves in-memory governance state **byte-identical**
to before the attempted mutation — memory can never advance past a
dropped/failed PG audit write for these three routes. `dualWriteGovernance`
(control/intent row mirror to `orch_governance_controls`/`orch_governance_intents`)
still runs best-effort AFTER the commit, unchanged — it is not part of the
audit-integrity surface D3 hardens.
**P6-b G002 (PG-D) — architect P2 fix: per-workspace mutex closes the
concurrent-same-workspace TOCTOU the preview->await PG write->commit split
opened.** The `await` between preview (a `structuredClone` snapshot of
`this.state`) and commit (`this.state = draft`) lets a second same-workspace
request interleave: without further guarding, both requests preview from the
SAME pre-image, both commit, and the later commit clobbers the earlier one
in memory (a lost update on `GET /audit`/`GET /controls`), and two
concurrent `/consume` calls on one `APPROVED` control can both pass the
`status === "APPROVED"` preview check before either commits (double
`CONTROL_CONSUMED` for a single-use control). PG chain integrity itself was
never at risk — `audit_chain_heads`' `FOR UPDATE` row lock already
serializes the PG write per workspace — but the in-memory SoR could
transiently diverge from PG and from itself. `withWorkspaceMutex`
(`apps/api/src/app.ts`) closes this by serializing the ENTIRE
preview->PG-write->commit critical section per workspace: an in-process
`Map<workspaceId, Promise-chain>` so a second same-workspace mutation's
critical section never starts until the first's has fully settled (success
or failure — a thrown/rejected mutation releases the lock immediately, it
never wedges the workspace). Different workspaces get independent chains
and never block each other (no global lock, no cross-workspace
head-of-line blocking, no deadlock). It wraps all three governance routes
(authorize/decide/consume) AND the four ledger routes (draft/verify/
post/reverse), which share the identical preview/PG-write/commit shape.
In-process only (single-instance); multi-instance ordering is already
covered by PG's `FOR UPDATE` head lock plus the single-instance eventing
note above. Memory mode is unaffected (the mutex still serializes the
in-memory preview/commit pair with no `govRepo`/`ledgerRepo`, which is
strictly safer and negligible overhead for the single-request common case).
Falsifiably proven live against real PG by
`apps/api/test/pg-mutex-concurrency.livepg.integration.test.ts`
(`LIVE_PG_TEST=1`): concurrent same-workspace authorize shows no lost
update (memory audit count == PG `audit_events` count == chain-head), a
concurrent `/consume` pair on one control yields exactly one success, a
concurrent `/verify` pair on one ledger entry yields exactly one success,
and two different workspaces make concurrent progress without
head-of-line blocking behind a slow one.

Every OTHER governance-audit-bearing surface — `POST /api/notifications`,
`POST /api/notifications/:id/transition`, and any mutation folded into
`dualWriteAgentState` (agent command execution, job cancel, work-item
completion, the AI-review REWORK bridge) — still calls the pre-existing
`dualWriteAudit(ws)` AFTER the in-memory mutation, and stays
**best-effort**: a failure there is swallowed (`[DUALWRITE_FAILED]`
warn + `dualWriteFailures` counter), memory stays authoritative, and the
request still succeeds. This is an intentional, documented scope split
(constraint: "notification best-effort stays") — only the
authorize/decide/consume governance-bearing mutation routes are PG-primary
fail-closed. `dualWriteAudit` tracks, per workspace, how many of
`governance.listAuditEvents(workspaceId)`'s (in-memory, append-only within
the process) events have already been flushed to PG, and appends only the
new ones via `GovernanceRepository.appendAuditEvents(workspaceId, events)`.
Both `pgFirstAuditAppend` and `dualWriteAudit` share the same
`dualWrittenAuditCount` cursor, so a fail-closed flush from one of the three
routes above is never redelivered by a later best-effort `dualWriteAudit`
call for the same workspace.

In memory mode (no `govRepo`/pool), `pgFirstAuditAppend` and
`dualWriteAudit` both no-op immediately — behavior there is byte-identical
to before D3; every pre-existing memory-mode API/governance test stays
green unmodified.

`PgGovernanceRepository.appendAuditEvents` (`packages/governance/src/pg-governance-adapter.ts`)
does real, column-mapped, in-transaction work inside one
`withWorkspaceScope` call:

1. `INSERT INTO audit_chain_heads (workspace_id, head_sequence) VALUES ($1, 0) ON CONFLICT (workspace_id) DO NOTHING` — creates the head row on first use.
2. `SELECT head_sequence, head_event_hash FROM audit_chain_heads WHERE workspace_id = $1 FOR UPDATE` — row-locks the head so two concurrent callers on the same workspace serialize instead of racing (proven live by the 2-writer test below: contiguous, gap-free, duplicate-free `head_sequence`).
3. For each new event: `INSERT INTO audit_events (workspace_id, sequence, event_type, payload, previous_event_hash, event_hash, correlation_id) VALUES (...) RETURNING id`, then `INSERT INTO outbox_events (workspace_id, audit_event_id, event_type, partition_key, payload, status) VALUES (..., 'PENDING')`. `sequence`/`previous_event_hash`/`event_hash` are allocated from the row-locked head, not from the in-memory `AuditEvent.sequence`/hash chain — the two chains are intentionally independent (see below).
4. `UPDATE audit_chain_heads SET head_sequence = $2, head_event_id = $3, head_event_hash = $4, updated_at = now() WHERE workspace_id = $1` — advances the head past every event just written (satisfies the `audit_chain_heads_monotonic` trigger).

The whole call runs inside `withWorkspaceScope`'s single checked-out
connection/transaction (`BEGIN` ... `COMMIT`), so FORCE RLS, the
`audit_events_append_only` trigger, and the `audit_chain_heads_monotonic`
trigger all apply atomically — a partial audit write (events inserted but
the head not advanced, or vice versa) cannot be observed. Grants for
`ai_crm_runtime_api` (`SELECT, INSERT` on `audit_events`/`outbox_events`,
`SELECT, INSERT, UPDATE` on `audit_chain_heads`) already existed in
`0001_foundation.sql` before this change — verified, no new migration was
needed.

**The PG chain-head is independent of the in-memory hash chain.**
`GovernanceAuthorizationService.appendAudit` still assigns its own
`sequence`/`previousHash`/`hash` for the in-memory `audits` array (used by
`GET /api/governance/audit` and `verifyAuditChain` in memory mode) — that
chain resets to empty on every process restart (hydrate does not source
audits, see Scope limit below). The PG chain, by contrast, **never resets**:
its sequence numbers come from `audit_chain_heads.head_sequence`, which
survives restarts. This is why a fresh instance's audit dual-writes
continue the real PG chain instead of colliding with sequence 1 again —
`dualWrittenAuditCount` (the in-memory "already flushed" cursor) starts at
0 for every workspace on every boot, but `appendAuditEvents` always
re-reads the live PG head under `FOR UPDATE` before allocating new
sequence numbers, so the numbers it hands out simply continue from
wherever PG left off.

Hydrate-on-boot additionally reads `audit_chain_heads.head_sequence` (via
the new `GovernanceRepository.getAuditChainHead(workspaceId)`) for every
workspace observed in the hydrated controls/intents and exposes it as
`aiCrm.auditChainHeads: Record<string, number>` on the Fastify runtime
decoration — a continuity snapshot for ops/tests proving the instance is
aware of the continuing chain, not the sequence source of truth (that's
always the live `FOR UPDATE` read on the next append).
## Dual-write failure observability

`dualWriteJobSnapshot` / `dualWriteGovernance` / `dualWriteAudit` /
`dualWriteCrmCustomer` in `apps/api/src/app.ts` all stay best-effort: a
failed PG write never fails the in-flight request (memory stays
authoritative), but a failure no longer disappears silently. Each catch
increments `aiCrm.dualWriteFailures` (exposed on the Fastify `aiCrm`
runtime decoration for tests / a future `/metrics` route) and emits
`console.warn("[DUALWRITE_FAILED] target=... workspaceId=... ...")` with the
workspace/job context and the underlying error message. `dualWriteAudit`
uses `target=audit_chain`; `dualWriteCrmCustomer` uses `target=crm_customers`.
This best-effort posture does NOT apply to `pgFirstAuditAppend` (see PG-D /
D3 above) — that call is intentionally never wrapped in a try/catch, so a
failure there increments nothing and emits no `[DUALWRITE_FAILED]` warn; it
propagates as a thrown error / 5xx instead, by design.

## N-13: audit restart-sourced (D3 — CLOSES the N-08 residual above)

The N-08 residual documented above — "hydrate-on-boot does **not** replay
`audit_events` rows back into `GovernanceAuthorizationService`'s in-memory
`audits` array" — is **CLOSED** as of N-13:

1. `GovernanceRepository.getAuditEventsForWorkspace(workspaceId)`
   (`packages/governance/src/pg-governance-adapter.ts`) is a new
   `withWorkspaceScope`d `SELECT id, sequence, event_type, payload,
   previous_event_hash, event_hash FROM audit_events WHERE workspace_id = $1
   ORDER BY sequence ASC` — the same scoping pattern as
   `getControlsForWorkspace`/`getIntentsForWorkspace`.
2. `GovernanceAuthorizationService.hydrate({ controls, intents, audits })`
   (`packages/governance/src/index.ts`) gained an optional `audits` field:
   when supplied, every persisted row is pushed into `state.audits`
   **verbatim**, including the PG-computed `hash`/`previousHash` columns.
3. `apps/api/src/app.ts`'s `onReady` hydrate-on-boot step now calls
   `getAuditEventsForWorkspace(ws)` for every workspace observed in the
   hydrated controls/intents (same workspace set `auditChainHeads` already
   used), flattens the results, and passes them to `governance.hydrate(...)`
   — so `GET /api/governance/audit` and `GET /api/governance/audit/verify`
   reflect PG history and validate the continuing chain immediately after
   restart, instead of resetting to empty. The dual-write flush cursor
   (`dualWrittenAuditCount`) is seeded to the hydrated count per workspace
   so a post-restart mutation does not re-flush already-persisted events.
4. **Tamper-evidence across restart is real, not assumed.** Both the
   in-memory chain (`appendAudit`/`verifyAuditChain` in `index.ts`) and the
   PG chain (`PgGovernanceRepository.appendAuditEvents` /
   `getAuditEventsForWorkspace`) now compute the audit-event hash via one
   shared function, `computeAuditEventHash`
   (`packages/governance/src/pg-governance-adapter.ts`) — a hash produced on
   write, whether by the in-memory service or reconstructed from a hydrated
   PG row, verifies identically. **Important subtlety**: Postgres `jsonb`
   storage does not preserve object key insertion order, so
   `computeAuditEventHash` serializes the event `data` field with
   `stableStringify` (recursively key-sorted, from `@ai-crm/policy-engine`)
   rather than plain `JSON.stringify` — otherwise a hash computed
   pre-insertion from the original JS object would spuriously fail to
   re-verify after a `jsonb` round-trip even with zero tampering. Because
   hydrate copies the PG `hash`/`previousHash` columns verbatim (it does
   NOT recompute them), a row tampered directly in PG (`UPDATE audit_events
   SET payload = ...` out-of-band) is detected: `verifyAuditChain` recomputes
   the hash from the (now-tampered) `data` + `previousHash` and compares
   against the still-original, now-mismatching `hash` column — a broken
   chain, exactly like tampering an in-memory event today.
5. The two chains (in-memory sequence/hash vs. PG `audit_chain_heads`
   sequence/hash) remain **structurally independent allocators** — PG still
   always re-reads its own live head under `FOR UPDATE` before allocating a
   new sequence, never trusting the in-memory sequence number — but because
   both now use the same hash algorithm, a chain built from one flush
   (in-memory) and read back from the other (PG) validates as one
   continuous, tamper-evident history.

Proven live end-to-end in
`apps/api/test/n12-n13-livepg.integration.test.ts` (`LIVE_PG_TEST=1`, see
Live verification below): instance A performs governed mutations; fresh
instance B hydrates and `GET /api/governance/audit` returns A's events
(not empty) with `GET /api/governance/audit/verify` returning `true`; a
mutation on B correctly continues the chain (sequence `N+1`, still
verifies); and a directly-tampered PG `audit_events` row is detected as a
broken chain (`verify` returns `false`) after a fresh hydrate-restart.

## N-12: CRM customers PG repository (D2 — first CRM domain PG proof)

`CrmService` (`packages/domain/src/crm.ts`) holds `customers` / `contracts`
/ `communications` / `nextActions` / `exceptions` in in-memory `Map`s. N-12
gives **CUSTOMERS ONLY** a real PG-backed restart path, as the first proof
that a non-governance/orchestration domain can be dual-written +
hydrate-replayed the same way:

1. `crm_customers` (`0005_crm_customers.sql`) — text PK (opaque customer id,
   caller-supplied, `CrmService` mints none of its own), `workspace_id uuid
   REFERENCES workspaces(id)`, `name`, `status`, `version` (mirrors
   `Customer.version` optimistic concurrency), `ENABLE + FORCE ROW LEVEL
   SECURITY`, `workspace_isolation` policy, and the same
   `ai_crm_runtime_api`/`ai_crm_runtime_worker`/`ai_crm_audit_verifier`
   grants as `0003`/`0004`.
2. `packages/domain/src/pg-crm-adapter.ts` — mirrors
   `pg-governance-adapter.ts`/`pg-store.ts`: `CrmRepository` port
   (`saveCustomer`, `getCustomersForWorkspace`, `listAllCustomers`),
   `InMemoryCrmRepository` for tests, `createPgCrmRepository(pool)` for
   `createApp` injection. Per-workspace ops go through
   `db.withWorkspaceScope`; `listAllCustomers()` is the hydrate-on-boot
   admin path (unscoped, same caveat as `listAllControls`/`listAllIntents`
   — see the admin/cross-workspace section above).
3. `CrmService.hydrateCustomers(customers)` rebuilds the in-memory
   `customers` Map wholesale on boot (same pattern as
   `GovernanceAuthorizationService.hydrate`).
4. `apps/api/src/app.ts`: `POST /api/customers` and `PATCH
   /api/customers/:customerId` call `dualWriteCrmCustomer(customer)`
   (best-effort, `target=crm_customers` on `[DUALWRITE_FAILED]`,
   `aiCrm.dualWriteFailures` on failure — same contract as the other
   dual-write helpers) after the in-memory mutation. `onReady` hydrate-on-boot
   calls `hCrmRepo.listAllCustomers()` and `crm.hydrateCustomers(customers)`
   alongside the orchestration/governance/audit hydrate.

Proven live in `apps/api/test/n12-n13-livepg.integration.test.ts`: a
customer created on instance A survives restart — `GET
/api/customers/:id/overview` on a freshly booted instance B reflects it —
and is cross-workspace denied both at the HTTP layer and under raw `SET
ROLE ai_crm_runtime_api` (`NOBYPASSRLS`), proving FORCE RLS itself (not
just the app's `WHERE` clause) hides workspace B's row.

## Honest staged residual (NOT done — do not overclaim "full-domain")

N-12/N-13 are a **bounded slice**, not full-domain PG coverage. Explicitly
NOT dual-written/hydrate-replayed yet:

- **CRM sub-aggregates**: `CustomerContract`, `Communication`, `NextAction`,
  `OperationalException` (`packages/domain/src/crm.ts`) remain in-memory
  only. No `crm_contracts`/`crm_communications`/`crm_next_actions`/
  `crm_exceptions` tables exist.
- **Project Manager (PM) domain**: `PmService` (`packages/domain/src/pm.ts`)
  and `DeliveryService` (`packages/domain/src/delivery.ts`) remain in-memory
  only — no PG repo for plans/tasks/projects/deliverables.
- **Finance domain (ledger)**: `LedgerService` writes are PG-first
  fail-closed (`pg-finance-ledger-adapter.ts`, P6-b G001 / PG-C1) — see the
  ledger routes in `apps/api/src/app.ts`.
- **Finance domain (reconciliation + daily-gate)**: `ReconciliationService`
  (reconcile/resolve-exception) and `DailyGate` (record-day/
  activate-risk-tier) writes are PG-first fail-closed as of Continued-dev
  Q1 (D3/D4) — see the "Q1: reconciliation + daily-gate PG-primary
  fail-closed" section below. PG repos exist
  (`pg-finance-recon-adapter.ts`, migration `0010`).
- `outbox_events` (event delivery queue) is written but not read back —
  publication remains a worker-owned concern, not request-path SoR state.
- `notifications` (delivery-side state, not authorization/orchestration SoR)
  is still not dual-written at all.

Any claim that "everything survives a restart" or "the CRM/PM/Finance
domain is PG-backed" would be dishonest — only the in-memory orchestration
job spine, the in-memory governance control/intent state, the (now
hydrate-replayed, tamper-evident) governance audit chain, and CRM
**customers only** have a real PG-backed restart path as of N-12/N-13. Every
other CRM sub-aggregate plus the entire PM and finance domains remain
in-memory-only with no PG-backed restart path.


### N-13 audit hydrate workspace-set coupling (honest limit)

Hydrate enumerates workspaces to audit-rehydrate from `listAllControls()` + `listAllIntents()` (matching the pre-existing `auditChainHeads` scoping). A workspace with persisted `audit_events` but **no** persisted control/intent — reachable only via notification-only activity (`POST /api/notifications` calls `dualWriteAudit` without a control/intent) — is therefore **not** audit-restart-sourced: after restart `GET /api/governance/audit` returns empty and `/audit/verify` returns a vacuous `true` over a chain that does exist in PG. Realistic audit is governance-driven (every authorize/decide/consume dual-writes a control/intent), so the gap is narrow, but it is real. **Follow-up:** enumerate audit workspaces from `audit_chain_heads` (add an admin `listAllAuditChainHeads`) and union with the controls/intents set before `getAuditEventsForWorkspace`. Also latent: jsonb numeric normalization could drift the reconstructed hash for future rich (high-precision decimal / >2^53 int) audit payloads — constrain audit `data` to a canonical JSON-safe subset before enriching.

## Live verification

- `packages/persistence/scripts/pg-rls-smoke.sh` — applies `0001`..`0005`
  idempotently against the docker `ai_crm` database only (refuses other
  DB/port targets) and asserts FORCE RLS + `workspace_isolation` policies on
  all six orch/orch_governance/`crm_customers` tables. `run_isolation`
  proves, under `SET ROLE ai_crm_runtime_api` (`NOBYPASSRLS`), that a
  governed control insert AND a `crm_customers` insert each succeed for the
  correct workspace and are denied cross-workspace — i.e. RLS enforcement
  is exercised as the runtime role, not the `ai_crm` superuser. See
  `docs/ops/pg-rls-smoke.md` for run logs.
- `LIVE_PG_TEST=1 pnpm --filter @ai-crm/api exec vitest run
  test/sor-restart-livepg.integration.test.ts` — boots a real `createApp`
  instance against the docker Postgres DSN, creates a job + a
  CHECKPOINT-governed control through the real HTTP surface (real dual-write
  SQL, real FORCE RLS), then boots a second fresh instance against the same
  DSN and asserts hydrate-on-boot reads the same job/control back from real
  Postgres. Skipped (not failed) when `LIVE_PG_TEST` is unset, so CI without
  a live Postgres stays green.
- `LIVE_PG_TEST=1 pnpm --filter @ai-crm/api exec vitest run
  test/n08-pg-primary.livepg.integration.test.ts` (N-08) — four acceptance
  tests against the same real docker Postgres: (1) a control row INSERTed
  directly into `orch_governance_controls` out-of-band (never touching the
  app's in-memory service) is reflected by `GET /api/governance/controls` —
  falsifiable, fails if reads stayed in-memory; (2) cross-workspace denial
  both at the HTTP layer and via a raw `SET ROLE ai_crm_runtime_api`
  session proving FORCE RLS itself (not just the app's `WHERE` clause)
  hides workspace B's row from a workspace A scope; (3) a governed mutation
  on instance A dual-writes real `audit_events` + `audit_chain_heads` +
  `outbox_events`, and a freshly booted instance B hydrates
  `aiCrm.auditChainHeads` with the same head and continues the SAME chain
  (next sequence is `head + 1`, never resets to 1) on a subsequent
  mutation; (4) two overlapping `appendAuditEvents` callers on the same
  workspace (two independent `pg.Pool`s, two independent
  `PgGovernanceRepository`s) produce a contiguous, gap-free, duplicate-free
  `head_sequence`, verified both from the JS return values and a direct
  `SELECT` against `audit_events`/`audit_chain_heads`. Skipped (not failed)
  when `LIVE_PG_TEST` is unset.
- `LIVE_PG_TEST=1 pnpm --filter @ai-crm/api exec vitest run
  test/n12-n13-livepg.integration.test.ts` (N-12 + N-13) — three acceptance
  tests against the same real docker Postgres: (1) N-13 — instance A
  performs governed mutations; a freshly booted instance B hydrates `GET
  /api/governance/audit` (matching A's events, not empty) and `GET
  /api/governance/audit/verify` (`true`), then a mutation on B continues the
  SAME chain (`sequence = N+1`) and still verifies; (2) N-13 tamper case — a
  persisted `audit_events` row is corrupted out-of-band (`UPDATE ... SET
  payload = ...`, bypassing the app entirely), and a fresh hydrate-restart's
  `/audit/verify` returns `false`, detecting the break; (3) N-12 — a
  customer created on instance A survives restart (`GET
  /api/customers/:id/overview` on a fresh instance B reflects it) and is
  cross-workspace denied both at the HTTP layer and via a raw `SET ROLE
  ai_crm_runtime_api` session against `crm_customers`. Skipped (not failed)
  when `LIVE_PG_TEST` is unset.
- `LIVE_PG_TEST=1 pnpm --filter @ai-crm/api exec vitest run
  test/q1-recon-pgfirst.livepg.integration.test.ts` (Continued-dev Q1
  D3/D4) — four acceptance tests against the same real docker Postgres: (1)
  happy path — reconcile (variance -> exception) + resolve-exception +
  record-day + activate-risk-tier all write real PG rows (`finance_
  reconciliations`/`finance_exceptions`/`finance_daily_gate_state`/
  `finance_day_records`) and the in-memory state (`GET /api/finance/...`)
  reflects the SAME committed mutation; (2) fail-closed — a `pgPool`
  injected to throw on `INSERT INTO finance_reconciliations` makes `POST
  /api/finance/reconciliations` return 5xx AND leaves the in-memory open-
  exceptions list uncommitted AND 0 PG rows in both tables — memory can
  never lead PG; (3) fail-closed + cross-workspace — the same proof for
  `INSERT INTO finance_day_records` on `POST /api/finance/daily-gate/days`,
  plus proving an unrelated workspace's day-record call on the SAME app
  instance is unaffected (the injected failure is scoped, not global); (4)
  concurrency — N concurrent same-workspace `record-day` calls with
  sequential dates all commit exactly once each under `withWorkspaceMutex`
  (no lost update, final streak/PG row count == N). Skipped (not failed)
  when `LIVE_PG_TEST` is unset.

## Q1: reconciliation + daily-gate PG-primary fail-closed (D3/D4)

Architect P3 (on the PG-D review) flagged that `ReconciliationService`/
`DailyGate` writes were memory-first best-effort dual-write (the same
swallowed-try/catch + `dualWriteFailures` counter shape `dualWriteAudit`
still uses) even though PG repos already existed
(`pg-finance-recon-adapter.ts`, PG-C2/G001) — a dropped PG write on
`POST /api/finance/reconciliations`, `POST
/api/finance/exceptions/:id/resolve`, `POST /api/finance/daily-gate/days`,
or `POST /api/finance/daily-gate/activate-risk-tier` could silently lose an
OPEN reconciliation exception (+ its `reconciledFingerprints` dedup entry)
or a day record on the next restart, exactly the residual the ledger
PG-first (PG-C1) and audit PG-first (PG-D/D3) work already closed for
their own surfaces.

Continued-dev Q1 closes this the same way, by giving
`ReconciliationService`/`DailyGate` a **preview/commit split** — mirroring
`LedgerService.previewDraft`/`commitDraft`
(`packages/finance/src/ledger.ts`):

- `ReconciliationService.previewReconcile(input)` validates and builds the
  `Reconciliation` (+ variance-only `FinanceException`) pair WITHOUT
  mutating `reconciliations`/`exceptions`/`reconciledFingerprints`;
  `commitReconcile(reconciliation, exception?)` commits the SAME
  already-validated pair. `previewResolveException`/`commitResolveException`
  is the same split for exception resolution.
- `DailyGate.previewRecordDay(day)` computes the full result of recording
  `day` — including any gap-filled "missing" day records — WITHOUT
  mutating `streak`/`tier`/`lastDateEpoch`/`activatedMatrixVersion`/
  `records`; `commitRecordDay(preview)` commits it.
  `previewActivateRiskTier`/`commitActivateRiskTier` is the same split for
  risk-tier activation.

The four `apps/api/src/app.ts` routes now run preview -> `await` the PG
write (`financeReconRepo`/`dailyGateRepo`) -> commit, all inside the
EXISTING per-workspace `withWorkspaceMutex` (the same mutex the ledger and
governance routes use) — so a PG failure throws (5xx) BEFORE memory
commits, AND the whole critical section stays concurrency-safe (no TOCTOU)
for free. In memory mode (no pool), the PG write is a no-op and `commit*`
still runs — behavior is byte-identical to before Q1, and all 44
pre-existing `@ai-crm/finance` unit tests plus the memory-mode
`@ai-crm/api` integration tests stay green unmodified.

Falsifiably proven live against real PG by
`apps/api/test/q1-recon-pgfirst.livepg.integration.test.ts` (see "Live
verification" above): a forced PG INSERT failure on
`finance_reconciliations`/`finance_day_records` aborts the route with 5xx,
leaves the in-memory open-exceptions list / day-gate streak exactly as it
was before the call, and leaves 0 rows in PG — memory can never lead PG for
these writes, same falsifiable shape as the PG-D audit fail-closed proof.

## Methodology: scorecard weight-sum guard

`packages/persistence/scripts/scorecard-weight-check.mjs` (dependency-free
node script) guards against the exact error class documented in
`docs/planning/merge-corp-shell/04-SCORECARD.md` §3H: the §1.1
dimension-weight table's D1..D12 weights summed to 110 while the section
header claimed "합 100" (sum 100), silently inflating every absolute score
derived from `기여점 = (차원/5) × 가중` by ~10% until Claude red-team #3
caught it. The script parses the §1.1 weight table, sums the per-dimension
weights, and asserts the sum matches the declared max stated in the §1.1
header — READ-ONLY, it never touches the scorecard's dimension scores or
history. Run it with:

```sh
node packages/persistence/scripts/scorecard-weight-check.mjs
```

Exits 0 with a `PASS` line (showing every `D<n>=<weight>` it parsed) when
the sum matches; exits 1 with a diagnostic (fail-closed, including on a
parse failure such as a missing/duplicate/renumbered row) when it does not.

### Audit dual-write delivery semantics (N-08)

The request-path audit dual-write is **at-least-once**: the per-workspace flush cursor advances only on a resolved PG write, so a post-COMMIT ack loss can re-append the same logical events under new PG `audit_chain_heads` sequences (duplicate *valid* rows under fresh monotonic sequence numbers, never corruption or gaps). This is acceptable for the tamper-evident chain-head continuity D3 relies on; a future exactly-once path would need a dedup key on `(workspace_id, in_memory_event_id)`.
### ADR-010 connection-boundary boot guard (Q2 architect P3-1)

`MODEL_GATEWAY_DATABASE_URL`/`options.modelGatewayDatabaseUrl` falls back to
the main `DATABASE_URL`/`databaseUrl` when unset (documented dev/CI
behavior, same fallback shape as `ADMIN_DATABASE_URL`) — see
`CreateAppOptions.modelGatewayDatabaseUrl` doc and
`docs/adr/010-model-gateway.md`. That fallback is convenient for local/CI
bring-up but, left unchecked, would let a production deploy silently run
`model_invocations` writes through the SAME DSN/principal as the api/worker
pool — collapsing the ADR-010 disjoint-principal boundary the migration
history (`0002_model_gateway_and_break_glass_roles.sql`'s REVOKE +
model-gateway-only GRANT, asserted by
`schema.security.test.ts`'s globbed no-re-grant check) exists to enforce.

`createApp` now refuses to boot when **all** of the following hold:
`NODE_ENV==='production'`, a model provider is configured
(`options.modelClient`/`resolveModelClientFromEnv()`), `resolvedDatabaseUrl`
is set (this instance actually persists to PG — a pure memory-mode/test
bring-up with a model client but no `DATABASE_URL` never touches
`model_invocations`, so there is nothing to collapse), and
`MODEL_GATEWAY_DATABASE_URL` is either unset or identical to
`DATABASE_URL`. It throws
`[MODEL_GATEWAY_DSN_REQUIRED_IN_PROD]` synchronously at construction — the
same fail-closed-at-construction shape as the pre-existing
`[AUTH_REQUIRED_IN_PROD]` guard (`docs/ops/runtime-dsn.md`) — with an
`ALLOW_INSECURE_PROD=1` escape hatch for an explicit, audited same-DSN
bring-up (mirrors `allowInsecureProd`/`ALLOW_INSECURE_PROD` exactly; when
set, it boots with a `[MODEL_GATEWAY_DSN_COLLAPSED_IN_PROD]` warning
instead of throwing). Dev/CI (`NODE_ENV!=='production'`) keeps the
documented same-DSN fallback unconditionally — no behavior change there.

Set `MODEL_GATEWAY_DATABASE_URL` in production to a DSN authenticated as
(or `SET ROLE`d into) `ai_crm_runtime_model_gateway`, distinct from the
`DATABASE_URL` used by `ai_crm_runtime_api`/`ai_crm_runtime_worker` — see
`.env.example` and `docs/security/rls-role-model.md`.

