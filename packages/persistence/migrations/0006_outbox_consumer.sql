-- =============================================================================
-- 0006_outbox_consumer.sql
--
-- D3 durable ACKED outbox CONSUMER (closes the "at-least-once EMISSION, not
-- DELIVERY" gap left after 0001's `outbox_events` + the M1 drainer/relay in
-- apps/worker/src/outbox.ts). The drainer already claims PENDING rows,
-- relays them (structured log + best-effort NOTIFY), and marks them
-- PUBLISHED — but nothing durably ACKS consumption of a PUBLISHED row at a
-- real sink. This migration adds that sink:
--
--   - `outbox_consumed_events` — one row per (consumer_name, outbox_id) the
--     consumer has durably applied. The composite PRIMARY KEY is the
--     idempotent-dedup mechanism: `ON CONFLICT (consumer_name, outbox_id) DO
--     NOTHING` makes redelivery of an already-consumed id a no-op, turning
--     the drainer's at-least-once emission into effectively-once delivery at
--     this sink.
--   - `outbox_consumer_offsets` — one row per consumer_name recording the
--     furthest (created_at, id) cursor the consumer has advanced past. Purely
--     an efficiency/observability watermark (correctness comes from the
--     dedup table above): lets a tick skip re-scanning the entire consumed
--     backlog on every run, and gives tests/ops a monotonic progress signal.
--
-- Layout:
--   1. Tables                       (outbox_consumer_offsets, outbox_consumed_events)
--   2. Ownership                    (migration owner owns both tables)
--   3. Row Level Security           (outbox_consumed_events only; see note below)
--   4. Grants                       (worker read-write, audit verifier read)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

-- Cross-workspace admin bookkeeping (one row per logical consumer, not per
-- tenant) — same posture as `workspaces` itself / `schema_migrations`, and
-- the same "worker/admin concern, not per-request" posture already
-- documented for `claimPendingOutbox`/`markOutboxPublished` in
-- pg-governance-adapter.ts. Not workspace-bound data, so no RLS.
CREATE TABLE outbox_consumer_offsets (
  consumer_name             text PRIMARY KEY,
  last_consumed_id          uuid NOT NULL,
  last_consumed_created_at  timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Workspace-bound dedup ledger (mirrors outbox_events' own workspace_id
-- column) so a consumed row is still attributable to a tenant for
-- audit/read purposes, even though the consumer itself reads/writes
-- cross-workspace via the admin pool (same as the drainer's claim).
-- `ON DELETE CASCADE` on `outbox_id`: no production path ever deletes an
-- `outbox_events` row (there is no retention/delete flow anywhere in this
-- repo), so this only matters for test/ops fixture cleanup — a consumed
-- ledger row for a deleted outbox event is meaningless bookkeeping, not
-- data that must survive its parent's deletion.
CREATE TABLE outbox_consumed_events (
  consumer_name  text NOT NULL,
  outbox_id      uuid NOT NULL REFERENCES outbox_events (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id),
  consumed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_consumed_events_pkey PRIMARY KEY (consumer_name, outbox_id)
);
CREATE INDEX outbox_consumed_events_workspace_idx ON outbox_consumed_events (workspace_id);
CREATE INDEX outbox_consumed_events_outbox_id_idx ON outbox_consumed_events (outbox_id);

-- -----------------------------------------------------------------------------
-- 2. Ownership — migration owner owns both tables (runtime roles never own).
-- -----------------------------------------------------------------------------

ALTER TABLE outbox_consumer_offsets OWNER TO ai_crm_migration_owner;
ALTER TABLE outbox_consumed_events  OWNER TO ai_crm_migration_owner;

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
--
-- `outbox_consumed_events` is workspace-bound data: ENABLE + FORCE + the same
-- `workspace_isolation` policy shape as 0001's loop (outbox_events included).
-- `outbox_consumer_offsets` intentionally has NO RLS: it is not tenant data,
-- it is one row per consumer_name shared across all workspaces (same
-- rationale 0001 gives for never adding RLS to `workspaces` itself).
-- -----------------------------------------------------------------------------

ALTER TABLE outbox_consumed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_consumed_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON outbox_consumed_events
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

-- -----------------------------------------------------------------------------
-- 4. Grants — least privilege, non-owner, NOBYPASSRLS runtime roles.
--
-- Only the worker runtime consumes the outbox (mirrors 0001's
-- `GRANT SELECT, INSERT, UPDATE ON outbox_events, ... TO ai_crm_runtime_worker`).
-- The API runtime has no reason to read/write consumer bookkeeping.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON outbox_consumer_offsets TO ai_crm_runtime_worker;
GRANT SELECT, INSERT ON outbox_consumed_events TO ai_crm_runtime_worker;

-- Audit verifier: read-only, no write grants (matches 0001's posture).
GRANT SELECT ON outbox_consumer_offsets, outbox_consumed_events TO ai_crm_audit_verifier;
