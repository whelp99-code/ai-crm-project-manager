# Quarantine override scratch proof

Snapshot `notion-cfo-os-20260930T014053Z`. Scratch database only (`ai_crm_override_scratch` on the pilot Postgres). Not `ai_crm`. Not a Notion write. Scratch dropped after this record.

Flags off: quarantined 39. Finance plan matches the restored dump: IN net 9714000 / vat 971400 / gross 10685400 (n=2), OUT net 87760000 / vat 8776000 / gross 96536000 (n=6).

Flags on (all five rules, page-id file): quarantined 9. Rows no rule covers:

| entity | page id | reason |
|---|---|---|
| engagement | `f8033ddb-7425-8239-8038-01ba0c753851` | card-fee row excluded; `MISSING_PROJECT_KEY` |
| activity | `3bf33ddb-7425-8131-bf65-f9283e2e9dfa` | no account on the page; still `ORPHAN_ACTIVITY` |
| activity | `3bf33ddb-7425-81a4-bca6-e325b4a17a75` | same |
| activity | `3bf33ddb-7425-81e0-8fe7-c93f195c8eeb` | same |
| financial_item | `3d633ddb-7425-8132-a2ce-f85bc88156c2` | project imported by rule 1, still no expected date, not in the rule-4 list |
| financial_item | `3d633ddb-7425-8146-bb0b-f4fa2f8cdf6a` | same |
| financial_item | `3e933ddb-7425-8169-b757-e95319c581e2` | project imported, no 거래처 and no single 매출처 |
| financial_item | `3e933ddb-7425-81b8-b88c-f753f5399575` | same |
| financial_item | `3e933ddb-7425-81ba-b104-cd246dd9fa99` | 롯데건설 매출, no account id in the file |

Per rule, planner:

1. 11 stage overrides applied (`DELIVERY` + renewal/maintenance/delivery). Card-fee id is not in the file.
2. Rule 1 wins for 7 finance rows that point at those projects (stay assigned). 4 empty-relation rows become `unassigned` with amounts kept. 5 of the 16 stay quarantined (no account, or date still required).
3. 3 activities with a listed account become account-level. 2 unknown-relation activities follow the rule-1 projects. 3 without an account stay quarantined.
4. 2 listed finance rows keep `expectedDate` null.
5. 굿어스 invoice uses account `3bb33ddb-7425-8100-a3f3-e7f2b285430c`.

Sync into the restored scratch (migrations through 0027), then the same plan again:

- Re-run: `alreadyApplied`, inserts 0, totals unchanged.
- Rule 4 rows in DB: `expected_date` NULL (not 2026-09-30).
- Rule 3 rows in DB: `engagement_id` NULL, `account_id` present.
- Rule 2 empty-relation rows in DB: `import_assignment=unassigned`, amounts unchanged.

Scratch totals after sync:

- IN net 24486000 / vat 2448600 / gross 26934600 (n=5). Delta net +14772000.
- OUT net 94212000 / vat 9421200 / gross 103633200 (n=10). Delta net +6452000.

Itemised delta that landed (existing rows did not change):

| direction | net | page id | why |
|---|---:|---|---|
| IN | 9752000 | `3be33ddb-7425-818f-b474-c49f702b11de` | rule 4, date null |
| IN | 4240000 | `3d633ddb-7425-81e9-8d09-f8eae49e658d` | rule 4, date null |
| IN | 780000 | `3e933ddb-7425-81b5-8574-fe154243ead9` | rule 5 |
| OUT | 100000 | `3bb33ddb-7425-8105-8036-e363c2cf3766` | rule 2 unassigned |
| OUT | 5000000 | `3bb33ddb-7425-816d-baaa-cbadd9db6758` | rule 2 unassigned |
| OUT | 30000 | `3bb33ddb-7425-81ce-a93e-e34d030a9dfa` | rule 2 unassigned |
| OUT | 1322000 | `3bb33ddb-7425-81fc-9089-cb70be2b9fe2` | rule 2 unassigned |

