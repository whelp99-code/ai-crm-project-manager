# 검증 판정 — Notion 증분 동기화 PR #16

독립 검증. 대상 `feat/notion-incremental-sync` @ `16947cd85e763bf64236d4561ca510cbac9b826d` (커밋 `8b6793a` `2812541` `76d8cdb` `ae75030` `16947cd`). 이슈 #15. 클론 `/tmp/verify-notion-sync`. `ai_crm`에는 접속하지 않았다. 검증냥은 출시를 승인하지 않는다.

전체: **FAIL**. 일자·시각·metadata 정규화 불일치로, plan hash가 달라지는 동기화마다 변하지 않은 행을 다시 쓴다.

## 37 updates 원인 (확정)

개발 인계의 합성 변경(추가 1, 제목 1, 활동 제거 1, 정산 있는 금액 +1000)은 `updates=37`이었다. 같은 스냅샷으로 마커만 지우고 dry-run한 결과는 `updates=38`, inserts/archives/holds 0. 합성 37은 그 38에서 제거된 활동 1건이 빠진 것이다. 제목 변경은 이미 날짜 오탐에 포함된 engagement라 건수를 늘리지 않는다.

| 종류 | 불변 재비교 | 합성 전 비교 | 필드 |
| --- | ---: | ---: | --- |
| engagement | 15 | 15 | `start_date` 15, `target_date` 7, 합성에서 `name` 1 |
| activity | 13 | 12 | `occurred_at` |
| financial_item | 8 | 8 | `expected_date` |
| artifact | 2 | 2 | `metadata` 키 순서 |

증거: `cwos_engagements.start_date` 저장값은 `2025-12-01`인데, `rowToLive`의 `dateText`가 `Date#toISOString().slice(0,10)`이라 Asia/Seoul에서 `2025-11-30`이 된다. desired는 `2025-12-01`. `notionSyncFieldEqual`이 불일치로 보고 `updateEntity`가 version을 올린다. `engagement-2f0787ad`는 이름 변경이 없는데 version 1→2, `updated_at`이 갱신되고 저장 일자는 `2026-01-01` 그대로였다. `occurred_at`은 desired 날짜 문자열과 live `2026-08-13T00:00:00.000Z`가 다르다. artifact metadata는 `{legacySourceId, importedFrom}`와 pg가 돌려준 `{importedFrom, legacySourceId}`의 `JSON.stringify` 순서가 다르다.

같은 plan hash 재실행은 `alreadyApplied`라 0건이다. 그래서 바이트 단위로 같은 계획은 매일 다시 쓰지 않는다. 계획 해시가 바뀌는 실제 변경이 하나라도 있으면 약 36개 무변경 행이 같이 갱신되어 진짜 변경이 가려진다. 결함. 심각도: 높음(데이터 오염은 이 실행에서 일자 값이 한 칸 밀리지는 않았음. desired를 다시 써서 저장 일자는 유지). 확실성: 재현됨.

## 시험

분모 8실행 + 정책 9. 실행 8. 건너뜀 1(정산 있는 재무 페이지 자체를 스냅샷에서 제거하는 경우).

| ID | 내용 | 판정 |
| --- | --- | --- |
| T1 | src 없이 신규 2파일 vitest | PASS (실패가 맞음). 스위트 2 실패, 테스트 0. `notion-sync-diff.js` / `customer-work-os-notion-sync.js` 로드 실패. 단정 불일치가 아님 |
| T2 | src 복원 후 같은 2파일 | PASS. 11 passed, exit 0 |
| T3 | `pnpm --filter @ai-crm/api run typecheck` | PASS. exit 0. Node v24.19.0 (engines는 22) |
| T4 | `pnpm test` | PASS(허용 예외). 739 passed, 1 failed, 52 skipped. 실패는 `apps/worker/test/worker-start.integration.test.ts` SIGTERM 15s timeout만 |
| S1 | scratch 1차 적재 | PASS. inserts 189, updates 0, archives 0, holds 0, settlementInserts 5. DB `ai_crm_verify_sync_20260930` (덤프 복원 후 0024·0025 적용). 종료 후 DROP |
| S2 | 동일 스냅샷 재동기화 | PASS(마커). `alreadyApplied true`, 쓰기 0. 이건 diff를 타지 않는다 |
| S3 | 마커 삭제 후 동일 계획 dry-run | FAIL. 기대 0/0/0/0. 실제 updates 38 |
| S4 | 합성 변경 적용 | FAIL(updates). inserts 1, updates 37, archives 1, holds 1 `AMOUNT_OR_DIRECTION`, settlementInserts 0. 계정 46, 활동 archived 1, settlement_sum 50010400 |
| S5 | 합성 재실행 | PASS. `alreadyApplied true` |
| S6 | 마커 직후 throw `injected` | PASS. 예외 메시지 `injected`, runs 1 유지(롤백) |

## 정책

| 정책 | 판정 | 근거 |
| --- | --- | --- |
| `syncApprovedNotionPlan` 단일 진입 | PASS | 1차·합성·재실행·주입 실패 모두 이 함수 |
| Notion page id로 맞춤 | PASS | id는 `id(kind, workspace, legacySourceId)`. 이 실행에서 추가 1건만 insert, 나머지 id 재사용 |
| 단일 트랜잭션 + plan hash + marker | PASS | S6 롤백. 같은 hash는 S2/S5 |
| 멱등 | FAIL | 마커 멱등은 PASS. 내용 멱등(S3)은 FAIL |
| dry-run diff | PASS | S3가 쓰기 없이 38을 반환. 결과 품질은 FAIL |
| 금액·정산 변경 HELD | PASS | hold 1, settlement_sum 유지, settlementInserts 0 |
| 없는 페이지는 soft-archive만 | PASS | 활동 1 archived, hard delete 경로 없음(`deletes` 항상 빈 배열) |
| 정산 있는 재무는 archive 안 함 | NOT_RUN | 금액 변경 hold는 실행. 정산 행을 스냅샷에서 빼는 실험은 하지 않음. 코드는 `SETTLED_ARCHIVE` hold |
| 0025 additive | PASS | ADD COLUMN / CREATE TABLE·INDEX만. scratch에 적용됨. down 없음은 주석과 일치 |

## 잔여

- 일일 잡 연결, `ai_crm` apply, override, reversal, 읽기 API의 archive 제외: NOT_RUN.
- 출시 보류 사유: S3/S4. 날짜 비교를 타임존에 의존하지 않게 하고, timestamptz·jsonb 키 순서를 정규화한 뒤에 불변 스냅샷 재diff가 0인지 재시험할 것.
- 수정 후 재시험: 아직 없음.
