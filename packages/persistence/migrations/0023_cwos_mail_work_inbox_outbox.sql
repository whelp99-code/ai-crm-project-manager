BEGIN;

-- Additive mail integration records. Source identity is scoped by workspace,
-- provider, mailbox, and provider locator; company names are never merge keys.
CREATE TABLE IF NOT EXISTS cwos_v2_mail_work_links (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  mailbox text NOT NULL,
  source_locator text NOT NULL,
  source_event_id text NOT NULL,
  work_item_id text NOT NULL,
  linked_by_principal_id text NOT NULL,
  correction_reason text,
  link_status text NOT NULL DEFAULT 'ACTIVE' CHECK (link_status IN ('ACTIVE','CORRECTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (workspace_id, provider, mailbox, source_locator, link_status)
);

CREATE TABLE IF NOT EXISTS cwos_v2_mail_inbox_receipts (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  provider text NOT NULL,
  mailbox text NOT NULL,
  source_locator text NOT NULL,
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (workspace_id, provider, mailbox, source_locator, provider_event_id)
);

CREATE TABLE IF NOT EXISTS cwos_v2_mail_outbox (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('WORK_LINKED','INBOX_RECEIVED','WORK_LINK_CORRECTED')),
  work_item_id text,
  source_event_id text,
  link_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EMITTED')),
  created_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS cwos_v2_mail_outbox_pending_idx
  ON cwos_v2_mail_outbox (workspace_id, status, created_at);

ALTER TABLE cwos_v2_mail_work_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_mail_work_links FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_mail_inbox_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_mail_inbox_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_mail_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cwos_v2_mail_outbox FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY cwos_v2_mail_work_links_scope ON cwos_v2_mail_work_links USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id())';
  EXECUTE 'CREATE POLICY cwos_v2_mail_inbox_receipts_scope ON cwos_v2_mail_inbox_receipts USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id())';
  EXECUTE 'CREATE POLICY cwos_v2_mail_outbox_scope ON cwos_v2_mail_outbox USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id())';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

REVOKE ALL ON cwos_v2_mail_work_links, cwos_v2_mail_inbox_receipts, cwos_v2_mail_outbox FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_api') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON cwos_v2_mail_work_links, cwos_v2_mail_inbox_receipts, cwos_v2_mail_outbox TO ai_crm_runtime_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_crm_runtime_worker') THEN
    EXECUTE 'GRANT SELECT, UPDATE ON cwos_v2_mail_outbox TO ai_crm_runtime_worker';
  END IF;
END $$;

COMMIT;