Seven assigned OUT rows are in the plan (net 86300000) but did not land on that scratch. Their engagements already exist there under a different id with the same `project_key` (example: 게임조선 `engagement-580e2406` vs planned `engagement-3af71d0d`). Sync insert hit `cwos_engagements_workspace_id_project_key_key`, then the finance row failed its engagement FK. That is id drift, not an amount change.

## Engagement identity bind — 2026-09-30

Sync now resolves an engagement before insert: Notion page id (including a `notion://` source ref), then `(workspace_id, project_key)`. It reuses that database id for the engagement and for finance/activity rows. If the planned id and the identity row both exist, the database identity wins and the mapping is logged. A second engagement is not inserted.

Unit proof: existing row `engagement-580e2406` + planned `engagement-3af71d0d` with the same `project_key` → no engagement insert, finance `engagement_id` is `engagement-580e2406`, re-run `alreadyApplied` inserts 0. The raw workspace string `jm-business-crm` hashes to `engagement-580e2406`; the resolved workspace UUID hashes to `engagement-3af71d0d`.

Scratch: read-only `pg_dump` of current `ai_crm` (0025/0026 + markers, 35 engagements) restored to `ai_crm_engagement_bind_scratch`, then 0027 only. Not a write to `ai_crm`. Not a Notion write. Scratch dropped after this record. Flags on, snapshot `notion-cfo-os-20260930T014053Z`.

- Quarantined 9 (same nine page ids as above).
- First sync: inserts 59, updates 2, archives 0, holds 0, settlementInserts 5. SCHEMA_REJECT 0.
- Re-run: `alreadyApplied`, inserts 0, updates 0, archives 0, holds 0.
- Engagements 35 → 46. Duplicate `(workspace_id, project_key)` groups: 0. Those 11 projects are the stage-override pages. They are not in current `ai_crm` (no `202607-GAMECHOSUN-HCI-RNWL`, no `engagement-580e2406`), so they are new rows, not twins of the baseline 35.
- IN net 24486000 / vat 2448600 / gross 26934600 (n=5). Delta net +14772000.
- OUT net 177492000 / vat 17749200 / gross 195241200 (n=17). Delta net +89732000.

Itemised delta that landed (existing rows did not change):

| direction | net | page id | why |
|---|---:|---|---|
| IN | 9752000 | `3be33ddb-7425-818f-b474-c49f702b11de` | rule 4, date null |
| IN | 4240000 | `3d633ddb-7425-81e9-8d09-f8eae49e658d` | rule 4, date null |
| IN | 780000 | `3e933ddb-7425-81b5-8574-fe154243ead9` | rule 5 |
| OUT | 100000 | `3bb33ddb-7425-8105-8036-e363c2cf3766` | rule 2 unassigned |
| OUT | 5000000 | `3bb33ddb-7425-816d-baaa-cbadd9db6758` | rule 2 unassigned |
| OUT | 30000 | `3bb33ddb-7425-81ce-a93e-e34d030a9dfa` | rule 2 unassigned |
| OUT | 1322000 | `3bb33ddb-7425-81fc-9089-cb70be2b9fe2` | rule 2 unassigned |
| OUT | 3300000 | `3bb33ddb-7425-8114-8769-d2a1e0c9bac2` | assigned, new engagement |
| OUT | 62350000 | `3bb33ddb-7425-813c-b878-cfba9da826e6` | assigned, new engagement |
| OUT | 4730000 | `3bb33ddb-7425-8153-ad8b-d3f0fc6fbe02` | assigned, new engagement |
| OUT | 1580000 | `3bb33ddb-7425-8171-9236-ca1618805be1` | assigned, 게임조선, engagement `engagement-3af71d0d` |
| OUT | 7300000 | `3bb33ddb-7425-8184-be97-d2d4a1c54246` | assigned, new engagement |
| OUT | 520000 | `3bb33ddb-7425-81b3-8dbc-f3541c1a473e` | assigned, new engagement |
| OUT | 3500000 | `3bb33ddb-7425-81c7-bc3c-dc18d930e2fa` | assigned, new engagement |

