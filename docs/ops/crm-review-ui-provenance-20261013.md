# CRM review-ui 출처와 실제 후보 화면 편입

TASK-CRM-REVIEWUI-PROVENANCE-20261013.
[Issue #64](https://github.com/whelp99-code/ai-crm-project-manager/issues/64).
기준: 2026-10-13, `jm-omachy`.
이 PR은 준비와 합성 데이터 검증용이며 운영 전환을 수행하지 않는다.

## 운영 파일의 출처 확정

| 항목 | 읽기 전용 실측 |
| --- | --- |
| 서비스 | `core5-review-ui.service`, active/running, PID `20477` |
| 실제 Node | `/home/jm/.nvm/versions/node/v22.23.2/bin/node` |
| 실제 cwd | `/home/jm/orca/projects/shipping-harness/ci/core5` |
| 실행 파일 | `h03/review-server.mjs`, 1,753 bytes |
| 유효 override | `~/.config/systemd/user/core5-review-ui.service.d/91-migrate.conf` |
| listener | `127.0.0.1:4174` |
| Git blob | `306ab775b983392529553ab6cb4fb05878c59c0f` |
| SHA-256 | `72bc9fe310decee09f81d95f37a413a9854e2e85acf2de4f49d9597028011504` |
| 도입 커밋 | shipping-harness `2e30a3089f6e6d38227f0b941f556bbbee438edd` |
| 기록된 main | shipping-harness `bec97ca104780af8182465bf8d16e3a82102cd6a` |

[도입 커밋의 원본](https://github.com/whelp99-code/shipping-harness/blob/2e30a3089f6e6d38227f0b941f556bbbee438edd/ci/core5/h03/review-server.mjs)과
[기록된 main의 원본](https://github.com/whelp99-code/shipping-harness/blob/bec97ca104780af8182465bf8d16e3a82102cd6a/ci/core5/h03/review-server.mjs)을
GitHub API로 각각 가져와 메모리에서 decode했다. 두 원본의 크기, Git blob,
SHA-256이 운영 파일과 모두 일치했다. `.git`이 없는 현재 운영 복사본의
디렉터리 이름이나 기억에만 의존한 추정이 아니다. 해당 **파일**의 출처가
확정된 것이며, 전체 shipping-harness 디렉터리의 배포 커밋이나 과거
Node 메모리 이미지를 단정하지 않는다.

재현 조회:

```sh
systemctl --user show core5-review-ui \
  -p MainPID -p WorkingDirectory -p FragmentPath -p DropInPaths
readlink /proc/20477/exe /proc/20477/cwd
sha256sum "$HOME/orca/projects/shipping-harness/ci/core5/h03/review-server.mjs"
git hash-object "$HOME/orca/projects/shipping-harness/ci/core5/h03/review-server.mjs"
gh api 'repos/whelp99-code/shipping-harness/contents/ci/core5/h03/review-server.mjs?ref=2e30a3089f6e6d38227f0b941f556bbbee438edd' --jq '{sha,size}'
gh api 'repos/whelp99-code/shipping-harness/contents/ci/core5/h03/review-server.mjs?ref=bec97ca104780af8182465bf8d16e3a82102cd6a' --jq '{sha,size}'
```

비밀 환경파일, 키, 실제 메일·후보 본문은 출력하지 않는다.

## 정적 helper와 실제 후보 화면의 차이

| 표면 | 기존 동작 | 이 PR의 준비 |
| --- | --- | --- |
| 기존 `h03/review-server.mjs` | Basic key 보호, 고정 HTML. Reject는 브라우저 글자만 변경하며 API 호출/저장이 없음 | 출처 근거로 기록하고 운영 파일은 그대로 둠 |
| `core5-web`의 `/v2/mail-candidate-review` | 실제 목록과 LINK/UNDO, owner 로그인·CSRF 연결 | 화면·인증·검토 API를 그대로 재사용 |
| 새 `core5-review-ui` 실행 방식 | 아직 운영 미전환 | 동일 CRM release의 Next 앱을 별도 포트로 실행, `CRM_REVIEW_UI=1`로 `/`를 후보 화면에 연결 |

원래 증상은 Mail 후보 API가 정적 helper에 연결되지 않은 것이었다.
Mail 팀의 운영 후보 다섯 건 관측은
[mail-intelligence Issue #45 댓글](https://github.com/whelp99-code/mail-intelligence/issues/45#issuecomment-6138357374)을
참고한다. 이 작업은 그 실제 후보를 조회하거나 변경하지 않고 합성 후보
다섯 건으로 검증한다.

실제 경로:

```text
review-ui Next instance: /
  -> native login (if no valid owner session)
  -> /v2/mail-candidate-review
  -> GET /api/self-entry (validated CSRF/session details)
  -> GET /api/cwos/v2/mail-candidate-review
  -> POST same route: LINK or UNDO
  -> existing core5 API -> authorized versioned domain command/store
```

근거 코드: `apps/web/app/v2/mail-candidate-review/page.tsx`,
`review-client.tsx`, `apps/web/app/api/cwos/v2/mail-candidate-review/route.ts`,
`apps/web/app/lib/owner-review.ts`,
`apps/api/src/customer-work-os-v2-routes.ts`.
계정 목록은 기존 workspace-scoped projection을 사용한다. 브라우저에
API key를 전달하지 않고 기존 HttpOnly owner proof, Origin, CSRF,
idempotency 및 expectedVersion 경계를 유지한다.

새 `/` 진입 분기만 서버에서 추가한다. `CRM_REVIEW_UI`가 없는 기존 웹의
고객 overview는 유지한다. 새 별도 로그인, Basic 우회, CSRF 우회,
후보 응답 mock을 제품 코드에 넣지 않는다.

## 합성 검증 실행

```sh
pnpm --filter @ai-crm/web test:e2e:review-ui
```

전용 scenario는 기존 fail-closed 기본 e2e와 분리된 config에서 실행한다.
실제 Fastify 인증·후보 routes, 버전이 있는 in-memory domain store와
다섯 개 합성 후보를 사용한다. normalized 계정 조회만 기존 API 테스트와
같은 workspace-scoped 합성 projection으로 공급한다. LINK/UNDO 응답이나
후보 목록을 브라우저에서 가로채지 않는다. 이 검증은 운영 DB의 영속성
인수를 대신하지 않는다.

이 명령은 제어 파일 계약 검사와 전용 scenario를 실행하며 두 CI workflow의
필수 단계에도 연결되어 있다. 후보 저장소는 매 시도마다 교체·재시드한다.
`PLAYWRIGHT_BASE_URL`로 소유한 외부 loopback 시험 서버를 사용하려면
그 서버가 작성한 `PLAYWRIGHT_FIXTURE_DIRECTORY`도 명시해야 한다.
디렉터리 0700, 파일 0600, 현재 사용자 소유, 비-symlink, 정확한 webOrigin을
확인한다. 누락·불일치는 로그인 전에 거부하며 외부 디렉터리는 teardown이
삭제하지 않는다. 운영 로그인이나 운영 제어 파일을 사용하는 설정이 아니다.

## 공통 릴리스 배포 준비

`deploy/crm-deploy-review-ui.sh`는 기존 1cf5 준비 방식의 세 서비스용
후속이다. PR #63은 아직 미병합이므로 그 파일에 실행 의존성을 두지 않는다.
이번 작업에서 이 스크립트의 승인 모드를 운영에 실행하지 않는다.

| 서비스 | 전환 후 WorkingDirectory | 실행 |
| --- | --- | --- |
| API | `app-<target8>/apps/api` | 기존 API boot |
| web | `app-<target8>/apps/web` | 기존 Next, loopback4313 |
| review-ui | 같은 `app-<target8>/apps/web` | 같은 Next build, loopback4174, `CRM_REVIEW_UI=1` |

운영자는 Cursor가 검수한 **전체 40자리 커밋**을 `CRM_TARGET_SHA`로 지정한다.
현재 master `1cf53882`에는 새 진입 모드가 없으므로 그 SHA를 그대로 쓰면
거부한다. 대상은 기준 master의 후손이어야 하고, 새 진입 모드와 SQL delta0을
확인한다. 임의의 floating master를 자동으로 배포하지 않는다.

필수 준비:

- `CRM_WEB_ORIGIN`: 기존 web의 승인된 HTTPS origin.
- `CRM_REVIEW_WEB_ORIGIN`: review-ui의 승인된 HTTPS origin. 기존 HTTP4174
  주소를 그대로 production 로그인 origin으로 사용할 수 없다.
- `OPERATOR_AUTH_API_BASE_URL`: 기존 private identity API HTTPS origin.
- `CWOS_V2_OPERATOR_AUTH_STATE_PATH`: 대표가 직접 등록한 새 private bcrypt
  상태. [기존 owner 등록 절차](crm-own-login.md#owner-run-first-enrollment)를
  따르며 기존 state/signing key를 보존한다. 에이전트는 등록하지 않는다.

review-ui는 web과 같은 app/human EnvironmentFile과 API/principal 설정을
사용한다. 기존 review용 Basic key 파일을 읽거나 복사하거나 새 키로
교체하지 않는다. 새 `92-crm-release.conf`에서 이전 EnvironmentFile/ExecStart
목록을 재설정하고 Next를 실행한다. 각 unit의 의도한 값은 release 안의
mode600 환경파일을 마지막 `EnvironmentFile=`로 붙여 적용한다.
API 인증 경로뿐 아니라 review origin도 공유 env 파일보다 우선한다.
기존 `91-migrate.conf`와 human env/auth state/key는 수정하지 않는다.

```sh
# 준비 검토만: 전환 없음
bash deploy/crm-deploy-review-ui.sh --help

# 아래는 별도 운영 승인 이후에만 실행하며, 이번 작업에서 실행하지 않는다.
# CRM_TARGET_SHA에는 위 조건을 충족하는 검수된 실제 40자리 커밋을 지정한다.
: "${CRM_TARGET_SHA:?set the reviewed full SHA}"
CRM_DEPLOY_APPROVAL=approved CRM_TARGET_SHA="$CRM_TARGET_SHA" bash deploy/crm-deploy-review-ui.sh
```

스크립트는 고정 archive를 준비하고, 타깃 실행 전에 private custom-format
DB dump의 streaming hash/catalog와 password-free role 정의를 보관하고,
네트워크 없는 임시 PostgreSQL에 role·schema·data를 실제 복원한다.
`pg_restore --exit-on-error --single-transaction --no-owner` 성공 뒤에만
BACKUP_OK를 내고 frozen install/build를
운영 비밀 없는 환경에서 수행하고 세 override의 내용·권한·존재
여부를 snapshot한다. 모든 snapshot이 완료된 뒤에만 롤백을 활성화하고
전환한다. 각 서비스의 startup event를 별도로 구독하며 web의 Ready 하나를
review-ui 기동으로 간주하지 않는다. health, 두 로그인 origin, 무인증
후보 API의 `401 STEP_UP_REQUIRED`도 확인한다. 로그인한 상태의 LINK/UNDO
최종 인수는 대표의 후속 단계다.

성공 판정은 세 unit의 `is-active --quiet`를 **각각** 호출하고, 각
MainPID의 실효 환경값을 비교한 뒤에만 내린다. API 인증 경로와 web/review
origin을 사전 Node 환경만으로 확인하지 않는다. `/proc/<MainPID>/environ`의
필요 키만 비교하며 비밀이나 환경 본문은 출력하지 않는다.
설정된 WorkingDirectory와 실제 MainPID cwd도 새 릴리스여야 한다.
review는 릴리스 내부 Next 실행 파일을 직접 사용하고 실효 ExecStart의
executable/argv가 정확히 일치해야 완료된다.

### 롤백

오류 시 API90, web90, review92를 모두 원래 내용/권한으로 복원한다.
원래 review92가 없었다면 제거하여 그대로 남아 있던91의 정적 helper로
돌아간다. 세 서비스를 함께 reload/restart하되 활성 여부는 각각 검사하고,
전환 전의 실효 환경값도 복구됐는지 확인한다. 하나만 살아 있는 상태를
`CRM_ROLLBACK_OK`로 처리하거나 새 release를 지우지 않는다. SQL 변경을
허용하지 않으므로 운영 DB를 자동 restore하지 않는다. 복원 검증용 임시
DB/container는 종료·중단 시 제거한다.
복구도 예상 WorkingDirectory/MainPID cwd, 원래 review executable/argv,
API `/health`·`/ready`, e91 web4313의 `/`200,
옛 review4174의 `/` Basic401 challenge를 통과해야 완료다.
Basic realm과 공개 응답 본문도 원본과 비교하며 운영 키를 읽거나 보내지 않는다.
새 `/login`·self-entry·후보 인증 계약은 새 릴리스 검사에만 적용한다.
PID·start_time 같은 가변 필드는
실행 명령 비교에서 제외한다. 503 또는 경로 불일치는 복구 실패이며
새 release와 backup을 보존한다.

SIGHUP/SIGINT/SIGTERM은 진행 중인 소유 process group을 종료하고 close를 기다린
뒤 직렬로 롤백한다. 복구 중 반복 신호는 복구를 끊지 않으며 완료 후
exit129/130/143으로 끝난다. 원래 없던 review92는 중단 복구에서도 제거된다.
TERM 뒤 5초에도 끝나지 않는 소유 그룹에는 SIGKILL을 보내고 close를
확인한다. 반복 요청은 이 시한을 늘리지 않는다.

backup 디렉터리에는 `api90`, `web90`, 선택적 `review92`와 각각의 `.meta`,
DB dump가 있다. `.meta`가 `absent`이면 원래 파일이 없었고, 나머지는
원래 octal mode다. 수동 복구도 이 구분을 지켜야 한다. `absent`인데
과거 다른 backup의 review92를 복사하면 기존 실행 경로로 돌아가지 않는다.

`CRM_ROLLBACK_FAILED`이면 새 release와 backup을 보존하고 운영자 복구가
필요함을 표시한다. `CRM_CLEANUP_FAILED`도 실패로 보고하며 정리 오류를
숨기지 않는다. 운영자는 해당 실행의 정확한 backup만 사용해 세 파일을
복원한 뒤 서비스 상태와 e91/legacy cwd를 확인한다. 이 PR에서 운영
복구 명령이나 서비스 재시작을 실행하지 않는다.

## 검증 결과

| 확인 | 결과 |
| --- | --- |
| web `tsc --noEmit`, 수정 TS/Shell LSP | PASS, 오류 없음 |
| 기존 Mail 후보 API security suite | 4/4 PASS |
| 전용 review-ui browser scenario | 2/2 PASS: 실제 로그인, 다섯 후보, LINK/UNDO 재조회, CSRF/Origin 거부 |
| 기존 Mail 후보 web e2e | 4/4 PASS, fail-closed 계약 유지 |
| lead 직접 omowright 브라우저 | 목록 version9 → LINKED version10 → UNDONE version11, reload 후 유지 |
| lead 직접 무CSRF 요청 | `403 OPERATOR_CSRF`, version11 및 전체 후보 상태 불변 |
| 1440px / iPhone14 390px | 로그인·OTP·목록·LINK·UNDO, 모바일 조작부/목록 끝 확인. 가로 overflow 없음 |
| 배포 script 문법/CLI | Bash/내장 Node syntax PASS, 승인 없음 exit1, 잘못된 인수 exit64 |
| 초기 격리 배포/복구 | 6/6 PASS였으나 네 배포 경계 결함을 놓침. 아래 커밋된 회귀 시험으로 보완 |

브라우저 결과를 mock하지 않았다. 최종 전용 테스트는 root에서 이동한
로그인 화면의 **동일 origin**에서 인증하며, 성공 응답뿐 아니라 reload 뒤
실제 GET 상태와 LINKED→UNDONE 이력도 검사한다. Next15의 loopback host
정규화 때문에 전용 합성 fixture의 browser origin은 `localhost`로 통일했다.
production의 승인된 HTTPS origin 검사는 변경하지 않았다.

이번 검증에서 배포 probe의 잘못된 기대값도 발견해 고쳤다. 무인증
후보 요청은 route보다 앞선 middleware가 `401 STEP_UP_REQUIRED`로
막는다. 인증 없는 요청으로 route의 Origin403을 기대하지 않는다.
인증된 교차 Origin403은 별도 실제 browser scenario에서 검증한다.

증거 디렉터리:
`~/.local/state/omonyang/TASK-CRM-REVIEWUI-PROVENANCE-20261013/evidence/`.
`action-log.json`과 `login-desktop-final.png`, `otp-desktop.png`,
`queue-desktop.png`, `linked-desktop.png`, `undone-desktop.png`,
`queue-mobile-{top,controls,end}.png`를 보존했다. 사진과 로그는 합성 데이터만
포함한다. 이전 origin 진단용 `login-desktop.png`는 최종 판정 자료가 아니다.

격리 배포 QA:

```sh
"$HOME/.nvm/versions/node/v22.23.2/bin/node" \
  "$HOME/.local/state/omonyang/TASK-CRM-REVIEWUI-PROVENANCE-20261013/deploy-qa.mjs"
```

실제 script/Git archive/file I/O를 사용하고 systemctl/docker/pnpm/curl만
격리한다. DB dump는 합성 bytes이며 실제 DB backup/build/운영 전환을
증명하지 않는다. 여섯 sandbox와 별도 Git index는 모두 정리됐다.
운영 키 생성·실제 후보 변경·외부 발송은 하지 않았다.

최종 운영 재조회에서도 API/web/review-ui PID는 각각
`20475`/`20478`/`20477`, cwd와 active/running 상태는 시작 전 그대로였다.
legacy helper의 SHA-256도 동일했다. QA browser/profile과 임시 인증
디렉터리를 정리했고 합성 web 포트38993은 닫혔다. 실제 운영은 여전히
기존 정적 helper이며, 기능 반영은 PR 검수와 별도 배포 승인 이후다.

## 첫 Cursor REJECT 배포 경계 수정

초기 격리 QA는 다중 unit의 ANY-active 결과와 EnvironmentFile 우선순위를
충분히 모델링하지 못했다. 커밋된 `deploy/test` fixture는 이 두 동작을
그대로 재현하며, 실제 OS 신호와 대용량 dump를 실제 script에 전달한다.

```sh
CI=1 PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH" \
  pnpm exec vitest run deploy/test/crm-deploy-review-ui.integration.test.mjs \
  --reporter=verbose --no-color
```

회귀 범위: 세 서비스 각각의 단독 실패(성공/롤백), 첫 쓰기와 실행 중
자식에서의 SIGINT/SIGTERM 및 반복 신호, 새 인증 경로·review origin의
실효값과 원본 env 보존, 건강 probe가 성공해도 stale 값이면 롤백,
256MiB dump의 길이/hash/catalog/RSS, 빈 dump와 catalog 실패.
실제 운영 실행이나 운영 DB 백업을 대신하는 시험은 아니다.

수정 전 **14 실패 / 2 통과**, 수정 후 **16/16 통과**.
256MiB dump 최대 RSS는 **332,856KiB → 108,208KiB**였으며,
192MiB 상한과 전체 길이·SHA-256·catalog 입력 일치 검사를 통과했다.
별도 실제 격리 CLI SIGTERM 검사도 exit143, signal=null, rollback=complete,
소유 자식 0개였다. Shell/내장 Node 문법·LSP·승인/인수 거부 검사가 통과했다.

API/web/review-ui의 운영 PID·경로는 계속 `20475`/`20478`/`20477`과
기존 e91/legacy 경로로 유지됐다. fixture 디렉터리와 소유 프로세스를
정리했다. UI·로그인·CSRF 구현은 이번 배포 경계 수정에서 바꾸지 않았으며
운영 실행·키 생성·실제 후보 변경은 하지 않았다. CI/Bugbot 사용량 한도는
별도 상태로 남으며 로컬 검증으로 해결됐다고 주장하지 않는다.

## 두 번째 Cursor REJECT 수정

`Environment=` 원문 줄을 review drop-in에 복사하지 않는다. 기준 web
MainPID에서 이름이 지정된 `API_BASE_URL` 값만 읽어 마지막 mode600
환경파일에 넣는다. principal/origin 등은 이미 검증된 지정 값으로
구성한다. 여러 assignment의 인용 방식이나 순서 때문에 비밀이 mode0644
파일로 따라오는 경로를 없앴다. 새 API 값도 재시작 후 실효값 검사에 포함된다.

끝 LF가 없는 API/web drop-in에는 LF를 보충해서 새 directive를 구분한다.
SIGHUP도 기존 복구 경로를 거치며, 롤백은 LF 유무·권한·review92 부재를
그대로 되돌린다.

#63과 같은 `CRM_UNIT_ROOT/.crm-deploy.lock`의 배타 flock을 기준 검사
전부터 정리 완료까지 유지한다. 다른 target의 승인된 실행도
`deployment_in_progress`로 거부하며, lock 파일을 삭제하지 않는다.
inode나 target별 잠금으로 우회되는 구조가 아니다.

```sh
CRM_DEPLOY_TEST_NODE="$HOME/.nvm/versions/node/v22.23.2/bin/node" \
CI=1 PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" \
  pnpm exec vitest run deploy/test/crm-deploy-review-ui.integration.test.mjs \
  --reporter=verbose --no-color
# Node 22 행에서는 PATH를 v22.23.2로 바꾼다.
```

Git은 sandbox 경계로 모델링하고 실제 tar/script/file I/O/OS 신호/flock을
실행한다. 호스트 이력에 기대지 않으며 생산 source pin과 Node 22 제한은
유지한다. CI는 별도 Node 22 경로를 저장한 뒤 기존 Node 20/22 시험기로
복귀한다. checkout depth나 행렬을 바꾸지 않았고 deploy 경로도 게이트에 포함했다.

| 검증 | 결과 |
| --- | --- |
| 수정 전 | 8 실패 / 19 통과: HUP 2, LF 1, 경합 2, 혼합 Environment 3 |
| 작업 checkout Node 20 / 22 | 각각 27/27 통과 |
| 실제 depth 1 Node 20 / 22 | 각각 27/27 통과 |
| shallow 조건 | 커밋 수 1, f1/1cf/e91 객체 없음; 실행 파일 7개 blob 일치 |
| 실제 중복 실행 CLI | 이전 두 실행 exit0 → 첫 실행만 exit0, contender exit1, 실제 잠금 유지 |
| 실제 혼합 설정 CLI | 정상 exit0을 유지하면서 공개 파일의 합성 비밀 포함 true → false |
| #63↔#65 교차 실행 | 두 방향 모두 HUP exit129, contender 차단, 정확한 복원, 잠금 해제, 소유 자식 0개 |

비밀 시험은 기본값과 다른 API endpoint를 넣고 인용/비인용/secret-first
세 가지를 검증한다. 값은 로그에 출력하지 않는다. 256MiB dump도 네 행에서
통과했다. shell/내장 Node 문법·shell/JS 진단과 승인/인수/생산 Node 20 거부
검사도 통과했다. YAML LSP 미설치는 남아 있으며 PyYAML 구문·구조 검사로
확인했다. UI·로그인·CSRF·운영 서비스는 이 작업에서 실행하거나 바꾸지 않았다.

## 세 번째 Cursor REJECT 수정

Node 20/22 시험기에서 각각 **42/42** 통과했다. 수정 전에는 16건이
실패했다. 기존 회귀는 유지하며 다음 실제 경계를 추가했다.

| 경계 | 근거 |
| --- | --- |
| TERM 무시 그룹 | 실제 부모/후손이 TERM 무시, 실제 SIGKILL 종료 이벤트, HUP exit129·복원·생존 자식 0 |
| 복구 준비 상태 | health/ready 각각 503이면 OK 금지 및 복구 자료 보존 |
| 실효 경로 | 세 서비스의 늦은 override와 stale process cwd 거부; 복구 cwd 불일치도 실패 |
| 타깃 실행 경계 | 검증된 dump가 모든 pnpm 호출보다 앞섬; install/build의 운영 비밀 노출 0, 합성 DB 버전 보존 |
| 인증 파일 | realpath 및 dev/inode 비교; `..`/부모 symlink/hardlink alias 모두 거부 |
| review 실행 | 릴리스 내부 `node_modules/next/dist/bin/next` 직접 실행; 늦은 legacy ExecStart는 LIVE 거부 |

privileged auth validator도 백업 이후에만 실행한다. install/build의
환경은 격리 HOME과 PATH/NODE_ENV/CI/NEXT_PUBLIC_API_BASE_URL뿐이다.
새 auth 파일은 문자열이 달라도 같은 실제 파일이면 사용할 수 없다.

독립 CLI:
`~/.nvm/versions/node/v22.23.2/bin/node ~/.local/state/omonyang/TASK-CRM-63-FIX3-20261013/manual-qa.mjs review`.
7개 시나리오가 통과했고 각 실행의 생존 자식 수는 0이었다.

추가 실제 표면 검증: 깨끗한 격리 소스와 운영 변수 없는 `env -i`에서
Next build 성공(static pages 16/16, exit0). 그 산출물의 절대 Next 엔트리로
임시 포트33625를 기동해 `/login` HTTP200을 확인하고 서버를 종료했다.
본문은 `~/.local/state/omonyang/TASK-CRM-63-FIX3-20261013/isolated-login.html`
에 보존했다. 이 생성 HTML의 Next inline-script 스타일 진단은 원문을
바꾸지 않고 남겼다. 저장소 shell/JS 진단·문법은 통과했다.
운영 전환, 실제 DB backup, 대표 인증 또는 후보 변경은 실행하지 않았다.

## 네 번째 Cursor REJECT 수정

성공과 롤백은 동일한 `verifyRuntime`을 호출한다. API health/ready200,
세 unit 각각 active, 기대 실효 환경, 설정 WorkingDirectory와 MainPID cwd,
review executable/argv까지 모두 통과해야 한다. 옛 review 경로·명령은
복구용 기대값으로 전달하고, 새 릴리스에서는 릴리스 내부 Next 명령을 전달한다.

API HTTP에는 연결 거부 재시도를 적용했다. 간격 1초, 최대 120회,
재시도 시작 기한 120초이며 각 전송 상한 10초를 유지한다. 성공 경로의
startup 구독도 유지한다. Type=simple restart 반환 직후 연결 거부가
나더라도 이 검사로 기동을 기다린다. 실패하면 `ROLLBACK_INCOMPLETE`와
기존 `CRM_ROLLBACK_FAILED`를 출력하고 release/backup 및 실패 marker를 보존한다.

수정 전 **11 실패 / 36 통과**, 수정 후 Node 20/22 각각 **47/47 통과**.
실제 `/usr/bin/curl`의 연결 거부 이벤트 뒤에만 loopback 서버를 열어
native retry가 health/ready200을 받는 것을 확인했다. 고정 sleep은 없다.
그 후에도 복구 환경이 잘못되면 완료하지 않는다. 세 서비스의 비활성·cwd
불일치, `/health`·`/ready`503과 review 실행 명령 불일치도 실패·보존을 확인했다.

독립 CLI:
`~/.nvm/versions/node/v22.23.2/bin/node ~/.local/state/omonyang/TASK-CRM-63-FIX4-20261013/manual-qa.mjs review`.
13건 PASS. 같은 디렉터리 `review-receipts.json`에 실제 응답 상태·헤더·본문,
복원/보존과 생존 자식0·포트 종료를 기록했다. `review-node20.log`와
`review-node22.log`는 전체 회귀 완료 기록이다.

shell/내장 Node 문법·저장소 진단과 승인/인수 거부도 통과했다.
외부 QA 디렉터리의 TypeScript 미설치로 LSP 대신 Node 문법·실행을 검증했다.
운영 실행은 하지 않았다. 원격 CI는 로컬 PASS와 다르며, 확인한 #63 새 head의
Actions annotation은 결제/사용량 제한으로 job 미시작, Bugbot은 usage limit였다.

## 다섯 번째 Cursor REJECT 수정

모든 forward HTTP/runtime probe를 `verifyRuntime`에 모았다. 복구도 같은
API·두 웹 포트·Origin·후보 인증·active·환경·cwd·review 실행 명령을 검사한다.
과거 e91과 Basic 정적 helper가 이 HTTP 계약을 충족한다고 가정하지 않는다.
원복했더라도 계약 미충족이면 INCOMPLETE와 자료 보존이며 검사를 생략하지 않는다.

백업 검증은 실제 복원을 포함한다. PostgreSQL 16.11에서 목차가 읽히는
반쪽 archive는 거부되고 정상 archive의 RLS와 합성 2,000행은 복원됐다.
Docker socket 권한이 없어 권한을 바꾸지 않고 소유 경로에 빌드한 native
16.11로 같은 SQL/restore 절차를 검증했다. Docker daemon 기동 자체는
이 호스트에서 검증하지 못했다.

여섯 runtime 경로는 force-dynamic이며 public 빌드 설정을 빈 값으로
덮어쓰지 않는다. manifest에 해당 경로가 static이면 전환 전에 거부한다.
운영 설정 없는 실제 production build 후 합성 runtime 설정만 넣어
소유 브라우저에서 1440/390, light/dark 24캡처를 확인했다.
구성된 화면과 무가로넘침을 확인했고 직접 LINK version10, UNDO version11을
reload·GET 이력으로 확인했다. production build를 사용하되 loopback
합성 인증만 NODE_ENV=test였으며 운영 인증은 실행하지 않았다.

| 최종 로컬 검증 | 결과 |
| --- | --- |
| 배포 회귀 Node 20/22 시험기, SUT Node 22 | 각각 73/73 |
| 별도 실제 curl 복구 | 4313/4174 콜드·503·Origin 총 6/6 |
| web typecheck / production build | PASS |
| 기존 e2e / 필수 review scenario | 19/19, 3/3; 정상 실행 flaky 없음 |
| 외부 소유 production 서버의 review scenario | 3/3 |
| 외부 제어 파일 누락 / origin 불일치 | 테스트·로그인 전 결정적 거부 |
| 실제 post-LINK 실패·Playwright retry | 다음 시도에서 다섯 pending, 빈 history 복원 |
| CI YAML 구조 | 두 workflow 모두 조건 없는 필수 단계; YAML LSP 미설치는 구조 파싱으로 보완 |

재시도 증거만을 위한 의도적 실패 probe는 검증 후 저장소에서 제거했다.
커밋되는 store 격리 회귀는 첫 시도에 통과한다. 기존 콜드 fixture는
readiness 경로에만 적용해 새 인증 probe 응답을 잘못 200으로 만들지 않는다.

근거: `~/.local/state/omonyang/TASK-CRM-63-FIX5-20261013/`의
`review-browser-evidence.json`, `review-node20.log`, `review-node22.log`,
`review-real-restore.log`, `review-native-curl.log`, `review-web-e2e.log`,
`review-external-retry.log`, `review-external-refusals.log`.
운영 서비스·DB·인증 상태·실제 후보는 수정하지 않았다.

## 여섯 번째 Cursor REJECT 수정

FIX5의 같은 HTTP 목록 적용은 건강한 옛 릴리스까지 거부했다. 현재는
`releaseContracts`의 target/baseline을 명시해 `verifyRuntime`에 전달한다.
공통 active, API health/ready, 실효 환경, 설정/실제 cwd, review 실행 명령은
양쪽에서 그대로 확인한다.

| 계약 | 실제 검사 |
| --- | --- |
| target | 4313/4174 login200, self-entry INPUT_INVALID400·외부 Origin403, 후보 인증401 |
| baseline web | e91의 실제 `/`200; 없는 login/self-entry를 요구하지 않음 |
| baseline review | 정적 helper `/`401, `Basic realm="Core5 review"`, 공개 body 일치 |

근거는 e91 `apps/web/app/page.tsx`와 앞에서 출처를 확정한 shipping-harness
helper 원본이다. helper는 URL을 구분하지 않는 Basic catch-all이며 공개
health 예외가 없다. 무인증 `/`200은 정상 계약이 아니므로 거부한다.
운영 Basic 키를 새로 수집해 인증시키는 방식은 쓰지 않는다.

프로세스 종료는 리더의 close가 아닌 그룹 생존 여부로 판단한다.
리더가 TERM에 종료해도 손자가 남으면 원래 5초 SIGKILL 기한을 유지하고,
watcher/child 정리가 그 종료 수명을 기다린다.

전환과 복원의 drop-in은 같은 디렉터리의 배타적 private temp에 전체
내용을 쓴 뒤 권한 적용, file sync, rename, directory sync를 거친다.
temp는 `.conf`가 아니므로 systemd가 읽지 않는다. 원래 없던 review92는
unlink 후 directory sync한다. 개별 파일 교체의 원자성이며 여러 파일의
자동 전원 장애 복구 프로토콜을 새로 구현한 것은 아니다.

회귀는 실제 리더 선종료·TERM 무시 손자, 전환/복구 각각의 partial-write·
rename 직전·직후 SIGKILL, 옛 계약만 제공하는 HTTP 서버를 사용한다.
원자성은 7건 red 후 수정됐고, 기존 event.args 계약 누락도 전체 시험이
잡아내 수정했다. 새 계약의 Origin/후보 인증 검사는 target 실패 시험으로
유지했다. 이전 e2e·UI·실제 DB 복원 구현은 변경하지 않았다.

독립 재현:
`node ~/.local/state/omonyang/TASK-CRM-63-FIX6-20261013/group-proof.mjs review`,
`atomic-proof.mjs review`, `legacy-proof.mjs review` (Node 22).
근거와 인수 결과는 같은 FIX6 디렉터리 및
`/tmp/ulw-20261013-214248.rrdKKV.md`에 보존한다.
최종 Node 20/22 시험기에서 각각 **85/85**, 독립 CLI **12/12**
(그룹 2, 원자성 7, 옛 HTTP 계약 3)가 통과했다. 디렉터리 단위 JS와
shell 진단, 내장 Node 문법도 통과했다.
운영 전환·재시작·DB/인증/실제 후보 변경은 실행하지 않는다.
