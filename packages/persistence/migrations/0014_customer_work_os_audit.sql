CREATE TABLE cwos_runtime_audit_heads (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  head_sequence bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  head_event_id uuid,
  head_event_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cwos_runtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  runtime_version bigint NOT NULL CHECK (runtime_version >= 1),
  operation_id text NOT NULL CHECK (btrim(operation_id) <> ''),
  principal_id text NOT NULL CHECK (btrim(principal_id) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash text NOT NULL CHECK (btrim(request_hash) <> ''),
  before_state_hash text NOT NULL CHECK (btrim(before_state_hash) <> ''),
  after_state_hash text NOT NULL CHECK (btrim(after_state_hash) <> ''),
  result_hash text NOT NULL CHECK (btrim(result_hash) <> ''),
  previous_event_hash text,
  event_hash text NOT NULL CHECK (btrim(event_hash) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sequence),
  UNIQUE (workspace_id, idempotency_key)
);

ALTER TABLE cwos_runtime_audit_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_runtime_audit_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_runtime_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_runtime_audit_heads_workspace_policy
  ON cwos_runtime_audit_heads
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY cwos_runtime_events_workspace_policy
  ON cwos_runtime_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_runtime_audit_heads TO ai_crm_runtime_api, ai_crm_runtime_worker;
GRANT SELECT, INSERT ON cwos_runtime_events TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_runtime_audit_heads FROM ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE UPDATE, DELETE ON cwos_runtime_events FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_runtime_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cwos_runtime_events is append-only';
END;
$$;

CREATE TRIGGER cwos_runtime_events_append_only_trigger
BEFORE UPDATE OR DELETE ON cwos_runtime_events
FOR EACH ROW EXECUTE FUNCTION cwos_runtime_events_append_only();

CREATE OR REPLACE FUNCTION cwos_runtime_audit_head_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cwos runtime audit head cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.head_sequence <> OLD.head_sequence + 1 THEN
    RAISE EXCEPTION 'cwos runtime audit sequence must increment exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_runtime_audit_head_guard_trigger
BEFORE UPDATE OR DELETE ON cwos_runtime_audit_heads
FOR EACH ROW EXECUTE FUNCTION cwos_runtime_audit_head_guard();

CREATE INDEX cwos_runtime_events_operation_idx
  ON cwos_runtime_events(workspace_id, operation_id, sequence DESC);
