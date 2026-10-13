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
pnpm --filter @ai-crm/web exec playwright test \
  --config playwright.review-ui.config.ts
```

전용 scenario는 기존 fail-closed 기본 e2e와 분리된 config에서 실행한다.
실제 Fastify 인증·후보 routes, 버전이 있는 in-memory domain store와
다섯 개 합성 후보를 사용한다. normalized 계정 조회만 기존 API 테스트와
같은 workspace-scoped 합성 projection으로 공급한다. LINK/UNDO 응답이나
후보 목록을 브라우저에서 가로채지 않는다. 이 검증은 운영 DB의 영속성
인수를 대신하지 않는다.

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
CRM_DEPLOY_APPROVAL=approved bash deploy/crm-deploy-review-ui.sh
```

스크립트는 고정 archive 한 개, frozen install/build 한 번, private
custom-format DB dump의 streaming hash/catalog 확인 후에 세 override의 내용·권한·존재
여부를 snapshot한다. 모든 snapshot이 완료된 뒤에만 롤백을 활성화하고
전환한다. 각 서비스의 startup event를 별도로 구독하며 web의 Ready 하나를
review-ui 기동으로 간주하지 않는다. health, 두 로그인 origin, 무인증
후보 API의 `401 STEP_UP_REQUIRED`도 확인한다. 로그인한 상태의 LINK/UNDO
최종 인수는 대표의 후속 단계다.

성공 판정은 세 unit의 `is-active --quiet`를 **각각** 호출하고, 각
MainPID의 실효 환경값을 비교한 뒤에만 내린다. API 인증 경로와 web/review
origin을 사전 Node 환경만으로 확인하지 않는다. `/proc/<MainPID>/environ`의
필요 키만 비교하며 비밀이나 환경 본문은 출력하지 않는다.

### 롤백

오류 시 API90, web90, review92를 모두 원래 내용/권한으로 복원한다.
원래 review92가 없었다면 제거하여 그대로 남아 있던91의 정적 helper로
돌아간다. 세 서비스를 함께 reload/restart하되 활성 여부는 각각 검사하고,
전환 전의 실효 환경값도 복구됐는지 확인한다. 하나만 살아 있는 상태를
`CRM_ROLLBACK_OK`로 처리하거나 새 release를 지우지 않는다. SQL 변경을
허용하지 않으므로 DB를 자동 restore하지 않는다.

SIGINT/SIGTERM은 진행 중인 소유 process group을 종료하고 close를 기다린
뒤 직렬로 롤백한다. 복구 중 반복 신호는 복구를 끊지 않으며 완료 후
exit130/143으로 끝난다. 원래 없던 review92는 중단 복구에서도 제거된다.

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

## Cursor REJECT 배포 경계 수정

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
