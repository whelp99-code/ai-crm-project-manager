# 검증 판정 — live overlay + deploy PR #26

대상: `whelp99-code/ai-crm-project-manager` PR #26, head `53b3dfbd3a87d936b9bbbef880d2901c60d6d648`, base `core5-c01-c02` (`d20b2a07`). 검증 문맥: `/tmp` 신규 clone (구현 트리와 분리). 라이브 유닛 재배포·재시작 없음. 검증 후 clone은 삭제. 출시 승인은 하지 않는다.

전체: **요청한 4항은 PASS**. 릴리스 게이트는 PASS. 일반 CI의 Node 20 잡 2건은 FAIL이며 이 diff 밖이다. 로컬 `pnpm test`는 실패 0, 스킵 54.

## 판정

| ID | 내용 | 판정 |
| --- | --- | --- |
| V1 | `53b3dfb` export vs 라이브 `app-53b3dfb` 소스 일치 | PASS |
| V2 | diff에 비밀 없음. env는 `~/.config/core5/app.env` | PASS |
| V3 | typecheck, `pnpm test`, `next build` | PASS (실패 0, 스킵은 분모에 표시) |
| V4 | deploy 스크립트: 백업→스위치, dump 실패 시 닫힘, 미적용 마이그레이션 거부, 롤백, 헬스 파서, 바인드, DB 쓰기 | PASS (드라이런 없음, 로컬 가짜 대상으로 재현) |
| V5 | 릴리스 게이트 | PASS |
| V6 | 일반 CI Node 20 package+e2e | FAIL (이 PR diff 아님, 로컬 미재현) |

분모: 요청 검사 6 ID 중 실행 6. NOT_RUN은 로컬 livepg 54건(CI 게이트가 별도로 실행)과 운영 재배포.

## 증거

V1. `diff -rq` exclude `node_modules` `.next` `build` `.deploy-sha`. 차이 1건: clone에만 `.git`. 라이브 `.deploy-sha`는 `53b3dfbd3a87d936b9bbbef880d2901c60d6d648`. 검증 중 라이브 `core5-api`/`core5-web` `ActiveState=active`, `WorkingDirectory`는 `app-53b3dfb`.

V2. `origin/core5-c01-c02..HEAD` 파일 9개 (`ops-boot.mts`, accounts/page/layout, contract tests, `ops/deploy-core5-live.sh`, `ops/core5-required-migrations.txt`, `docs/ops/core5-live-deploy.md`). 비밀 리터럴 없음. 이름(`AUTH_API_KEY`, `DATABASE_URL`)과 env 경로만 있다.

V3. Node `v22.23.2`. `pnpm run typecheck` exit 0. `pnpm test`: Test Files 83 passed, 19 skipped; Tests 754 passed, 54 skipped, 0 failed. `pnpm --filter @ai-crm/web build` exit 0 (Next 15.5.26).

V4. 스크립트에 `--dry-run` 없음. `bwrap`로 `/usr/bin/systemctl`을 로거로 가리고, throwaway Postgres `127.0.0.1:15433`(라이브 15432 아님), 실패 헬스 `127.0.0.1:18099`에서 스크립트 원문을 실행했다.

- dump 실패: `pg_dump`가 `127.0.0.1:1` 연결 거부로 exit 1. systemctl 로그 0바이트. clone dest 없음. 0바이트 dump 파일이 umask 077로 남음. 스위치는 없음.
- 백업 시각이 clone보다 앞섬 (throwaway dump 1698 bytes, mode 600).
- 미적용 `0019_customer_work_os_v2_runtime`: exit 1, `units not switched`, 유닛 파일 `cmp` 동일, systemctl 0바이트. 조회는 `SELECT id FROM schema_migrations`뿐. 스크립트 후 public 테이블은 그 1개만.
- 헬스 500: 10회 후 `did not become ready`, 롤백 로그, 유닛 `WorkingDirectory`가 이전 경로로 복구, stub `systemctl --user restart` 기록. exit 1.
- 계정 HTML: `<!--.*?-->` 제거 후 `계정 {count}` 비교. `계정 <!-- -->45`와 평문은 일치, 잘못된 수는 불일치. 한 줄 주석에 묶이지 않음. 여러 줄 주석은 DOTALL이 아니라 불일치 → 롤백(닫힘).
- 바인드: `ops-boot.mts`는 `127.0.0.1`. 웹 `ExecStart`는 `-H 127.0.0.1`. 이 diff에 `0.0.0.0` 없음. `ops/obs-stack-drill.sh`의 `0.0.0.0`은 이번 diff 밖.
- DB 쓰기: deploy 스크립트에 DML/DDL 없음. 부트 경로는 RLS `set_config` 후 SELECT만 COMMIT. 배포 스크립트가 마이그레이션을 적용하지 않음.

V5. Release Gate run `36677060740` conclusion success, head `53b3dfb`. Node 20/22 full regression, PG16 migration/RLS/restore, web build+E2E, dependency/capability security, zero open gate failures 모두 pass.

V6. CI run `36677060728`, `36677057061`의 Node 20 잡 fail. 로그: `pg-date-oid.livepg.integration.test.ts`, `node: bad option: --experimental-strip-types`, expected 0 got 9. 같은 워크플로 Node 22는 pass. 해당 테스트 파일은 이 PR diff에 없다. 로컬 `pnpm test`는 livepg를 스킵했다. 오버레이 결함으로 확정하지 않는다.

## 잔여

- 같은 SHA로 다시 배포하면 기존 `app-<short>` 때문에 백업 전에 거부한다. 마이그레이션 거부가 남긴 트리는 수동 제거가 필요하다.
- dump 실패 시 0바이트 파일이 남을 수 있다. 스위치는 하지 않았다.
- 롤백은 유닛 파일을 되돌리고 재시작한다. 새 트리를 지우지는 않는다. 롤백 재시작이 실패하면 ERR 트랩이 다시 탈 수 있다. 재시작 성공 경로만 재현했다.
- 문서 `docs/ops/core5-live-deploy.md`는 clone 다음 dump로 적혀 있다. 스크립트는 dump가 clone보다 먼저다. 동작이 더 닫혀 있다.
- 운영 재배포는 이 검증에서 하지 않았다. 코드 존재·로컬 테스트·CI 게이트 통과와 운영 사용은 별개다.
