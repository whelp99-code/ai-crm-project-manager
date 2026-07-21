# Agent job eventing (G-03)

`apps/api` exposes agent job progress two ways: a durable event log
(`orch_job_events`, 0003) that is the single source of truth, and an
in-process live SSE hub that fans out "something changed" notices on top of
it. This doc draws the boundary between the two and states the residual
honestly — this is a single-process live layer, not a distributed broker.

## The durable log / outbox: `orch_job_events`

- Table: `orch_job_events` (migration `0003_orchestration.sql`), FORCE RLS,
  workspace-scoped, `(id, job_id, workspace_id, kind, payload, at)`.
- Written by `OrchestrationService.appendEvent` (in-memory SoR) on every job/
  work-item lifecycle transition (`job.created`, `work_item.created`,
  `work_item.waiting_control`, `work_item.done`, `work_item.failed`,
  `work_item.reopened_for_rework`, `work_item.cancelled`, `job.cancelled`,
  `job.status`, …).
- Persisted via the existing dual-write spine: every agent-mutating route
  (`POST /api/agent/commands`, `POST /api/agent/jobs/:id/cancel`,
  `POST /api/agent/jobs/:id/work-items/:workItemId/complete`) calls
  `dualWriteAgentState(workspaceId, jobId)` → `saveSnapshot` → deletes and
  re-inserts that job's full `orch_job_events` rows in the same statement
  batch (see `pg-store.ts`). Reads go through
  `SELECT * FROM orch_job_events WHERE workspace_id = $1 AND job_id = $2
  ORDER BY at ASC, id ASC` (`listEvents`/`getJob`/hydrate-on-boot).
- This is the outbox: it is the only place that guarantees an ordered,
  replayable, durable record of what happened to a job. `GET
  /api/agent/jobs/:id` and `GET /api/agent/jobs/:id/events` (non-stream mode)
  read this log directly and are unaffected by whether any SSE client is
  connected.
- Ordering contract: **append-order** — `ORDER BY at ASC, id ASC`. `at` is a
  wall-clock timestamp assigned at append time; `id` is a monotonically
  increasing per-append tiebreaker for same-timestamp events, so ordering is
  stable even under clock-resolution ties.

## The live layer: in-process `EventHub`

`apps/api/src/event-hub.ts` implements a minimal typed pub/sub:
`Map<"workspaceId\0jobId", Set<listener>>`. It exists purely to let an
**already-open** SSE connection learn that a mutation landed, so it can
re-read the snapshot and push a follow-up frame instead of forcing clients to
poll `GET /api/agent/jobs/:id` on an interval.

- `createApp` constructs one `EventHub` per process and attaches it to the
  Fastify instance as `app.eventHub` (test/ops hook only).
- Every agent job-state mutation publishes to the hub: the three `/api/agent`
  routes (`commands`, `jobs/:id/cancel`, `jobs/:id/work-items/:id/complete`)
  and the `/api/ai/reviews` REWORK bridge each call
  `eventHub.publish({ workspaceId, jobId, kind })` **after**
  `dualWriteAgentState` has run, so a publish always
  implies the durable log already has the corresponding rows.
