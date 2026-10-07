# Worker (Option D — no Temporal)

Pilot / Gate B control-plane worker for lease recovery and stuck-intent
visibility. **Temporal is out of scope** for merge tickets T-001..T-020
(ADR-001 pilot activation). This process is **not** a user-facing HTTP service
and does **not** perform remote connector dispatch.

## Package

| Item | Value |
|---|---|
| Package | `@ai-crm/worker` (`apps/worker`) |
| Pure tick | `runWorkerTick({ governance, nowIso })` (`src/tick.ts`) |
| Durable tick | `runDurableWorkerTick(runtime, nowIso)` (`src/main.ts`) |
| Outbox drain tick | `runDurableOutboxDrainTick(runtime, options?)` (`src/main.ts` / `src/outbox.ts`) |
| Outbox consumer tick | `runDurableOutboxConsumerTick(runtime, options?)` (`src/main.ts` / `src/outbox-consumer.ts`) |
| Company-memory donor bind | `loadCompanyMemoryDonorBind` / `runBoundCompanyMemoryDonorTick` (`src/company-memory-donor-bind.ts`) |
| Runtime builder | `loadGovernance(env?)` (`src/main.ts`) |
| CLI | `src/main.ts` (`pnpm --filter @ai-crm/worker start`) |

## What a tick does

1. **`governance.recoverExpiredLeases(nowIso)`** — moves expired `LEASED`
   intents back to `QUEUED`, clears lease token/deadline, **does not** reset
   `leaseEpoch` (epoch stays monotonic; GOV-U-06).
2. **Stuck-intent scan (log only)** — reports intents still in `LEASED` or
   `DISPATCHING` whose `leaseDeadline` is missing or ≤ `nowIso`. No automatic
   `UNKNOWN` transition and **no remote dispatch** in MVP.
3. **Durable dual-write (`runDurableWorkerTick` only)** — when the runtime was
   built with a `govRepo` (i.e. `DATABASE_URL` was set), every intent
   `recoverExpiredLeases` moved to `QUEUED` is immediately persisted back via
   `govRepo.saveIntent(intentToPersisted(intent))`, so the recovery survives a
   worker restart instead of only mutating the in-process snapshot.
4. **Outbox drain (`DATABASE_URL` set only)** — claims a batch of `PENDING`
   `outbox_events` rows (governance's `appendAuditEvents` enqueues these on
   one, and marks the successfully-relayed ones `PUBLISHED`. See
   "Outbox drainer/relay (D3)" below.
5. **Outbox consumer (`DATABASE_URL` set only)** — reads `PUBLISHED`
   `outbox_events` rows not yet durably consumed, idempotently records each
   at a durable sink (`outbox_consumed_events`), and advances a persisted
   per-consumer cursor. See "Outbox consumer — durable acked delivery (D3,
   part 2)" below.

## Durable governance SoR (G-02)

The worker now shares the **same durable governance SoR as `apps/api`**
(`orch_governance_controls` / `orch_governance_intents`, migration `0004`,
FORCE RLS — see `docs/ops/sor-persistence.md`), reusing the G-01
`createPgGovernanceRepository` adapter and
`GovernanceAuthorizationService.hydrate` unchanged:

- **`DATABASE_URL` unset** (default): `loadGovernance()` returns a purely
  in-memory `GovernanceAuthorizationService` with no `govRepo`/`adminGovRepo`.
  Behavior is unchanged from before G-02 — no durability across restarts,
  useful for dev/tests.
- **`DATABASE_URL` set, `ADMIN_DATABASE_URL` unset** (dev/pilot default):
  `loadGovernance()` dynamically imports `pg`, opens ONE `Pool` on
  `DATABASE_URL`, does a fail-closed `select 1` connectivity check, wraps the
  pool as a plain (unscoped) `GovernancePgQueryable`, builds
  `createPgGovernanceRepository(pool)`, and uses that SAME repo instance as
  both `govRepo` and `adminGovRepo`. **Hydrates** a fresh
  `GovernanceAuthorizationService` from `listAllControls()` /
  `listAllIntents()` **before** any tick runs — the identical hydrate-on-boot
  restart-consistency path G-01 added to `apps/api`'s `createApp`. This runs
  under the same `ai_crm` superuser DSN used elsewhere in dev/pilot, which
  bypasses RLS by design (see `docs/ops/sor-persistence.md`).
