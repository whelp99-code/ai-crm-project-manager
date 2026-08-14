BEGIN;

CREATE TABLE IF NOT EXISTS cwos_v2_runtime_snapshots (
  workspace_id uuid PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  idempotency jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(idempotency) = 'array'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  updated_by_principal_id text NOT NULL CHECK (btrim(updated_by_principal_id) <> ''),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cwos_v2_audit_events (
  workspace_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  operation_id text NOT NULL CHECK (btrim(operation_id) <> ''),
  principal_id text NOT NULL CHECK (btrim(principal_id) <> ''),
  command text NOT NULL CHECK (btrim(command) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  before_state_hash text NOT NULL CHECK (before_state_hash ~ '^[0-9a-f]{64}$'),
  after_state_hash text NOT NULL CHECK (after_state_hash ~ '^[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  previous_event_hash text NULL CHECK (previous_event_hash IS NULL OR previous_event_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, sequence),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS cwos_v2_audit_events_created_idx
  ON cwos_v2_audit_events (workspace_id, created_at DESC);

ALTER TABLE cwos_v2_runtime_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_runtime_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cwos_v2_snapshot_workspace_select ON cwos_v2_runtime_snapshots;
CREATE POLICY cwos_v2_snapshot_workspace_select ON cwos_v2_runtime_snapshots
  FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS cwos_v2_snapshot_workspace_insert ON cwos_v2_runtime_snapshots;
CREATE POLICY cwos_v2_snapshot_workspace_insert ON cwos_v2_runtime_snapshots
  FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS cwos_v2_snapshot_workspace_update ON cwos_v2_runtime_snapshots;
CREATE POLICY cwos_v2_snapshot_workspace_update ON cwos_v2_runtime_snapshots
  FOR UPDATE
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS cwos_v2_audit_workspace_select ON cwos_v2_audit_events;
CREATE POLICY cwos_v2_audit_workspace_select ON cwos_v2_audit_events
  FOR SELECT
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

DROP POLICY IF EXISTS cwos_v2_audit_workspace_insert ON cwos_v2_audit_events;
CREATE POLICY cwos_v2_audit_workspace_insert ON cwos_v2_audit_events
  FOR INSERT
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION cwos_v2_deny_snapshot_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cwos_v2 runtime snapshots cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS cwos_v2_runtime_snapshot_no_delete ON cwos_v2_runtime_snapshots;
CREATE TRIGGER cwos_v2_runtime_snapshot_no_delete
BEFORE DELETE ON cwos_v2_runtime_snapshots
FOR EACH ROW EXECUTE FUNCTION cwos_v2_deny_snapshot_delete();

CREATE OR REPLACE FUNCTION cwos_v2_deny_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cwos_v2 audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS cwos_v2_audit_immutable ON cwos_v2_audit_events;
CREATE TRIGGER cwos_v2_audit_immutable
BEFORE UPDATE OR DELETE ON cwos_v2_audit_events
FOR EACH ROW EXECUTE FUNCTION cwos_v2_deny_audit_mutation();

CREATE OR REPLACE FUNCTION cwos_v2_guard_audit_chain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_sequence bigint;
  previous_event_hash_value text;
  previous_after_state_hash text;
  snapshot_state_hash text;
BEGIN
  SELECT sequence, event_hash, after_state_hash
    INTO previous_sequence, previous_event_hash_value, previous_after_state_hash
  FROM cwos_v2_audit_events
  WHERE workspace_id = NEW.workspace_id
  ORDER BY sequence DESC
  LIMIT 1;

  IF previous_sequence IS NULL THEN
    IF NEW.sequence <> 1 OR NEW.previous_event_hash IS NOT NULL THEN
      RAISE EXCEPTION 'cwos_v2 audit chain must start at sequence 1 with no previous hash';
    END IF;
  ELSE
    IF NEW.sequence <> previous_sequence + 1 THEN
      RAISE EXCEPTION 'cwos_v2 audit sequence must be contiguous';
    END IF;
    IF NEW.previous_event_hash IS DISTINCT FROM previous_event_hash_value THEN
      RAISE EXCEPTION 'cwos_v2 previous event hash mismatch';
    END IF;
    IF NEW.before_state_hash IS DISTINCT FROM previous_after_state_hash THEN
      RAISE EXCEPTION 'cwos_v2 before-state hash does not continue the audit chain';
    END IF;
  END IF;

  SELECT state_hash INTO snapshot_state_hash
  FROM cwos_v2_runtime_snapshots
  WHERE workspace_id = NEW.workspace_id;

  IF snapshot_state_hash IS NULL OR snapshot_state_hash IS DISTINCT FROM NEW.after_state_hash THEN
    RAISE EXCEPTION 'cwos_v2 audit after-state hash does not match the authoritative snapshot';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cwos_v2_audit_chain_guard ON cwos_v2_audit_events;
CREATE TRIGGER cwos_v2_audit_chain_guard
BEFORE INSERT ON cwos_v2_audit_events
FOR EACH ROW EXECUTE FUNCTION cwos_v2_guard_audit_chain();

REVOKE ALL ON cwos_v2_runtime_snapshots FROM PUBLIC;
REVOKE ALL ON cwos_v2_audit_events FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON cwos_v2_runtime_snapshots TO ai_crm_runtime_api';
    EXECUTE 'GRANT SELECT, INSERT ON cwos_v2_audit_events TO ai_crm_runtime_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON cwos_v2_runtime_snapshots TO ai_crm_runtime_worker';
    EXECUTE 'GRANT SELECT, INSERT ON cwos_v2_audit_events TO ai_crm_runtime_worker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_audit_verifier') THEN
    EXECUTE 'GRANT SELECT ON cwos_v2_runtime_snapshots, cwos_v2_audit_events TO ai_crm_audit_verifier';
  END IF;
END;
$$;

COMMIT;
