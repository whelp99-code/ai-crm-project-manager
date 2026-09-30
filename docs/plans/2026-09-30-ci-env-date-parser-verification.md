# 검증 판정 — CI PG env + DATE 문자열 파서 PR #18

독립 클론 `/tmp/pr18-verify`, HEAD `e31f34bba777d363314b13fa1478b8d94a3f4c9f` (커밋 `4407ff3` `69264b1` `e31f34b`). 브랜치 `fix/ci-pg-rls-smoke-env`. `ai_crm`에는 쓰지 않았다. Notion은 호출하지 않았다. 검증냥은 출시를 승인하지 않는다.

전체: **PASS(범위 안)**. 필수 주장(스모크 env 정렬, 어휘 순 0024/0025, OID 1082 문자열 파서, `dateText`의 Date 거부, Asia/Seoul·UTC 달력일)은 재현됐다. 포트 5432 라이브 스위트와 배포된 core5-web/api 렌더는 이 커밋으로 실행하지 못했다.

## 판정

| ID | 내용 | 판정 |
| --- | --- | --- |
| C1 | `ci.yml` 서비스와 `pg-rls-smoke.sh` env | PASS(코드). 서비스 `POSTGRES_USER=ai_crm`. 스모크 스텝이 `PGUSER`/`PGPASSWORD`/`PGDATABASE`를 넘긴다. 스크립트는 이 셋이 비면 exit 2. 기본값으로 `ai_crm`에 붙지 않는다. `find … \| sort`로 0024/0025 포함 |
| C2 | 스모크 실행 | PASS. throwaway `postgres:16` `pr18-pg16`, `127.0.0.1:55432`, `PGUSER=postgres` `PGDATABASE=ai_crm`, `AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1`. `=== summary PASS=49 FAIL=0 SKIP=0 ===` exit 0. `schema_migrations`에 `0024_cwos_normalized_import_columns`, `0025_cwos_notion_sync`. 호스트 5432는 pilot이라 CI와 같은 포트는 쓰지 않음 |
| P1 | Pool/Client마다 파서 | PASS(제품 진입점) / 잔여 1곳. `app-base.ts` 3풀, worker `main.ts` 2풀, cwos ai/controls/identity/notion/runtime 팩토리, `notion-sync-scratch-proof.mts`는 `new Pool` 직전에 `installPgDateStringParser`. vitest `setupFiles`가 테스트 프로세스에서 같은 `pg` 모듈에 설치. `setTypeParser`는 모듈 전역이라 생성 순서만 맞으면 이후 쿼리에 적용 |
| P2 | `customer-work-os-v2-routes.ts` | 잔여. `new pg.Pool` 전에 설치 호출 없음. 이 풀의 SQL은 v2 snapshot jsonb라 DATE 컬럼을 읽지 않음. 재현된 렌더 결함은 아님 |
| P3 | 일일 러너 | 잔여, 재현된 일자 이동 없음. `/home/jm/.omo/omonyang/bin/core5-notion-scratch-sync.mts`는 파서를 설치하지 않는다. 비교 SQL이 `start_date::text`라 이번 불변 스냅샷 기준에는 파서 부재가 일자 비교를 바꾸지 않음. 러너는 이 PR 커밋이 아님 |
| P4 | Date를 기대하던 호출 | PASS. `toDateString`은 문자열이면 `slice(0, 10)`. `dateText`는 문자열이 아니면 throw. `instanceof Date` 분기는 timestamptz용이며 DATE가 문자열이면 그 분기를 타지 않음. web 앱 소스에 `start_date`/`startDate` 렌더 없음 |
| P5 | typecheck | PASS. `pnpm -r --if-present run typecheck` exit 0. Node v24.19.0 (engines는 22) |
| P6 | `TZ=UTC pnpm test` | PASS(허용 예외). 749 passed, 1 failed, 54 skipped. 실패는 `worker-start.integration.test.ts` SIGTERM 15s만 |
| P7 | `TZ=Asia/Seoul pnpm test` | PASS(허용 예외). 같은 749/1/54. 같은 SIGTERM만 |
| L1 | `pg-date-oid` 라이브 | PASS. throwaway `DATABASE_URL` `55432`. `2025-12-01`이 `::text` 없이 string. Asia/Seoul·UTC 둘 다 exit 0 |
| L2 | 라이브 PG 스위트 나머지 | BLOCKED. 각 파일이 스모크를 `PGPORT=5432`로 고정 호출. 5432는 `core5-crm-pilot-pg`. 재시도하지 않음. `customer-work-os-v2` 3 passed(스모크 없음). `q1-recon-pgfirst`는 이 때문에 NOT_RUN. 이슈 #19는 범위 밖이며 이번 실행으로 재확인하지 않음 |
| S1 | scratch 불변 스냅샷 | PASS. 덤프 `ai_crm-daily-20260930T131451.dump`를 `core5-crm-pilot-pg`의 `ai_crm_verify_pr18_date`에 복원 후 0025만 적용. 스냅샷 `notion-snapshot-20260930T041451Z.json`. `e31f34b` 코드, `TZ=Asia/Seoul`, 파서 설치, DATE는 `::text` 없이 읽음. 분류: marker 182, business 7건 모두 activity `account_id` (`activity-6fe54ca1` `7c8b8676` `39c8ca3d` `d047b442` `ba2e4334` `145dbaab` `65a4d9ff`). 적용 updates 189, inserts/archives/holds 0. 재실행 `alreadyApplied` updates 0. 프로브 `DATE '2025-12-01'`/`2026-01-01`은 Seoul·UTC 모두 문자열 달력일. scratch DROP 확인. `ai_crm` 유지 |

## 배포된 앱

core5-web/core5-api는 `app-64d38ea`로 active. 이 트리는 `e31f34b`가 아니다. 라이브 UI 날짜 렌더는 NOT_RUN. 코드상 web은 DATE 필드를 그리지 않고, v2 state는 jsonb다. 이 커밋을 배포하지 않았으므로 "사용됨"이 아니다.

## 잔여

- 호스트 5432 라이브 스위트, worker live-pg, 배포 렌더, `q1` 재확인: NOT_RUN/BLOCKED.
- v2 라우트와 일일 러너는 파서 설치가 빠져 있다. 현재 SQL은 DATE를 직접 파싱하지 않거나 `::text`를 쓴다.
- 출시 승인은 하지 않는다.
