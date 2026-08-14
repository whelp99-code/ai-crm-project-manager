-- JM AI-Native Customer Work OS v1 integrated schema.
-- CRM + CPQ + PSA + Project ERP + Project Finance share one workspace and project key.

CREATE TABLE cwos_accounts (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  normalized_name text NOT NULL CHECK (btrim(normalized_name) <> ''),
  kinds jsonb NOT NULL CHECK (jsonb_typeof(kinds) = 'array' AND jsonb_array_length(kinds) > 0),
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'at_risk')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, normalized_name)
);

CREATE TABLE cwos_contacts (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  account_id text NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  title text,
  email text,
  phone text,
  stakeholder_role text CHECK (stakeholder_role IS NULL OR stakeholder_role IN ('practitioner','technical','procurement','decision_maker','influencer','opponent')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE cwos_engagements (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_key text NOT NULL CHECK (btrim(project_key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  engagement_type text NOT NULL CHECK (engagement_type IN ('inquiry','opportunity','consulting','delivery','support','maintenance','renewal','internal')),
  stage text NOT NULL CHECK (stage IN ('INQUIRY','DISCOVERY','PROPOSAL','NEGOTIATION','CONTRACTED','DELIVERY','ACCEPTANCE','BILLING','COLLECTION','CLOSED','ON_HOLD','LOST','CANCELLED')),
  health text NOT NULL CHECK (health IN ('normal','warning','critical')),
  owner_principal_id text NOT NULL CHECK (btrim(owner_principal_id) <> ''),
  start_date date,
  target_date date,
  won_quote_id text,
  contract_id text,
  delivery_project_id text,
  terminal_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_key),
  CHECK (target_date IS NULL OR start_date IS NULL OR target_date >= start_date),
  CHECK (stage NOT IN ('LOST','CANCELLED') OR terminal_reason IS NOT NULL)
);

CREATE TABLE cwos_engagement_parties (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  account_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('customer','prime_contractor','partner','vendor','manufacturer','delivery_partner','outsourcer','advisor')),
  is_primary boolean NOT NULL DEFAULT false,
  commercial_responsibility boolean NOT NULL DEFAULT false,
  delivery_responsibility boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE NULLS NOT DISTINCT (workspace_id, engagement_id, role, is_primary) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id)
);

-- PostgreSQL UNIQUE NULLS NOT DISTINCT above cannot encode "one primary only" while allowing
-- multiple non-primary rows, so replace it with a partial unique index.
ALTER TABLE cwos_engagement_parties DROP CONSTRAINT cwos_engagement_parties_workspace_id_engagement_id_role_is_primary_key;
CREATE UNIQUE INDEX cwos_engagement_parties_one_primary_role_idx
  ON cwos_engagement_parties(workspace_id, engagement_id, role)
  WHERE is_primary;

CREATE TABLE cwos_activities (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  account_id text,
  activity_type text NOT NULL CHECK (activity_type IN ('email_in','email_out','call','meeting','message','visit','document','decision','note','finance')),
  occurred_at timestamptz NOT NULL,
  summary text NOT NULL CHECK (btrim(summary) <> ''),
  source_uri text,
  evidence_ref text,
  ai_confidence numeric(5,4) CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  human_reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id)
);

CREATE TABLE cwos_knowledge_items (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  item_kind text NOT NULL CHECK (item_kind IN ('requirement','confirmed_fact','unknown','assumption','decision','risk','exclusion','acceptance_criterion','change')),
  statement text NOT NULL CHECK (btrim(statement) <> ''),
  status text NOT NULL CHECK (status IN ('OPEN','VERIFYING','CONFIRMED','REJECTED','SUPERSEDED')),
  owner_principal_id text,
  due_at timestamptz,
  impact text,
  evidence_ref text,
  source_activity_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, source_activity_id) REFERENCES cwos_activities(workspace_id, id),
  CHECK (status <> 'CONFIRMED' OR evidence_ref IS NOT NULL)
);

CREATE TABLE cwos_commitments (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  source_activity_id text,
  owner_principal_id text NOT NULL CHECK (btrim(owner_principal_id) <> ''),
  counterparty_account_id text,
  description text NOT NULL CHECK (btrim(description) <> ''),
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','WAITING','DONE','CANCELLED')),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  financial_impact boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,
  completion_evidence_ref text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, source_activity_id) REFERENCES cwos_activities(workspace_id, id),
  FOREIGN KEY (workspace_id, counterparty_account_id) REFERENCES cwos_accounts(workspace_id, id),
  CHECK (status <> 'DONE' OR completion_evidence_ref IS NOT NULL)
);

