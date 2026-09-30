-- Keep the Notion 프로젝트 단계 label beside the mapped core5 stage.
-- Additive and nullable. Existing rows stay valid. Down is omitted: drop only with a dump restore.

ALTER TABLE cwos_engagements ADD COLUMN source_stage text;
