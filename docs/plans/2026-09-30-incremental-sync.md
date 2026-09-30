# 2026-09-30 Notion → core5 증분 동기화

상태: S1–S2 구현이 이 브랜치에 있다. `ai_crm` apply(S3)는 하지 않았다. 이 문서는 승인이 아니다.
대상: `whelp99-code/ai-crm-project-manager` `64d38ea` (`origin/core5-c01-c02`). 이 worktree는 그 커밋의 detached HEAD. 로컬 `core5-c01-c02` checkout(`/home/jm/orca/projects/AI-CRM+PM`, `cbf4f3a`)은 움직이지 않았다.
근거(읽음): `apps/api/src/customer-work-os-notion.ts` `applyApprovedNotionPlan` / `applyNotionPlanToDomain`, `apps/api/src/customer-work-os-normalized-write.ts` (`ON CONFLICT (id) DO NOTHING`, settlement은 `NOT EXISTS`), `packages/imports/src/notion-cwos.ts` `id()`, `packages/domain/src/customer-work-os.ts` `ensureNew`·`recordSettlement`(reversal), `0024_cwos_normalized_import_columns.sql` (`cwos_accounts.source_ref`만). 일일 리포트 `report-20260930.md` (report-only, 재적용 `DUPLICATE_ID`). 런북 `CUTOVER-RUNBOOK-20261001.md`는 1회 적재다. 격리 계획 `docs/plans/2026-09-30-quarantine-overrides.md`는 `64d38ea`에 없다. `notion-import-fix` worktree의 미추적 파일이다. 본 모듈 밖(RLS, 리포트 SQL, 앱 쓰기 라우트 전수)은 조사하지 않았다.
추적: GitHub Issues 한 건. `~/ops/github-development-management/WORKFLOW.md`. 다른 보드에 복제하지 않는다. 이슈는 아직 없다. 공개 이슈 본문에 로컬 경로·고객명·금액을 넣지 않는다.

## 현행

코드 있음, 증분 없음.

- `applyApprovedNotionPlan`은 APPROVED plan을 도메인에 처음 넣는다. `ensureNew`가 같은 id면 `DUPLICATE_ID`. 정규화 쓰기는 충돌 행을 건너뛴다. 변경·삭제는 반영되지 않는다.
- 정산은 insert-if-absent. 금액·일자를 고치는 경로가 없다. 도메인 정산 수정 API는 없고, 상쇄는 `reversalOfSettlementId` 추가뿐 (`recordSettlement`).
- 식별: `id(prefix, workspaceId, source) = prefix + "-" + notionCwosHash({workspaceId, source}).slice(-8)`. source는 Notion page id. 계정만 `source_ref`에 page id가 남는다. engagement 이하에는 page id 컬럼이 없다. 이름 매칭은 쓰지 않는다.
- 일일 잡(`core5-notion-daily-sync`)은 덤프 후 차이 보고만 한다. Notion에는 쓰지 않는다. 병렬 구간 마스터는 Notion이다.
- 같은 plan hash 재적용은 마커가 같은 트랜잭션에 있을 때만 안전하다 (교훈 2026-09-30). 증분도 그 계약을 깨지 않는다.

## 목표 상태

스냅샷 하나의 desired state를 계산하고, 라이브 행과 비교한 diff를 한 트랜잭션에 반영한다. `applyApprovedNotionPlan`은 1회 적재로 남긴다. 증분은 새 연산 `syncApprovedNotionPlan`이다. 첫 적재를 이 함수로 바꾸지 않는다.

## 식별

