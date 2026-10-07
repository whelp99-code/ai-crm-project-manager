# 2026-09-30 Notion 임포터 결함 수정 계획

상태: 설계 완료. 구현 아님. 커밋하지 않음.
대상: worktree `/home/jm/orca/workspaces/ai-crm/notion-import-fix`, 브랜치 `fix/notion-cfo-os-importer`, HEAD `261cea4`, PR `whelp99-code/ai-crm-project-manager#13`, base `core5-c01-c02` (`cbf4f3a`). 이슈 `#12`.
추적: GitHub issue `#12`에 이 계획의 작업 ID만 남긴다. 다른 보드에 복제하지 않는다. 이 문서는 로컬 계획이며 공개 이슈에 붙이지 않는다.

근거 (읽음):

- 이슈 `#12` dry-run 코멘트 (2026-09-30).
- `/home/jm/.local/state/omonyang/core5-dryrun/dryrun-report-20260930.json`
- `/home/jm/.local/state/omonyang/core5-dryrun/dryrun-apply-harness.ts`
- 스냅샷 건수와 planner 재실행 (고객 원문은 이 문서에 없음).
- 코드 경로 아래. 보지 않은 모듈은 전수 조사하지 않았다.

범위: 결함 1, 3, 4만 개발냥. 결함 2는 구현 보류.

가정 (소유자 재결정 없이 진행):

- 파일럿 workspace 바인딩은 dry-run이 이미 쓴 벡터로 고정한다. namespace나 name을 바꾸면 UUID가 갈라지고 재적용 대조가 깨진다.
- 기한 없는 commitment는 격리하지 않고 `dueAt: null`로 둔다. 건수 25를 유지한다. 격리면 건수가 바뀌므로 그 선택은 하지 않는다.
- `expectedDate ?? capturedAt` (재무)와 `settledAt` 폴백은 이번 결함 4가 아니다. planner가 기대일 없는 미정산 행을 이미 quarantine 한다. 개발냥이 같이 고치지 않는다.

## 현행

제품 적용 경로는 HTTP가 없다. dry-run 하네스가 두 호출을 잇는다.

1. `CustomerWorkOsRuntimeManager.mutate` → `applyNotionPlanToDomain` → `PgCustomerWorkOsSnapshotStore.compareAndSwap` (자기 `BEGIN/COMMIT`).
2. 그 다음 `CustomerWorkOsNotionService.markApplied` → `PgNotionPlanStore.compareAndSwap` (다른 `BEGIN/COMMIT`).

정규화 테이블을 쓰는 호출자는 저장소에 없다. `applyNotionPlanToDomain`은 메모리 도메인만 채우고, 그게 `cwos_runtime_snapshots.state` jsonb로 남는다.

| ID | 상태 | 위치 |
|---|---|---|
| D1 workspace UUID | 미구현. 하네스가 즉석 치환 | `CustomerWorkOsNotionService.plan`이 `snapshot.workspaceId`를 그대로 `cwos_notion_import_plans.workspace_id`(uuid)에 넣음. 스냅샷 값은 UUID가 아님 (길이 15). PG `22P02`. |
| D2 정규화 쓰기 | 미구현. 소유자 미결정 | `applyNotionPlanToDomain` 호출자는 하네스뿐. jsonb→`cwos_*` 투영 코드 없음. |
| D3 markApplied 원자성 | 부분. 도메인 mutate는 한 트랜잭션. 마커는 밖 | `markApplied` 267행, 하네스 198행 근처. |
| D4 기한 날조 | 미구현 | `applyNotionPlanToDomain` 361행 `dueAt: item.targetDate ?? plan.capturedAt.slice(0, 10)`. planner 재실행: commitment가 될 engagement 25건 모두 `targetDate` 없음. 25건 전부 캡처일 `2026-09-29`가 기한이 된다. |

## 결함 1 — 결정적 UUIDv5

작업 ID: `IMP-D1`. 선행 없음.

고정 벡터 (dry-run `workspaceBinding`과 같음. 바꾸지 말 것):

- algorithm: RFC 4122 UUIDv5 (SHA-1)
- namespace: `6ba7b811-9dad-11d1-80b4-00c04fd430c8` (RFC 4122 NAMESPACE_URL)
- name: 스냅샷의 비-UUID `workspaceId` 문자열. 이번 스냅샷은 dry-run name `jm-business-crm`과 일치 (`sourceMatchesName: true`)
- 기대 UUID: `75c2b088-e5aa-5396-9e9e-6dfd77e50048`

바꿀 곳:

