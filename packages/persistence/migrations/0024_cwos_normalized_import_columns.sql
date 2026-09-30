-- D2: nullable columns so a normalized canonical write can keep Notion provenance
-- and commitments whose source has no due date. Existing rows stay valid.
ALTER TABLE cwos_accounts
  ADD COLUMN source_ref text;

ALTER TABLE cwos_financial_items
  ADD COLUMN evidence_ref text;

ALTER TABLE cwos_commitments
  ALTER COLUMN due_at DROP NOT NULL;