- 안정 키: Notion page id. 워크스페이스 id와 함께 `id()`에 넣는다. 기존 행 매칭은 재계산한 id다. 이름·project_key로 묶지 않는다.
- 8 hex는 32비트다. 유일 제약의 본키로 쓰지 않는다. 마이그레이션 `0025_cwos_notion_sync.sql` (0025가 있으면 그 다음, 없으면 0024 다음)에 테이블마다 `notion_page_id text` + `UNIQUE (workspace_id, notion_page_id)` WHERE `notion_page_id IS NOT NULL`. 기존 적재 행은 백필: 계정은 `source_ref`, 나머지는 계획 레코드의 source→id 맵으로만. 맵에 없는 행은 백필하지 않고 sync 대상에서 뺀다 (core5 전용 행).
- 자식 id도 같다. 활동·재무·정산·산출물·commitment·party는 planner가 이미 만든 id를 유지한다. 정산 id는 `settlement-` + `notionCwosHash(financialItemId)` 끝 8자 (`applyNotionPlanToDomain`). 이 식을 바꾸면 기존 정산이 신규로 보인다. 바꾸지 않는다.
- 한 page id가 두 엔티티 종류로 나오지 않는다. 종류가 바뀌면 업데이트하지 않고 hold.

## 마지막 기록자

병렬 구간 Notion이 마스터다. sync가 쓰는 필드는 Notion 값이 이긴다. 단, 아래 «멈추는 필드»는 자동으로 덮지 않는다.

core5에서 그 행을 고쳤는지는 `notion_page_id`가 있는 행의 `version`이 마지막 sync가 기록한 version보다 크면으로 본다. 크면 그 엔티티는 hold(아래 격리와 별도 사유 `CORE5_DRIFT`)이고 덮지 않는다. 권장: 최종 전환 전까지 소유자 화면은 읽기 전용. 쓰기를 막는 코드는 이 계획의 선행이 아니다. 운영으로 막는다. drift가 0이 아니면 `ai_crm` apply 단계로 가지 않는다.

## 연산 (엔티티)

공통: insert / update / archive. hard delete 없음. archive는 `archived_at timestamptz` (0025_cwos_notion_sync). 읽기 API는 기본으로 archive를 빼되, 재무 합계는 archive여도 정산이 살아 있으면 빼지 않는다 (돈은 행이 남아 있는 동안 합에 남는다).

desired state는 override를 적용한 뒤의 plan이다 (아래 격리 절).

| 엔티티 | insert | update 필드 | archive (스냅샷에 page id 없음) |
|---|---|---|---|
| accounts | 신규 page id | name, normalized_name, kinds, status, source_ref | `status=inactive` + `archived_at`. 행 유지 |
| engagements | 신규 | name, project_key, type, stage, start_date, target_date. stage/type이 CHECK 밖이면 update 하지 않고 hold | `archived_at`. 자식은 따라 지우지 않음 |
| parties | 신규 | role, is_primary, commercial_responsibility, delivery_responsibility | `archived_at` |
| activities | 신규 | type, occurred_at, summary, decision, engagement_id, account_id | `archived_at`. evidence 행은 유지 |
| commitments | 신규 | description, due_at, priority, financial_impact. status는 Notion에 대응 값이 있고 core5가 DONE+evidence가 아닐 때만 | `status=CANCELLED` + `archived_at`. DONE+evidence면 hold |
| artifacts | 신규 | title, status, storage_uri, metadata | `status=SUPERSEDED` + `archived_at`. storage 파일은 삭제하지 않음 |
| financial items | 신규. 계정이 없으면 지금처럼 실패가 아니라 hold | 정산이 없으면 net/vat/gross, expected_date, lifecycle, category, engagement_id, account_id. 정산이 있으면 금액·방향·계정은 멈추는 필드 | 미정산만 `lifecycle=CANCELLED` + `archived_at`. 정산이 있으면 archive 하지 않고 hold |
| settlements | Notion lifecycle이 SETTLED이고 그 financial item에 미상쇄 정산이 없을 때만 insert. 금액은 gross, 일자는 actualDate, 없으면 expectedDate. 둘 다 없으면 insert 하지 않고 hold (capturedAt으로 만들지 않음) | 없음. in-place 수정 금지 | 없음. 행을 archive/delete 하지 않음 |

