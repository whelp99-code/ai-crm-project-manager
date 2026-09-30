# 검증냥 인계 — Notion artifact id 안정화

대상: `fix/notion-stable-artifact-id` → `core5-c01-c02` (`ab06a7f`). 이슈 #15. `ai_crm` 쓰기 없음. Notion 쓰기 없음. 이 재검사는 독립 감사가 아니다.

## 원인과 수정

artifact id와 `notion_page_id`가 서명된 S3 URL 전체를 해시했다. 쿼리가 스냅샷마다 바뀌면 같은 파일이 새 id가 되고, `(workspace_id, engagement_id, artifact_type, title, version_label)` 유니크에 걸려 `SCHEMA_REJECT`가 된다.

id는 페이지 id + property(kind) + 쿼리/프래그먼트를 뺀 파일 경로만 쓴다. 최초 적재 행은 옛 id를 유지한다. sync는 `metadata.legacySourceId`(없으면 `notion_page_id`의 페이지)와 파일 경로가 같으면 그 id로 갱신한다. 경로가 달라도 같은 페이지·유형·`version_label`이면 그 행에 묶는다. hard delete 없음.

## 1회 기준선이 해야 할 일

`artifact-dc0aa018`, `artifact-84a9f46a`는 삭제하거나 다시 insert하지 않는다. 기준선 sync가 `notion_page_id`를 채우고, 서명이 바뀐 `storage_uri`만 갱신하면 된다. `metadata.legacySourceId`가 비어 있으면 매칭되지 않으니 그 행은 hold로 두고 수동 확인한다.

## 커밋

- `ad3509b` test(notion): fail when artifact ids follow signed URLs
- `805bdac` fix(notion): derive artifact ids from stable file paths
- 이 문서

## 명령

- 수정 전 `vitest run apps/api/test/notion-stable-artifact-id.test.ts`: 3 failed (id 불일치, SCHEMA_REJECT).
- 수정 후 같은 파일: 3 passed.
- `pnpm run typecheck`: exit 0.
- `pnpm test`: exit 1. 748 passed, 52 skipped, 1 failed. 실패는 `apps/worker/test/worker-start.integration.test.ts` SIGTERM 15s timeout만.

## scratch

일일 덤프는 `/home/jm/.local/state/omonyang/core5-backups/`에 없었다. 최신 일일 덤프 `ai_crm-daily-20260930T125037.dump`를 `core5-crm-pilot-pg`의 `core5_sync_scratch_20260930`에 복원하고 worktree의 0025를 적용했다. 스냅샷 `notion-snapshot-20260930T035037Z.json`. 증명 후 DB drop. 남은 DB는 `ai_crm`뿐.

- before artifacts 2, baseline ids 2, schema_reject 0
- after artifacts 2, baseline ids 2, schema_reject 0
- artifactInserts 0, schemaRejectHolds 0, reportInserts 0, schemaRejectInReport 0

## 확인하지 않은 것

운영 `ai_crm` 적용, 일일 잡 교체, 배포.
