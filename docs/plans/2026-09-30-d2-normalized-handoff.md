# D2 정규화 쓰기 인계 (검증냥)

소유자 A 선택 시에만 PR로 올림

브랜치: `feat/notion-normalized-write` (기준 `409e210`). `fix/notion-cfo-os-importer`와 PR #13은 건드리지 않음. 소유자가 B를 고르면 이 브랜치를 버린다.

## 만든 것

- `packages/persistence/migrations/0024_cwos_normalized_import_columns.sql`: `cwos_accounts.source_ref`, `cwos_financial_items.evidence_ref` nullable 추가. `cwos_commitments.due_at` NULL 허용.
- `apps/api/src/customer-work-os-normalized-write.ts`: 도메인 state를 9테이블에 쓴다. settlement는 `ON CONFLICT`가 아니라 `WHERE NOT EXISTS`로 삽입 자체를 건너뛴다. 가드를 끄지 않는다.
- `applyApprovedNotionPlan`의 같은 트랜잭션 `participate` 안에서 스냅샷 다음, APPLIED 마커 전에 정규화 행을 쓴다. 격리 `sourceId`는 쓰지 않는다.
- 테스트: `apps/api/test/notion-normalized-write.test.ts`. 구현 전 스위트 로드 실패, 구현 후 통과.

## 명령과 종료 코드

작업 트리: `/home/jm/orca/workspaces/ai-crm/notion-normalized-write`. node v24.19.0 (저장소 엔진은 22). 시각: 2026-09-30.

| 명령 | exit |
|---|---|
| 구현 전 `vitest run test/notion-normalized-write.test.ts` | 1 (모듈 없음) |
| `vitest` notion-normalized-write + same-transaction + commitment-due | 0 |
| `pnpm --filter @ai-crm/imports exec vitest run test/notion-workspace-id.test.ts` | 0 |
| `pnpm --filter @ai-crm/domain exec vitest run test/customer-work-os.integration.test.ts` | 0 |
| `pnpm --filter @ai-crm/reports exec vitest run test/customer-work-os-reports.test.ts` | 0 |
| `pnpm --filter @ai-crm/persistence exec vitest run test/schema.security.test.ts test/customer-work-os-schema.security.test.ts` | 0 |
| `pnpm run typecheck` | 0 |
| dry-run 재적용 스크립트 | 0 |

워커 SIGTERM 테스트는 실행하지 않음.

## Dry-run (`ai_crm_dryrun_20260930` @ 127.0.0.1:55433)

`current_database()`로 이름 확인. 운영 `ai_crm`에는 접속하지 않음. 0024는 이 DB에만 적용. `schema_migrations` 테이블은 이 DB에 없음.

실패 주입 (`participate` throw): snapshot version null, plan `APPROVED`, 정규화 9테이블 전부 0.

성공 적용 후 재쓰기 (`WHERE NOT EXISTS` / `ON CONFLICT DO NOTHING`)도 commit. P0001 없음. 건수 불변.

| 테이블 | 건수 |
|---|---|
| cwos_accounts | 45 |
| cwos_contacts | 0 |
| cwos_engagements | 35 |
| cwos_engagement_parties | 61 |
| cwos_activities | 13 |
| cwos_commitments | 25 |
| cwos_artifacts | 2 |
| cwos_financial_items | 8 |
| cwos_settlements | 5 |

plan `APPLIED`, snapshot version 1, workspace `75c2b088-e5aa-5396-9e9e-6dfd77e50048`. quarantined 39, price ledger 67, orphan 18. finance IN `9714000/971400/10685400`, OUT `87760000/8776000/96536000`.

## 롤백

이 브랜치를 안 쓰면 코드 롤백만. dry-run 데이터 삭제는 소유자 승인 범위. 승인 시 해당 `workspace_id`의 9테이블 DELETE. 스냅샷 jsonb는 남길 수 있다. 역마이그레이션은 두 칼럼 drop과 `due_at` NOT NULL 복구뿐이며, null 기한이 있으면 NOT NULL 복구는 실패한다.

## 미확인

- 운영 `ai_crm` 건수, 0024 적용, 정규화 쓰기: NOT_RUN.
- PR, merge, 배포: 하지 않음.
- CI의 워커 SIGTERM 테스트: NOT_RUN. 이 브랜치 수용 조건 아님.
- 독립 검증: 이 문서의 실행은 개발냥 재검사다. 검증냥 판정 아님.