- **`DATABASE_URL` AND `ADMIN_DATABASE_URL` both set** (G-01 MEDIUM 4 role
  separation, mirrors `apps/api`'s `ADMIN_DATABASE_URL` split —
  `apps/api/src/app.ts` `createScopedPgQueryable`/`resolvedAdminDatabaseUrl`):
  `loadGovernance()` opens TWO `pg` `Pool`s, each with its own fail-closed
  `select 1` check:
  - **`DATABASE_URL`** is wrapped with a `withWorkspaceScope`-capable
    `createScopedPgQueryable` (a worker-local mirror of `apps/api`'s
    `createScopedPgQueryable`: `BEGIN` + `set_config('app.workspace_id', …,
    true)` on one checked-out connection, `COMMIT`/`ROLLBACK` + `release()`).
    The resulting `govRepo` is used **only** for the per-workspace
    `saveIntent` dual-write of recovered leases (`runDurableWorkerTick`), so
    `DATABASE_URL` can safely point at a NOBYPASSRLS runtime role (e.g.
    `ai_crm_runtime_worker`) instead of an admin/superuser role — FORCE RLS
    on `orch_governance_intents` (0004) is enforced for that write.
  - **`ADMIN_DATABASE_URL`** is wrapped with the plain (unscoped)
    queryable. The resulting `adminGovRepo` is used for hydrate-on-boot
    (`listAllControls()`/`listAllIntents()`) and the outbox drain
    (`claimPendingOutbox`/`markOutboxPublished`/`abortOutboxClaim`) — both
    are inherently cross-workspace/admin reads that are expected to bypass
    RLS, mirroring `apps/api`'s `resolvedAdminDatabaseUrl` hydrate path.
