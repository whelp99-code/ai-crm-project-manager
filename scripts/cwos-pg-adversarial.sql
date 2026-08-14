\set ON_ERROR_STOP on

INSERT INTO workspaces (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'CWOS Gate A'),
  ('22222222-2222-4222-8222-222222222222', 'CWOS Gate B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, workspace_id, email, display_name, role, is_active) VALUES
  ('11111111-aaaa-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'owner-a@example.test', 'Owner A', 'owner', true),
  ('22222222-aaaa-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'owner-b@example.test', 'Owner B', 'owner', true)
ON CONFLICT DO NOTHING;

INSERT INTO principals (id, workspace_id, kind, user_id, role, display_name, is_active) VALUES
  ('11111111-bbbb-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'HUMAN', '11111111-aaaa-4111-8111-111111111111', 'owner', 'Owner A', true),
  ('22222222-bbbb-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'HUMAN', '22222222-aaaa-4222-8222-222222222222', 'owner', 'Owner B', true)
ON CONFLICT DO NOTHING;

SET ROLE ai_crm_runtime_api;
SELECT set_config('app.workspace_id', '11111111-1111-4111-8111-111111111111', false);

INSERT INTO cwos_accounts
  (id, workspace_id, name, normalized_name, kinds, status)
VALUES
  ('account-a', '11111111-1111-4111-8111-111111111111', 'Customer A', 'customer a', '["customer"]', 'active');

DO $$
BEGIN
  BEGIN
    INSERT INTO cwos_accounts
      (id, workspace_id, name, normalized_name, kinds, status)
    VALUES
      ('cross-account', '22222222-2222-4222-8222-222222222222', 'Cross', 'cross', '["customer"]', 'active');
    RAISE EXCEPTION 'RLS_BYPASS: cross-workspace insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM cwos_accounts;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'RLS_READ_FAILURE: expected 1 visible account, got %', visible_count;
  END IF;
END;
$$;

INSERT INTO cwos_engagements
  (id, workspace_id, project_key, name, engagement_type, stage, health, owner_principal_id)
VALUES
  ('engagement-a', '11111111-1111-4111-8111-111111111111', 'PRJ-GATE-001', 'Gate Project', 'delivery', 'BILLING', 'normal', '11111111-bbbb-4111-8111-111111111111');

INSERT INTO cwos_financial_items
  (id, workspace_id, engagement_id, account_id, direction, category, lifecycle,
   net_amount_krw, vat_amount_krw, gross_amount_krw, expected_date, revision)
VALUES
  ('fin-a', '11111111-1111-4111-8111-111111111111', 'engagement-a', 'account-a',
   'IN', 'contract_revenue', 'BILLED', 1000, 100, 1100, CURRENT_DATE, 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO cwos_financial_items
      (id, workspace_id, engagement_id, account_id, direction, category, lifecycle,
       net_amount_krw, vat_amount_krw, gross_amount_krw, expected_date, revision)
    VALUES
      ('bad-vat', '11111111-1111-4111-8111-111111111111', 'engagement-a', 'account-a',
       'IN', 'contract_revenue', 'BILLED', 1000, 100, 1099, CURRENT_DATE, 1);
    RAISE EXCEPTION 'VAT_BYPASS: invalid VAT row unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END;
$$;

INSERT INTO cwos_settlements
  (id, workspace_id, financial_item_id, direction, amount_krw, settled_at,
   account_or_card, evidence_ref)
VALUES
  ('settlement-a', '11111111-1111-4111-8111-111111111111', 'fin-a', 'IN', 500,
   CURRENT_DATE, 'gate-bank', 'evidence://gate/settlement-a');

DO $$
BEGIN
  BEGIN
    INSERT INTO cwos_settlements
      (id, workspace_id, financial_item_id, direction, amount_krw, settled_at,
       account_or_card, evidence_ref)
    VALUES
      ('over-settlement', '11111111-1111-4111-8111-111111111111', 'fin-a', 'IN', 601,
       CURRENT_DATE, 'gate-bank', 'evidence://gate/over');
    RAISE EXCEPTION 'SETTLEMENT_BYPASS: over-settlement unexpectedly succeeded';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'SETTLEMENT_BYPASS:%' THEN RAISE; END IF;
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    UPDATE cwos_settlements SET amount_krw = 400 WHERE id = 'settlement-a';
    RAISE EXCEPTION 'APPEND_ONLY_BYPASS: settlement update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

INSERT INTO cwos_runtime_snapshots
  (workspace_id, version, schema_version, state, idempotency, state_hash,
   updated_by_principal_id, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 1, 1,
   '{"schemaVersion":1,"accounts":[],"contacts":[],"engagements":[],"parties":[],"activities":[],"knowledge":[],"commitments":[],"products":[],"quotes":[],"contracts":[],"deliveryProjects":[],"changes":[],"purchaseOrders":[],"assets":[],"financialItems":[],"settlements":[],"consumedReceiptIds":[]}',
   '[]', 'gate-state-hash-v1', '11111111-bbbb-4111-8111-111111111111', now());

DO $$
BEGIN
  BEGIN
    UPDATE cwos_runtime_snapshots SET version = version + 2 WHERE workspace_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'CAS_BYPASS: invalid version jump unexpectedly succeeded';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'CAS_BYPASS:%' THEN RAISE; END IF;
  END;
END;
$$;

INSERT INTO cwos_runtime_audit_heads (workspace_id, head_sequence, updated_at)
VALUES ('11111111-1111-4111-8111-111111111111', 0, now());

INSERT INTO cwos_runtime_events
  (workspace_id, sequence, runtime_version, operation_id, principal_id,
   idempotency_key, request_hash, before_state_hash, after_state_hash,
   result_hash, previous_event_hash, event_hash)
VALUES
  ('11111111-1111-4111-8111-111111111111', 1, 1, 'gate.operation',
   '11111111-bbbb-4111-8111-111111111111', 'gate-idempotency', 'gate-request',
   'gate-before', 'gate-after', 'gate-result', NULL, 'gate-event');

DO $$
BEGIN
  BEGIN
    DELETE FROM cwos_runtime_events WHERE workspace_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'AUDIT_BYPASS: audit delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

RESET ROLE;

SET ROLE ai_crm_runtime_model_gateway;
SELECT set_config('app.workspace_id', '11111111-1111-4111-8111-111111111111', false);
DO $$
BEGIN
  BEGIN
    INSERT INTO cwos_accounts
      (id, workspace_id, name, normalized_name, kinds, status)
    VALUES
      ('model-write', '11111111-1111-4111-8111-111111111111', 'Model Write', 'model write', '["customer"]', 'active');
    RAISE EXCEPTION 'MODEL_CAPABILITY_BYPASS: model gateway write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

SELECT 'CWOS_PG_ADVERSARIAL_PASS' AS result;
