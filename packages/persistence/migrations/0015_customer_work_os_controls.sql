ALTER TABLE orch_governance_controls
  ADD COLUMN IF NOT EXISTS resource_type text,
  ADD COLUMN IF NOT EXISTS required_roles jsonb,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_reason text,
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS request_idempotency_key text,
  ADD COLUMN IF NOT EXISTS decision_reason text;

ALTER TABLE orch_governance_controls
  ADD CONSTRAINT orch_governance_controls_required_roles_check
    CHECK (required_roles IS NULL OR (jsonb_typeof(required_roles) = 'array' AND jsonb_array_length(required_roles) > 0)),
  ADD CONSTRAINT orch_governance_controls_expiry_check
    CHECK (expires_at IS NULL OR expires_at >= created_at);

CREATE UNIQUE INDEX IF NOT EXISTS orch_governance_controls_request_idempotency_idx
  ON orch_governance_controls(workspace_id, request_idempotency_key)
  WHERE request_idempotency_key IS NOT NULL;

CREATE TABLE cwos_control_decision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  control_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('REQUESTED','APPROVED','REJECTED','EXPIRED')),
  actor_principal_id text NOT NULL CHECK (btrim(actor_principal_id) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (control_id) REFERENCES orch_governance_controls(id)
);

ALTER TABLE cwos_control_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_control_decision_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_control_decision_events_workspace_policy
  ON cwos_control_decision_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT ON cwos_control_decision_events TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE UPDATE, DELETE ON cwos_control_decision_events FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_control_decision_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'cwos_control_decision_events is append-only';
END;
$$;

CREATE TRIGGER cwos_control_decision_events_append_only_trigger
BEFORE UPDATE OR DELETE ON cwos_control_decision_events
FOR EACH ROW EXECUTE FUNCTION cwos_control_decision_events_append_only();
