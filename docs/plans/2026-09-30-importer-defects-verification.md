# 검증 기록 — IMP-D1 / IMP-D3 / IMP-D4

검증 주체: 검증냥. 개발냥 인계를 증거로 쓰지 않음.
대상: `whelp99-code/ai-crm-project-manager` `409e210` (코드 `ede1ec1`, `5acf611`). 브랜치 `fix/notion-cfo-os-importer`. PR `#13`.
독립 실행: `/tmp/verify-importer-20260930084505` (로컬 클론, `409e210` detached). 제품 코드 미수정. 프로브는 그 클론에만 둠. 시각 2026-09-30. node v24.19.0, pnpm 9.15.0 (엔진 경고: 저장소는 `>=22 <23`).
운영 `ai_crm` 미접속. dry-run은 `ai_crm_dryrun_20260930` @ 127.0.0.1:55433만. `current_database()`로 확인.

판정은 출시 승인이 아니다.

## 시험 계획과 분모

| ID | 검사 | 실행 |
|---|---|---|
| T1 | 부모 커밋에서 신규 테스트 실패 | 실행 2 |
| T2 | `409e210` 수용 명령 7개 | 실행 7 |
| T3 | `pnpm test` (루트 vitest) | 실행 1 |
| T4 | 코드 대조 D1/D3/D4/D2 | 실행 |
| T5 | dry-run reset, 실패 주입, 성공 적용, 재적용 2회, 독립 SQL | 실행 |
| 운영 `ai_crm` 행 수, CI 원격 재실행, D2 구현 | NOT_RUN | 0 |

실행 12 / 계획된 필수 12. 운영·원격 CI는 분모 밖.

## T1 테스트 선행

신규 테스트 파일을 부모 트리에 얹고 실행. 구현은 부모 것.

| 커밋 | 부모 | 명령 | exit | 결과 |
|---|---|---|---|---|
| `ede1ec1` | `261cea4` | `notion-workspace-id.test.ts` | 1 | 3 failed. `resolveNotionWorkspaceId is not a function` |
| `5acf611` | `ede1ec1` | `notion-apply-same-transaction.test.ts` | 1 | 2 failed. `applyApprovedNotionPlan is not a function` |
| `5acf611` | `ede1ec1` | `notion-apply-commitment-due.test.ts` | 1 | 스위트 로드 실패. `@ai-crm/reports`에 `./customer-work-os` export 없음 |

D4 부모 실패는 기한 단정이 아니라 export 부재다. 행동 차이는 코드로 확인: 부모 `dueAt: item.targetDate ?? plan.capturedAt.slice(0, 10)`, `409e210`은 `item.targetDate ?? null`.

## T2 수용 명령 @ `409e210`

| 명령 | exit | 건수 |
|---|---|---|
| `pnpm --filter @ai-crm/imports exec vitest run test/notion-workspace-id.test.ts` | 0 | 3 passed |
| `pnpm --filter @ai-crm/imports test` | 0 | 3 files, 32 passed |
| `pnpm --filter @ai-crm/api exec vitest run test/notion-apply-same-transaction.test.ts` | 0 | 2 passed |
| `pnpm --filter @ai-crm/api exec vitest run test/notion-apply-commitment-due.test.ts` | 0 | 3 passed |
| `pnpm --filter @ai-crm/domain exec vitest run test/customer-work-os.integration.test.ts` | 0 | 5 passed |
| `pnpm --filter @ai-crm/reports exec vitest run test/customer-work-os-reports.test.ts` | 0 | 4 passed |
| `pnpm run typecheck` | 0 | 15 패키지 Done |

## T3 전체 `pnpm test`

exit 1. Test Files 1 failed | 77 passed | 18 skipped (96). Tests 1 failed | 725 passed | 52 skipped (778).

유일 실패: `apps/worker/test/worker-start.integration.test.ts` `honors WORKER_INTERVAL_MS and remains terminable with SIGTERM`. `Test timed out in 15000ms`.

`git diff --stat cbf4f3a 409e210 -- apps/worker` 비어 있음. 이 브랜치가 워커를 바꾸지 않았다. 실패 형태는 계획이 적은 base `cbf4f3a` CI 실패와 같다. base 체크아웃 재실행은 NOT_RUN (트리 동일). 이 수정 결함으로 치지 않음.

## T4 코드 대조

