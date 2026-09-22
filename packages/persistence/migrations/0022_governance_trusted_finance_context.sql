-- Issue #5: bind server-derived DailyGate policy context across restart.
-- Nullable preserves pre-tier controls/intents and all non-finance actions.

ALTER TABLE orch_governance_controls
  ADD COLUMN IF NOT EXISTS trusted_context_hash text;

ALTER TABLE orch_governance_intents
  ADD COLUMN IF NOT EXISTS trusted_context_hash text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orch_governance_controls_trusted_context_hash_check'
  ) THEN
    ALTER TABLE orch_governance_controls
      ADD CONSTRAINT orch_governance_controls_trusted_context_hash_check
      CHECK (trusted_context_hash IS NULL OR trusted_context_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orch_governance_intents_trusted_context_hash_check'
  ) THEN
    ALTER TABLE orch_governance_intents
      ADD CONSTRAINT orch_governance_intents_trusted_context_hash_check
      CHECK (trusted_context_hash IS NULL OR trusted_context_hash ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;
