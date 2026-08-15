# 17 — Rollback Plan

## General

Every PR is additive and independently revertible before production. Preserve database exports and evidence before any destructive/manual cutover action. Do not use history rewrite on shared branches.

| Change | Rollback trigger | Action | Data result |
|---|---|---|---|
| PR-001 dependency/import repair | unrelated regression | revert PR-001 only after restoring an alternate green baseline | no data change |
| v3 route registration | elevated errors or auth finding | disable/unregister v3 routes; keep v2 | no canonical data loss |
| migration 0020 | migration/RLS defect before pilot | stop v3 writers and apply a reviewed forward-fix; restore backup only inside an approved write freeze | canonical tables untouched |
| action projection | stale/incorrect output | stop consumer, truncate/rebuild derived rows with approved procedure | canonical source preserved |
| AI proposal path | unsafe evidence/model behavior | disable proposal capability and reject open drafts | no approved effect occurs |
| pilot/release candidate | missing/false evidence | mark run BLOCKED/FAILED and invalidate manifest | source remains deployed only if separately approved |

## Applied migration policy

After any environment accepts writes into 0020 tables, application rollback is preferred over dropping tables. A table-drop migration requires a separate destructive-change approval, verified export, retention review, and restore rehearsal.

## Cutover rollback

Before MANUAL cutover, enter a verified write freeze: drain API/worker outbox, reject new canonical mutations, record the last audit/outbox sequence, take a PostgreSQL backup, and capture source hash/counts/money plus owner decision. Target RPO is zero accepted canonical writes during the freeze; target RTO is 60 minutes for the pilot workspace.

If post-cutover reconciliation differs, keep writes frozen and prefer a forward-fix or transaction rollback. Backup restore is allowed only when the release reviewer proves the restore boundary contains no accepted post-snapshot canonical write. If a write was accepted despite the freeze, export its audit/outbox sequence, restore, replay it idempotently, and rerun count/money/hash reconciliation before reopening writes. Notion remains read-only; dual-write is not a rollback mechanism.