- D1: `resolveNotionWorkspaceId` + `NOTION_CWOS_WORKSPACE_NAMESPACE` (`packages/imports/src/notion-cwos.ts`, 주석으로 URL namespace 고정). `plan()`이 planner 전에 치환하고 `workspaceBinding`을 plan jsonb에 넣음. UUID 입력은 재해시하지 않음. `applyNotionPlanToDomain`은 plan의 id를 다시 치환하지 않음.
- D3: `PgCustomerWorkOsSnapshotStore.compareAndSwap`이 audit UPDATE 다음, `withWorkspace`의 `COMMIT` 전에 `participate`를 호출. throw면 기존 `ROLLBACK`. `applyApprovedNotionPlan`만 마커를 그 콜백에서 갱신. 저장소 안 `markApplied(` 호출자는 메서드 정의뿐.
- 잔여: `/home/jm/.local/state/omonyang/core5-dryrun/dryrun-apply-harness.ts` 198행은 여전히 mutate 후 `markApplied`. 저장소 밖. 이번 재적용은 그 하네스를 쓰지 않음.
- D4: commitment `dueAt`은 `targetDate ?? null`. `expectedDate ?? capturedAt`, `settledAt` 폴백은 계획대로 유지. cockpit/리포트/라우트는 `dueAt != null`일 때만 연체. 도메인 null 정렬은 뒤로. 마이그레이션 없음.
- D2: `ede1ec1^..409e210`에 정규화 INSERT 경로 없음. dry-run 9테이블 0.

## T5 dry-run

Reset: 지정 테이블 `TRUNCATE ... CASCADE`, workspace `75c2b088-...`만 삭제 후 재삽입. 다른 workspace 0. `DROP DATABASE` 안 함. 호출자는 UUID를 미리 바꾸지 않음 (`sourceWorkspaceId` `jm-business-crm`). 진입 `applyApprovedNotionPlan` 1회. 역할 `ai_crm_runtime_api`.

실패 주입 (`participate` throw): snapshot version null, plan `APPROVED`. 이어서 성공 적용: plan `APPLIED`, snapshot version 1.

독립 SQL (`psql`, `current_database = ai_crm_dryrun_20260930`):

| 항목 | 기대 | 관측 |
|---|---|---|
| accounts / engagements / activities / financial | 45 / 35 / 13 / 8 | 같음 (jsonb) |
| quarantined / price ledger / orphan | 39 / 67 / 18 | 같음 (plan reconciliation) |
| parties / commitments / artifacts / settlements / contacts | 61 / 25 / 2 / 5 / 0 | 같음 (적용 payload + jsonb 길이) |
| commitment dueAt null / `2026-09-29` | 25 / 0 | 25 / 0 |
| 정규화 9테이블 | 0 | 0 |
| finance IN net/vat/gross | 9714000 / 971400 / 10685400 | state 합계 같음 |
| finance OUT | 87760000 / 8776000 / 96536000 | state 합계 같음 |
| workspace id | `75c2b088-e5aa-5396-9e9e-6dfd77e50048` | plan·binding 같음 |

재적용: 같은 idempotency key와 새 key 모두 `only the current APPROVED plan can be applied`. version 1, status `APPLIED` 유지. 중복 쓰기 없음. 계획의 "같은 키 replay는 participate를 다시 부르지 않음"은 이 진입점에서는 도달 불가 (이미 APPLIED면 mutate 전에 거절). 건수 멱등은 유지.

## 요구별 판정

| 요구 | 판정 | 근거 |
|---|---|---|
| D1 결정적 UUIDv5, 문서화, plan 치환 | PASS | T1 실패→T2 통과, dry-run 벡터 일치 |
| D3 스냅샷과 마커 한 트랜잭션 | PASS | 코드 순서, 단위 테스트, 실패 주입 후 version null / APPROVED |
| D4 기한 날조 금지 | PASS | null 25, 캡처일 0, 연체 비교 null 제외 |
| D2 미구현, 정규화 0 | PASS (보류 확인) | 쓰기 경로 없음, 9테이블 0. DONE 아님 |
| 수용 명령 | PASS | 7/7 exit 0 |
| 전체 `pnpm test` | FAIL (기존) | 워커 SIGTERM timeout 1건. 이 수정 원인 아님 |
| 하네스 분리 호출 제거 | NOT_RUN (코드 밖 잔여) | 외부 하네스 198행 유지. 제품 진입은 새 함수 |
| 운영 적용 | NOT_RUN | 범위 밖 |

## 잔여 위험

- 외부 dry-run 하네스를 다시 쓰면 마커가 별도 트랜잭션이다. 재적용은 `applyApprovedNotionPlan`만 쓸 것.
- `markApplied` 공개 메서드는 남아 있다. 저장소 내 호출자는 없다.
- 이미 APPLIED인 plan에 같은 키로 다시 들어가면 mutate replay가 아니라 `INVALID_STATE`다. 데이터는 안 늘어난다.
- 재무 `expectedDate ?? capturedAt`, `settledAt` 폴백은 이번 범위 밖.
- D2 정본 미결정. 정규화 `due_at NOT NULL`은 그대로.
- node 24에서 실행. 저장소 엔진은 22.

## 릴리스 판단 자료

D1/D3/D4 수용과 dry-run 건수는 이 클론에서 재현됐다. 출시 승인은 하지 않는다. 워커 CI 적색은 기존과 동일하며 이 이슈의 보류 사유로 쓰지 않는다. 운영 `ai_crm` 적용은 미검증이다.
