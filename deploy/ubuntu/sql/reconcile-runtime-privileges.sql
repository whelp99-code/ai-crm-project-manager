\set ON_ERROR_STOP on

-- Runtime privileges are deployment state, not backup payload.  Reapply them
-- after every migration pass and every restore so stale or missing ACL entries
-- can never leave an otherwise healthy database inaccessible.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api') THEN
    RAISE EXCEPTION 'required role ai_crm_runtime_api is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker') THEN
    RAISE EXCEPTION 'required role ai_crm_runtime_worker is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_audit_verifier') THEN
    RAISE EXCEPTION 'required role ai_crm_audit_verifier is missing';
  END IF;

  IF to_regclass('public.cwos_v2_runtime_snapshots') IS NULL
     OR to_regclass('public.cwos_v2_audit_events') IS NULL
     OR to_regclass('public.cwos_v25_automation_snapshots') IS NULL
     OR to_regclass('public.cwos_v25_automation_audit_events') IS NULL THEN
    RAISE EXCEPTION 'Customer Work OS runtime tables are missing; migrations are incomplete';
  END IF;

  GRANT USAGE ON SCHEMA public
    TO ai_crm_runtime_api, ai_crm_runtime_worker, ai_crm_audit_verifier;

  GRANT SELECT, INSERT, UPDATE ON TABLE
    public.cwos_v2_runtime_snapshots,
    public.cwos_v25_automation_snapshots
    TO ai_crm_runtime_api, ai_crm_runtime_worker;

  GRANT SELECT, INSERT ON TABLE
    public.cwos_v2_audit_events,
    public.cwos_v25_automation_audit_events
    TO ai_crm_runtime_api, ai_crm_runtime_worker;

  GRANT SELECT ON TABLE
    public.cwos_v2_runtime_snapshots,
    public.cwos_v2_audit_events,
    public.cwos_v25_automation_snapshots,
    public.cwos_v25_automation_audit_events
    TO ai_crm_audit_verifier;
END;
$$;

DO $$
DECLARE
  failed text[] := ARRAY[]::text[];
BEGIN
  IF NOT has_schema_privilege('ai_crm_runtime_api', 'public', 'USAGE') THEN
    failed := array_append(failed, 'ai_crm_runtime_api:USAGE public');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_api', 'public.cwos_v2_runtime_snapshots', 'SELECT,INSERT,UPDATE') THEN
    failed := array_append(failed, 'ai_crm_runtime_api:cwos_v2_runtime_snapshots');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_api', 'public.cwos_v2_audit_events', 'SELECT,INSERT') THEN
    failed := array_append(failed, 'ai_crm_runtime_api:cwos_v2_audit_events');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_api', 'public.cwos_v25_automation_snapshots', 'SELECT,INSERT,UPDATE') THEN
    failed := array_append(failed, 'ai_crm_runtime_api:cwos_v25_automation_snapshots');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_api', 'public.cwos_v25_automation_audit_events', 'SELECT,INSERT') THEN
    failed := array_append(failed, 'ai_crm_runtime_api:cwos_v25_automation_audit_events');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_worker', 'public.cwos_v2_runtime_snapshots', 'SELECT,INSERT,UPDATE') THEN
    failed := array_append(failed, 'ai_crm_runtime_worker:cwos_v2_runtime_snapshots');
  END IF;
  IF NOT has_table_privilege('ai_crm_runtime_worker', 'public.cwos_v25_automation_snapshots', 'SELECT,INSERT,UPDATE') THEN
    failed := array_append(failed, 'ai_crm_runtime_worker:cwos_v25_automation_snapshots');
  END IF;
  IF NOT has_table_privilege('ai_crm_audit_verifier', 'public.cwos_v2_audit_events', 'SELECT') THEN
    failed := array_append(failed, 'ai_crm_audit_verifier:cwos_v2_audit_events');
  END IF;
  IF NOT has_table_privilege('ai_crm_audit_verifier', 'public.cwos_v25_automation_audit_events', 'SELECT') THEN
    failed := array_append(failed, 'ai_crm_audit_verifier:cwos_v25_automation_audit_events');
  END IF;

  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'runtime privilege reconciliation failed: %', array_to_string(failed, ', ');
  END IF;
END;
$$;
