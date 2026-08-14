-- Durable, optimistic-concurrency snapshot for the integrated Customer Work OS runtime.
-- Normalized cwos_* tables remain query/report models; this snapshot is the atomic command state.

CREATE TABLE cwos_runtime_snapshots (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  idempotency jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(idempotency) = 'array'),
  state_hash text NOT NULL CHECK (btrim(state_hash) <> ''),
  updated_by_principal_id text NOT NULL CHECK (btrim(updated_by_principal_id) <> ''),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cwos_runtime_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_runtime_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY cwos_runtime_snapshots_workspace_policy
  ON cwos_runtime_snapshots
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON cwos_runtime_snapshots TO ai_crm_runtime_api, ai_crm_runtime_worker;
REVOKE DELETE ON cwos_runtime_snapshots FROM ai_crm_runtime_api, ai_crm_runtime_worker;

CREATE OR REPLACE FUNCTION cwos_runtime_snapshot_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id <> OLD.workspace_id THEN
      RAISE EXCEPTION 'workspace_id is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'runtime snapshot version must increment exactly once';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'updated_at cannot move backwards';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_runtime_snapshot_guard_trigger
BEFORE UPDATE ON cwos_runtime_snapshots
FOR EACH ROW EXECUTE FUNCTION cwos_runtime_snapshot_guard();

CREATE OR REPLACE FUNCTION cwos_runtime_snapshot_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'runtime snapshots cannot be deleted; restore through an audited replacement';
END;
$$;

CREATE TRIGGER cwos_runtime_snapshot_no_delete_trigger
BEFORE DELETE ON cwos_runtime_snapshots
FOR EACH ROW EXECUTE FUNCTION cwos_runtime_snapshot_no_delete();