- 새 함수 `resolveNotionWorkspaceId`를 `packages/imports/src/notion-cwos.ts`에 두고 `packages/imports/src/index.ts`의 기존 `export * from "./notion-cwos.js"`로 내보낸다.
- 상수 `NOTION_CWOS_WORKSPACE_NAMESPACE`를 같은 파일에 둔다. 새 npm 의존성 금지. `node:crypto` SHA-1로 RFC 4122 버전/variant 비트를 구현한다.
- 동작: 입력이 UUID면 그대로 반환 (`rewritten: false`). 아니면 `uuidv5(namespace, trim(name))` (`rewritten: true`). 빈 문자열은 기존 `INVALID_SNAPSHOT`.
- 역원: UUIDv5는 이름 복원이 안 된다. 역추적은 저장으로 한다. `CustomerWorkOsNotionService.plan` (`apps/api/src/customer-work-os-notion.ts`)이 planner 호출 **전**에 스냅샷 `workspaceId`를 치환하고, plan 레코드에 `workspaceBinding: { algorithm: "uuidv5", namespace, sourceWorkspaceKey, workspaceId }`를 남긴다. 이미 UUID인 입력은 `sourceWorkspaceKey`를 그 UUID로 둔다.
- 치환은 planner 앞이어야 한다. 중첩 행의 `workspaceId`와 plan hash가 dry-run(치환 후 plan)과 같아야 한다.
- 적용 경로 `applyNotionPlanToDomain`은 plan에 들어 있는 UUID를 그대로 쓴다. 두 번째 치환 금지.

테스트 추가: `packages/imports/test/notion-workspace-id.test.ts`

- 위 벡터와 바이트 일치.
- 같은 name 두 번 = 같은 UUID. 다른 name ≠.
- UUID 입력은 통과이며 벡터 UUID와 달라야 한다 (재해시 금지).

수용:

```bash
cd /home/jm/orca/workspaces/ai-crm/notion-import-fix
pnpm --filter @ai-crm/imports exec vitest run test/notion-workspace-id.test.ts
pnpm --filter @ai-crm/imports test
```

롤백: 함수와 `plan()` 치환만 되돌린다. 스키마 변경 없음. 이미 쓴 dry-run 행의 UUID는 이 벡터와 같으므로 롤백해도 그 행 키는 바뀌지 않는다.

위험: namespace 상수를 나중에 바꾸면 전 작업공간이 새 UUID가 된다. 상수 변경은 이 이슈 범위 밖.

## 결함 3 — markApplied를 같은 트랜잭션으로

작업 ID: `IMP-D3`. 선행: 없음 (D1과 파일은 겹친다. 같은 파일은 한 개발냥이 직렬로).

원인: `PgNotionPlanStore.compareAndSwap`과 `PgCustomerWorkOsSnapshotStore.compareAndSwap`이 각각 `withWorkspace`에서 `BEGIN/COMMIT` 한다 (`customer-work-os-notion.ts` 88행, `customer-work-os-runtime.ts` 273행 근처). `mutate` (518행)는 스냅샷 CAS만 호출한다. `markApplied` (267행)는 그 다음 별도 호출이다. 적용 후 마커 실패 시 plan은 `APPROVED`로 남고, 재적용은 `isImportPlanApplied`가 막는다. 실패 주입은 이 저장소 테스트에 없다.

설계:

- `PgCustomerWorkOsSnapshotStore.compareAndSwap`에 선택 인자 `participate?(connection): Promise<void>`를 추가한다. 스냅샷 INSERT/UPDATE와 audit INSERT가 끝난 뒤, `COMMIT` 전에 호출한다. throw면 기존 `ROLLBACK`.
- `CustomerWorkOsRuntimeManager.mutate`가 그 인자를 store까지 전달한다. `InMemoryCustomerWorkOsSnapshotStore.compareAndSwap`도 같은 시점에 `participate`를 호출한다 (연결 없음. 실패 시 메모리 행을 쓰지 않은 상태로 둔다).
- 새 조정 함수 `applyApprovedNotionPlan`을 `apps/api/src/customer-work-os-notion.ts`에 둔다. 이것이 유일한 적용 진입점이다.
  1. plan이 현재 `APPROVED`이고 version이 일치해야 한다. 아니면 기존 `INVALID_STATE`.
  2. `manager.mutate({ operationId: "NOTION_IMPORT_APPLY", idempotencyKey, requestHash: planHash, operation: service => applyNotionPlanToDomain(...), participate })`.
  3. `participate`는 `PgNotionPlanStore`의 연결 한정 CAS로 status를 `APPLIED`로 올린다. 이미 `APPLIED`면 no-op (0행을 동시성 오류로 보지 않음). `APPROVED`가 아니면 throw → 스냅샷과 마커 모두 롤백.
  4. 연결 한정 CAS는 `BEGIN`을 다시 열지 않는다. 기존 `compareAndSwap`은 그 함수를 자기 `withWorkspace` 안에서 재사용해도 된다.