CREATE TABLE cwos_products (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sku text NOT NULL CHECK (btrim(sku) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  product_kind text NOT NULL CHECK (product_kind IN ('hardware','software','license','service','maintenance','expense')),
  manufacturer_account_id text,
  default_cost_krw bigint CHECK (default_cost_krw IS NULL OR default_cost_krw >= 0),
  default_price_krw bigint CHECK (default_price_krw IS NULL OR default_price_krw >= 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, sku),
  FOREIGN KEY (workspace_id, manufacturer_account_id) REFERENCES cwos_accounts(workspace_id, id)
);

CREATE TABLE cwos_quotes (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  version_label text NOT NULL CHECK (btrim(version_label) <> ''),
  status text NOT NULL CHECK (status IN ('DRAFT','REVIEW','APPROVED','SENT','ACCEPTED','REJECTED','SUPERSEDED')),
  valid_until date NOT NULL,
  bom_lines jsonb NOT NULL CHECK (jsonb_typeof(bom_lines) = 'array' AND jsonb_array_length(bom_lines) > 0),
  scope text NOT NULL CHECK (btrim(scope) <> ''),
  exclusions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusions) = 'array'),
  total_cost_krw bigint NOT NULL CHECK (total_cost_krw >= 0),
  total_price_krw bigint NOT NULL CHECK (total_price_krw >= 0),
  gross_profit_krw bigint NOT NULL,
  margin_bps integer NOT NULL,
  approval_receipt_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, engagement_id, version_label),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  CHECK (gross_profit_krw = total_price_krw - total_cost_krw),
  CHECK (total_price_krw >= total_cost_krw)
);

CREATE TABLE cwos_contracts (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  quote_id text NOT NULL,
  title text NOT NULL CHECK (btrim(title) <> ''),
  scope text NOT NULL CHECK (btrim(scope) <> ''),
  exclusions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusions) = 'array'),
  contract_value_krw bigint NOT NULL CHECK (contract_value_krw >= 0),
  effective_from date NOT NULL,
  effective_to date,
  billing_milestones jsonb NOT NULL CHECK (jsonb_typeof(billing_milestones) = 'array' AND jsonb_array_length(billing_milestones) > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','COMPLETED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, quote_id) REFERENCES cwos_quotes(workspace_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE cwos_delivery_projects (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  contract_id text NOT NULL,
  project_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED','ACTIVE','ACCEPTANCE','AWAITING_APPROVAL','COMPLETE','CANCELLED')),
  scope_baseline text NOT NULL CHECK (btrim(scope_baseline) <> ''),
  schedule_start date NOT NULL,
  schedule_end date NOT NULL,
  requirement_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requirement_ids) = 'array'),
  deliverables jsonb NOT NULL CHECK (jsonb_typeof(deliverables) = 'array' AND jsonb_array_length(deliverables) > 0),
  work_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(work_items) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_key),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, contract_id) REFERENCES cwos_contracts(workspace_id, id),
  CHECK (schedule_end >= schedule_start)
);

CREATE TABLE cwos_change_requests (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  delivery_project_id text NOT NULL,
  source_activity_id text,
  description text NOT NULL CHECK (btrim(description) <> ''),
  scope_impact text NOT NULL CHECK (btrim(scope_impact) <> ''),
  schedule_impact_days integer NOT NULL,
  cost_impact_krw bigint NOT NULL CHECK (cost_impact_krw >= 0),
  price_impact_krw bigint NOT NULL CHECK (price_impact_krw >= 0),
  disposition text CHECK (disposition IS NULL OR disposition IN ('NO_CHARGE','CONTINGENCY','ADDITIONAL_QUOTE','REJECT')),
  status text NOT NULL CHECK (status IN ('ANALYZED','AWAITING_APPROVAL','APPROVED','REJECTED','APPLIED')),
  approval_receipt_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, delivery_project_id) REFERENCES cwos_delivery_projects(workspace_id, id),
  FOREIGN KEY (workspace_id, source_activity_id) REFERENCES cwos_activities(workspace_id, id)
);

CREATE TABLE cwos_purchase_orders (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  vendor_account_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  expected_date date,
  approval_receipt_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, vendor_account_id) REFERENCES cwos_accounts(workspace_id, id)
);

CREATE TABLE cwos_assets (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text NOT NULL,
  customer_account_id text NOT NULL,
  product_id text NOT NULL,
  purchase_order_id text NOT NULL,
  serial_or_license_key text NOT NULL CHECK (btrim(serial_or_license_key) <> ''),
  status text NOT NULL CHECK (status IN ('IN_STOCK','ALLOCATED','DELIVERED','ACTIVE','EXPIRED','RETIRED')),
  delivered_at date,
  warranty_end date,
  renewal_date date,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, serial_or_license_key),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, customer_account_id) REFERENCES cwos_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, product_id) REFERENCES cwos_products(workspace_id, id),
  FOREIGN KEY (workspace_id, purchase_order_id) REFERENCES cwos_purchase_orders(workspace_id, id)
);

