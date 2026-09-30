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

Seven assigned OUT rows are in the plan (net 86300000) but did not land. Their engagements already exist in the restored dump under a different id with the same `project_key` (example: 게임조선 `engagement-580e2406` vs planned `engagement-3af71d0d`). Sync insert hit `cwos_engagements_workspace_id_project_key_key`, then the finance row failed its engagement FK. That is id drift in the dump, not an amount change. Do not apply this branch to `ai_crm` until that bind is verified.

Checks already recorded on `c23c070`: typecheck 0, `pnpm test` 779 passed / 0 failed, `next build` 0.