- 하네스 순서 (mutate 후 markApplied)는 금지. 재적용 절차는 `applyApprovedNotionPlan`만 호출한다.
- 멱등: 같은 idempotency key는 `mutate`가 replay하고 `participate`를 다시 부르지 않는다. plan은 이미 `APPLIED`. 새 키로 두 번째 적용은 기존처럼 `alreadyApplied: true`와 스냅샷 version +1이 날 수 있다. 그 쓰기와 마커 no-op은 같은 트랜잭션이어야 한다. version +1 자체는 이번 범위에서 없애지 않는다.

테스트 추가: `apps/api/test/notion-apply-same-transaction.test.ts`

- 스크립트 connection: 스냅샷 쓰기 성공 후 `participate`가 throw. 기대: `ROLLBACK` 1회, `COMMIT` 0, plan status ≠ `APPLIED`, 스냅샷 행 없음, 메모리 도메인 건수 0.
- 성공 경로: 한 `BEGIN` 안에서 스냅샷과 plan UPDATE가 모두 있고 그 다음 `COMMIT`. plan `APPLIED`.
- 라이브 PG 없으면 이 단위 테스트만으로 D3 수용. dry-run 재주입은 아래 절차의 추가 증거이지 CI 게이트가 아니다.

수용:

```bash
cd /home/jm/orca/workspaces/ai-crm/notion-import-fix
pnpm --filter @ai-crm/api exec vitest run test/notion-apply-same-transaction.test.ts
```

롤백: `participate` 인자와 `applyApprovedNotionPlan` 제거. 스키마 변경 없음. 이미 `APPLIED`인 dry-run 행은 코드 롤백만으로 `APPROVED`로 돌아가지 않는다. 상태 되돌리기는 dry-run reset으로만.

위험: `participate`를 `COMMIT` 뒤에 호출하면 결함이 남는다. 리뷰 포인트는 호출 순서뿐이다.

## 결함 4 — 기한을 만들지 않음

작업 ID: `IMP-D4`. 선행: 없음. D3과 같은 함수를 고치므로 한 패치로 묶어도 된다.

바꿀 곳:

- `applyNotionPlanToDomain` 361행. `dueAt`은 `item.targetDate`가 있을 때만 그 값. 없으면 `null`. `plan.capturedAt`을 기한으로 쓰지 않는다.
- `packages/domain/src/customer-work-os.ts` `Commitment.dueAt`을 `string | null`로. `addCommitment` (667행)는 null을 허용하고 빈 문자열은 거부한다.
- 정렬 1183행: null은 뒤로.
- `apps/api/src/customer-work-os-routes-durable.ts` 406행 `overdueCommitmentCount`: `dueAt == null`이면 연체 아님. `null < string` 비교 금지.
- `packages/reports/src/customer-work-os-reports.ts` `buildOwnerCockpit` 연체 필터 (206행, 212행 근처): null은 연체 아님. `dayStart(null)` 호출 금지.
- `packages/ai-orchestrator/src/customer-work-os-ai.ts`의 commitment `dueAt: string`이 이 상태를 읽으면 `string | null`로 맞춘다. 읽기 전용. 프롬프트 문구는 바꾸지 않는다.

스키마: 제품 경로는 jsonb다. `cwos_commitments.due_at timestamptz NOT NULL` (migration `0012` 127행)은 이번 쓰기가 닿지 않는다. D4만으로 마이그레이션하지 않는다. D2를 나중에 열면 그 칼럼을 NULL 허용으로 바꾸는 마이그레이션이 선행이다. 지금은 하지 않는다.

UI: `apps/web/app/page.tsx` 7행, 97행은 `dueAt: string`이며 CRM next action 목이지 CWOS commitment 저장이 아니다. 이번 PR에서 화면을 바꾸지 않는다. 나중에 CWOS 기한을 그 화면에 붙이면 null을 "기한 없음"으로 보여야 한다. 연체로 세지 말 것.

건수: commitment 25 유지. 바뀌는 것은 값뿐이다. 25건 모두 `dueAt === null`. 캡처일 `2026-09-29`와 같으면 실패.

테스트 추가: `apps/api/test/notion-apply-commitment-due.test.ts`

- `targetDate` 없는 engagement `nextAction` → commitment `dueAt === null`. 개수는 nextAction이 있고 종결 stage가 아닌 engagement 수.
- `targetDate`가 있으면 그 날짜만.
- 도메인/리포트: null commitment는 cockpit 연체 0.