멈추는 필드 (자동 반영 안 함, sync quarantine에 사유와 page id만):

- 정산이 있는 재무의 금액·방향·계정 변경.
- Notion에서 SETTLED가 풀리거나 정산 금액이 줄어야 하는 경우. 도메인 reversal을 **제안**만 한다. 자동 `recordSettlement` 하지 않는다.
- commitment DONE+evidence.
- `CORE5_DRIFT`.
- page id는 있는데 이번 plan에서 격리된 행 (다음 절).

정산 정책 (제안, 돈에 닿으므로 소유자 결정):

- 정산 행은 append-only. 수정·삭제·archive 없음.
- Notion이 돈 사실을 바꾸면 core5는 기존 정산을 유지하고 hold로 올린다.
- 소유자가 hold를 승인하면, 그 다음에만 reversal 정산을 추가한다. reversal id는 기존 정산 id와 다르게 `settlement-rev-` + hash(원정산 id, plan hash) 끝 8자. 기존 식과 충돌하지 않게.
- 승인 전 reversal을 넣지 않는다. 승인 경로는 일일 잡이 아니다.

스냅샷에 없음과 격리됨을 구분한다.

- page id가 스냅샷 집합에 없음 → archive 후보 (위 표). 재무·정산은 예외.
- page id가 있으나 planner/override가 격리 → 기존 행은 동결(update/archive 없음). 신규 insert 없음. 리포트에 남긴다.

## 트랜잭션·멱등·dry-run·롤백

한 sync = 한 DB 트랜잭션.

1. 스냅샷 해시(파일 sha256)와 plan hash를 계산한다.
2. `cwos_notion_sync_runs`에 `(workspace_id, plan_hash)` APPLIED가 있으면 no-op. 행 수를 보고하고 끝.
3. diff를 만든다. dry-run이면 여기서 커밋하지 않고 리포트만 쓴다. 잡의 기본값은 dry-run이다.
4. apply: upsert + archive + hold insert + run 행(`plan_hash`, `snapshot_sha256`, `status=applied`, `applied_at`)을 같은 트랜잭션에 넣는다. 마커만 먼저 쓰지 않는다. 중간에 예외면 전부 롤백. 적용 마커와 행이 어긋난 상태를 성공으로 보지 않는다.
5. hold는 `cwos_notion_sync_holds(workspace_id, notion_page_id, kind, reason, plan_hash, created_at)`. 같은 page+reason이 이미 있으면 DO NOTHING. hold는 돈 행을 만들지 않는다.

멱등: 같은 plan hash 재실행은 no-op. 다른 스냅샷이 같은 엔티티 diff를 만들면 두 번째 트랜잭션은 행 변경 0이어야 한다 (테스트).

롤백:

- 트랜잭션 실패: DB가 롤백. 덤프를 복원하지 않는다.
- 커밋 후 잘못된 반영: 그날 잡이 apply 전에 남긴 `ai_crm-daily-*.dump`로 복원. 행 단위 undo는 만들지 않는다. 정산이 들어간 뒤에는 dump 복원만 롤백이다.
- `ai_crm` 복원은 소유자 승인. scratch 복원은 잡이 해도 된다.
- 0025_cwos_notion_sync down은 archive/hold/notion_page_id가 있으면 자동으로 내리지 않는다. 컷오버 당일 롤백은 런북과 같이 dump 복원이다.

## core5 쪽 수정

권장: 최종 전환(소유자가 Notion 마스터를 끝낸다고 말할 때)까지 core5는 소유자 읽기 전용. sync는 Notion→core5만. core5→Notion 쓰기는 없다.

읽기 전용을 어기면 `CORE5_DRIFT` hold. 그 행은 Notion이 이기지 않는다. drift를 지우려면 소유자가 «Notion 값으로 덮기»를 그 page id에 대해 승인한다. 일일 잡의 기본 동작이 아니다.

