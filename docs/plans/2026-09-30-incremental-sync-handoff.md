# 검증냥 인계 — Notion 증분 동기화

대상: `feat/notion-incremental-sync` → `core5-c01-c02`. PR #16. 이슈 #15. `ai_crm`에는 쓰지 않았다.

## 커밋

- `8b6793a` feat(persistence): 0025 sync markers
- `2812541` feat(imports): pure diff
- `76d8cdb` feat(api): `syncApprovedNotionPlan`
- 이 문서와 계획 문서는 그 다음 커밋

0025는 비어 있었다. sync 마이그레이션을 0026이 아니라 0025로 뒀다. 격리 nullable 스키마는 이 번호가 아니다.

## 명령

- src 스태시 후 `vitest run` 신규 2파일: 스위트 2 실패 (`notion-sync-diff.js` / `customer-work-os-notion-sync.js` 로드 실패). 구현 복원 후 11 passed.
- `pnpm --filter @ai-crm/api run typecheck`: exit 0 (수정 후).
- `pnpm test`: exit 1. 739 passed, 1 failed. 실패는 `apps/worker/test/worker-start.integration.test.ts` SIGTERM 15s timeout. 알려진 실패로 본다. 그 외 실패 없음.

## scratch

덤프 `ai_crm-before-cutover-20260930T1037.dump`를 컨테이너 `core5-crm-pilot-pg`의 `ai_crm_sync_scratch`에 복원. 덤프에 0024가 없어 0024 다음 0025를 적용. 스냅샷 `notion-snapshot-20260930T021058Z.json`. 증명 후 DB drop.

- 1차: inserts 189, updates 0, archives 0, holds 0, settlementInserts 5, runs 1, accounts 45, settlement_sum 50010400
- 합성(추가 1, 프로젝트명 변경 1, 활동 제거 1, 정산 있는 재무 금액 +1000): inserts 1, updates 37, archives 1, holds 1 (`AMOUNT_OR_DIRECTION`), settlementInserts 0
- 이후: accounts 46, activities_archived 1, holds 1, settlement_sum 50010400 유지. 해당 정산 amount 12100000, financial gross 12100000 (금액 변경 미반영)
- 재실행: alreadyApplied true, runs 2
- 마커 직후 throw: 메시지 `injected`, runs 2 유지 (롤백)
- 추가 계정 존재, 활동 archived true, 프로젝트명 접미 `변경`

updates 37은 제목 변경 1건보다 많다. 행 단위 원인 분류는 하지 않았다.

## 확인하지 않은 것

- `ai_crm` apply, 일일 잡 연결, override 플래그 on, reversal 실행, 읽기 API의 archive 제외
- 이 재검사는 독립 감사가 아니다

## 2026-09-30 정합 비교 수정 (검증냥 FAILED 대응)

원인: DATE를 `toISOString().slice(0,10)`으로 읽어 Asia/Seoul에서 하루가 밀리고, `occurred_at` 날짜 문자열과 `T00:00:00.000Z`를 그대로 비교하며, artifact metadata JSON 키 순서가 달랐다. 비교를 느슨하게 끄지 않고 정규형으로 맞췄다. DATE는 `::text`와 로컬 달력 일로 읽고, 타임스탬프는 양쪽을 UTC 자정 ISO로 맞추며, metadata는 키 정렬 JSON으로 비교한다.

- `pnpm --filter @ai-crm/api run typecheck`와 `@ai-crm/imports` typecheck: exit 0
- `pnpm test`: exit 1. 745 passed, 1 failed, 52 skipped. 실패는 `worker-start.integration.test.ts` SIGTERM 15s timeout만.
- scratch `ai_crm_sync_canon_20260930` (덤프 + 0024 + 0025, 증명 후 DROP). `ai_crm` 미사용. Notion 미호출.
  - 1차: inserts 189, updates 0, archives 0, holds 0, settlementInserts 5
  - 내용 동일·plan hash만 다름: inserts 0, updates 0, archives 0, holds 0. engagement `max(version)=1`, `version>1` 0건
  - 합성(추가 1, 제목 1, 제거 1, 정산 금액 +1000): inserts 1, updates 1, archives 1, holds 1 (`AMOUNT_OR_DIRECTION`)
  - 재실행: alreadyApplied true, runs 3 유지, settlement_sum 50010400 유지