수용:

```bash
cd /home/jm/orca/workspaces/ai-crm/notion-import-fix
pnpm --filter @ai-crm/api exec vitest run test/notion-apply-commitment-due.test.ts
pnpm --filter @ai-crm/domain exec vitest run test/customer-work-os.integration.test.ts
pnpm --filter @ai-crm/reports exec vitest run test/customer-work-os-reports.test.ts
pnpm run typecheck
```

롤백: 위 타입과 361행만 되돌린다. DB 마이그레이션 없음.

위험: 연체 비교를 한 곳만 고치면 다른 독자가 `dueAt`을 문자열로 단정한다. 개발냥은 `dueAt` 참조를 위 네 파일에서 고치고, 다른 패키지를 전수 수정했다고 말하지 않는다.

## 결함 2 — 설계만. 구현 보류: 소유자 결정 대기

작업 ID: `DES-D2`. 개발냥 범위 밖. 코드를 만들지 않는다. 마이그레이션을 추가하지 않는다.

미결정: 정본이 정규화 테이블인가, `cwos_runtime_snapshots.state`인가. 설계 권고는 정규화 테이블이다. 권고는 결정이 아니다. 소유자가 고르기 전에는 쓰지 않는다.

정규화 쓰기가 건드리는 것 (dry-run 투영 목록과 스키마):

- `cwos_accounts`, `cwos_contacts`, `cwos_engagements`, `cwos_engagement_parties`, `cwos_activities`, `cwos_commitments`, `cwos_artifacts`, `cwos_financial_items`, `cwos_settlements`
- 행 수는 적용 결과와 같아야 한다: accounts 45, contacts 0, engagements 35, parties 61, activities 13, commitments 25, artifacts 2, financial 8, settlements 5.
- 빠지는 필드 (dry-run `droppedFields`): `Account.sourceRef`, `FinancialItem.evidenceRef`. 정본을 정규화로 정하면 이 둘을 넣을 칼럼 추가가 선행이다. 없으면 출처가 jsonb에만 남는다.
- `cwos_commitments.due_at`은 NOT NULL. D4의 null을 넣으려면 NULL 허용 마이그레이션이 선행이다.
- 재실행: `ON CONFLICT DO NOTHING`은 settlement 가드가 충돌 판정보다 먼저 실행되어 `P0001 settlement allocation outside 0..gross range` ×5, 전체 ROLLBACK (테이블 건수 불변). 정본 쓰기 함수는 그 가드를 우회하지 말고, 이미 있는 settlement면 삽입 자체를 건너뛰는 분기여야 한다.

이전/롤백 (결정 후에만):

- 추가 칼럼은 nullable. 기존 0행 운영 테이블 기준 backward compatible. 이 서버의 운영 `ai_crm` live 행은 이 계획에서 재조회하지 않았다. 적용 전 검증냥이 대상 DB의 `cwos_%` 건수가 0인지 확인한다. 0이 아니면 중단.
- 롤백: 해당 `workspace_id`의 위 9테이블만 DELETE. 스냅샷 jsonb는 남긴다. 역순 마이그레이션은 칼럼 drop뿐. 데이터 삭제는 소유자 승인 범위다.
- 백업 검증: dry-run DB에서만. 운영 `ai_crm`에 접속하지 않는다.

시험 (결정 후): 한 트랜잭션, RLS `ai_crm_runtime_api`, 제약 위반 0, 건수 위와 일치, 재실행이 P0001 없이 no-op, 실패 주입 시 9테이블 건수 불변.

## 개발 순서와 의존

1. `IMP-D1` + `IMP-D4` + `IMP-D3`을 한 작업 줄로. 같은 파일 `customer-work-os-notion.ts`.
2. 단위 테스트 녹색 후 dry-run 재적용 (검증냥).
3. `DES-D2`는 소유자 결정 전 시작 금지.

진입 조건 (재적용):

- 위 수용 명령 exit 0.
- `pnpm --filter @ai-crm/worker test` 는 게이트가 아니다. 아래 CI 참고.
- 대상 DB 이름이 `ai_crm_dryrun_20260930`인지 접속 문자열로 확인. `ai_crm`이면 중단.

## Dry-run 재적용 (`ai_crm_dryrun_20260930`만)

포트 55433 컨테이너. DB 목록 조회로 이름 확인은 허용. 운영 `ai_crm`에는 접속·쓰기 금지.

Reset (이 DB만):

