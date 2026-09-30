# 2026-09-30 격리 39건 소유자 override 계획

상태: 설계만. 구현·커밋·DB 쓰기 없음. 다섯 규칙은 소유자 미확인. 이 문서는 승인이 아니다.
대상: `whelp99-code/ai-crm-project-manager` `64d38ea` (PR #13/#14 머지). 이 worktree는 그 커밋의 detached HEAD. 브랜치 `core5-c01-c02`는 `/home/jm/orca/projects/AI-CRM+PM` worktree가 잡고 있어 checkout 하지 못했다.
근거: 스냅샷 `notion-cfo-os-20260930T014053Z` (`sha256:1f01d692…dce8`), rehearsal `rehearsal-apply-20260930.json` (quarantined 39), 런북 `CUTOVER-RUNBOOK-20261001.md` 「격리 39건」. 본 모듈 밖(리포트 전 쿼리, RLS)은 전수 조사하지 않았다.
추적: GitHub Issues 한 건. `~/ops/github-development-management/WORKFLOW.md`. 다른 보드에 복제하지 않는다. 이슈 번호는 아직 없다.

## 현행 (코드 있음, 규칙 없음)

`NotionCwosImportPlanner.plan(snapshot)` (`packages/imports/src/notion-cwos.ts`)에 override 인자가 없다. rehearsal 격리:

| 건수 | 사유 | 위치 |
|---|---|---|
| 9 | `UNMAPPED_STAGE` 미분류 | planner 608–615, `PROJECT_STAGES` 373–382 |
| 1 | `MISSING_REQUIRED_FIELD` 단계 빈칸 (선진엔지니어링) | 608–610 |
| 2 | `MISSING_PROJECT_KEY` (KVM IAG, 카드사용료) | 593–594. 카드사용료는 단계 `보류`라 단계 규칙 대상이 아니다 |
| 6 | `ORPHAN_ACTIVITY` | 680–682 |
| 2 | activity `UNKNOWN_RELATION` | 686–689. 프로젝트는 스냅샷에 있으나 단계 격리로 `projectSourceIds`에 없음 |
| 5 | `ORPHAN_FINANCE` | 810–813 |
| 11 | finance `UNKNOWN_RELATION` | 815–817. 11건 모두 스냅샷 안 프로젝트(단계 격리분)를 가리킨다. 스냅샷 밖 id는 0 |
| 2 | `예상 입금일` 없음 | 836–838 |
| 1 | 거래처 없음 (굿어스) | 825–827 |

stage CHECK는 `cwos_engagements.stage` (`0012` 41행). `maintenance`/`renewal`은 stage가 아니라 `engagement_type` (40행). 적용 시 type은 stage에서만 찍힌다: `importedEngagementType` (`apps/api/src/customer-work-os-notion.ts` 349–352). `ON_HOLD`→`maintenance`는 우연이지 운영 단계가 아니다.
재무: `engagement_id` NULL은 `category='overhead'`일 때만 (`cwos_financial_items` CHECK, 0012 314행). 활동 `engagement_id` NOT NULL + FK (0012 83, 94). `expected_date` NOT NULL (0012 306). 0024는 commitment `due_at`만 풀었다.
적용 경로가 날짜를 만든다: `expectedDate: item.expectedDate ?? plan.capturedAt.slice(0, 10)` (notion.ts 447). 활동은 engagement가 없으면 `continue`로 버린다 (438–439). 도메인 `Activity.engagementId`는 필수, `recordActivity`가 `this.engagement`를 호출한다 (domain 556–557). `FinancialItem.expectedDate`는 필수 (349행).

## 결정

이름 정규식·단계 휴리스틱은 넣지 않는다. 감사 가능한 override 파일 하나.

- 경로: `packages/imports/fixtures/notion-owner-overrides.json`
- 키: Notion page id (`sourceId`). 이름 매칭 금지.
- `plan(snapshot, options?)`. `options.rules`는 `{ stage, unassignedFinance, accountActivity, nullExpectedDate, counterparty }`. 기본 전부 false. 파일만 있어도 격리 39는 유지된다. 규칙마다 독립.
- 파일에 없는 id에는 적용하지 않는다. 카드사용료 `f8033ddb-7425-8239-8038-01ba0c753851`은 파일에 넣지 않는다.
- 한 규칙이 켜져도 다른 격리 사유는 남긴다 (금액·VAT·중복 등).

### 규칙 1 — 단계 (스키마 변경 없음)

`PROJECT_STAGES` 조회 전에, 규칙이 켜져 있고 파일에 `stage`+`engagementType`이 있으면 그 값을 쓴다. 값은 기존 `EngagementStage` / `engagement_type` CHECK 안이어야 한다. 없으면 지금처럼 격리.
KVM은 키가 없어 593행에서 끊긴다. 파일의 `projectKey`를 그 행에만 쓴다. 키를 코드가 만들지 않는다. 제안 값은 스냅샷 자연키 `kvm-iag-visit-202610` (확인 전 후보).
`EngagementImportRecord`에 `engagementType`을 넣고, `applyNotionPlanToDomain`은 override가 있으면 `importedEngagementType`을 쓰지 않는다.
운영에 해당하는 기존 stage는 없다. 열거를 늘리지 않는다 (CHECK, domain union, `TRANSITIONS`, 리포트). 수행 중 등가 = `DELIVERY` (ACTIVE_STAGES). type으로 유지보수/리뉴얼을 구분한다.

소유자 확인용 매핑 (스냅샷 `20260930T014053Z`). 확인 전 플래그 off.

| page id | 이름 | 제안 stage | 제안 type | 비고 |
|---|---|---|---|---|
| 18533ddb-7425-82f8-9e3b-81bfc5ea54ce | 게임조선 HCI Renewal | DELIVERY | renewal | 미분류 |
| 3bb33ddb-7425-8118-9cf4-d7622716e939 | 자이S&D Sangfor VDI 유지보수 | DELIVERY | maintenance | 미분류 |
| 3bb33ddb-7425-8175-a784-fc54b383fd73 | DRB동일 Renewal | DELIVERY | renewal | 미분류 |
| 3bb33ddb-7425-81e1-ad70-d0e428a67110 | ESTEC Renewal | DELIVERY | renewal | 미분류 |
| 5c733ddb-7425-8352-8caa-812c5ee07fd6 | GS건설 - VDI 리뉴얼 | DELIVERY | renewal | 미분류 |
| b3733ddb-7425-82ec-bbf8-81d87d495c57 | 디지털조선 HCI Renewal | DELIVERY | renewal | 미분류 |
| 37c33ddb-7425-8333-9ecc-01cf18b74ec4 | GS건설 - WANO, IAG | DELIVERY | delivery | 신규. 키 `202601-GS건설-신규구매`는 유지 |
| 3bb33ddb-7425-8196-a6f0-fbbb932136d6 | GS건설 디지털트윈팀 HCI C260217 | DELIVERY | delivery | 신규 |
| 9be33ddb-7425-83cc-91cb-01a18f75ac9b | 일지테크 - 토탈솔루션 | DELIVERY | delivery | 신규 |
| 3df33ddb-7425-8110-afb6-df19d305254c | KVM IAG 내방·보안정책 | DELIVERY | delivery | 단계 속성 없음. `projectKey` 후보 `kvm-iag-visit-202610` |
| 3bb33ddb-7425-810c-ab77-c5fa278eff31 | 선진엔지니어링 HCI | DELIVERY | delivery | 단계 속성 없음, 스냅샷 `상태=진행`. 신규 목록에 없음. 확인 전 비활성 |
| f8033ddb-7425-8239-8038-01ba0c753851 | [비프로젝트] 2월 카드사용료1 | (제외) | — | 이미 `MISSING_PROJECT_KEY`. 파일에 넣지 않음 |

### 규칙 2 — 프로젝트 미배정 금액 (스키마 필요)

금액·`category`는 유지한다. `overhead`로 바꾸지 않는다. 그건 리포트 의미를 바꾼다.
재hearsal 16 = 빈 관계 5 + 단계 격리 프로젝트를 가리키는 11. 11은 규칙 1이 같은 `plan()`에서 그 프로젝트를 넣으면 배정된 채로 둔다 (규칙 1이 이긴다). 규칙 2만 켜면 11은 미배정이 되어 Notion 관계가 끊긴다. 권장: 1과 같이 켜거나, 11은 파일의 unassigned 목록에 넣지 않는다.
미배정 대상(관계 빈칸, 규칙 2만으로도 해당):

- 3bb33ddb-7425-8105-8036-e363c2cf3766 한국정보인증
- 3bb33ddb-7425-816d-baaa-cbadd9db6758 넥시아스 Sangfor HCI Renewal외
- 3bb33ddb-7425-81ce-a93e-e34d030a9dfa 더존 WEHAGO
- 3bb33ddb-7425-81fc-9089-cb70be2b9fe2 이루인포
- 3e933ddb-7425-81ba-b104-cd246dd9fa99 롯데건설 매출 (거래처도 없음. 규칙 2만으로는 계정 필수라 여전히 격리. 계정 page id가 파일에 있어야 한다. 없으면 넣지 않는다)

planner 810–817: 목록에 있고 계정이 있으면 `engagementSourceId=null`, 금액 유지, provenance에 `projectMappingStatus: "unassigned"`. 계정이 없으면 격리 유지.

### 규칙 3 — 계정 단위 활동 (스키마 필요)

`ORPHAN_ACTIVITY` 6 중 계정이 있는 3만 규칙만으로 가능.

- 3bb33ddb-7425-8169-b337-e3d61fc20585 베를로 ← 계정 `3bb33ddb-7425-8146-96ea-e1ef2cb2ec0f`
- 3bb33ddb-7425-81c8-9813-ee1b2951fc80 베를로 7월 ← 같은 계정
- 3bb33ddb-7425-81d3-99c3-c6b03c1d348f 부산도시가스 ← `3bb33ddb-7425-81c8-b8f3-e1e3ffc3cf47`

계정 관계 없음 (파일에 `accountSourceId`가 있어야 하고, 그 id는 이번 plan의 계정이어야 한다. 없으면 격리):

- 3bf33ddb-7425-8131-bf65-f9283e2e9dfa 코원에너지 R770
- 3bf33ddb-7425-81a4-bca6-e325b4a17a75 MISTO SASE
- 3bf33ddb-7425-81e0-8fe7-c93f195c8eeb 롯데건설 NGAF Renewal

`UNKNOWN_RELATION` 2 (`…8166` ESTEC, `…81bf` 디지털트윈)는 규칙 3으로 계정 단위에 내리지 않는다. 규칙 1이 프로젝트를 넣으면 기존 프로젝트 활동으로 들어간다. 1이 꺼져 있으면 지금처럼 격리.

### 규칙 4 — 예상 입금일 null (스키마 필요)

날짜를 만들지 않는다. planner 836행 격리를, 목록에 있는 행이고 규칙이 켜진 경우에만 제거. `expectedDate`는 null.
대상: `3be33ddb-7425-818f-b474-c49f702b11de` 동국대병원 선금, `3d633ddb-7425-81e9-8d09-f8eae49e658d` 시큐아이 서초 Renewal.
적용 447행의 `?? plan.capturedAt`와 settlement `settledAt`의 같은 폴백을 이 행에 쓰면 안 된다. null이면 settlement의 `settledAt`도 실제 처리일이 있을 때만. 없으면 settlement를 만들지 않는다.
도메인 `FinancialItem.expectedDate`를 optional로. 정규화 write (`customer-work-os-normalized-write.ts` 141–145)는 null을 그대로.

### 규칙 5 — 굿어스 거래처 (스키마 변경 없음)

`3e933ddb-7425-81b5-8574-fe154243ead9` → 계정 `3bb33ddb-7425-8100-a3f3-e7f2b285430c` (스냅샷 회사/조직명 굿어스). 825행 앞에서 listed account가 없고 override가 있으면 그 source id를 쓴다. provenance `accountSource: "owner_override"`. 프로젝트 `3d633ddb-7425-8110-bff3-d12b6da90bba` (KV · IAG, 단계 청구/수금)는 이미 반입 대상. 이름 검색으로 굿어스를 찾지 않는다.

## 스키마 없이 되는 규칙

1과 5만. 2·3·4는 제약을 우회하면 의미가 깨지거나 적용 경로가 행을 버린다. overhead 강제(2), engagement 없는 활동을 조용히 skip(3), capturedAt 대입(4)은 하지 않는다.

## 마이그레이션 0025 (additive)

`packages/persistence/migrations/0025_cwos_import_overrides.sql`. 0024 다음. 기존 행은 유효해야 한다.

- `cwos_activities.engagement_id` DROP NOT NULL. FK는 NULL을 허용하므로 유지. `CHECK (engagement_id IS NOT NULL OR account_id IS NOT NULL)` 추가. 둘 다 비는 행은 거부.
- `cwos_financial_items.expected_date` DROP NOT NULL.
- `cwos_financial_items`에 `import_assignment text NOT NULL DEFAULT 'assigned' CHECK (import_assignment IN ('assigned','unassigned'))`. 기존 CHECK `(engagement_id IS NOT NULL OR category = 'overhead')`를 교체: `(engagement_id IS NOT NULL OR category = 'overhead' OR import_assignment = 'unassigned')`. overhead 미배정 기존 행은 default `assigned`로도 통과한다.
- 역적용: null 기대일 또는 unassigned 행이 있으면 0024 시점으로 못 돌아간다. 롤백은 플래그 off로 재계획해 그 행을 다시 격리하고, 컬럼 DROP은 별도 승인. cutover 당일은 덤프 복원(런북 DROP/CREATE)이 롤백이다. 0025를 프로덕션에 적용하는 것은 소유자 승인 후.

도메인·정규화 write·`recordActivity`가 DB와 같이 null을 받아야 한다. DB만 풀면 적용이 여전히 실패한다.

## 테스트

- `packages/imports/test/notion-cwos.test.ts`: 플래그 off면 39 유지(픽스처로 재현 가능한 부분집합 + 카드사용료는 항상 `MISSING_PROJECT_KEY`). 플래그 on이면 해당 page id만 풀리고 다른 격리는 남음. 파일에 없는 id는 안 풀림. 단계 값은 표와 일치 (정규식 없음).
- 규칙 1 on + 규칙 2 on: QPROJ 11은 `engagementSourceId`가 그 프로젝트. 빈 관계 5만 null.
- `apps/api` apply 테스트: 규칙 4 행의 `expectedDate`가 null이고 `capturedAt`이 아님. 규칙 3 행이 skip되지 않음. 규칙 1 type이 `importedEngagementType` 결과가 아님.
- persistence: 0025 이후 unassigned+비overhead insert 성공, engagement·account 둘 다 null인 활동은 실패, 기존 overhead NULL engagement는 여전히 성공.

## 리허설로 증명

같은 스냅샷 `notion-cfo-os-20260930T014053Z`, 같은 하네스(`dryrun-apply-harness.ts` / `rehearsal-apply.mts`). 플래그를 하나씩 켠 뒤:

- quarantined가 39에서 그 규칙의 해제 건수만큼만 준다. 카드사용료는 남는다.
- 규칙 4: DB `expected_date`가 그 2행에서 NULL. 캡처일 `2026-09-30`이 들어가면 실패.
- 재무 합은 해제된 source id의 스냅샷 금액만큼만 증가. 합을 문서에 미리 적지 않는다. 대조는 스냅샷 원본.
- 규칙 3: `cwos_activities.engagement_id` NULL, `account_id`는 override 계정.
- 플래그 전부 off 재실행: rehearsal과 같은 39 / imported 35·13·8.

## 작업 순서

1. override 파일 + `plan` 인자 + 규칙 1·5 (스키마 없음). 테스트. 플래그 기본 off.
2. 0025 + 도메인·apply·normalized write의 null 허용. 규칙 2·3·4.
3. 소유자가 규칙별로 켠 뒤에만 리허설. 이슈에 규칙 id와 증거(리허설 JSON 경로)를 남긴다.

개발냥: 1은 0025 없이 시작 가능. 2는 1의 타입 필드와 독립이나, 11건 재무는 1이 들어간 뒤 규칙 2 테스트가 맞다. 검증냥: 위 리허설 기준. 일정·인원은 정하지 않는다.

## 리스크

- 표의 DELIVERY/type은 제안이다. 확인 전 플래그를 켜지 않는다.
- KVM 키 후보는 자연키일 뿐 사업 프로젝트ID가 아니다. 소유자가 키를 바꾸면 id 생성(`id("engagement", …)`)은 source id 기준이라 그대로다. project_key만 바뀐다.
- 규칙 2를 1 없이 켜면 11건의 Notion 프로젝트 관계가 끊긴다.
- 롯데건설 매출·계정 없는 활동 3은 계정 id 없이는 규칙만으로 안 들어간다.
- 활동 engagement NULL이면 engagement 기준 리포트에서 빠질 수 있다. 리포트 쿼리는 이번 조사 범위 밖.
- 적용 경로의 capturedAt 폴백을 규칙 4와 같이 안 고치면 마이그레이션은 통과하고 데이터는 날조된다.
