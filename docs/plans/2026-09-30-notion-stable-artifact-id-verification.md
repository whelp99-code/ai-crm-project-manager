# 검증 판정 — Notion artifact id 안정화 PR #17

독립 검증. 대상 `fix/notion-stable-artifact-id` @ `2e3af2f` (커밋 `ad3509b` `805bdac` `2e3af2f`, 기준 `ab06a7f`). 클론 `/tmp/verify-artifact-id` (종료 후 삭제). `ai_crm`에는 접속하지 않았다. Notion 쓰기는 하지 않았다. 검증냥은 출시를 승인하지 않는다.

전체: **PASS** (필수 시험). 운영 적용·일일 잡 교체·배포는 NOT_RUN.

## 시험

분모 8. 실행 8. 건너뜀 0.

| ID | 내용 | 판정 |
| --- | --- | --- |
| T1 | `ad3509b`에서 `vitest run apps/api/test/notion-stable-artifact-id.test.ts` | PASS (실패가 맞음). 3 failed. id 불일치와 `SCHEMA_REJECT` |
| T2 | `2e3af2f`에서 같은 파일 | PASS. 3 passed |
| T3 | `pnpm run typecheck` | PASS. exit 0. Node v24.19.0 (engines는 `>=22 <23`) |
| T4 | `pnpm test` | PASS(허용 예외). 748 passed, 52 skipped, 1 failed. 실패는 `apps/worker/test/worker-start.integration.test.ts` SIGTERM 15s timeout만. exit 1 |
| R1 | id 입력에 서명·만료·쿼리 없음 | PASS. `notionArtifactIdentity`만 artifact id를 만든다. 호출은 sync와 최초 적재(`customer-work-os-notion.ts`) 두 곳. `stableNotionStorageKey`가 `?`와 `#`를 뺀 뒤 origin+pathname만 해시한다 |
| R2 | 같은 페이지의 파일 둘, 이름 변경 | PASS(요청 범위). 쿼리만 다른 두 파일은 옛 id를 각자 유지한다. 경로가 유지된 채 순서가 바뀌어도 id는 파일을 따른다. 파일 하나만 경로가 바뀌면 `version_label`로 그 슬롯에 묶이고 다른 파일 id를 가져가지 않는다. `DELETE FROM` 없음. scratch `deletes` 0 |
| S1 | 덤프 `ai_crm-daily-20260930T125037.dump` → `core5-crm-pilot-pg` / `core5_sync_scratch_20260930` + 클론의 0025. 스냅샷 `notion-snapshot-20260930T040624Z.json` (`sha256:2cdab48e…`) sync 1회 | PASS. artifacts 2→2. id `artifact-84a9f46a`, `artifact-dc0aa018` 유지. inserts 0, archives 0, holds 0, SCHEMA_REJECT 0. 업무 필드 변경은 activity `account_id` 7건뿐 (`activity-6fe54ca1` `activity-7c8b8676` `activity-39c8ca3d` `activity-d047b442` `activity-ba2e4334` `activity-145dbaab` `activity-65a4d9ff`). updates 189 = 마커 180 + 그 7 + artifact `storage_uri` 2(서명 갱신, id 불변) |
| S2 | 63초 뒤 스냅샷 `notion-snapshot-20260930T040727Z.json` (`sha256:61862d06…`, 행 수 동일 45/47/21/94) sync 1회 | PASS. inserts 0, SCHEMA_REJECT 0, activity `account_id` 변경 0, archives 0, holds 0. artifact id·`notion_page_id` 동일. updates 2는 서명된 `storage_uri` 갱신(version 2→3). 증명 후 scratch DROP. 남은 DB에 `ai_crm`가 있다 |

## 잔여 위험

두 파일의 경로가 **둘 다** 바뀌면 파일 키가 없어 `version_label`(배열 순서)로만 묶는다. 순서까지 바뀌면 서로 다른 파일에 옛 id가 붙을 수 있다. 이번 스냅샷 쌍과 요청한 단일 개명 시험에서는 재현되지 않았다. 확실성: 코드 경로 재현, 운영 데이터 미재현. 심각도: 낮음(현재 견적 파일 2개는 경로가 유지됨).

8자리 FNV 충돌은 이번 범위에서 시험하지 않았다.

## 제한

코드 존재·테스트됨·scratch 1회 증명까지다. 운영 `ai_crm` 적용, 일일 잡 교체, 배포는 하지 않았다. 출시 승인이 아니다.
