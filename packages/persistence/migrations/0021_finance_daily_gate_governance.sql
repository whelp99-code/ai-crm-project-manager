-- Server-derived DailyGate evidence and independent CFO activation proofs.
-- These records are append-only; current machine state remains in 0010.

CREATE TABLE finance_daily_gate_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  business_date date NOT NULL,
  controller_principal_id uuid NOT NULL REFERENCES principals (id),
  controller_role text NOT NULL CHECK (controller_role = 'CONTROLLER'),
  evidence_id text NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  evidence_signature text NOT NULL CHECK (evidence_signature ~ '^[0-9a-f]{64}$'),
  metrics jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  matrix_version integer NOT NULL CHECK (matrix_version > 0),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  pack_version integer NOT NULL CHECK (pack_version > 0),
  resulting_streak integer NOT NULL CHECK (resulting_streak >= 0),
  resulting_tier text NOT NULL CHECK (resulting_tier IN ('conservative', 'eligible')),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_daily_gate_evidence_workspace_date_key UNIQUE (workspace_id, business_date),
  CONSTRAINT finance_daily_gate_evidence_workspace_evidence_key UNIQUE (workspace_id, evidence_id),
  CONSTRAINT finance_daily_gate_evidence_workspace_hash_key UNIQUE (workspace_id, evidence_hash)
);

CREATE TABLE finance_daily_gate_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  business_date date NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  cfo_principal_id uuid NOT NULL REFERENCES principals (id),
  approval_id text NOT NULL,
  approval_hash text NOT NULL CHECK (approval_hash ~ '^[0-9a-f]{64}$'),
  approval_signature text NOT NULL CHECK (approval_signature ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_daily_gate_activation_workspace_date_key UNIQUE (workspace_id, business_date),
  CONSTRAINT finance_daily_gate_activation_workspace_approval_key UNIQUE (workspace_id, approval_id),
  CONSTRAINT finance_daily_gate_activation_workspace_hash_key UNIQUE (workspace_id, approval_hash),
  CONSTRAINT finance_daily_gate_activation_evidence_fkey FOREIGN KEY (workspace_id, evidence_hash)
    REFERENCES finance_daily_gate_evidence (workspace_id, evidence_hash),
  CONSTRAINT finance_daily_gate_activation_expiry_check CHECK (expires_at > approved_at)
);

ALTER TABLE finance_daily_gate_evidence OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_daily_gate_activations OWNER TO ai_crm_migration_owner;
ALTER TABLE finance_daily_gate_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_gate_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_gate_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_gate_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON finance_daily_gate_evidence USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id());
CREATE POLICY workspace_isolation ON finance_daily_gate_activations USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id());

CREATE OR REPLACE FUNCTION app_reject_finance_daily_gate_governance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance daily-gate governance records are immutable; % is not permitted', TG_OP USING ERRCODE = 'P0001'; END;
$$;
CREATE TRIGGER finance_daily_gate_evidence_immutable BEFORE UPDATE OR DELETE ON finance_daily_gate_evidence FOR EACH ROW EXECUTE FUNCTION app_reject_finance_daily_gate_governance_mutation();
CREATE TRIGGER finance_daily_gate_activations_immutable BEFORE UPDATE OR DELETE ON finance_daily_gate_activations FOR EACH ROW EXECUTE FUNCTION app_reject_finance_daily_gate_governance_mutation();

GRANT SELECT, INSERT ON finance_daily_gate_evidence, finance_daily_gate_activations TO ai_crm_runtime_api;
GRANT SELECT ON finance_daily_gate_evidence, finance_daily_gate_activations TO ai_crm_audit_verifier;
REVOKE UPDATE, DELETE ON finance_daily_gate_evidence, finance_daily_gate_activations FROM ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier, PUBLIC;
