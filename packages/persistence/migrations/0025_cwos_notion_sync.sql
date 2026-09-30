-- Incremental Notion sync markers. Soft-archive only; no hard delete.
-- Down is intentionally omitted: drop only with a dump restore.

ALTER TABLE cwos_accounts ADD COLUMN notion_page_id text;
ALTER TABLE cwos_accounts ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_accounts ADD COLUMN archived_at timestamptz;
ALTER TABLE cwos_accounts ADD COLUMN synced_version integer;

ALTER TABLE cwos_engagements ADD COLUMN notion_page_id text;
ALTER TABLE cwos_engagements ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_engagements ADD COLUMN archived_at timestamptz;
ALTER TABLE cwos_engagements ADD COLUMN synced_version integer;

ALTER TABLE cwos_engagement_parties ADD COLUMN notion_page_id text;
ALTER TABLE cwos_engagement_parties ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_engagement_parties ADD COLUMN archived_at timestamptz;

ALTER TABLE cwos_activities ADD COLUMN notion_page_id text;
ALTER TABLE cwos_activities ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_activities ADD COLUMN archived_at timestamptz;

ALTER TABLE cwos_commitments ADD COLUMN notion_page_id text;
ALTER TABLE cwos_commitments ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_commitments ADD COLUMN archived_at timestamptz;
ALTER TABLE cwos_commitments ADD COLUMN synced_version integer;

ALTER TABLE cwos_artifacts ADD COLUMN notion_page_id text;
ALTER TABLE cwos_artifacts ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_artifacts ADD COLUMN archived_at timestamptz;
ALTER TABLE cwos_artifacts ADD COLUMN synced_version integer;

ALTER TABLE cwos_financial_items ADD COLUMN notion_page_id text;
ALTER TABLE cwos_financial_items ADD COLUMN notion_parent_page_id text;
ALTER TABLE cwos_financial_items ADD COLUMN archived_at timestamptz;

CREATE UNIQUE INDEX cwos_accounts_notion_page_uq ON cwos_accounts (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_engagements_notion_page_uq ON cwos_engagements (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_engagement_parties_notion_page_uq ON cwos_engagement_parties (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_activities_notion_page_uq ON cwos_activities (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_commitments_notion_page_uq ON cwos_commitments (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_artifacts_notion_page_uq ON cwos_artifacts (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;
CREATE UNIQUE INDEX cwos_financial_items_notion_page_uq ON cwos_financial_items (workspace_id, notion_page_id) WHERE notion_page_id IS NOT NULL;

CREATE TABLE cwos_notion_sync_runs (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  plan_hash text NOT NULL CHECK (btrim(plan_hash) <> ''),
  snapshot_sha256 text NOT NULL CHECK (btrim(snapshot_sha256) <> ''),
  status text NOT NULL CHECK (status IN ('applied')),
  applied_at timestamptz NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  UNIQUE (workspace_id, plan_hash),
  UNIQUE (workspace_id, id)
);

CREATE TABLE cwos_notion_sync_holds (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  notion_page_id text NOT NULL CHECK (btrim(notion_page_id) <> ''),
  kind text NOT NULL CHECK (btrim(kind) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  plan_hash text NOT NULL CHECK (btrim(plan_hash) <> ''),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, notion_page_id, reason),
  UNIQUE (workspace_id, id)
);

ALTER TABLE cwos_notion_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_sync_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_sync_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_sync_holds FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_notion_sync_runs_workspace_policy
  ON cwos_notion_sync_runs
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY cwos_notion_sync_holds_workspace_policy
  ON cwos_notion_sync_holds
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_notion_sync_runs TO ai_crm_runtime_api, ai_crm_runtime_worker;
GRANT SELECT, INSERT ON cwos_notion_sync_holds TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_notion_sync_runs FROM ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE UPDATE, DELETE ON cwos_notion_sync_holds FROM ai_crm_runtime_api, ai_crm_runtime_worker;

-- Artifact content is immutable to the app. Sync may update title/status/storage/metadata
-- only while app.cwos_notion_sync=on. Deletes stay forbidden.
CREATE OR REPLACE FUNCTION cwos_artifact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'artifacts cannot be deleted; supersede them';
  END IF;
  IF current_setting('app.cwos_notion_sync', true) = 'on' THEN
    IF NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id OR NEW.engagement_id <> OLD.engagement_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'artifact identity is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'artifact version must increment exactly once';
    END IF;
    RETURN NEW;
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