1. 접속 문자열의 database 이름이 `ai_crm_dryrun_20260930`이 아니면 중단.
2. `TRUNCATE` `cwos_runtime_snapshots`, `cwos_runtime_events`, `cwos_runtime_audit_heads`, `cwos_notion_import_plans`, `cwos_notion_import_plan_events`, 그리고 결함 2 목록의 9테이블. dry-run 투영 하네스가 정규화 테이블에 COMMIT 해 둔 행이 있다. 지우지 않으면 "정규화 0행" 단정이 거짓이 된다.
3. `workspaces`에서 id `75c2b088-e5aa-5396-9e9e-6dfd77e50048`만 삭제 후 재삽입해도 된다. 다른 workspace 행이 있으면 보고하고 건드리지 않는다.
4. 마이그레이션 0001–0023은 이미 적용됨. reset 때 다시 적용하지 않는다. `DROP DATABASE`는 하지 않는다 (재마이그레이션과 역할 변경 위험이 있다).

재적용:

- 역할 `ai_crm_runtime_api`, `app.workspace_id` = 벡터 UUID.
- 원본 스냅샷을 넣는다. 호출자가 UUID를 미리 치환하지 않는다. 임포터가 치환한다.
- 진입은 `applyApprovedNotionPlan` 한 번. mutate와 markApplied를 나누지 않는다.
- 실패 주입 1회: participate 또는 plan UPDATE에서 throw. 기대: 스냅샷 version null, plan ≠ APPLIED, 도메인 건수 0. 그 다음 성공 적용 1회.

기대 건수 (스냅샷 jsonb / plan reconciliation):

- accounts 45, engagements 35, activities 13, financial items 8
- quarantined 39, price ledger (`reconciliation.outOfScope.priceLedger`) 67, orphan relations 18
- 부가 (이슈 코멘트와 동일, 이번 수정이 바꾸면 안 됨): parties 61, commitments 25, artifacts 2, settlements 5, contacts 0
- 정규화 9테이블: 0. D2를 구현하지 않았으므로. 0이 아니면 실패.
- commitment 25건의 `dueAt`은 전부 null. 하나라도 `2026-09-29`면 D4 실패.
- `workspaces.id`와 plan `workspace_id`는 `75c2b088-e5aa-5396-9e9e-6dfd77e50048`.
- 적용 성공 응답의 plan status는 `APPLIED`. 스냅샷 행과 plan 행이 둘 다 있거나 둘 다 없다.

재무 합계 (planner 재실행, 2026-09-30): inbound net/vat/gross `9714000` / `971400` / `10685400`, outbound `87760000` / `8776000` / `96536000`. 적용 state와 plan reconciliation이 같아야 한다.

## 완료 기준 연결

| 요구 | 작업 | 구현 대상 | 테스트 | 완료 증거 |
|---|---|---|---|---|
| D1 | IMP-D1 | `resolveNotionWorkspaceId`, `plan()` 치환 | `notion-workspace-id.test.ts` | 명령 exit 0 + 벡터 UUID |
| D3 | IMP-D3 | `applyApprovedNotionPlan`, `participate` | `notion-apply-same-transaction.test.ts` | ROLLBACK 단정 |
| D4 | IMP-D4 | 361행, `Commitment.dueAt`, cockpit/reports | `notion-apply-commitment-due.test.ts` | null 25, 연체 미포함 |
| D2 | DES-D2 | 없음 | 없음 | 구현 보류. DONE 아님 |

DONE은 위 명령과 dry-run 재적용 건수를 검증냥이 기록한 뒤에만. 이 계획 문서는 DONE이 아니다.

## CI — 고치지 말 것

`apps/worker/test/worker-start.integration.test.ts`의 `honors WORKER_INTERVAL_MS and remains terminable with SIGTERM`은 15000ms timeout이다.

- PR head run `36588295138` (2026-09-29)에서 실패.
- base `cbf4f3a` run `35927532031` (2026-09-23) 같은 테스트 실패.

이 이슈의 수정으로 그 테스트를 바꾸지 않는다. 녹색 CI를 이 작업의 수용 조건에 넣지 않는다.

## 인계

개발냥: IMP-D1, IMP-D3, IMP-D4만. 수용 명령은 각 절. 운영 DB 접속 금지. 커밋은 오모냥 지시 전엔 하지 않는다.
검증냥: 단위 명령 후 dry-run reset·재적용·실패 주입. D2 테이블이 0인지 확인. worker CI 실패를 이 수정 실패로 적지 않는다.
소유자 (오모냥 경유): D2 정본 선택. 그 전까지 DES-D2는 보류. D1 벡터 변경, 운영 적용, dry-run `DROP DATABASE`는 승인 없으면 하지 않는다.
