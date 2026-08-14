CREATE TABLE cwos_notion_import_plans (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  snapshot_id text NOT NULL CHECK (btrim(snapshot_id) <> ''),
  snapshot_hash text NOT NULL CHECK (btrim(snapshot_hash) <> ''),
  plan_hash text NOT NULL CHECK (btrim(plan_hash) <> ''),
  captured_at timestamptz NOT NULL,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  source_counts jsonb NOT NULL CHECK (jsonb_typeof(source_counts) = 'object'),
  imported_counts jsonb NOT NULL CHECK (jsonb_typeof(imported_counts) = 'object'),
  finance_totals jsonb NOT NULL CHECK (jsonb_typeof(finance_totals) = 'object'),
  quarantine_count integer NOT NULL CHECK (quarantine_count >= 0),
  orphan_relation_count integer NOT NULL CHECK (orphan_relation_count >= 0),
  duplicate_candidate_count integer NOT NULL CHECK (duplicate_candidate_count >= 0),
  status text NOT NULL CHECK (status IN ('PLANNED','APPROVED','APPLIED','REJECTED')),
  read_only_source boolean NOT NULL CHECK (read_only_source),
  created_by_principal_id text NOT NULL CHECK (btrim(created_by_principal_id) <> ''),
  approved_by_principal_id text,
  applied_by_principal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  applied_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (workspace_id, snapshot_hash),
  UNIQUE (workspace_id, plan_hash),
  UNIQUE (workspace_id, id),
  CHECK ((status IN ('APPROVED','APPLIED') AND approved_by_principal_id IS NOT NULL AND approved_at IS NOT NULL)
      OR status IN ('PLANNED','REJECTED')),
  CHECK ((status = 'APPLIED' AND applied_by_principal_id IS NOT NULL AND applied_at IS NOT NULL)
      OR status <> 'APPLIED')
);

CREATE TABLE cwos_notion_import_plan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  plan_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('PLANNED','APPROVED','APPLIED','REJECTED')),
  actor_principal_id text NOT NULL CHECK (btrim(actor_principal_id) <> ''),
  plan_hash text NOT NULL CHECK (btrim(plan_hash) <> ''),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, plan_id) REFERENCES cwos_notion_import_plans(workspace_id, id)
);

ALTER TABLE cwos_notion_import_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_import_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_import_plan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_notion_import_plan_events FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_notion_import_plans_workspace_policy
  ON cwos_notion_import_plans
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

CREATE POLICY cwos_notion_import_plan_events_workspace_policy
  ON cwos_notion_import_plan_events
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_notion_import_plans TO ai_crm_runtime_api, ai_crm_runtime_worker;
GRANT SELECT, INSERT ON cwos_notion_import_plan_events TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_notion_import_plans FROM ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE UPDATE, DELETE ON cwos_notion_import_plan_events FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_notion_import_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notion import plans cannot be deleted';
  END IF;
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id OR
     NEW.snapshot_id <> OLD.snapshot_id OR NEW.snapshot_hash <> OLD.snapshot_hash OR
     NEW.plan_hash <> OLD.plan_hash OR NEW.captured_at <> OLD.captured_at OR
     NEW.plan <> OLD.plan OR NEW.source_counts <> OLD.source_counts OR
     NEW.imported_counts <> OLD.imported_counts OR NEW.finance_totals <> OLD.finance_totals OR
     NEW.quarantine_count <> OLD.quarantine_count OR
     NEW.orphan_relation_count <> OLD.orphan_relation_count OR
     NEW.duplicate_candidate_count <> OLD.duplicate_candidate_count OR
     NEW.read_only_source <> OLD.read_only_source OR
     NEW.created_by_principal_id <> OLD.created_by_principal_id OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Notion import plan definition is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Notion import plan version must increment exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_notion_import_plan_guard_trigger
BEFORE UPDATE OR DELETE ON cwos_notion_import_plans
FOR EACH ROW EXECUTE FUNCTION cwos_notion_import_plan_guard();

CREATE OR REPLACE FUNCTION cwos_notion_import_plan_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Notion import plan events are append-only';
END;
$$;

CREATE TRIGGER cwos_notion_import_plan_events_append_only_trigger
BEFORE UPDATE OR DELETE ON cwos_notion_import_plan_events
FOR EACH ROW EXECUTE FUNCTION cwos_notion_import_plan_events_append_only();

CREATE INDEX cwos_notion_import_plan_status_idx
  ON cwos_notion_import_plans(workspace_id, status, created_at DESC);
