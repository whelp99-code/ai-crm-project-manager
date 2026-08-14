CREATE TABLE cwos_ai_suggestions (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account_id text,
  engagement_id text,
  agent_role text NOT NULL CHECK (agent_role IN (
    'capture_understand','deal_architect','meeting_copilot','proposal_architect',
    'delivery_guardian','procurement_asset_guardian','finance_guardian',
    'relationship_renewal','executive_analyst','independent_reviewer'
  )),
  suggestion_kind text NOT NULL CHECK (suggestion_kind IN (
    'account_link','engagement_link','activity_extract','knowledge_item','commitment',
    'deal_score','meeting_brief','quote_draft','proposal_draft','change_request',
    'purchase_risk','finance_risk','renewal_opportunity','executive_brief'
  )),
  title text NOT NULL CHECK (btrim(title) <> ''),
  proposed_payload jsonb NOT NULL CHECK (jsonb_typeof(proposed_payload) = 'object'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  risk text NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status text NOT NULL CHECK (status IN ('PROPOSED','REVIEWED','ACCEPTED','REJECTED','EXPIRED')),
  requires_human_review boolean NOT NULL,
  proposed_command jsonb CHECK (proposed_command IS NULL OR jsonb_typeof(proposed_command) = 'object'),
  input_digest text NOT NULL CHECK (btrim(input_digest) <> ''),
  response_digest text NOT NULL CHECK (btrim(response_digest) <> ''),
  model_version text NOT NULL CHECK (btrim(model_version) <> ''),
  prompt_version text NOT NULL CHECK (btrim(prompt_version) <> ''),
  usage jsonb NOT NULL CHECK (jsonb_typeof(usage) = 'object'),
  created_by_principal_id text NOT NULL CHECK (btrim(created_by_principal_id) <> ''),
  reviewed_by_principal_id text,
  review_reason text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  CHECK ((status IN ('ACCEPTED','REJECTED','EXPIRED') AND reviewed_by_principal_id IS NOT NULL AND review_reason IS NOT NULL)
      OR status IN ('PROPOSED','REVIEWED'))
);

CREATE TABLE cwos_ai_suggestion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  suggestion_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('PROPOSED','ACCEPTED','REJECTED','EXPIRED')),
  actor_principal_id text NOT NULL CHECK (btrim(actor_principal_id) <> ''),
  before_hash text,
  after_hash text NOT NULL CHECK (btrim(after_hash) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, suggestion_id) REFERENCES cwos_ai_suggestions(workspace_id, id)
);

ALTER TABLE cwos_ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_ai_suggestions FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_ai_suggestion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_ai_suggestion_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_ai_suggestions_workspace_policy
  ON cwos_ai_suggestions
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY cwos_ai_suggestion_events_workspace_policy
  ON cwos_ai_suggestion_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_ai_suggestions TO ai_crm_runtime_api, ai_crm_runtime_worker;
GRANT SELECT, INSERT ON cwos_ai_suggestion_events TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_ai_suggestions FROM ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE UPDATE, DELETE ON cwos_ai_suggestion_events FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_ai_suggestion_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI suggestions cannot be deleted';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id OR
     NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.engagement_id IS DISTINCT FROM OLD.engagement_id OR
     NEW.agent_role <> OLD.agent_role OR
     NEW.suggestion_kind <> OLD.suggestion_kind OR
     NEW.title <> OLD.title OR
     NEW.proposed_payload <> OLD.proposed_payload OR
     NEW.evidence <> OLD.evidence OR
     NEW.confidence <> OLD.confidence OR
     NEW.risk <> OLD.risk OR
     NEW.requires_human_review <> OLD.requires_human_review OR
     NEW.proposed_command IS DISTINCT FROM OLD.proposed_command OR
     NEW.input_digest <> OLD.input_digest OR
     NEW.response_digest <> OLD.response_digest OR
     NEW.model_version <> OLD.model_version OR
     NEW.prompt_version <> OLD.prompt_version OR
     NEW.usage <> OLD.usage OR
     NEW.created_by_principal_id <> OLD.created_by_principal_id OR
     NEW.created_at <> OLD.created_at OR
     NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'AI suggestion proposal fields are immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI suggestion version must increment exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_ai_suggestion_immutability_trigger
BEFORE UPDATE OR DELETE ON cwos_ai_suggestions
FOR EACH ROW EXECUTE FUNCTION cwos_ai_suggestion_immutability();

CREATE OR REPLACE FUNCTION cwos_ai_suggestion_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AI suggestion events are append-only';
END;
$$;

CREATE TRIGGER cwos_ai_suggestion_events_append_only_trigger
BEFORE UPDATE OR DELETE ON cwos_ai_suggestion_events
FOR EACH ROW EXECUTE FUNCTION cwos_ai_suggestion_events_append_only();

CREATE INDEX cwos_ai_suggestions_queue_idx
  ON cwos_ai_suggestions(workspace_id, status, risk, created_at DESC);
CREATE INDEX cwos_ai_suggestions_engagement_idx
  ON cwos_ai_suggestions(workspace_id, engagement_id, created_at DESC)
  WHERE engagement_id IS NOT NULL;