Assigned OUT that landed: 7 rows, net 83280000. The earlier 86300000 figure was the prior scratch, where the same bind failed. This dump has no pre-existing row for those project keys, so the rows insert once.

Checks on this commit: `pnpm typecheck` 0, `pnpm test` 782 passed / 0 failed / 54 skipped, `pnpm --filter @ai-crm/web exec next build` 0. `ai_crm` schema_migrations has no 0027. `ai_crm` engagements still 35.

## Independent verification — 2026-09-30 (검증냥, not the implementer)

Context: fresh clone of `feat/quarantine-overrides` at `f34adb5`. Scratch `ai_crm_verifier_st01a0f245` restored from a read-only `pg_dump` of current `ai_crm` (35 engagements, migrations through 0026, no 0027), then 0027 SQL only. Not a write to `ai_crm`. Not a Notion write. Snapshot `notion-cfo-os-20260930T014053Z`. Flags on via the committed override file. Scratch dropped after this record.

| check | result | evidence |
|---|---|---|
| New resolution tests fail before | FAIL_BEFORE (expected) | Parent `71d8c22` plus the new test file: 2 failed / 1 passed. Binding assertion got `SCHEMA_REJECT`; `bindExistingEngagementIds` is not a function. The passing test is re-run `alreadyApplied` only. |
| New resolution tests pass after | PASS | `f34adb5` `apps/api/test/notion-engagement-identity.test.ts` 3 passed inside the full suite. |
| `pnpm test` 0 failed | PASS | 780 passed / 0 failed / 54 skipped (109 files). Node v24.19.0 (engine wants 22). Developer count 782 passed was not reproduced. Not a failure of the 0-failed gate. |
| Quarantine 39→9, same nine page ids | PASS | Flags off 39. Flags on 9. Page ids match the table above. |
| Engagements 35→46, 0 duplicate `project_key` | PASS | 11 keys exist only after sync (`202607-GAMECHOSUN-HCI-RNWL` among them). Baseline dump has none of those 11. |
| Finance totals | PASS | IN net 24486000 / vat 2448600 / gross 26934600 (n=5). OUT net 177492000 / vat 17749200 / gross 195241200 (n=17). First sync inserts 59, updates 2, archives 0, holds 0, settlementInserts 5. Re-run `alreadyApplied`, inserts 0. |
| Finance FK | PASS | 18/22 rows have an `engagement_id` that exists. 4/22 are rule-2 `unassigned` with null `engagement_id` (not a dangling FK). |
| Hometax gross gap is one row | PASS | 17 BuyHomeTax rows, gross 194911200. 195241200−194911200=330000. 16 gross amounts match. The only gap is page `3bb33ddb-7425-8114-8769-d2a1e0c9bac2` (넥시아스, approval tail `0855`): scratch gross 3630000 vs invoice gross 3300000. Invoice 작성일 and Notion 예상 출금일 are 2026-05-22. Recon date 2026-08-13 is Notion 실제 처리일, not a second invoice. Same page. Net gap on that row is 300000 (3300000 vs invoice supply 3000000); vat gap 30000. No second mismatched gross. |
| Earlier assigned OUT 86300000 vs 83280000 | NOT a ledger row | The seven assigned OUT pages that landed sum to 83280000 (3300000+62350000+4730000+1580000+7300000+520000+3500000). 86300000−83280000=3020000. No finance amount in this snapshot is 3020000. The 86300000 figure in the prior scratch paragraph is not the sum of these seven nets. Do not carry it as a measured total. |

`ai_crm` after this run: engagements still 35, schema_migrations has no 0027. Checked by SELECT. Not deployed. Not in owner use.

Verdicts: tests-before NOT a product fail (it is the before state). Product checks PASS except the unreproduced 782 count (recorded, not a 0-failed fail). 86300000 claim FAIL as a number, does not change the landed totals. Release approval is not this note.