## 격리 override와의 관계

`docs/plans/2026-09-30-quarantine-overrides.md`는 미구현·미커밋·소유자 미확인이다. 이 계획의 선행이 아니다. 규칙 플래그가 꺼진 상태가 오늘 계약이다.

- desired state는 `plan(snapshot, options)` 결과다. options는 override 파일과 플래그. 파일이 없거나 플래그가 꺼지면 지금 planner와 같다.
- 격리 source id는 `excludeSourceIds`와 같이 insert/update에서 빠진다. 이미 들어가 있는 행은 동결한다. override가 나중에 그 id를 풀면 그때 insert다 (archive였으면 archive를 풀고 update).
- 규칙 4(예상일 null, capturedAt 금지)가 켜지기 전에는 증분도 날짜를 만들지 않는다. 날짜가 없는 SETTLED는 hold.
- 이후 마이그레이션(활동 engagement null, 재무 expected_date null, unassigned)가 없으면 규칙 2·3·4로 풀린 행은 증분 insert도 실패해야 한다. 실패하면 트랜잭션 전체 롤백이 아니라 그 행만 hold로 내리는 쪽이 일일 잡에 맞다. 스키마가 거절하는 행은 hold `SCHEMA_REJECT`. 나머지 diff는 커밋한다. 돈 hold와 달리 이것은 실패 격리이지 승인 대기 돈이 아니다.
- override 문서를 승인으로 읽지 않는다. 플래그는 기본 off.

## 버전

버전 번호를 성과로 치지 않는다. 각 단계 진입 조건이 증거다.

### S0 — 지금 (있음, 적용 안 함)

범위: 일일 잡 report-only, dump 14개 유지. 코드 변경 없음.
수용: 잡이 `applyApprovedNotionPlan`을 호출하지 않음. Notion 쓰기 없음. 증거: `report-20260930.md` applied=false.

### S1 — diff 함수, 여전히 미적용

코드: `packages/imports`에 pure diff (desired plan + 현재 행 목록 → insert/update/archive/hold). DB 없음. `syncApprovedNotionPlan`은 호출하지 않음. 잡은 리포트에 diff 건수만 추가할 수 있다. `ai_crm`에 쓰지 않음.
선행: 없음. override·nullable 스키마·sync 마이그레이션 없음.
수용: 이름 변경 스냅샷은 update 1, 추가 page는 insert 1, 빠진 page는 archive 1, 같은 hash 재실행은 변경 0. 정산 금액 변경은 hold이고 settlement 연산이 아님. 테스트는 픽스처 page id. 고객명 단정 없음.
롤백: 잡 리포트 필드 제거. DB 변경 없음.
다음: S1 테스트가 한 번 녹색.

### S2 — scratch apply

코드: 0025_cwos_notion_sync, `syncApprovedNotionPlan`, 잡의 `SYNC_TARGET=scratch`. scratch는 당일 dump를 복원한 DB. `ai_crm` 이름이면 거절.
선행: S1. nullable 스키마는 규칙 2·3·4를 쓸 때만. 기본 플래그 off면 그 마이그레이션 없이 S2 가능.
수용: scratch에서 1회 적용 후 같은 스냅샷 재적용은 행 수·해시 동일, run 행 1. 이름 변경+행 추가 스냅샷은 `DUPLICATE_ID`가 아니라 update+insert. 계정 수가 변한다. 정산 in-place 0. 실패 주입(마커 insert 직후 throw) 시 run 행과 데이터 행이 둘 다 없음.
롤백: scratch drop. `ai_crm` 무변경.
다음: scratch 하루가 리포트 diff와 행 단위로 일치. 소유자가 `ai_crm` apply를 승인.

### S3 — `ai_crm` apply

