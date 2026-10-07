# D2 정규화 쓰기 검증 (검증냥)

대상: `whelp99-code/ai-crm-project-manager` `feat/notion-normalized-write` @ `e000237`. 기준 커밋 `409e210`. 독립 클론 `/tmp/aicrm-verify-d2b`. node v24.19.0 (저장소 엔진은 `>=22 <23`). 시각: 2026-09-30. 이 문서는 출시 승인이 아니다.

개발자 보고 `/tmp/d2-reapply-report.json`과 건수·재무·격리·plan/snapshot이 같다. 운영 `ai_crm`는 NOT_RUN.

## 판정

| 단계 | 판정 | 로그 |
|---|---|---|
| 1 클론·설치 | PASS | `git clone` → `e000237`. `pnpm install --frozen-lockfile` exit 0 (엔진 경고만). |
| 2 D2 테스트 전후 | PASS | `e000237` `vitest run test/notion-normalized-write.test.ts` 3 passed, exit 0. `409e210`에 같은 테스트 파일만 복사 후 실행: suite load 실패 `customer-work-os-normalized-write.js` 없음, exit 1. |
| 3 수용 명령·typecheck·전체 테스트 | PASS | 아래 수용 명령과 `pnpm run typecheck` exit 0. `pnpm test`: 728 passed, 52 skipped, 1 failed. 실패는 `apps/worker/test/worker-start.integration.test.ts` SIGTERM 15000ms뿐. `cbf4f3a`부터 알려진 실패. 이 브랜치 수용 조건 아님. |
| 4 코드 리뷰 `409e210..e000237` | PASS | 아래. 잔여: 역마이그레이션 SQL 파일은 없음. |
| 5 dry-run DB | PASS | `ai_crm_dryrun_20260930` @ `127.0.0.1:55433`만. `current_database()` 확인. 운영 `ai_crm` 접속 없음. |

수용 명령 (전부 exit 0, `e000237`):

- `pnpm --filter @ai-crm/api exec vitest run test/notion-normalized-write.test.ts test/notion-apply-same-transaction.test.ts test/notion-apply-commitment-due.test.ts` (8 passed)
- `pnpm --filter @ai-crm/imports exec vitest run test/notion-workspace-id.test.ts`
- `pnpm --filter @ai-crm/domain exec vitest run test/customer-work-os.integration.test.ts`
- `pnpm --filter @ai-crm/reports exec vitest run test/customer-work-os-reports.test.ts`
- `pnpm --filter @ai-crm/persistence exec vitest run test/schema.security.test.ts test/customer-work-os-schema.security.test.ts`

분모: 요청 5단계 모두 실행. NOT_RUN: 운영 DB, PR 머지, 배포, 부하, 0024를 빈 스키마에 새로 적용.

## 코드 리뷰

- 한 트랜잭션: `applyApprovedNotionPlan`의 `participate` 안에서 `writeNormalizedCustomerWorkState` 다음 `markAppliedInTransaction`. `markAppliedInTransaction`은 받은 connection에 UPDATE/INSERT만 하고 `BEGIN`/`COMMIT`을 열지 않음. 별도 `markApplied` 호출 없음.
- 격리: `quarantined[].sourceId`를 `excludeSourceIds`로 넘김. id·sourceRef·`notion://`+sourceId가 맞으면 INSERT를 건너뜀.
- 발명 값 없음: commitment `due_at`에 `item.dueAt`만 넣음. `capturedAt`으로 채우지 않음.
- `0024`는 `source_ref`/`evidence_ref` nullable ADD와 `due_at` DROP NOT NULL만. 기존 행을 지우지 않음. 롤백 경로는 인계 문서의 칼럼 drop과 `due_at` NOT NULL 복구. null 기한이 있으면 NOT NULL 복구는 실패한다. 저장소에 down SQL 파일은 없다.

## Dry-run

Reset: 계획의 14테이블 `TRUNCATE`, workspace `75c2b088-e5aa-5396-9e9e-6dfd77e50048`만 재삽입. 다른 workspace 0. 0001–0023 재적용 없음. `DROP DATABASE` 없음. 0024 칼럼은 이미 있었고 nullable. ADD COLUMN을 다시 실행하지 않음 (비멱등).

스냅샷: `/home/jm/.local/state/omonyang/core5-dryrun/notion-snapshot-20260929T150310Z.json` (`capturedAt` `2026-09-29T15:03:10.519Z`, accounts 45). 적용 코드는 이 클론의 `e000237`.

| 검사 | 기대 | 실제 |
|---|---|---|
| 실패 주입 | snapshot null, plan APPROVED, 9테이블 0 | 일치. throw `injected participate failure` |
| 성공 적용 | 9테이블 45/0/35/61/13/25/2/8/5, APPLIED, version 1 | 일치 |
| commitment `due_at` | 25건 전부 null | `count(due_at)=0`, 도메인 non-null 0 |
| 격리 source가 account 행 | 0 | 0 |
| `applyApprovedNotionPlan` 재호출 2회 | 건수 불변 | `INVALID_STATE` (이미 APPLIED). 건수 불변. version 1 유지 |
| 정규화 재쓰기 | P0001 없이 no-op | `noop-commit`. 건수 불변 |

재무: IN `9714000/971400/10685400`, OUT `87760000/8776000/96536000`. quarantined 39, price ledger 67, orphan 18. 개발자 JSON과 같다.

## 잔여 위험

- 운영 `ai_crm` 건수·0024·쓰기는 NOT_RUN. 0행이 아니면 적용 전 중단이 설계다.
- down SQL이 없어 롤백은 수동이다. null `due_at`이 있으면 NOT NULL 복구가 실패한다.
- `applyApprovedNotionPlan`은 APPLIED plan을 조용히 재실행하지 않고 거절한다. 건수는 안 변한다. settlement 가드 우회 없는 재쓰기는 별도 호출로 확인했다.
- node 24에서 돌렸다. 엔진 범위는 22.

출시 보류 사유는 검증냥이 만들지 않는다. PR 게이트용 증거는 위 PASS다. 운영 적용은 이 판정에 포함되지 않는다.
