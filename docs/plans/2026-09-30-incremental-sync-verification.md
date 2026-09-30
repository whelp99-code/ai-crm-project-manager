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

## 재검증 2026-09-30 — `8b26ff9`

독립 클론 `/tmp/ai-crm-verify-8b26`, HEAD `8b26ff955efebb4e0ddcdda49c6f3106b4ad327b`. `ai_crm` 미접속. Notion 미호출. 검증냥은 출시를 승인하지 않는다. 이전 FAIL(S3/S4)의 재시험이다.

| 단계 | 판정 | 증거 |
| --- | --- | --- |
| 1. 신규 테스트가 수정 전 src에서 실패하고 `8b26ff9`에서 통과. typecheck. `pnpm test` | PASS | `0259d06` src + `8b26ff9` 테스트, `TZ=Asia/Seoul`: imports 2 failed (occurred_at, metadata 키 순서, assertion), api 3 failed (updates 4와 3, `start_date::text` 없음). `8b26ff9`: imports 10 passed, api 7 passed, exit 0. `pnpm --filter @ai-crm/api run typecheck` exit 0. `pnpm test` exit 1: 745 passed, 1 failed, 52 skipped. 실패는 `worker-start.integration.test.ts` SIGTERM 15s timeout만. Node v24.19.0 |
| 2. DB냥 diff 검토 | PASS | 읽기 SQL이 `start_date::text`, `target_date::text`, `expected_date::text`. pg 기본 DATE 파서는 Date이며 Asia/Seoul에서 `2025-12-01`의 `toISOString()`은 `2025-11-30T15:00:00.000Z`. 실제 비교 경로는 캐스트 문자열이라 `rowToLive`가 `2025-12-01` / `2025-12-31` / `2026-01-01`을 TZ=Asia/Seoul과 TZ=UTC 모두에서 반환. 타임스탬프는 날짜 문자열과 ISO를 같은 UTC 자정으로 정규화. JSON은 중첩 키 정렬. 값 변경은 불일치로 남음. 금액 컬럼은 `bigint`, node-pg는 무스케일 문자열(`7314000`). 비교는 정수 파싱이 아니라 그 문자열 동등. `1000.00`은 불일치로 남으며, 이 스키마에서는 스케일 문자열이 나오지 않음. `changedFields`는 desired에 없는 키를 건너뛰나, 계획 빌더는 UPDATABLE 키를 모두 넣음. 0025는 ADD COLUMN / CREATE TABLE·INDEX·POLICY·GRANT와 artifact guard 함수 교체. DROP COLUMN·데이터 삭제 없음. 0024의 `due_at` NOT NULL 해제는 0025가 아님 |
| 3. scratch 양쪽 TZ | PASS | 덤프 `ai_crm-before-cutover-20260930T1037.dump` + 0024 + 0025. DB `ai_crm_verify_recheck_20260930`(Seoul), `ai_crm_verify_recheck_utc_20260930`(UTC). 스냅샷 `notion-snapshot-20260930T021058Z.json`. 둘 다 1차 189/0/0/0 settlementInserts 5, hash만 변경한 재동기화 0/0/0/0, engagement max(version)=1 bumped 0, 합성 1/1/1/1 hold `AMOUNT_OR_DIRECTION`, 재실행 alreadyApplied, 주입 `injected` 후 runs 3 유지, settlement_sum 50010400. Seoul 적용 후 engagement version>1은 1건, artifact/account version>1은 0. 일자 가장자리: 트랜잭션 후 ROLLBACK. `2025-12-01`·`2025-12-31`·`2026-01-01`이 양쪽 TZ에서 달력일 유지. probe 잔존 0. 두 DB DROP 확인 |
| 4. 문서만 커밋·푸시 | PASS | `9813ea1` docs only, `feat/notion-incremental-sync`. 제품 코드 변경 없음 |

잔여 NOT_RUN: 일일 잡, `ai_crm` apply, override, reversal, 읽기 API archive 제외, 정산 행을 스냅샷에서 제거, 앱 런타임 역할(이번 scratch는 superuser라 RLS 우회). 출시 승인은 하지 않음. 이전 S3/S4 결함은 이 커밋에서 재현되지 않았다.