선행: S2 증거 + 소유자 승인 + 그날 dump가 `pg_restore -l`에 TABLE DATA를 가짐 + open `CORE5_DRIFT` 0 + 돈 hold는 있어도 되나, hold를 자동 반영하지 않는다는 문장이 잡 로그에 있음.
수용: 적용 후 재무 합이 «정산 없는 update가 반영된 plan»과 1원 차이 없음. 돈 hold 분은 plan 합과 다를 수 있다. 그 차이를 hold 목록으로 설명한다. 다르면 dump 복원(소유자 승인).
롤백: 당일 dump. 행 단위 undo 없음.
다음: 소유자가 Notion 마스터 종료를 말하기 전에는 core5 쓰기를 열지 않는다. 종료 후 이 잡은 끈다. 끄기 전에는 Notion 쓰기 잠금을 이 계획이 하지 않는다.

## 테스트 (검증냥)

- S1 unit: insert/update/archive/hold 분류. 정산 불변. 같은 hash no-op. 격리 id는 동결(이미 있는 행 update 없음, 없는 행 insert 없음). 스냅샷에서 사라진 미정산 재무만 cancel+archive. 정산 있는 재무는 archive 아님.
- S2 integration (live pg, scratch만): 0012–0024(+0025_cwos_notion_sync) 적용 후 sync. 재실행 멱등. 트랜잭션 실패 주입 시 마커 없음. `DUPLICATE_ID`로 두 번째 스냅샷이 거절되지 않음.
- 재무: 금액 변경은 `cwos_settlements` 행이 그대로. reversal 행 0. hold 1.
- override 플래그 off: 오늘 격리 집합은 insert 되지 않음. 플래그 on 테스트는 override 계획이 머지된 뒤에만. 그 전 테스트를 만들지 않는다.
- 잡지 않는 것: 리포트 문장, 고객명, 합계 숫자를 테스트에 박지 않음. 합계 대조는 스냅샷 원본과 DB.

## 작업 의존

| ID | 내용 | 선행 | 시작 가능 |
|---|---|---|---|
| SYNC-1 | pure diff + S1 테스트 | 없음 | 개발냥, 지금 |
| SYNC-2 | 0025_cwos_notion_sync + sync 트랜잭션 + 실패 주입 | SYNC-1 | 0025_cwos_notion_sync는 스키마 승인 후. 설계 파일만으로는 프로덕션 마이그레이션 금지 |
| SYNC-3 | 잡 scratch 모드 | SYNC-2 | scratch DB 생성은 운영. `ai_crm`에 하지 않음 |
| SYNC-4 | `ai_crm` apply | SYNC-3 증거 + 소유자 | 차단. 승인 전 코드를 기본 on으로 두지 않음 |
| SYNC-5 | reversal 실행 경로 | 소유자가 돈 hold 정책을 승인 | 차단. 제안 레코드만 |

override 1·5는 이 작업과 독립. 2·3·4는 nullable 스키마가 있어야 insert가 SCHEMA_REJECT가 아니다. 11건 재무의 관계는 override 계획대로 규칙 1이 같은 plan()에 있을 때만 유지된다.

## 완료로 치지 않는 것

이 문서, dry-run 리포트, scratch 적용은 `ai_crm` 증분 완료가 아니다. S3 수용 증거가 있을 때만 증분 적용됨. 앱이 쓰이기 시작한 것은 또 다른 승인이다.

## 소유자 결정 (이것만)

1. 병렬 구간 core5 소유자 쓰기를 끌 것인가. 권장: 끈다. drift는 hold.
2. 정산·금액 변경을 자동 반영하지 않고 hold로 둘 것인가. 권장: hold. reversal은 건별 승인. 자동 reversal은 하지 않는다.
3. 스냅샷에서 사라진 page를 soft-archive 할 것인가. 권장: 한다. hard delete 없음. 정산이 있는 재무는 archive 하지 않는다.
4. S2 scratch가 하루 리포트와 맞은 뒤 `ai_crm` apply를 켤지. 날짜는 정하지 않는다. 켜기 전 승인.