CREATE TABLE cwos_financial_items (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  engagement_id text,
  account_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  category text NOT NULL CHECK (category IN ('contract_revenue','change_revenue','maintenance_revenue','hardware_cost','license_cost','outsourcing_cost','travel_cost','cloud_cost','internal_labor','overhead','other')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('PLANNED','APPROVED','CONFIRMED','BILLED','INCURRED','PARTIAL','SETTLED','OVERDUE','CANCELLED')),
  net_amount_krw bigint NOT NULL CHECK (net_amount_krw >= 0),
  vat_amount_krw bigint NOT NULL CHECK (vat_amount_krw >= 0),
  gross_amount_krw bigint NOT NULL CHECK (gross_amount_krw >= 0),
  expected_date date NOT NULL,
  contractual_due_date date,
  source_artifact_id text,
  source_purchase_order_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, engagement_id) REFERENCES cwos_engagements(workspace_id, id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES cwos_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, source_purchase_order_id) REFERENCES cwos_purchase_orders(workspace_id, id),
  CHECK (gross_amount_krw = net_amount_krw + vat_amount_krw),
  CHECK (engagement_id IS NOT NULL OR category = 'overhead'),
  CHECK (source_purchase_order_id IS NULL OR direction = 'OUT')
);

CREATE TABLE cwos_settlements (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  financial_item_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN','OUT')),
  amount_krw bigint NOT NULL CHECK (amount_krw > 0),
  settled_at date NOT NULL,
  account_or_card text NOT NULL CHECK (btrim(account_or_card) <> ''),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  reversal_of_settlement_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, reversal_of_settlement_id),
  FOREIGN KEY (workspace_id, financial_item_id) REFERENCES cwos_financial_items(workspace_id, id),
  FOREIGN KEY (workspace_id, reversal_of_settlement_id) REFERENCES cwos_settlements(workspace_id, id)
);

CREATE OR REPLACE FUNCTION cwos_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_direction text;
  item_gross bigint;
  current_total bigint;
  original cwos_settlements%ROWTYPE;
BEGIN
  SELECT direction, gross_amount_krw
    INTO item_direction, item_gross
    FROM cwos_financial_items
   WHERE workspace_id = NEW.workspace_id AND id = NEW.financial_item_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'financial item not found for settlement';
  END IF;
  IF item_direction <> NEW.direction THEN
    RAISE EXCEPTION 'settlement direction mismatch';
  END IF;

  IF NEW.reversal_of_settlement_id IS NOT NULL THEN
    SELECT * INTO original
      FROM cwos_settlements
     WHERE workspace_id = NEW.workspace_id AND id = NEW.reversal_of_settlement_id;
    IF NOT FOUND OR original.financial_item_id <> NEW.financial_item_id
       OR original.direction <> NEW.direction OR original.amount_krw <> NEW.amount_krw
       OR original.reversal_of_settlement_id IS NOT NULL THEN
      RAISE EXCEPTION 'invalid settlement reversal';
    END IF;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN reversal_of_settlement_id IS NULL THEN amount_krw ELSE -amount_krw END), 0)
    INTO current_total
    FROM cwos_settlements
   WHERE workspace_id = NEW.workspace_id AND financial_item_id = NEW.financial_item_id;

  current_total := current_total + CASE WHEN NEW.reversal_of_settlement_id IS NULL THEN NEW.amount_krw ELSE -NEW.amount_krw END;
  IF current_total < 0 OR current_total > item_gross THEN
    RAISE EXCEPTION 'settlement allocation outside 0..gross range';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cwos_settlement_guard_trigger
BEFORE INSERT ON cwos_settlements
FOR EACH ROW EXECUTE FUNCTION cwos_settlement_guard();

CREATE OR REPLACE FUNCTION cwos_settlement_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'settlements are append-only; create a reversal row';
END;
$$;

CREATE TRIGGER cwos_settlement_immutable_trigger
BEFORE UPDATE OR DELETE ON cwos_settlements
FOR EACH ROW EXECUTE FUNCTION cwos_settlement_immutable();

CREATE INDEX cwos_engagements_stage_idx ON cwos_engagements(workspace_id, stage, updated_at DESC);
CREATE INDEX cwos_commitments_due_idx ON cwos_commitments(workspace_id, status, due_at);
CREATE INDEX cwos_activities_timeline_idx ON cwos_activities(workspace_id, engagement_id, occurred_at DESC);
CREATE INDEX cwos_financial_items_due_idx ON cwos_financial_items(workspace_id, direction, lifecycle, contractual_due_date);
CREATE INDEX cwos_assets_renewal_idx ON cwos_assets(workspace_id, renewal_date) WHERE renewal_date IS NOT NULL;
CREATE INDEX cwos_changes_status_idx ON cwos_change_requests(workspace_id, status, updated_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cwos_accounts','cwos_contacts','cwos_engagements','cwos_engagement_parties',
    'cwos_activities','cwos_knowledge_items','cwos_commitments','cwos_products',
    'cwos_quotes','cwos_contracts','cwos_delivery_projects','cwos_change_requests',
    'cwos_purchase_orders','cwos_assets','cwos_financial_items','cwos_settlements'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      table_name || '_workspace_policy', table_name
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ai_crm_runtime_api, ai_crm_runtime_worker', table_name);
  END LOOP;
END;
$$;

REVOKE UPDATE, DELETE ON cwos_settlements FROM ai_crm_runtime_api, ai_crm_runtime_worker;