- `GET /api/agent/jobs/:id/events`:
  1. Always authorizes + emits the initial burst (`job.updated`, one
     `work_item.updated` per item, `control.updated` when `item.controlId`
     is set) — unchanged from the pre-G-03 contract.
  2. **Once-mode (default)**: writes `stream.end` and closes the response
     immediately after the burst. This is the original behavior and is what
     `s0-natural-command.integration.test.ts` ("SSE stream mode emits event
     frames for job snapshot") exercises via `inject()` — that test does not
     pass `?live=1`, so it is unaffected by this change.
  3. **Live mode (`?live=1` or `?live=true`)**: keeps the HTTP response open
     and subscribes to the hub for `(workspaceId, jobId)`. On each publish it
     re-reads `naturalCommands.getJob(workspaceId, jobId)` and re-emits the
     full `job.updated` + `work_item.updated` (+ `control.updated`) snapshot
     as a new SSE frame. The subscription is torn down (and the response
     ended with a final `stream.end`) on:
     - client disconnect (`reply.raw.on("close", cleanup)`),
     - an idle timeout (reset on every delivered frame; the stream auto-closes only after `sseLiveTimeoutMs` of no further mutation) (`CreateAppOptions.sseLiveTimeoutMs`, default 30s,
       purely a liveness safety net — it does not indicate an error), or
     - a snapshot re-read failure (defensive; should not happen since the
       job existed at subscribe time).
  4. Backward-compatible JSON mode (`Accept` without `text/event-stream` and
     no `stream=1`) is untouched: it still returns `{ jobId, events }` read
     straight from `orch_job_events` via `snap.events`.

## Cross-process eventing: PG `LISTEN`/`NOTIFY` (N-09 / D6)

`EventHub` alone is single-process (see "Honest residual" below, pre-N-09
scope). When a real Postgres pool is configured (`databaseUrl`/`DATABASE_URL`,
not an injected `pgPool` test double — see `CreateAppOptions.pgNotify`),
`apps/api/src/pg-notify.ts`'s `PgNotifyBridge` closes that gap:

- **Publish (keys-only).** After `dualWriteJobSnapshot` durably saves a job's
  `orch_job_events` rows, it calls `publishNotify(pool, {workspaceId, jobId,
  eventId, kind}, "ai_crm_agent_events")` — i.e. `SELECT pg_notify(...)` with a
  JSON payload containing **only those four keys, never row bodies**. Two
  reasons this is non-negotiable:
  1. `NOTIFY`/`LISTEN` payloads are **not RLS-protected**. Every listener on
     the channel receives every payload regardless of `app.workspace_id` —
     unlike table reads, there is no FORCE RLS policy that can filter a
     `NOTIFY` payload.
  2. Postgres caps a `NOTIFY` payload around 8000 bytes. `encodeNotifyPayload`
     asserts the encoded JSON stays under `MAX_NOTIFY_PAYLOAD_BYTES` (8000) and
     throws (`PgNotifyPayloadTooLargeError`) rather than silently truncating.
     A keys-only payload is a few dozen bytes, so this is defensive, not a
     practical constraint.
- **Subscribe (re-read, never trust the wire).** Each `apps/api` process opens
  one dedicated `pg.Client` LISTEN connection (separate from the scoped
  per-request pool) on `ai_crm_agent_events`. On every notification,
  `PgNotifyBridge` **never reads row content from the NOTIFY payload** — it
  re-reads `orch_job_events` for `payload.workspaceId` through
  `PgQueryable.withWorkspaceScope(workspaceId, ...)`, the same FORCE-RLS
  scoping helper the request path uses (`set_config('app.workspace_id', ...,
  true)` inside a transaction on one checked-out connection). Only rows that
  pass RLS for that workspace come back; the bridge then calls
  `eventHub.publish({workspaceId, jobId, kind})` on the **local** hub, so any
  `?live=1` SSE subscriber on this process sees the follow-up frame exactly as
  if the mutation had happened in-process. A NOTIFY that claims a workspace it
  cannot actually read matching rows for yields zero recovered events — no
  cross-tenant leak is possible by construction, because the read is scoped by
  RLS, not by trusting the sender.
- **Reconnect reconcile (no replay on the wire).** `LISTEN`/`NOTIFY` fires only
  post-commit and provides **no backlog** — a disconnected or not-yet-started
  listener misses every notification sent while it was down/absent. The
  durable log remains source of truth: `PgNotifyBridge` tracks a per-workspace
  `(at, id)` cursor into `orch_job_events` and, on every (re)connect (including
  the very first connect), calls `reconcileWorkspace` for every already-tracked
  workspace — re-reading everything strictly after the last-seen cursor and
  replaying it into the local hub. A workspace only starts being tracked once
  the bridge has seen at least one notification for it (or a caller explicitly
  calls `trackWorkspace`); reconcile only recovers gaps for workspaces the
  bridge already knew about before the gap, consistent with `EventHub` itself
  only ever serving already-subscribed workspaces.
- **Failure mode.** Bridge startup/publish/reconcile failures are logged
  (`[PG_NOTIFY_*_FAILED]`) and never fail the request or block app boot — this
  is an enhancement over the durable outbox, not a new source of truth. If the
  bridge cannot start (e.g. `pg` too old to export `Client`, or the LISTEN
  connection cannot open), single-process `EventHub` fanout still works
  exactly as it did pre-N-09; only cross-process delivery is degraded.
- `CreateAppOptions.pgNotify` (default `true`) and `.pgNotifyChannel` (default
  `ai_crm_agent_events`) are the two knobs; set `pgNotify: false` to keep pure
  pre-N-09 in-process-only behavior in pg mode.

## Honest residual

- **In-process-only without a configured pool.** Memory mode (no
  `databaseUrl`/`pgPool`) is unchanged: `EventHub` is still a single-process
  `Map`, with no cross-process fanout of any kind. This is the documented,
  intentional single-instance behavior for the memory SoR path.
- **NOTIFY is best-effort, not a second source of truth.** The bridge is an
  enhancement over the durable outbox, never a replacement: every fact it can
  ever deliver was already committed to `orch_job_events` first. If the
  `PgNotifyBridge` never starts, was never told about a workspace
  (`trackWorkspace`/first notification), or a NOTIFY is dropped by the
  network, the durable log is still fully queryable via `GET
  /api/agent/jobs/:id` or the non-stream `events` endpoint — those never
  depend on `EventHub` or `PgNotifyBridge` at all.
- **No async worker fanout.** Publishing (both `EventHub.publish` and
  `publishNotify`) happens synchronously, inline in the request handler that
  performed the mutation, not via a background worker draining an outbox
  table. `apps/worker` is unrelated to this hub.
- **Ordering across the hub is best-effort, not authoritative.** The hub only
  triggers a re-read of the current snapshot; the authoritative order of
  events for a job is always `orch_job_events` (`at ASC, id ASC`), not the
  order frames happen to arrive over a given SSE connection or NOTIFY channel.
- **Reconcile replay window.** Reconcile only recovers events for workspaces
  the bridge was already tracking before a gap. A brand-new bridge instance
  (or a workspace it has never seen a notification for) starts from "now",
  not from the dawn of `orch_job_events` — by design, to avoid an unbounded
  full-table replay on every boot. Use `PgNotifyBridge.trackWorkspace` up
  front if a caller needs guaranteed from-zero coverage for a specific
  workspace.

## Tests

`apps/api/test/sse-eventing.integration.test.ts`:

- Initial-burst ordering (`job.updated` before `work_item.updated`, with
  `control.updated` present when a control exists) via `inject()`.
- No-events/empty: a job with no further mutation still closes cleanly in
  once-mode, and leaves zero hub subscribers.
- Live follow-up: a real listening HTTP server (`?live=1`), a job mutated on
  a second connection (`cancel`), and an assertion that the already-open
  stream receives a second frame reflecting the new status.
- Failure injection: client disconnect mid-stream is followed by the hub
  reporting zero subscribers for that job, and the server continuing to
  serve subsequent requests without crashing.

`s0-natural-command.integration.test.ts` retains the original burst-then-close
SSE contract test unmodified.

`apps/api/test/n09-notify.livepg.integration.test.ts` (`LIVE_PG_TEST=1`, real
Postgres):

- Payload guard: `encodeNotifyPayload` accepts a normal keys-only payload and
  throws `PgNotifyPayloadTooLargeError` once the encoded JSON reaches the
  8000-byte cap.
- Cross-workspace leak: workspace B's control row is inserted directly in PG,
  a NOTIFY is published claiming workspace B, and a `PgNotifyBridge` scoped to
  read as workspace A never recovers/publishes that event —
  `withWorkspaceScope(WS_A, ...)` returns zero rows for WS_B's `orch_job_events`
  row even by explicit id, proving FORCE RLS (not the NOTIFY payload) is what
  gates delivery.
- Cross-process delivery: two independent `PgNotifyBridge`/`EventHub` pairs
  (each with its own dedicated LISTEN connection) sharing one DSN — a NOTIFY
  published against the first is delivered to the second's local `EventHub`
  via a real `LISTEN`/`NOTIFY` round trip against Postgres (not an in-memory
  stub).
- Reconnect reconcile: a bridge's LISTEN connection is torn down
  (`simulateDisconnect`), events are inserted into `orch_job_events` directly
  while it is down (so no NOTIFY for them was ever received), the bridge
  reconnects, and the missed events are recovered from the durable log and
  published to the local hub.

### Reconcile cursor cold-start (honest note, N-09)

On the **first** NOTIFY received for a workspace after (re)start, the bridge seeds that workspace's `(at,id)` reconcile cursor to EPOCH, so its first reconcile re-reads that workspace's **full `orch_job_events` history** (bounded per-workspace, not whole-table). This guarantees no missed events but pays a one-time per-workspace catch-up scan concentrated post-deploy. It is functionally correct (hub publish no-ops without subscribers; the triggering event is still delivered) and never leaks (all reads scoped by `withWorkspaceScope` + `WHERE workspace_id`). **Follow-up (pre high-tenant-count scale):** seed the cursor near the notified `(at,eventId)` on notification-triggered tracking, keeping EPOCH only for the explicit `trackWorkspace` gap-coverage API. Also open: per-workspace reconcile serialization, id-primary high-water cursor, and a boot-time NOBYPASSRLS role assertion on the runtime pool.
