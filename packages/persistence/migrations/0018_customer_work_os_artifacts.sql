CREATE TABLE cwos_artifacts (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  account_id text,
  artifact_type text NOT NULL CHECK (artifact_type IN (
    'customer_request','requirement_source','vendor_quote','customer_quote','proposal',
    'contract','purchase_order','design','delivery_plan','meeting_note','change_request',
    'test_evidence','acceptance_evidence','completion_report','tax_invoice','receipt','other'
  )),
  title text NOT NULL CHECK (btrim(title) <> ''),
  version_label text NOT NULL CHECK (btrim(version_label) <> ''),
  status text NOT NULL CHECK (status IN ('DRAFT','REVIEW','APPROVED','SENT','ACCEPTED','SUPERSEDED')),
  storage_uri text NOT NULL CHECK (btrim(storage_uri) <> ''),
  content_hash text,
  source_activity_id text,
  supersedes_artifact_id text,
  effective_date date,
  approved_by_principal_id text,
  sent_at timestamptz,
  accepted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, engagement_id, artifact_type, title, version_label),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, source_activity_id) REFERENCES cwos_activities(workspace_id, id),
  FOREIGN KEY (workspace_id, supersedes_artifact_id) REFERENCES cwos_artifacts(workspace_id, id),
  CHECK ((status IN ('APPROVED','SENT','ACCEPTED') AND approved_by_principal_id IS NOT NULL) OR status IN ('DRAFT','REVIEW','SUPERSEDED')),
  CHECK ((status IN ('SENT','ACCEPTED') AND sent_at IS NOT NULL) OR status NOT IN ('SENT','ACCEPTED')),
  CHECK ((status = 'ACCEPTED' AND accepted_at IS NOT NULL) OR status <> 'ACCEPTED')
);

ALTER TABLE cwos_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_artifacts_workspace_policy
  ON cwos_artifacts
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_artifacts TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_artifacts FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'artifacts cannot be deleted; supersede them';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id OR
     NEW.engagement_id <> OLD.engagement_id OR
     NEW.account_id IS DISTINCT FROM OLD.account_id OR
     NEW.artifact_type <> OLD.artifact_type OR NEW.title <> OLD.title OR
     NEW.version_label <> OLD.version_label OR NEW.storage_uri <> OLD.storage_uri OR
     NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
     NEW.source_activity_id IS DISTINCT FROM OLD.source_activity_id OR
     NEW.supersedes_artifact_id IS DISTINCT FROM OLD.supersedes_artifact_id OR
     NEW.effective_date IS DISTINCT FROM OLD.effective_date OR
     NEW.metadata <> OLD.metadata OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'artifact identity and content fields are immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'artifact version must increment exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_artifact_guard_trigger
BEFORE UPDATE OR DELETE ON cwos_artifacts
FOR EACH ROW EXECUTE FUNCTION cwos_artifact_guard();

CREATE INDEX cwos_artifacts_engagement_idx
  ON cwos_artifacts(workspace_id, engagement_id, artifact_type, created_at DESC);
