# 검증냥 인계 — IMP-D1 / IMP-D3 / IMP-D4

목표: Notion 임포터 결함 1, 3, 4. D2는 구현하지 않음.
브랜치: `fix/notion-cfo-os-importer`. PR `#13`. 이슈 `#12`.
커밋: `ede1ec1` (D1), `5acf611` (D3+D4). push 됨 (`261cea4..5acf611`). merge 안 함.

## 한 일

- D1: `resolveNotionWorkspaceId` + `plan()`이 planner 전에 스냅샷 `workspaceId`를 치환. 벡터 `75c2b088-e5aa-5396-9e9e-6dfd77e50048`. namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, name `jm-business-crm`. UUID 입력은 재해시하지 않음. `workspaceBinding`은 plan jsonb에 저장.
- D3: `applyApprovedNotionPlan`이 `mutate`의 `participate`로 plan `APPLIED`를 같은 `BEGIN` 안에서 갱신. `COMMIT` 전. throw면 기존 `ROLLBACK`. 같은 idempotency key replay는 `participate`를 다시 부르지 않음 (기존 `mutate` 동작, 이번 테스트로 재확인하지 않음).
- D4: `dueAt`은 `targetDate` 또는 `null`. 캡처일을 기한으로 쓰지 않음. cockpit/리포트/라우트 연체 비교는 null을 연체로 세지 않음. 마이그레이션 없음.
- D2: 코드 없음. 정규화 9테이블 쓰기는 그대로.

가정: 기한 없는 commitment는 격리하지 않고 null 25건 유지. 재무 `expectedDate ?? capturedAt`와 `settledAt` 폴백은 안 고침.

## 명령과 종료 코드 (2026-09-29, worktree, node v24.19.0)

| 명령 | exit | 결과 |
|---|---|---|
| `pnpm --filter @ai-crm/imports exec vitest run test/notion-workspace-id.test.ts` | 0 | 3 passed |
| `pnpm --filter @ai-crm/imports test` | 0 | 3 files, 32 passed |
| `pnpm --filter @ai-crm/api exec vitest run test/notion-apply-same-transaction.test.ts` | 0 | 2 passed. 실패 트랜잭션 ROLLBACK 1, COMMIT 0. 성공 트랜잭션 BEGIN 1, 스냅샷 INSERT 후 plan UPDATE, COMMIT |
| `pnpm --filter @ai-crm/api exec vitest run test/notion-apply-commitment-due.test.ts` | 0 | 3 passed |
| `pnpm --filter @ai-crm/domain exec vitest run test/customer-work-os.integration.test.ts` | 0 | 5 passed |
| `pnpm --filter @ai-crm/reports exec vitest run test/customer-work-os-reports.test.ts` | 0 | 4 passed |
| `pnpm run typecheck` | 0 | 재실행 exit 0 (테스트 타입 수정 후) |

수정 전 신규 테스트는 실패했음 (`resolveNotionWorkspaceId` / `applyApprovedNotionPlan` 없음, null due 미구현).

## Dry-run (`ai_crm_dryrun_20260930` @ 127.0.0.1:55433)

접속 문자열 database 이름 확인 후만 씀. 운영 `ai_crm`에는 접속하지 않음. 다른 workspace 행 0. 지정 테이블 `TRUNCATE ... CASCADE` (부모 FK 때문에 CASCADE. CASCADE로 지워진 추가 테이블의 사전 건수는 stat상 0이 아닌 목록에 없었음). `DROP DATABASE` 안 함.

호출자가 UUID를 미리 바꾸지 않음. 진입은 `applyApprovedNotionPlan` 한 번.

실패 주입: participate throw. snapshot version null, plan `APPROVED`.
성공 적용: plan `APPLIED`, snapshot version 1.

| 항목 | 기대 | 관측 |
|---|---|---|
| accounts | 45 | 45 |
| engagements | 35 | 35 |
| activities | 13 | 13 |
| financial items | 8 | 8 |
| quarantined | 39 | 39 |
| price ledger | 67 | 67 |
| orphan relations | 18 | 18 |
| parties | 61 | 61 |
| commitments | 25 | 25, dueAt null 25, `2026-09-29` 0 |
| artifacts | 2 | 2 |
| settlements | 5 | 5 |
| contacts | 0 | 0 |
| 정규화 9테이블 | 0 | 0 |
| finance inbound net/vat/gross | 9714000 / 971400 / 10685400 | 같음 (state와 plan reconciliation) |
| finance outbound | 87760000 / 8776000 / 96536000 | 같음 |
| workspace id | 75c2b088-e5aa-5396-9e9e-6dfd77e50048 | 같음. sourceWorkspaceKey `jm-business-crm` |

## 확인하지 않음

- 이 구현자의 재실행을 독립 검증으로 치지 말 것.
- worker `worker-start.integration.test.ts` SIGTERM timeout은 안 고쳤고 안 돌림.
- 같은 idempotency key replay가 participate를 건너뛰는 경로는 코드상 기존 `mutate` early return. 단위 테스트 없음.
- 두 번째 새 키 적용의 version +1은 범위 밖이라 재확인하지 않음.
- D2 정본 선택, 운영 `ai_crm` 행 수, CI 전체는 NOT_RUN.
- 커밋 훅 `engineering-map docs:sync`가 rc=1. 커밋과 push는 됨. 원인 미조사.

상태: 구현과 위 명령은 이 역할이 확인. DONE은 검증냥 기록 전 아님.
