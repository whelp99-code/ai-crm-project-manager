-- Additive import overrides. Existing rows stay valid (import_assignment defaults to assigned).
-- Rollback of this migration is not safe once null expected_date or unassigned rows exist.
-- Cutover rollback is a dump restore. Do not apply to ai_crm without owner approval.

ALTER TABLE cwos_activities ALTER COLUMN engagement_id DROP NOT NULL;

ALTER TABLE cwos_activities DROP CONSTRAINT IF EXISTS cwos_activities_account_or_engagement_chk;
ALTER TABLE cwos_activities
  ADD CONSTRAINT cwos_activities_account_or_engagement_chk
  CHECK (engagement_id IS NOT NULL OR account_id IS NOT NULL);

ALTER TABLE cwos_financial_items ALTER COLUMN expected_date DROP NOT NULL;

ALTER TABLE cwos_financial_items
  ADD COLUMN IF NOT EXISTS import_assignment text NOT NULL DEFAULT 'assigned';

ALTER TABLE cwos_financial_items DROP CONSTRAINT IF EXISTS cwos_financial_items_import_assignment_chk;
ALTER TABLE cwos_financial_items
  ADD CONSTRAINT cwos_financial_items_import_assignment_chk
  CHECK (import_assignment IN ('assigned', 'unassigned'));

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'cwos_financial_items'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%category = ''overhead''%'
    AND pg_get_constraintdef(con.oid) NOT LIKE '%import_assignment%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE cwos_financial_items DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE cwos_financial_items DROP CONSTRAINT IF EXISTS cwos_financial_items_engagement_or_unassigned_chk;
ALTER TABLE cwos_financial_items
  ADD CONSTRAINT cwos_financial_items_engagement_or_unassigned_chk
  CHECK (engagement_id IS NOT NULL OR category = 'overhead' OR import_assignment = 'unassigned');