- After each tick, `runDurableWorkerTick` dual-writes any recovered intents
  back to `govRepo` (the scoped pool when `ADMIN_DATABASE_URL` is set, else
  the single fallback pool). A subsequent worker (re)start (or `apps/api`,
  since it's the same tables) sees the `QUEUED` state — proven end-to-end by
  `test/worker-durable.integration.test.ts` (shared `InMemoryGovernanceRepository`
  store, including an `ADMIN_DATABASE_URL`-split proof using two distinct
  in-memory repos) and `test/worker-durable.live-pg.integration.test.ts`
  (real Postgres, `LIVE_PG_TEST=1`).

**Production MUST set `ADMIN_DATABASE_URL`** to a cross-workspace-capable
role (e.g. the same superuser/admin DSN `apps/api`'s `ADMIN_DATABASE_URL`
uses) and point `DATABASE_URL` at a NOBYPASSRLS runtime role (e.g.
`ai_crm_runtime_worker`, see `packages/persistence/migrations/0001_foundation.sql`).
Leaving `ADMIN_DATABASE_URL` unset outside dev/pilot means every worker
operation — including the per-workspace `saveIntent` write — runs under
whatever role `DATABASE_URL` names; if that role has BYPASSRLS (the docker
dev superuser), FORCE RLS is not actually enforced on that write, same as
`apps/api`'s documented `ADMIN_DATABASE_URL` fallback behavior. Falls back
to the single `DATABASE_URL` pool for both concerns when
`ADMIN_DATABASE_URL` is unset (dev-only fallback, matching
`apps/api/.env.example`'s `ADMIN_DATABASE_URL` documentation).

## Outbox drainer/relay (D3)

Governance's PG-primary audit dual-write (`appendAuditEvents`, N-08/D3 — see
`docs/ops/sor-persistence.md`) enqueues one `PENDING` `outbox_events` row per
audit event on every governed mutation. Before this change **nothing drained
them** — they accumulated forever. `runDurableOutboxDrainTick(runtime,
options?)` (`src/main.ts`, delegating to `runOutboxDrainTick` in
`src/outbox.ts`) closes that gap and runs alongside the lease-recover tick in
`runOnce`, gated on `DATABASE_URL` being set (claims/publishes through
`adminGovRepo` — the dedicated `ADMIN_DATABASE_URL` pool when configured,
else the single fallback `govRepo`/`DATABASE_URL` pool; see "Durable
governance SoR (G-02)" above).

**Claim (`GovernanceRepository.claimPendingOutbox(limit)`).** Claims up to
`limit` `PENDING` rows via:

```sql
SELECT id, workspace_id, audit_event_id, event_type, partition_key, payload,
       causation_id, created_at
FROM outbox_events
WHERE status = 'PENDING'
ORDER BY id
LIMIT $1
FOR UPDATE SKIP LOCKED
```

Critically, this runs on a **single checked-out connection/transaction**
(`PgQueryable.connect()`, a real `pg.Pool.connect()` in production) that
stays open until `markOutboxPublished`/`abortOutboxClaim` closes it. A bare
autocommit `SELECT ... FOR UPDATE` releases its row lock the instant the
statement finishes — that would not protect the relay step that runs *after*
the SELECT returns. Holding the transaction open across relay is what makes
`FOR UPDATE SKIP LOCKED` actually mutually-exclusive between two concurrent
drainers: while transaction A's claim is open, transaction B's `SKIP LOCKED`
select genuinely skips A's locked rows over the wire. Outbox drain runs
cross-workspace/admin (like `listAllControls`/`listAllIntents` — it is a
worker/admin concern, not a per-request one), so it does not go through
`withWorkspaceScope` even when `ADMIN_DATABASE_URL` is configured.

**Relay.** Each claimed row is relayed via a structured, greppable log line:

```
[OUTBOX_PUBLISHED] id=<outbox id> workspace=<workspace id> event_type=<event type>
```

and, best-effort, a `pg_notify` on the `ai_crm_outbox_events` channel
(`OUTBOX_NOTIFY_CHANNEL` in `src/outbox.ts`) with a keys-only payload
(`{outboxId, workspaceId, eventType}` — never the row body, matching
`apps/api/src/pg-notify.ts`'s convention). A NOTIFY failure is logged and
does **not** fail the relay — the log line is the relay evidence of record.

**Mark (`GovernanceRepository.markOutboxPublished(ids)`).** Sets
`status = 'PUBLISHED', published_at = now()` for the successfully-relayed
`ids` and **commits + releases** the transaction `claimPendingOutbox` opened.
Any claimed id NOT included (relay failed for it) stays `PENDING` and
unlocked the instant this commits — available for the next tick's retry.

**At-least-once, NOT exactly-once.** Relay happens strictly BEFORE
`markOutboxPublished`. If the worker process crashes/throws after relaying
but before that call runs, the open claim transaction is never committed —
Postgres rolls it back on connection loss, the claimed rows stay
`PENDING`/unlocked, and the next drain tick reclaims and **re-relays** them.
The relay target (log line / NOTIFY) is therefore expected, by design, to be
observed more than once for the same outbox row on rare crash timing;
downstream consumers must be idempotent on `id` if they require
exactly-once semantics. `abortOutboxClaim()` exposes this rollback path
explicitly (used when every relay in a batch fails, and by tests to
simulate a crash between relay and mark).

Proven live (`LIVE_PG_TEST=1`, `test/outbox-drain.live-pg.integration.test.ts`):

1. **PENDING -> PUBLISHED** — seeded rows are claimed, relayed (log line
   observed), and end up `PUBLISHED` with `published_at` set.
2. **SKIP LOCKED, no double-publish** — two concurrent drainers (two
   independent `loadGovernance` runtimes/connections) racing the same
   backlog claim disjoint batches; the union is exactly the seeded set with
   zero overlap.
3. **At-least-once re-relay** — a claim aborted between relay and mark
   (simulated crash) leaves the row `PENDING`; the next tick reclaims,
   re-relays (the same log line observed a second time), and finally marks
   it `PUBLISHED`.

The in-memory `InMemoryGovernanceRepository` implements the same
claim/mark/abort contract (for parity/unit-test use) but has no real
cross-process concurrency to protect — outbox drain is only meaningful for
the durable (`DATABASE_URL`-backed) store.

## Outbox consumer — durable acked delivery (D3, part 2)

The drainer above closes "governance enqueues, nothing drains" — but relay
(a log line + best-effort NOTIFY) is **emission**, not **delivery**: nothing
durably ACKs that a `PUBLISHED` row was actually applied anywhere.
`runDurableOutboxConsumerTick(runtime, options?)` (`src/main.ts`, delegating
to `runOutboxConsumerTick` in `src/outbox-consumer.ts`) is that missing
consumer. It runs alongside the drain tick in `runOnce`, gated on the same
`DATABASE_URL`/`adminGovRepo` presence.

**Durable sink schema (`packages/persistence/migrations/0006_outbox_consumer.sql`).**

- `outbox_consumed_events (consumer_name, outbox_id, workspace_id, consumed_at)`
  — composite `PRIMARY KEY (consumer_name, outbox_id)`. This is the actual
  idempotent-dedup mechanism: inserting the same `(consumer_name, outbox_id)`
  pair twice is a no-op (`ON CONFLICT DO NOTHING`). Workspace-bound data —
  `ENABLE`/`FORCE ROW LEVEL SECURITY` + a `workspace_isolation` policy,
  mirroring `outbox_events` itself.
- `outbox_consumer_offsets (consumer_name, last_consumed_id, last_consumed_created_at, updated_at)`
  — one row per logical consumer, an efficiency/observability watermark
  (correctness comes from the dedup table above, not this cursor). NOT
  workspace-bound (one row per consumer across all tenants, same posture as
  `workspaces`/`schema_migrations`) — deliberately has no RLS.
- Both tables: owned by `ai_crm_migration_owner`; `ai_crm_runtime_worker` gets
  read-write (`SELECT, INSERT[, UPDATE]`), `ai_crm_audit_verifier` gets
  read-only `SELECT` — the same least-privilege shape as 0001's grants.

**Read (`GovernanceRepository.listConsumableOutbox(consumerName, limit)`).**
Selects up to `limit` `PUBLISHED` `outbox_events` rows for which no
`outbox_consumed_events` row exists for `consumerName` — that `NOT EXISTS`
anti-join is the **sole correctness filter**, ordered by `(created_at, id)`
ascending for a deterministic (not gating) processing order. The persisted
`(last_consumed_created_at, last_consumed_id)` cursor is **not** used to
filter candidates: `outbox_events.created_at` is captured at transaction
**start**, but MVCC visibility happens at **commit**, so a row that started
earlier can commit later than a row that started later and already advanced
the cursor. Gating on `(created_at, id) > cursor` would then permanently and
silently exclude that never-consumed row — silent under-delivery that
defeats at-least-once. `outbox_consumer_offsets` is kept purely as an
observability/efficiency watermark (still upserted monotonically by
`applyOutboxConsumed`, see below) — never as a correctness gate. Cross-
workspace/admin concern like `claimPendingOutbox` — does not go through
`withWorkspaceScope`.

**Residual trade-off.** Without an offset gate, every tick's anti-join scans
*all* PUBLISHED rows not yet in `outbox_consumed_events` for that consumer —
there is no retention/pruning of consumed rows yet, so the un-consumed
backlog size (not wall-clock recency) is what bounds this query's cost. This
is an accepted, honest residual for the current scale; if/when it matters,
the fix is either (a) periodic pruning/archival of old
`outbox_consumed_events`/`outbox_events` rows, or (b) a strictly
publish-time-monotonic cursor (e.g. a `bigserial`/`published_at`-based
sequence assigned at commit time rather than `created_at`) that can safely
gate candidates without the transaction-start-vs-commit ordering hazard
above.

**Apply (`GovernanceRepository.applyOutboxConsumed(consumerName, rows)`).**
For each row: `INSERT INTO outbox_consumed_events (consumer_name, outbox_id,
workspace_id) ... ON CONFLICT (consumer_name, outbox_id) DO NOTHING` (batched
via `unnest`), returning only the ids that were **newly** inserted. Then
upserts `outbox_consumer_offsets` to the batch's last `(created_at, id)`
tuple, guarded by a `WHERE (existing) < (EXCLUDED)` clause so the cursor is
**monotonic** — it never regresses even if a stale/out-of-order batch is
re-applied.

**Effectively-once delivery at the sink, despite at-least-once emission.**
The drainer's relay is at-least-once by design (see "Outbox drainer/relay
(D3)" above — a crash between relay and `markOutboxPublished` re-relays the
same row). The consumer inherits that same redelivery risk one layer up (a
crash between `applyOutboxConsumed` committing and the caller observing
success could cause the next tick to re-list and re-apply the same row when
the offset didn't advance), but the dedup ledger's composite primary key
makes every re-apply of an already-consumed `(consumer_name, outbox_id)` a
**no-op**: the row is inserted at the sink at most once, no matter how many
times it is redelivered. That is what converts at-least-once emission into
effectively-once delivery at this sink.

**Sink log line** (structured, greppable, safe to observe more than once —
the log line is not the dedup mechanism, `outbox_consumed_events` is):

```
[OUTBOX_CONSUMED] id=<outbox id> workspace=<workspace id> event_type=<event type> consumer=<consumer name>
```

Proven live (`LIVE_PG_TEST=1`,
`test/outbox-consumer.live-pg.integration.test.ts`):

1. **Drain then consume, exactly once at the sink** — seeded `PENDING` rows
   are drained to `PUBLISHED`, then consumed; `outbox_consumed_events` has
   exactly one row per `(consumer_name, outbox_id)`.
2. **Redelivery no-op** — running the consumer tick again over the same
   already-consumed backlog returns zero new candidates for those ids and
   creates zero duplicate sink rows.
3. **Crash-between-apply-and-offset** — directly exercises
   `applyOutboxConsumed` twice for the same row (modeling a redelivery after
   a crash): the second call returns zero newly-consumed ids and the sink
   still has exactly one row for that id.
4. **Monotonic offset** — the persisted `outbox_consumer_offsets` cursor
   strictly advances across successive ticks that each consume a new batch.

The in-memory `InMemoryGovernanceRepository` implements the same
list/apply/offset contract (dedup `Map`/`Set` per `consumerName`) for
parity/unit-test use.


## Run

```bash
# One-shot tick (default), in-memory governance
pnpm --filter @ai-crm/worker start

# One-shot tick against the shared durable SoR
DATABASE_URL=postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm \
  pnpm --filter @ai-crm/worker start

# One-shot tick with the production-shape ADMIN_DATABASE_URL split: DATABASE_URL
# on a NOBYPASSRLS runtime role, ADMIN_DATABASE_URL on the cross-workspace/admin role
DATABASE_URL=postgres://ai_crm_runtime_worker:CHANGE_ME@localhost:5432/ai_crm \
ADMIN_DATABASE_URL=postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm \
  pnpm --filter @ai-crm/worker start

# Interval mode (ms)
WORKER_INTERVAL_MS=15000 pnpm --filter @ai-crm/worker start

# Fixed clock (ops/tests)
WORKER_NOW_ISO=2026-01-01T00:01:00.000Z pnpm --filter @ai-crm/worker start
```

## Env

| Var | Process | Notes |
|---|---|---|
| `WORKER_INTERVAL_MS` | worker | Optional; when > 0, loop ticks |
| `WORKER_NOW_ISO` | worker | Optional fixed ISO clock |
| `DATABASE_URL` | worker | Optional. When set, worker hydrates governance from and dual-writes recovered leases to the shared `orch_governance_*` tables (same SoR as `apps/api`), and also runs the outbox drain tick (`runDurableOutboxDrainTick`) and outbox consumer tick (`runDurableOutboxConsumerTick`) each tick. When unset, worker stays in-memory (no durability across restarts, no outbox drain/consume). When `ADMIN_DATABASE_URL` is also set, `DATABASE_URL` becomes the `withWorkspaceScope`-scoped pool used ONLY for per-workspace `saveIntent` — production should point it at a NOBYPASSRLS runtime role (e.g. `ai_crm_runtime_worker`). |
| `ADMIN_DATABASE_URL` | worker | Optional (G-01 MEDIUM 4 role separation, mirrors `apps/api`'s `ADMIN_DATABASE_URL`). When set, opens a second pool used for cross-workspace admin reads/writes — hydrate (`listAllControls`/`listAllIntents`), outbox drain (`claimPendingOutbox`/`markOutboxPublished`), and outbox consume (`listConsumableOutbox`/`applyOutboxConsumed`) — so `DATABASE_URL` no longer needs BYPASSRLS. **Production MUST set this** to a cross-workspace-capable role. Falls back to the single `DATABASE_URL` pool for both concerns when unset (dev-only fallback; the docker superuser DSN bypasses RLS by design). |
| `COMPANY_MEMORY_SB_COMPANY` / `COMPANY_MEMORY_SB_COMPANY_CONFIG` / `COMPANY_MEMORY_SIGNING_KEY_FILE` / `COMPANY_MEMORY_AUTHORITY_FILE` | worker | Optional together. Absent = donor tick skipped. All four required or the worker fails closed at boot. Command must be an absolute `sb-company` path; personal `sb` is rejected. Does not write personal memory or talk to loopback :4311. When `DATABASE_URL` is set, each donor tick reads pending `cwos_v2_mail_outbox` rows from the governance/CWOS pool and fails closed if that schema is unavailable. Empty outbox is used only when `DATABASE_URL` is unset. |}

## Boundaries

| Allowed | Forbidden |
|---|---|
| Lease expiry recovery | Temporal activities / dual-queue |
| Stuck-intent log/metrics | User-facing HTTP API |
| Shared governance types + PG adapter (reused from G-01) | Remote connector dispatch |
| Option D PG concepts | Auto-redispatch from `UNKNOWN` |

## Tests

```bash
# Unit + shared-repo durable integration (default; no live Postgres needed)
pnpm --filter @ai-crm/worker test

# Real-Postgres variant (requires the docker ai_crm postgres running)
LIVE_PG_TEST=1 pnpm --filter @ai-crm/worker exec vitest run \
  test/worker-durable.live-pg.integration.test.ts

# Outbox drainer real-Postgres proof (same docker ai_crm postgres)
LIVE_PG_TEST=1 pnpm --filter @ai-crm/worker exec vitest run \
  test/outbox-drain.live-pg.integration.test.ts

# Outbox consumer real-Postgres proof (same docker ai_crm postgres)
LIVE_PG_TEST=1 pnpm --filter @ai-crm/worker exec vitest run \
  test/outbox-consumer.live-pg.integration.test.ts
```

- `test/worker.unit.test.ts` — GOV-U-06-style recover + epoch fencing and
  stuck `DISPATCHING` logging (pure `runWorkerTick`, in-memory governance).
- `test/worker-durable.integration.test.ts` — seeds a LEASED intent with an
  expired deadline into a shared `InMemoryGovernanceRepository`, hydrates a
  worker runtime from it, runs `runDurableWorkerTick`, and asserts the
  recovery is reflected both in-process **and** on reload straight from the
  shared repo (durability), plus a second independent hydrate (restart
  survival). Default CI-safe target — no live Postgres required.
- `test/worker-durable.live-pg.integration.test.ts` — the same proof against
  a **real** Postgres instance (docker `ai_crm` DSN), gated by
  `LIVE_PG_TEST=1` so CI without a live Postgres stays green; applies
  migrations idempotently via `packages/persistence/scripts/pg-rls-smoke.sh`
  the same way `apps/api`'s live-pg restart test does.
- `test/outbox-drain.live-pg.integration.test.ts` — the outbox
  drainer/relay proof against the same real Postgres instance, gated by
  `LIVE_PG_TEST=1`: PENDING -> PUBLISHED with relay log line observed;
  2 concurrent drainers claim disjoint batches via `SKIP LOCKED` (no
  double-publish); a claim aborted between relay and mark (simulated
  crash) leaves the row PENDING and is re-relayed + published on the next
  tick (at-least-once). See "Outbox drainer/relay (D3)" above.
- `test/outbox-consumer.live-pg.integration.test.ts` — the outbox consumer
  proof against the same real Postgres instance, gated by `LIVE_PG_TEST=1`:
  drain-then-consume exactly-once at the sink; a second tick over the same
  already-consumed backlog is a no-op (zero new candidates, no duplicate
  sink rows); a simulated crash-between-apply-and-offset redelivery of an
  already-sink-applied id is a no-op (dedup keeps exactly-once); the
  persisted consumer offset advances monotonically across ticks. See
  "Outbox consumer — durable acked delivery (D3, part 2)" above.

## Honest residual (deferred, not silently dropped)

- **No continuous scheduler / process supervisor.** The worker is a
  single-shot or fixed-`setInterval` CLI (`WORKER_INTERVAL_MS`); there is no
  cron/systemd/k8s CronJob wiring, backoff, or crash-restart policy in this
  repo. Ops must supply that around the CLI binary.
- **No remote connector dispatch.** `DISPATCHING` intents past their deadline
  are only logged as stuck (`worker.stuck_intents`); there is no automatic
  `UNKNOWN` transition or redispatch attempt in MVP.
- **No user-facing HTTP surface**, by design (kill-list item).
- **Dual-write is not transactional with `recoverExpiredLeases`.** The
  in-memory transition happens first (synchronously, inside
  `runWorkerTick`); the durable `saveIntent` writes happen immediately after,
  best-effort, with no compensating rollback of the in-memory state if the
  write fails. A `runDurableWorkerTick` call that throws during dual-write
  leaves the in-process governance already `QUEUED` but the durable store
  still `LEASED` until the next worker (re)start re-hydrates the still-LEASED expired intent and re-recovers it; within one long-running process it is not re-recovered because the in-memory status is already QUEUED
  (idempotent: `saveIntent` is an upsert). This matches `apps/api`'s
  documented dual-write failure semantics (`dualWriteFailures` counter,
  memory stays authoritative) rather than a stronger 2PC guarantee.
- **`saveIntent`'s RLS scoping depends on `ADMIN_DATABASE_URL` being set.**
  The worker now ships a `withWorkspaceScope`-capable wrapper
  (`createScopedPgQueryable` in `src/main.ts`, mirroring `apps/api`'s
  per-request wrapper of the same name), but it is only applied to
  `DATABASE_URL` when `ADMIN_DATABASE_URL` is ALSO set (see "Durable
  governance SoR (G-02)" above). Operators who leave `ADMIN_DATABASE_URL`
  unset in a non-dev environment still get the pre-split behavior — a single
  pool, unscoped `saveIntent`, and FORCE RLS enforcement depends entirely on
  whatever role `DATABASE_URL` names lacking BYPASSRLS. **Production MUST
  set `ADMIN_DATABASE_URL`** for the scoping to actually take effect.
- **Outbox drain is at-least-once, not exactly-once**, by design (see
  "Outbox drainer/relay (D3)" above) — a relayed-but-not-yet-committed row
  can be re-relayed on crash. `NOTIFY`/`LISTEN` has no replay either (matches
  `apps/api/src/pg-notify.ts`'s documented residual): a disconnected
  listener misses NOTIFYs sent while it was down; the log line / re-reading
  `outbox_events` directly remains the durable source of truth.
- **No dead-letter path.** A row whose relay repeatedly fails simply stays
  `PENDING` and is retried every tick forever (`FAILED` is a valid
  `outbox_events.status` value in the 0001 schema, but nothing in this
  drainer ever sets it — that transition is deferred, not wired up).
- **Fixed batch size, no backpressure/priority.** `runOutboxDrainTick`'s
  `limit` defaults to 25 rows per tick with no per-workspace fairness or
  priority ordering beyond `ORDER BY id` (insertion order).
- **Consumer sink apply is not transactional with the offset advance.** Both
  the `outbox_consumed_events` insert and the `outbox_consumer_offsets`
  upsert happen inside `applyOutboxConsumed`, but as two separate
  statements, not one transaction — a crash between them leaves the dedup
  row committed but the offset not (yet) advanced. This is deliberately
  self-healing, not a residual gap: `listConsumableOutbox`'s `NOT EXISTS`
  filter against `outbox_consumed_events` excludes that id regardless of
  the offset's position, and re-applying it (if it were ever re-listed) is
  a no-op via `ON CONFLICT DO NOTHING` — see "Outbox consumer — durable
  acked delivery (D3, part 2)" above.
- **Single logical consumer in `runOnce` today**
  (`DEFAULT_OUTBOX_CONSUMER_NAME = "worker-default"`), not a registry of
  independently-scheduled named consumers/subscribers. The repository
  contract (`consumerName` as a free parameter) already supports multiple
  independent consumers with their own cursors/dedup ledgers; only the
  worker's built-in wiring is single-consumer for now.
- **No consumer-side concurrency guard.** Unlike the drainer's
  `FOR UPDATE SKIP LOCKED` claim, `listConsumableOutbox` is a plain
  autocommit `SELECT` — two processes running the SAME `consumerName`
  concurrently could both list (and attempt to apply) the same batch. The
  sink's `ON CONFLICT DO NOTHING` still makes that safe (no duplicate rows),
  but it is not a work-splitting/exclusive-claim mechanism the way the
  drainer's claim is; concurrent same-named consumers only duplicate the
  read+redundant-insert work, not correctness.
- **Temporal remains out of scope** (ADR-001 pilot activation, kill-list).

## Related

- ADR-001 pilot Option D — `docs/adr/001-stack-and-boundaries.md`
- Intent state machine — `docs/governance/control-effect-state-machine.md`
- Blueprint worker row — `docs/planning/merge-corp-shell/03-BLUEPRINT.md` T-016
- G-01 durable SoR + hydrate-on-boot — `docs/ops/sor-persistence.md`
