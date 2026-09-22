-- Finance DailyGate version-aware restore: legacy NULL is deliberately
-- distinguishable from a known pack version. No default is permitted.
ALTER TABLE finance_daily_gate_state
  ADD COLUMN pack_version bigint NULL
  CHECK (pack_version IS NULL OR pack_version > 0);

CREATE TABLE finance_daily_gate_version_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  reason text NOT NULL CHECK (reason IN ('persisted_pack_version_missing', 'pack_version_mismatch')),
  from_pack_version bigint NULL,
  to_pack_version bigint NOT NULL CHECK (to_pack_version > 0),
  prior_streak integer NOT NULL,
  prior_tier text NOT NULL,
  prior_last_date_epoch bigint NULL,
  prior_activated_matrix_version bigint NULL,
  reset_streak integer NOT NULL,
  reset_tier text NOT NULL,
  reset_last_date_epoch bigint NULL,
  reset_activated_matrix_version bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_daily_gate_version_transitions_workspace_idx
  ON finance_daily_gate_version_transitions (workspace_id, id);

ALTER TABLE finance_daily_gate_version_transitions OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_daily_gate_version_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_gate_version_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_daily_gate_version_transitions
  USING (workspace_id = app_current_workspace_id())
  WITH CHECK (workspace_id = app_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON finance_daily_gate_state TO ai_crm_runtime_api;
GRANT SELECT, INSERT ON finance_daily_gate_version_transitions TO ai_crm_runtime_api;
GRANT USAGE, SELECT ON SEQUENCE finance_daily_gate_version_transitions_id_seq TO ai_crm_runtime_api;
GRANT SELECT ON finance_daily_gate_version_transitions TO ai_crm_audit_verifier;
-- The worker has no DailyGate version-transition writer; intentionally no worker grant.
