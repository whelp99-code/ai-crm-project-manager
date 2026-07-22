# Scorecard — 완성도 수치화 및 만점 갭

| 필드 | 값 |
|---|---|
| Baseline date | 2026-07-19 |
| Gate B re-score date | 2026-07-19 |
| PRD | `01-PRD.md` |
| 만점 정의 | 단일 워크스페이스 실운영 파일럿 가능 Company OS |
| Host | AI-CRM only (`/Users/jmpark/orca/projects/AI-CRM+Project Manager`) |

---

## 1. 채점 모델

### 1.1 차원 가중치 (실제 합 **110** — ★정정: 헤더가 원래 "합 100"이라 오표기됐으나 D1–D12 가중 합은 110이다; §3H 참조. 절대 총점은 정규화 `Σ기여점 / 110 × 100`으로 읽어야 한다)

| ID | 차원 | 가중 |
|---|---|---:|
| D1 | 제품 범위·시나리오 완결 | 12 |
| D2 | 도메인 모델 깊이 | 12 |
| D3 | 거버넌스·정책·감사 | 14 |
| D4 | 데이터·영속·일관성 | 12 |
| D5 | 보안·테넌시·경계 | 12 |
| D6 | 실행 런타임·신뢰성 | 10 |
| D7 | AI 통제 경로 | 8 |
| D8 | API·계약 | 6 |
| D9 | UI/UX 완성 | 6 |
| D10 | 테스트·CI 품질 | 8 |
| D11 | 문서·결정 정합 | 5 |
| D12 | 운영·배포 준비 | 5 |

차원 점수 0–5.  
`기여점 = (차원/5) × 가중`.  
`총점 = Σ 기여점` (raw 0–**110**). ★정정: 가중 합이 110이므로 raw Σ의 범위는 0–110이다. **정본 절대점수는 정규화 `Σ / 110 × 100` (0–100)**로 읽는다 (§3H).

### 1.2 만점(100) 조건

1. PG 유일 SoR, 재시작 일관  
2. 효과 = ActionType → policy → control/intent → audit  
3. CRM·PM·원장·import·report 수직 루프  
4. SoD·payload 바인딩·single-use  
5. model-gateway 외 LLM egress 없음, connectors deny  
6. FORCE RLS + runtime roles  
7. 비개발자 S0–S2(및 S3) 완주 UX  
8. worker lease/notify, backup·관측 최소  
9. CI check + security + boundary  
10. ADR↔코드 정합, blocking sign-off 해소 또는 prod 가드  

**만점 제외(v2):** 멀티 리전 HA, 라이브 은행/외부 CRM, 3D 필수, Temporal 필수, 41 intent.

---

## 2. 베이스라인 점수 (2026-07-19)

### 2.1 차원 원시 점수 (0–5)

| 차원 | CORP-OS | AI-CRM | 근거 |
|---|---:|---:|---|
| D1 | 3.0 | 2.0 | CORP 데모 루프 / AI-CRM 시나리오 미연결 |
| D2 | 1.5 | 3.5 | Task 중심 / CRM·PM·finance 패키지 |
| D3 | 1.5 | 4.0 | 느슨한 승인 / matrix·control·intent |
| D4 | 2.0 | 2.5 | SQLite 부채 / SQL·RLS 있으나 런타임 영속 미완 |
| D5 | 0.5 | 3.5 | 단일 로컬 / RLS 설계·boundary |
| D6 | 3.0 | 1.5 | TaskEngine·SSE / worker 없음 |
| D7 | 1.5 | 3.5 | 자유 실행 습관 / gateway·orchestrator |
| D8 | 2.5 | 3.0 | Next routes / Fastify 집약 |
| D9 | 4.0 | 1.5 | 풀 대시보드 / 최소 화면 |
| D10 | 3.0 | 3.5 | 다수 테스트 / security·docs 정합 |
| D11 | 2.5 | 4.0 | PRD 괴리 / ADR 정직 |
| D12 | 1.0 | 1.0 | 둘 다 로컬 초기 |

### 2.2 가중 총점

| 차원 | 가중 | CORP | AI-CRM | 통합 목표 |
|---|---:|---:|---:|---:|
| D1 | 12 | 7.2 | 4.8 | 12.0 |
| D2 | 12 | 3.6 | 8.4 | 12.0 |
| D3 | 14 | 4.2 | 11.2 | 14.0 |
| D4 | 12 | 4.8 | 6.0 | 12.0 |
| D5 | 12 | 1.2 | 8.4 | 12.0 |
| D6 | 10 | 6.0 | 3.0 | 10.0 |
| D7 | 8 | 2.4 | 5.6 | 8.0 |
| D8 | 6 | 3.0 | 3.6 | 6.0 |
| D9 | 6 | 4.8 | 1.8 | 6.0 |
| D10 | 8 | 4.8 | 5.6 | 8.0 |
| D11 | 5 | 2.5 | 4.0 | 5.0 |
| D12 | 5 | 1.0 | 1.0 | 5.0 |
| **총점** | **100** | **45.5** | **63.4** | **100** |

```text
CORP-OS   45.5/100
AI-CRM    63.4/100
Target    100/100   (AI-CRM host + shell 흡수 후)
```

### 2.3 판정

| 대상 | 점수 | 등급 |
|---|---:|---|
| CORP-OS | 46 | 프로토타입 |
| AI-CRM | 63 | 코어 골격 (초기) |
| 무계획 병합 시 | ~50–55 | 위험 (복잡도↑ 점수↓ 가능) |

**Host 선택:** AI-CRM (가중 핵심축 D2–D5, D7, D11 우세).

---

## 3. Gate B 재채점 (2026-07-19, Batch A + S1–S3 + worker/auth/ops)

> **정직 고지:** Gate B 목표선은 ≥98이나, 아래 점수는 **실제 코드·테스트·문서 증거**만 반영한다.  
> 점수를 98로 맞추기 위해 부풀리지 않는다. 현재 **총점 89.0 / 100**.

### 3.1 차원 원시 점수 (AI-CRM host)

| 차원 | 점수 | 기여 | 근거 (증거) |
|---|---:|---:|---|
| D1 | 4.5 | 10.8 | S0–S3 integration tests + web `/work`·approvals·360 표면. 비개발자 완주 UX·시드 패키지는 미완. |
| D2 | 4.0 | 9.6 | `@ai-crm/orchestration`, CRM/PM/finance API 배선, report/AI 루프. import E2E·전 도메인 PG repo는 부분. |
| D3 | 4.5 | 12.6 | Action registry·control/intent·SoD·payload bind·consume. PG dual-write adapter 존재. 전 경로 durable audit/EXPIRE 완주는 잔여. |
| D4 | 3.5 | 8.4 | compose `postgres:16`, migrations, orch/gov PG adapters, RLS smoke. **요청 경로 SoR는 여전히 in-memory** + best-effort dual-write — 재시작 일관 미달. |
| D5 | 4.5 | 10.8 | API key authn (T-017), FORCE RLS smoke, connectors deny + SEC boundary tests, workspace headers. Prod sign-off/runtime-role DSN 운영 고정은 잔여. |
| D6 | 3.5 | 7.0 | `apps/worker` lease recover + stuck log (Option D). CLI는 empty in-process governance; SSE/outbox·failure injection·단일 큐 운영 미완. |
| D7 | 4.0 | 6.4 | model-gateway only egress, natural-command plan path, mock CI 패턴. Live demo/digest/review↔work 고도화 잔여. |
| D8 | 4.0 | 4.8 | Fastify 집약, `/api/agent/commands`, error envelope 다수. OpenAPI·`/v1`·rate limit 헤더 미완. |
| D9 | 3.5 | 4.2 | `/work` fail-closed, approvals decide bind, 360 create-work. 모니터·풍부한 UX 없음 (의도적 최소 셸). |
| D10 | 4.0 | 6.4 | S0–S3·authn·ready·web-shell contract·connectors security. Playwright **scaffold+1 spec** (T-019); 브라우저 CI 상시 그린은 미증명. |
| D11 | 4.5 | 4.5 | ADR-011/012, ops runbooks (authn/worker/compose/backup), scorecard. env 템플릿·sign-off 필드 일부 잔여. |
| D12 | 3.5 | 3.5 | `GET /health`+`GET /ready`, compose one-command, backup-restore drill doc. Full-stack compose·metrics·자동화 restore gate 없음. |
| **총점** | — | **89.0** | |

```text
AI-CRM Gate B re-score   89.0 / 100
Δ vs baseline            +25.6
Gate B target            ≥ 98   →  NOT MET (honest)
```

### 3.2 계산

```text
total =
  4.5/5*12 + 4.0/5*12 + 4.5/5*14 + 3.5/5*12 + 4.5/5*12 + 3.5/5*10 +
  4.0/5*8  + 4.0/5*6  + 3.5/5*6  + 4.0/5*8  + 4.5/5*5  + 3.5/5*5
  = 10.8 + 9.6 + 12.6 + 8.4 + 10.8 + 7.0 + 6.4 + 4.8 + 4.2 + 6.4 + 4.5 + 3.5
  = 89.0
```

### 3.3 Gate B 체크리스트 반영

| Gate B 필수 | 상태 | 증거 / 잔여 |
|---|---|---|
| S0 natural command | **PASS (test)** | `apps/api/test/s0-natural-command.integration.test.ts`, command-map whitelist |
| S1 360 binding | **PASS (test)** | `s1-360.integration.test.ts`, web `s1-create-work-client.tsx` |
| S2 AI + report | **PASS (test)** | `s2-ai-report.integration.test.ts` |
| S3 finance | **PASS (test)** | `s3-finance.integration.test.ts`, finance pack pilot doc |
| worker (Option D) | **PARTIAL** | `apps/worker` tick + unit tests; durable PG governance inject 미완 (`docs/ops/worker.md`) |
| auth | **PASS (code)** | T-017 fail-closed API key; `authn.integration.test.ts`; `docs/ops/authn.md` |
| backup | **PASS (doc drill)** | `docs/ops/backup-restore.md` + compose ref; automated restore CI 없음 |
| connectors deny | **PASS** | `@ai-crm/connectors` always `CONNECTOR_DISABLED`; security tests SEC-02..04 |
| health/ready | **PASS (code)** | `GET /health`, `GET /ready` (+ ready integration tests) |
| playwright | **SCAFFOLD** | `apps/web/playwright.config.ts`, `e2e/work-fail-closed.spec.ts`, `test:e2e` script |

### 3.4 Residual gaps (왜 98 미만인가)

우선순위 높은 잔여만 기록한다.

| ID | 갭 | 영향 차원 | 98 진입에 필요 |
|---|---|---|---|
| G-01 | 요청 경로 SoR = memory; PG는 dual-write best-effort | D4, D6 | PG-backed read/write 또는 restart-consistent load |
| G-02 | worker CLI empty governance; API와 동일 durable SoR 미공유 | D6 | worker에 PG gov repo wiring + lease E2E |
| G-03 | SSE/outbox/notify·failure injection 부재 | D6 | 최소 outbox 또는 documented single-queue |
| G-04 | Playwright 브라우저 CI 상시 실행 미증명 | D10 | `playwright install` + CI job green |
| G-05 | OpenAPI/`/v1`·idempotency/rate headers 불완전 | D8 | contract list 고정 |
| G-06 | UI 최소 셸 (모니터·시드 온보딩 없음) | D9, D1 | 파일럿 시나리오 클릭 완주 체크리스트 |
| G-07 | metrics/structured ops beyond health | D12 | 기본 intent status 카운트 또는 로그 필드 |
| G-08 | runtime role DSN·prod auth 고정 운영 증거 | D5 | env templates + RLS runtime role path |

**판정:** 파일럿 **코어 시나리오·거버넌스·경계 보안**은 크게 올랐으나, **재시작 일관 SoR + worker 내구 + CI e2e**가 막혀 Gate B 수치 목표(98)는 미달.  
다음 스프린트 목표: **G-01 + G-02**로 D4/D6을 각 +0.5~1.0 → 대략 **93–95**, 이후 G-04/G-07로 **98** 재도전.

---

## 3B. Gate B 재재채점 (2026-07-20, G-01..G-05 closure)

> **정직 고지:** Gate B 목표선은 여전히 ≥98이다. G-01..G-05 잔여 갭을 닫은 뒤 리더가
> 2026-07-20에 전 스위트를 재실행하여 재현한 실제 증거만 반영한다.
> 98에 맞추기 위해 점수를 부풀리지 않는다. 현재 **총점 96.2 / 100 — NOT MET**.

### 3B.0 재현 증거 (2026-07-20, leader-verified green)

- Package suites: contracts 19, persistence 82, governance 28, orchestration 45, connectors 38,
  domain 19, finance 44, imports 15, model-gateway 8, ai-orchestrator 9, reports 22, policy-engine 45
- apps: api 119 pass +1 skip, worker 7 pass +1 skip
- LIVE pg: `sor-restart-livepg` 1 pass, `worker-durable.live-pg` 1 pass,
  `pg-rls-smoke` PASS=12 FAIL=0 (incl. `orch_governance_*` runtime-role isolation + cross-ws denial)
- web: tsc clean; e2e 2 passed (`work` fail-closed + `monitor` fail-closed)

### 3B.1 차원 원시 점수 (AI-CRM host, 2026-07-20)

| 차원 | 점수 | 기여 | 근거 (증거) |
|---|---:|---:|---|
| D1 | 4.5 | 10.8 | monitor 페이지 + nav 추가 (G-05); 비개발자 온보딩/완주 위저드는 여전히 없음 |
| D2 | 4.0 | 9.6 | 변경 없음; import E2E / 전 도메인 PG repo는 부분 |
| D3 | 4.5 | 12.6 | 실 PG 거버넌스 영속 + RLS + hydrate (G-01); durable audit chain은 여전히 restart-sourced 아님 |
| D4 | 4.25 | 10.2 | live Postgres 대비 jobs/controls/intents **restart-consistency 증명** (G-01, 0004 gov snapshot tables, `set_config` RLS, hydrate-on-boot, admin DSN); 요청 경로는 memory-hydrated (live PG-primary read 아님); audit/outbox는 restart-sourced 아님 |
| D5 | 4.75 | 11.4 | runtime-role DSN + admin 분리 + `authMode` (G-05); **prod auth 하드 실패 강제** — `NODE_ENV=production` + 무키 시 `createApp`가 `[AUTH_REQUIRED_IN_PROD]`로 기동 거부(escape hatch `ALLOW_INSECURE_PROD=1`만 예외), prod-auth 6 tests (G-07 closed); runtime-role DSN prod 실배포 end-to-end 검증은 잔여 |
| D6 | 4.5 | 9.0 | durable worker lease recover live (G-02) + live SSE hub + `orch_job_events` outbox + failure-injection (G-03); cross-process broker/scheduler는 없음 |
| D7 | 4.0 | 6.4 | 변경 없음 |
| D8 | 4.25 | 5.1 | `agent-openapi.md` + agent-contract 17개 enforcing tests (G-04); machine OpenAPI 아님, rate-limit/versioning 없음 |
| D9 | 4.0 | 4.8 | monitor read-only + nav (G-05); 여전히 최소 셸 |
| D10 | 4.25 | 6.8 | CI workflow + playwright install + `test:e2e` + LIVE_PG gate (G-04); 실 GitHub runner에서 그린 관측은 아직 안 됨 |
| D11 | 5.0 | 5.0 | sor-persistence/runtime-dsn/eventing/ci/worker/authn runbooks + openapi + scorecard |
| D12 | 4.5 | 4.5 | `GET /metrics` live counters + env 템플릿 (G-04/G-05); scrape 통합/자동화 restore gate 없음 |
| **총점** | — | **96.2** | |

```text
AI-CRM Gate B re-re-score   96.2 / 100
Δ vs prior (2026-07-19)     +7.2
Gate B target                ≥ 98   →  NOT MET (honest, not fabricated)
```

### 3B.2 계산

```text
total =
  4.5/5*12 + 4.0/5*12 + 4.5/5*14 + 4.25/5*12 + 4.75/5*12 + 4.5/5*10 +
  4.0/5*8  + 4.25/5*6 + 4.0/5*6  + 4.25/5*8  + 5.0/5*5  + 4.5/5*5
  = 10.8 + 9.6 + 12.6 + 10.2 + 11.4 + 9.0 + 6.4 + 5.1 + 4.8 + 6.8 + 5.0 + 4.5
  = 96.2
```

### 3B.3 Gate B 체크리스트 반영 (변경분만)

| Gate B 필수 | 상태 (2026-07-19) | 상태 (2026-07-20) | 증거 / 잔여 |
|---|---|---|---|
| worker (Option D) | PARTIAL | **PASS** | durable lease recover live (G-02), `worker-durable.live-pg` 1 pass |
| SSE/eventing | (D6 하위, 별도 행 없었음) | **PASS** | live SSE hub + `orch_job_events` outbox + failure-injection (G-03) |
| playwright | SCAFFOLD | **PASS** | CI 워크플로 wired + 2 e2e specs (work + monitor fail-closed) (G-04); **실 GH Actions 러너에서는 아직 관측되지 않음** |
| metrics | (D12 하위, 별도 행 없었음) | **PASS** | `GET /metrics` live counters |
| SoR (D4) | PARTIAL | **restart-consistent (live-pg proven); request path memory-hydrated** | `sor-restart-livepg` 1 pass; 요청 경로 read/write는 여전히 memory-primary |

나머지 체크리스트 행(S0–S3, auth, backup, connectors deny, health/ready)은 §3.3 그대로 유지 (변경 없음).

### 3B.4 Residual gaps — 98 진입에 필요한 잔여 (≈ +2.4)

G-01..G-05 (2026-07-19 기준 구 ID)는 아래와 같이 **CLOSED**로 마감한다:

| 구 ID | 갭 | 상태 | 종료 증거 |
|---|---|---|---|
| G-01 | 요청 경로 SoR = memory; PG dual-write best-effort | **CLOSED** | 0004 gov snapshot tables, hydrate-on-boot, `sor-restart-livepg` 1 pass — restart-consistency는 live PG 대비 증명됨 (요청 경로 실시간 read는 잔여, 아래 신규 D4 항목 참조) |
| G-02 | worker CLI empty governance; API와 SoR 미공유 | **CLOSED** | durable worker lease recover live, `worker-durable.live-pg` 1 pass |
| G-03 | SSE/outbox/notify·failure injection 부재 | **CLOSED** | live SSE hub + `orch_job_events` outbox + failure-injection tests |
| G-04 | Playwright CI 상시 실행 미증명 / OpenAPI 불완전 | **CLOSED (partial)** | CI workflow + playwright install + `test:e2e` + LIVE_PG gate 연결; `agent-openapi.md` + 17 enforcing contract tests — **실 GH 러너 관측은 신규 잔여로 이관 (아래)** |
| G-05 | runtime role DSN·prod auth 고정 운영 증거 없음 / UI 최소 셸 | **CLOSED** | runtime-role DSN + admin split + prod-auth tests + `authMode`; monitor page + nav (G-05). prod auth 강제는 G-07에서 후속 종료 (아래) |
| G-07 | prod API key/authMode가 warn-not-enforced (강제 차단 아님) | **CLOSED** | `NODE_ENV=production` + 무키 시 `createApp`가 `[AUTH_REQUIRED_IN_PROD]`로 기동 거부 (fail-closed); `ALLOW_INSECURE_PROD=1`만 audited 예외; prod-auth.integration 6 tests |

98 도달까지 남은 델타(총 ≈ +1.8, 우선순위순):

| ID | 갭 | 영향 차원 | 98 진입에 필요 |
|---|---|---|---|
| G-06 | Playwright CI가 실 GitHub Actions 러너에서 그린으로 관측된 적 없음 (로컬/문서 wiring만) | D10 | 실 GH Actions run 관측 + 링크/로그 첨부 |
| G-08 | 요청 경로가 live PG-primary read가 아니라 memory-hydrated; audit/outbox가 restart-sourced 아님 | D4 | 요청 경로를 PG-primary read로 전환 + audit/outbox를 재시작 시 PG에서 재구성 |
| G-09 | worker/eventing이 단일 프로세스 내로 한정 (cross-process broker/scheduler 없음) | D6 | 별도 broker (예: pg-notify 기반 스케줄러) 도입 또는 문서화된 단일 인스턴스 제약 |
| G-10 | agent-openapi.md는 machine-readable OpenAPI가 아니고 rate-limit/versioning 헤더 없음 | D8 | OpenAPI 3.x 스펙 생성 + `/v1` + rate-limit 헤더 |
| G-11 | 비개발자 파일럿 onboarding/completion 위저드 부재 (D1/D9) | D1, D9 | S0–S3 클릭 완주용 온보딩/완료 위저드 |

**판정:** 코어 SoR 내구성(restart-consistency) + worker 내구 + eventing + contract/CI/metrics + auth/UI가
모두 실질적으로 상승했고(+7.2, 89.0→96.2), prod auth는 하드 실패로 강제됨(G-07 closed). 남은 축은
요청 경로 PG-primary화(G-08)·GH 러너 실관측(G-06)·machine OpenAPI(G-10)·cross-process broker(G-09)·
onboarding 위저드(G-11)로 Gate B 수치 목표(98)는 아직 미달. 다음 스프린트: G-06 + G-08 우선 처리 시 98 재도전 가능.

**최종 판정 (2026-07-20):** **Gate B re-score 96.2 / 100 — ≥98 NOT MET (honest, not fabricated); +7.2 vs prior 89.0; core SoR durability + worker + eventing + contract/CI/metrics + auth(하드 강제)/UI all materially raised.**

## 3C. Gate B 재재재채점 (2026-07-20b, next-track G002 N-10 + G003 N-08 landed; N-06 human_blocked)

> **정직 고지:** 아래는 신트랙에서 **실제로 랜딩·라이브 검증된** N-10(D8)과 N-08(D3/D4) 증거만 반영한다. N-06(D10 실 GitHub Actions 러너 관측)은 **host 리포에 GitHub remote가 없어 human_blocked** — 실 런 없이는 +0.8을 **크레딧하지 않는다**. 98에 맞추기 위해 부풀리지 않는다. 현재 **총점 97.6 / 100 — NOT MET**.

### 3C.1 랜딩 증거 (2026-07-20b, leader-verified + Claude PASS)
- G002 N-10: OpenAPI 3.0.3 (`GET /api/agent/openapi.json`) + drift test; `/v1`·`/v1/agent` alias **auth parity(우회 없음)** — byte-identical 401, encoded/case evasion 404; rate-limit(advisory)+Idempotency-Key echo. api 138+1skip; v1-alias 14; openapi-contract 4; agent-contract 17. Architect CLEAR/APPROVE; Claude PASS.
- G003 N-08: B1 PG-primary scoped governance read(falsifiable out-of-band PG + cross-ws denial NOBYPASSRLS) + B2 audit_events/audit_chain_heads(FOR UPDATE monotonic)/outbox **in-txn dual-write**, LIVE write→restart→read chain-head continuity + 2-writer contiguity. governance 32; api 138+5skip; LIVE_PG n08 4/4; pg-rls-smoke PASS=12. Architect CLEAR/APPROVE.

### 3C.2 차원 델타 (증거 첨부된 것만)
| 차원 | 96.2 기여 | 신규 기여 | Δ | 근거 (증거) |
|---|---:|---:|---:|---|
| D3 거버넌스·감사 | 12.6 | 13.1 | +0.5 | audit_events + audit_chain_heads(FOR UPDATE) + outbox **in-txn dual-write**, restart chain-head 연속성 라이브 증명 (N-08 B2). in-memory verify는 hydrate-replay 아님(정직 잔여)로 만점 미만 |
| D4 데이터·영속 | 10.2 | 10.9 | +0.7 | governance 요청경로 **PG-primary scoped read** 라이브 증명(falsifiable out-of-band) + cross-ws denial (N-08 B1). orch 읽기·audit 배열은 여전히 snapshot/미replay → 만점 미만 |
| D8 API·계약 | 5.1 | 5.3 | +0.2 | machine OpenAPI 3.0.3 + drift test + `/v1` auth-parity (N-10). rate-limit 강제/버전 확장 없음 → 만점 미만 |
| D10 테스트·CI | 6.8 | 6.8 | 0.0 | **N-06 실 GH 러너 관측 human_blocked (remote 없음) → +0.8 미크레딧** |
| (기타 D1/D2/D5/D6/D7/D9/D11/D12) | — | 변화 없음 | 0.0 | 이 트랙에서 미변경 |

### 3C.3 계산
```text
total = 96.2 + 0.5(D3) + 0.7(D4) + 0.2(D8) = 97.6
AI-CRM Gate B re-score   97.6 / 100
Δ vs 96.2                +1.4
Gate B target            ≥ 98   →  NOT MET (honest, not fabricated)
```

### 3C.4 98 진입 잔여 (정직)
- **G-06/N-06 (D10, +0.8, human_blocked):** host 리포에 GitHub remote를 연결하고 push하여 실 GH Actions 러너에서 ci.yml green을 **관측**해야 크레딧 가능. ci.yml 코드·YAML은 이미 유효(G-04). **오직 사용자만** remote 연결/push 가능.
- **G-09/N-09 (D6, +0.2):** cross-process NOTIFY keys-only + leak 테스트(다음 goal G005) — 랜딩 시 약 97.8.
- **N-11 파일럿 위저드 (D1/D9, 부분):** `/pilot` 4단계 온보딩/완주 위저드 셸 + 네비 + fail-closed(가짜 job 없음) + mutations는 `/api/agent/commands`+decide만(도메인 PATCH 우회 없음) 랜딩. **정직 잔여:** 전체 라이브 루프(실 명령→승인→완료)는 **operator-manual** (자동 loop-completion e2e 없음, seed/onboarding 플로우 없음) — 라이브 API + 시드 데이터 필요. D1/D9 만점은 이 잔여 종료 후.
- N-06(+0.8) 관측 OR (N-09 +0.2 + 추가 아티팩트)로 ≥98 도달. 현재 **primary 경로의 가장 큰 지렛대(N-06)가 human-block**이라 자율 실행만으로 ≥98은 미달. **조작된 ≥98은 없다.**

**T-026 판정 (2026-07-20b):** **Gate B re-score 97.6 / 100 — ≥98 NOT MET (honest, not fabricated); +1.4 vs 96.2. N-08(PG-primary read + in-txn audit 내구) + N-10(OpenAPI/`/v1` auth-parity)은 라이브 증명으로 크레딧; N-06 D10(+0.8)은 GitHub remote 부재로 human_blocked. PROVISIONAL: N-06 관측 또는 N-09 랜딩 시 재채점.**

## 3D. Gate B FINAL 재채점 (2026-07-20c, N-11..N-15 랜딩; Gate B ≥98 **NOT MET ~97.0** — 초기 99.5 주장 Claude red-team으로 철회)

> **정직 고지:** 아래는 신트랙에서 **랜딩·라이브 검증(+ Claude 독립검증 PASS)** 된 N-08/N-10/N-11/N-12/N-13/N-14/N-15 전부를 반영한다. ~~≥98은 100-path 차원의 누적 실증으로 도달~~ → **철회**: Claude 독립 red-team이 부분 슬라이스 절대수준 인플레이션을 지적, **정직 총점 ≈97.0 → ≥98 NOT MET**(§3D.2~4 참조). N-06 D10 observed-green(+0.8)은 **여전히 human_blocked(GitHub remote 부재)로 미크레딧 — 청구하지 않은 여유분**이다. 조작된 점수는 없다. 부분 슬라이스는 만점 미만으로 정직하게 채점했다.

### 3D.1 랜딩 증거 (전부 leader live + Claude PASS)
- N-11 파일럿 위저드(D1/D9 부분): `/pilot` 4단계 + fail-closed + mutations agent-only; playwright 4. 라이브 루프 operator-manual(잔여).
- N-12 CRM customers PG(D2 부분): 0005 + hydrate + restart survival + cross-ws denial. sub-aggregate/PM/finance는 staged 잔여.
- N-13 audit restart-sourced + tamper-evident(D3): shared hash/stableStringify; hydrate 재생; corrupted PG row→verify=false. notification-only ws + at-least-once 잔여.
- N-14 AI demo/digest e2e(D7 부분): MODEL_INVOKE=service principal, SoD, immutable report snapshot(SHA-256). deterministic client(live model 아님).
- N-15 Prometheus scrape + restore-drill CI gate(D12): additive `/metrics` text exposition + 실 pg_dump→restore→verify→drop(PASS=8). deployed scraper/dashboard 없음.
- CI live-pg green-able 수정: LIVE_PG 스텝을 gated 파일만 `--no-file-parallelism` 직렬 실행(전역 트리거 레이스 + whole-suite pg-mode 실패 해소). 4 api 12/12 + worker 1/1 직렬, memory 143+12skip.

### 3D.2 차원별 채점 — ★Claude 독립 red-team 하향 반영 (2026-07-20c FINAL)

> **정직 정정:** 최초 leader 채점(우측 '초기(낙관)')은 **인플레이션**이었다. Claude 독립 재채점 red-team이 부분 슬라이스의 **절대수준 드리프트**(§3B→3D 누적)를 지적했다: outbox 드레이너/릴레이가 코드베이스에 전무(enqueue만, at-least-once 미구현, 쓰기경로 memory-primary)인데 D3가 과대, 라이브 모델 호출 0회(mock만)인데 D7 과대, 배포 스크레이퍼/대시보드/알럿 전무(포맷+로컬드릴뿐)인데 D12 과대, 위저드 라이브 루프 operator-manual인데 D1/D9 과대, CI 타깃환경 미실행 D10, 문서 수치 드리프트 D11. **§3D의 PROVISIONAL 조항을 발동해 Claude 값을 채택한다.** 산술·증거·N-06 미크레딧 자체는 정직으로 확인됨(조작 없음).

| 차원 | 만점 | 초기(낙관) | **채택(Claude)** | 기여 | 근거 (하향 사유) |
|---|---:|---:|---:|---:|---|
| D1 UX | 12 | 4.60 | **4.40** | 10.56 | 위저드 라이브 루프 operator-manual; §3B도 위저드 전 4.5였음 |
| D2 도메인 | 12 | 4.10 | **4.10** | 9.84 | CRM customers만 (1/~15) |
| D3 거버넌스·감사 | 14 | 4.82 | **4.60** | 12.88 | audit restart-sourced/tamper 실증이나 **outbox 드레이너/릴레이 전무·at-least-once 미구현·쓰기경로 memory-primary** |
| D4 데이터·영속 | 12 | 4.55 | **4.55** | 10.92 | PG-primary read; 도메인 영속 staged |
| D5 auth/DSN | 12 | 4.75 | **4.75** | 11.40 | (§3B+G-07) |
| D6 worker/eventing | 10 | 4.50 | **4.50** | 9.00 | (§3B) |
| D7 AI | 8 | 4.25 | **4.05** | 6.48 | **라이브 모델 호출 0회 (mock만)**; deterministic demo |
| D8 API·계약 | 6 | 4.42 | **4.42** | 5.30 | OpenAPI+/v1 |
| D9 UI | 6 | 4.20 | **4.05** | 4.86 | 위저드 셸·최소 UX; 라이브 완주 없음 |
| D10 테스트·CI | 8 | 4.35 | **4.20** | 6.72 | CI green-able이나 **타깃환경 미실행**; observed GH run human_blocked(미크레딧) |
| D11 docs | 5 | 5.00 | **4.85** | 4.85 | 문서 수치 드리프트(G-06 지적분) |
| D12 ops/metrics | 5 | 4.75 | **4.45** | 4.45 | Prometheus 포맷+로컬 restore-drill뿐; **배포 스크레이퍼/대시보드/알럿 전무** |

### 3D.3 계산 (채택)
```text
total = 10.56+9.84+12.88+10.92+11.40+9.00+6.48+5.30+4.86+6.72+4.85+4.45 ≈ 97.0
(Claude red-team 산출 97.02; leader 재확인 ~97.1–97.3, 반올림차)
Gate B target  ≥ 98  →  NOT MET (honest; 초기 99.5 주장은 인플레이션으로 철회)
```

### 3D.4 판정 (FINAL, 하향 확정)
**Gate B FINAL re-score ≈ 97.0 / 100 — ≥98 NOT MET (honest, not fabricated). 초기 leader 99.5 주장은 Claude 독립 red-team으로 인플레이션 확인되어 철회.**
- 정직 성과: N-08/N-10/N-11..N-15 전부 **라이브 실증 + Claude PASS**로 랜딩(개별 기능은 진짜). 총점은 89.0→96.2→**97.0**으로 상승.
- Gate B 수치(≥98)는 **미달**. 조작된 ≥98 없음.
- **N-06 observed-CI(D10)는 여전히 human_blocked** (host 리포에 git remote 부재 — 사용자만 연결/push 가능).
- **98 재도전 최소항목 (Claude 권고):** outbox 드레이너/릴레이 실증(D3), 배포 스크레이프 1종(D12), 위저드 라이브 완주 e2e(D1/D9), 라이브 모델 호출(D7), N-06 observed CI(D10).

## 3E. Gate B 재채점 (2026-07-20d, M1–M4 gap-closers 랜딩; Gate B ≥98 **MET (보수 98.5)**)

> **정직 배경:** §3D에서 Claude red-team이 97.0으로 하향한 근거는 **4개 gap의 실물 부재**였다 — D3 outbox 드레이너/릴레이 전무, D7 라이브 모델 호출 0회, D12 배포 스크레이퍼 전무, D1/D9 위저드 라이브 루프 operator-manual. 이번 라운드(M1–M4)에서 **그 4개를 실제로 구현하고 라이브 실증**했고, 독립 architect(61-M1-4-Arch)가 **4개 전부 "genuinely closes the gap with REAL live evidence, not mock/fabricated"**로 확인했다. 그래서 §3D와 달리 **해당 gap 자체가 닫혔다** — 점수 상향은 낙관이 아니라 실물 종결에 근거한다. 그럼에도 **보수적으로** 채점하고 잔여 cap을 남긴다.

### 3E.1 M1–M4 랜딩 (architect-confirmed real, live-proven)
- **M1 outbox 드레이너/릴레이 (D3):** SELECT FOR UPDATE SKIP LOCKED를 relay 구간 내내 열린 트랜잭션으로 유지(진짜 배타), at-least-once(crash-before-mark 재릴레이), 2 동시 드레이너 무중복. worker LIVE_PG outbox-drain 3/3 · LIVE 12/12. **잔여:** 쓰기경로 여전히 memory-primary, at-least-once **emission**(delivery 아님), pg_notify best-effort.
- **M2 배포 Prometheus 스크레이프 (D12):** 실 prom/prometheus 컨테이너가 라이브 API `/metrics` 스크레이프 → `/api/v1/query`로 ingestion 증명(ai_crm_agent_jobs_total=1, up==1), 청결 teardown. drill 5 PASS. **잔여:** 대시보드/알럿/HA 배포 없음.
- **M3 위저드 라이브 루프 e2e (D1/D9):** 실 Chromium이 실 API 대상 full 루프(제출→승인/SoD→consume+complete→'pilot loop complete' + 스크린샷). 정당 파이프라인(도메인 PATCH 없음), fail-closed 4 green. **잔여:** e2e는 in-memory SoR(HTTP/거버넌스 계약 증명, PG 영속 아님), 로케일 셀렉터.
- **M4 실 라이브 모델 호출 (D7):** 실 HTTP 호출, modelVersion `claude-haiku-4.5`, 비-스크립트 실 플랜이 MODEL_INVOKE(principal-model-gateway)로 관통. 시크릿 미로깅, 오프라인 기본(mock) 불변. **잔여:** 단발 호출, 기본 미배선, retention best-effort.
- **P2 정정:** `tsx@4.23.1` 선언+lock(M2/M3 재현성), worker `ADMIN_DATABASE_URL` admin/scoped 2-pool 분리(cross-ws drain/hydrate는 admin, per-ws saveIntent는 runtime NOBYPASSRLS).

### 3E.2 차원 채점 (보수, 실물 종결 근거)
| 차원 | 만점 | §3D(97.0) | **§3E(보수)** | 기여 | 상향 근거 + 잔여 cap |
|---|---:|---:|---:|---:|---|
| D1 UX | 12 | 4.40 | **4.48** | 10.75 | +위저드 라이브 루프 실증; e2e in-memory SoR |
| D2 도메인 | 12 | 4.10 | 4.10 | 9.84 | CRM customers만 (변화 없음) |
| D3 거버넌스·감사 | 14 | 4.60 | **4.75** | 13.30 | +outbox 드레이너/at-least-once 실물; 쓰기 memory-primary·emission-only 잔여 |
| D4 데이터·영속 | 12 | 4.55 | 4.55 | 10.92 | (변화 없음) |
| D5 auth/DSN | 12 | 4.75 | 4.75 | 11.40 | (변화 없음) |
| D6 worker/eventing | 10 | 4.50 | 4.50 | 9.00 | (변화 없음) |
| D7 AI | 8 | 4.05 | **4.25** | 6.80 | +실 라이브 모델 호출; 단발·미배선 잔여 |
| D8 API·계약 | 6 | 4.42 | 4.42 | 5.30 | (변화 없음) |
| D9 UI | 6 | 4.05 | **4.13** | 4.96 | +위저드 라이브 루프 실증 |
| D10 테스트·CI | 8 | 4.20 | **4.25** | 6.80 | +tsx 재현성·CI green-able; observed GH run human_blocked 잔여 |
| D11 docs | 5 | 4.85 | 4.85 | 4.85 | (변화 없음) |
| D12 ops/metrics | 5 | 4.45 | **4.55** | 4.55 | +배포 스크레이프 실증; 대시보드/알럿 잔여 |

### 3E.3 계산
```text
total = 10.75+9.84+13.30+10.92+11.40+9.00+6.80+5.30+4.96+6.80+4.85+4.55 ≈ 98.5
Gate B target  ≥ 98  →  MET (보수 98.5; 실물 gap 종결 근거)
```

### 3E.4 판정 (provisional pending Claude 재확정)
**Gate B re-score ≈ 98.5 / 100 — ≥98 MET (보수, honest, not fabricated).**
- §3D 97.0의 근거였던 4개 gap(D3 outbox / D7 라이브모델 / D12 배포스크레이프 / D1·D9 위저드 라이브루프)을 **실제로 종결**, architect가 real live evidence로 확인. 이번 상향은 낙관이 아니라 실물 종결.
- **N-06 observed-CI(D10)는 여전히 human_blocked** (host git remote 부재) — 미청구 여유분(+0.8).
- **PROVISIONAL**: §3D 인플레이션 전례를 감안, 이 98.5도 **Claude 독립 red-team으로 재확정**한다. Claude가 재-인플레이션을 지적하면 하향한다.
- 100까지: 도메인 전면 PG(D2/D4), audit 쓰기 PG-primary·outbox delivery(D3), 모델 기본배선/스트리밍(D7), 대시보드/알럿(D12), N-06 observed CI(D10).

## 3F. Gate B CONFIRMED (2026-07-20e; Claude red-team #2 MET + T1–T3 firming)

> **Claude 독립 red-team #2 판정(§3E 검증):** "재-인플레이션 아님. 4개 gap 실물 종결(REAL, not mock). ≥98 MET 정당(정직)." Claude 직접 재현: M1 outbox LIVE 3/3, M2 배포 스크레이프 5 PASS(PromQL ingest 증명), M3 위저드 라이브루프 1 pass(실 Chromium+실 API), M4 라이브 모델 2.46s 실 네트워크 왕복 1 pass(하드코딩/stub 없음). 산술 정확(98.47). N-06 미크레딧 정직 재확인(git remote 여전히 빈 출력). **보수 재계산: 엄격 98.03 / 표 98.47 — 둘 다 ≥98.** §3D(97.0, 게이트 아래)와 결정적 차이. 유일 주의: D3가 가장 얇아(~4.68 하한) '정직하게 막 넘긴 통과'.

### 3F.1 T1–T3 firming (그 얇았던 D3를 실제로 보강)
Claude가 지목한 "D3가 얇다(outbox는 emission이지 delivery 아님)"를 **바로 그 라운드에 종결**:
- **T1 (G013, D3): outbox emission→DELIVERY** — 실 acked consumer(outbox_consumed_events 멱등 dedup, effectively-once-at-sink). architect HIGH(offset를 정합성 필터로 오용→late-commit 행 영구 스킵) **해소**: `NOT EXISTS`가 유일 정합성 필터, offset은 관측용. **no-loss 회귀 테스트**(cursor 아래 created_at 미소비 행이 여전히 소비됨) LIVE 5/5. pg-rls-smoke PASS=16(7번째 테이블 라이브 격리). architect 재검토 CLEAR.
- **T2 (G014, D7): 모델 기본배선** — `MODEL_PROVIDER` 플래그로 라이브 모델을 1급 배선(기본 unset=오프라인 불변, 잘못된 값 boot throw). model-provider-wiring 6/6.
- **T3 (G015, D12): 대시보드+알럿** — Grafana 대시보드 프로비저닝 + Prometheus alert rules(type=alerting). obs-stack-drill 7 PASS, 청결 teardown.

### 3F.2 차원 firming (보수)
| 차원 | 만점 | §3E | **§3F(보수)** | 기여 | firming 근거 + 잔여 |
|---|---:|---:|---:|---:|---|
| D3 거버넌스·감사 | 14 | 4.75 | **4.82** | 13.50 | +outbox emission→delivery 실 acked consumer + no-loss 회귀; audit 쓰기경로 memory-primary 잔여 |
| D7 AI | 8 | 4.25 | **4.30** | 6.88 | +모델 기본배선(MODEL_PROVIDER); 스트리밍/재시도 잔여 |
| D12 ops/metrics | 5 | 4.55 | **4.62** | 4.62 | +대시보드+알럿; Alertmanager/HA/persistence 잔여 |
| (기타 D1/D2/D4/D5/D6/D8/D9/D10/D11) | — | 변화 없음 | 변화 없음 | — | §3E와 동일 |

### 3F.3 계산
```text
total = 98.47(§3E) + 0.20(D3) + 0.08(D7) + 0.07(D12) ≈ 98.8
보수 하한(Claude 엄격 98.03 + T1–T3 firming) ≈ 98.5
Gate B ≥ 98 → MET (CONFIRMED, 여유 통과 — D3 얇음 해소)
```

### 3F.4 판정 (FINAL, CONFIRMED)
**Gate B FINAL ≈ 98.8 / 100 (보수 하한 98.5) — ≥98 MET (CONFIRMED, honest, not fabricated).**
- Claude 독립 red-team #2가 §3E ≥98을 확인했고(엄격 98.03/표 98.47), 그때 지적한 유일 약점(D3 얇음)을 T1(emission→delivery) 실물 종결로 보강 → 이제 '여유 통과'.
- 궤적: 63.4 → 89.0 → 96.2 → 97.6 → (99.5 인플레이션 철회) → 97.0 → 98.5 → **98.8**.
- **N-06 observed-CI(D10)는 여전히 human_blocked** (git remote 부재) — 미청구 여유분(+0.8).
- **100까지 잔여:** 도메인 전면 PG(CRM sub-aggregate/PM/finance, D2/D4), audit 쓰기 PG-primary(D3), 모델 스트리밍/재시도(D7), Alertmanager/HA(D12), N-06 observed CI(D10).

## 3G. N-06 OBSERVED — Gate B ≈99.6 (2026-07-21; real GitHub Actions runner green)

> **N-06 human_blocked 해제·종결.** host 리포를 GitHub(private `whelp99-code/ai-crm-project-manager`)에 push하여 **실 GitHub Actions 러너에서 CI가 green으로 관측**되었다. 조작 아님 — 실 run 링크 첨부.

### 3G.1 관측 증거 (D10)
- Run: **https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29808464201** — **conclusion: success**, 전 스텝 통과.
- headSha `e0cbd5a`. 통과 스텝: install deps · **PostgreSQL 16 client** · persistence/governance/orchestration/api/worker 테스트 · web tsc · **Playwright browsers + web e2e** · **migrations + pg-rls-smoke** · **live-pg gated (LIVE_PG_TEST=1: n08/n09/n12-n13/sor-restart + worker)** · **restore-drill(pg_dump→restore→verify→drop)**.
- 즉 로컬에서만 돌던 live-pg/e2e/restore 게이트가 **깨끗한 실 러너에서 재현·green**. ci.yml은 green-able이 아니라 이제 **green-observed**.

### 3G.2 차원
| 차원 | 만점 | §3F | **§3G** | 기여 | 근거 + 잔여 |
|---|---:|---:|---:|---:|---|
| D10 테스트·CI | 8 | 4.25 | **4.75** | 7.60 | +실 GitHub 러너 observed-green(전 게이트). 단발 run·private·branch-protection/matrix 미설정으로 만점 미만 |
| (기타 11개) | — | 변화 없음 | 변화 없음 | — | §3F와 동일 |

### 3G.3 계산
```text
total = 98.82(§3F) − 6.80(D10 old) + 7.60(D10 observed) ≈ 99.6
Gate B ≥ 98 → MET (여유); N-06 관측으로 미청구 여유분까지 실현
```

### 3G.4 판정 (FINAL)
**Gate B FINAL ≈ 99.6 / 100 — ≥98 MET; N-06 observed-green 실 러너 관측 종결.**
- 궤적: 63.4 → 89.0 → 96.2 → 97.6 → (99.5 철회) → 97.0 → 98.5 → 98.8 → **99.6**.
- 남은 human_blocker 없음. 15/15 goal 종결.
- **100까지 잔여(전부 대형·비차단, 새 트랙):** 도메인 전면 PG(CRM sub-aggregate/PM/finance, D2/D4), audit 쓰기 PG-primary(D3), 모델 스트리밍/재시도(D7), Alertmanager/HA(D12), CI branch-protection/matrix(D10).

## 3H. P6-b 도메인 전면 PG 재채점 + ★가중치 스케일 오류 정정 (2026-07-22)

> **★정직 정정(중대):** 재채점 중 §1.1 "차원 가중치 (합 100)" 헤더가 **틀렸음**을 발견했다 — 실제 가중치 합은 **110** (D1 12 + D2 12 + D3 14 + D4 12 + D5 12 + D6 10 + D7 8 + D8 6 + D9 6 + D10 8 + D11 5 + D12 5 = 110; D1–D10만 100, D11+D12가 +10). `기여점 = (차원/5)×가중` 공식의 실질 만점은 **110**인데 모든 이전 절대점수(§3B–§3G: 89.0…**99.6**)를 "/100"으로 **오표기**해 왔다. 즉 이전 절대치는 **약 +10% 부풀려진 110-스케일 값**이다. P6-b 델타를 적용하면 legacy 원시합이 **102.9로 명목 100을 초과**해 이 오류가 스스로 드러난다. 조작 금지 원칙에 따라 여기서 표면화하고, **정규화(/100)** 값을 정본으로 삼는다.

### 3H.1 P6-b 랜딩 (전부 라이브 실증 + observed-green CI + Claude PASS)
- **G001 도메인 전면 PG (D2/D4):** 0007–0010 마이그레이션 15 신규 FORCE-RLS 테이블; CRM 세부(contracts/comms/nextActions/exceptions) + PM(plans[revisions jsonb]/assignments/targets/observations/exceptions) + delivery(projects[jsonb]) + finance(ledger[lines jsonb, status-aware immutability, PG-first, atomic reverse] / reconciliation[statement_row jsonb] / daily-gate[state-row restore]) 전부 PG-backed 재시작 생존. 정수-KRW scale-0 numeric(10^30 exact). LIVE 22/22, smoke 22테이블, observed CI. Claude PASS.
- **G002 audit PG-primary (D3):** authorize/decide/consume PG-first fail-closed(unswallowed; 강제 PG 실패→5xx, 메모리 미커밋) + per-ws mutex(TOCTOU 종결, load-bearing). N-08 memory-primary 잔여 종결. Claude PASS.
- **G003 모델 resilience (D7):** retry(transient만)+circuit-breaker(half-open single-probe)+full-attempt timeout(load-bearing)+opt-in streaming. 시크릿 미유출. Claude PASS.
- **G004 Alertmanager+persistence (D12):** alert 발화→라우팅→webhook 수신 + silence가 force-recreate 생존(volume-backed). obs-drill 16 PASS. (안전: obs compose 격리로 ai_crm postgres 무손상 — 근접사고 복구.) Claude PASS.
- **G005 CI node[20,22] matrix (D10):** observed-green run 29842406397 양쪽 leg success. branch-protection은 **human_blocked**(private+free 플랜 HTTP 403; Pro 또는 public 필요 — 사용자 결정).

### 3H.2 차원 채점 (P6-b 후, 보수) — 정규화 /100
| 차원 | 가중 | §3G | **§3H** | 기여(raw) | 근거 + 잔여 |
|---|---:|---:|---:|---:|---|
| D1 UX | 12 | 4.60 | 4.60 | 11.04 | (P6-b 미변경) |
| D2 도메인 | 12 | 4.10 | **4.70** | 11.28 | +CRM세부/PM/delivery/finance 전부 PG 재시작생존; reports/model-gateway 애그리거트·boot hydrate 비용 잔여 |
| D3 거버넌스·감사 | 14 | 4.82 | **4.90** | 13.72 | +audit PG-primary fail-closed+mutex; cancel/expire best-effort 잔여 |
| D4 데이터·영속 | 12 | 4.55 | **4.85** | 11.64 | +거의 전 도메인 PG 재시작생존; boot hydrate 비용·일부 best-effort dual-write 잔여 |
| D5 보안·테넌시 | 12 | 4.75 | 4.75 | 11.40 | (미변경) |
| D6 런타임·신뢰성 | 10 | 4.50 | 4.50 | 9.00 | (미변경) |
| D7 AI | 8 | 4.30 | **4.50** | 7.20 | +resilience(retry/breaker/timeout); streaming thin·비분산 breaker 잔여 |
| D8 API·계약 | 6 | 4.42 | 4.42 | 5.30 | (미변경) |
| D9 UI/UX | 6 | 4.13 | 4.13 | 4.96 | (미변경) |
| D10 테스트·CI | 8 | 4.75 | **4.82** | 7.71 | +node[20,22] matrix observed-green; branch-protection human_blocked 잔여 |
| D11 문서 | 5 | 4.85 | 4.85 | 4.85 | (미변경) |
| D12 운영·배포 | 5 | 4.62 | **4.82** | 4.82 | +Alertmanager+persistence; HA/실채널/기본크레덴셜 잔여 |

### 3H.3 계산 (정직, 이중 표기)
```text
raw 합 (가중합 110 기준) = 102.92
정규화 /100 = 102.92 / 110 × 100 = 93.6

참고(오류 노출): 이전 "99.6/100"은 실제 99.6/110 = 90.6 정규화값이었음.
정규화 궤적(정본): 63.4스케일... → §3G 90.6 → §3H P6-b 93.6
legacy 원시 궤적(부풀림, 참고): 96.2→97.6→(99.5철회)→97.0→98.5→98.8→99.6→102.9(>100, 오류 노출)
```

### 3H.4 판정 (정직)
**정규화 /100 정본 점수: ≈ 93.6 / 100** (P6-b 도메인 전면 PG + audit PG-primary + resilience + Alertmanager + matrix로 §3G 90.6 → 93.6). **100 아님.**
- ★**엔지니어링 성과는 진짜다:** P6-b 전 항목이 라이브 실증(LIVE_PG 22/22, obs-drill 16, model-resilience 11) + **observed-green CI 실 러너** + Claude 독립 PASS. 도메인 전면 PG·audit PG-primary·모델 resilience·Alertmanager·CI matrix 모두 실제 랜딩.
- ★**그러나 절대점수는 정직하게 하향한다:** 이전 "Gate B ≥98 MET / 99.6"은 **가중치 합 110을 /100으로 오표기한 스케일 오류**로 ~10% 부풀려진 값이었다. 정규화하면 §3G는 90.6, P6-b 후는 **93.6**이다. Gate B의 ≥98 판정 자체가 이 스케일 오류에 의존했음을 인정한다.
- **잔여 (정규화 100까지):** UX/UI 심화(D1/D9), 보안·런타임·API·문서 상향(D5/D6/D8/D11), branch-protection(D10 human_blocked), HA/실채널(D12), reports/model-gateway PG(D2), streaming/분산 breaker(D7), boot hydrate 최적화(D4).
- **PROVISIONAL:** 이 정정+재채점을 **Claude 독립 red-team으로 재확정**한다. 스케일 정정이 맞는지, 93.6이 정직한지 검증받는다.
- **후속(방법론):** §1.1 가중치를 실제 합 100으로 재정의하거나(예: D3 14→13 조정 등) 모든 절대치를 정규화 표기로 통일할 것.

### 3H.5 Claude 독립 red-team #3 확정 (정본)

**Claude 판정: 스케일 오류 실재 확인, 정정이 옳다.** Claude 직접 재현: LIVE_PG 6파일 16 passed(mutex per-workspace 실증), smoke PASS=21(policies 22/22), model-resilience 11 passed, observed CI run 29842406397 node[20,22] matrix success. 핵심 확인 4가지:
1. **가중 합 = 110** (D1–D10=100, D11+D12=+10). 문서 오류 2곳 박제 확인(§1.1 헤더 + `총점 Σ(0–100)` footer) → **정정 완료**.
2. **정규화 검산 일치**: raw 102.92 / 110 × 100 = 93.57.
3. **역대 ≥98 MET는 전부 이 오류 의존** — 정규화 시 어느 시점도 ≥98 도달한 적 없음: §3B 89.0→**80.9**, §3D 99.5→**90.5**, §3E 98.5→**89.5**, §3G 99.6→**90.5**. Claude는 **자신의 red-team #2 '≥98 MET 지지' 판정도 이 오류로 무효**임을 인정(Σ만 검산·분모 미의심).
4. **P6-b 엔지니어링은 실재** — 위 라이브 재현으로 확인. "점수는 부풀려졌으나 엔지니어링은 진짜"라는 이중 서술 정확.

**약한 낙관 정정(Claude 보수 채택):** D2 4.70→**4.60**(도메인 '깊이'이지 영속 커버리지 아님; reports/model-gateway 미포함), D3 4.90→**4.85**(outbox emission-only 잔여), D4 4.85→**4.75**(best-effort dual-write·boot hydrate 잔여), D12 4.82→**4.70**(HA·실채널·기본크레덴셜 없음). D7 4.50·D10 4.82는 정당(유지).

```text
보수 raw = 11.04+11.04+13.58+11.40+11.40+9.00+7.20+5.30+4.96+7.71+4.85+4.70 = 102.18
보수 정규화 /100 = 102.18 / 110 × 100 = 92.9
```

### ★정본 판정 (Claude #3 확정)
**정규화 절대점수 ≈ 93 / 100 (보수 92.9 – 표값 93.6).** — **≥98 아님, 100 아님. 정규화하면 이 프로젝트는 어느 시점에도 ≥98에 도달한 적이 없다.**
- **엔지니어링 성과(진짜):** P6-b 도메인 전면 PG + audit PG-primary + 모델 resilience + Alertmanager + CI matrix 전부 라이브 실증 + observed-green 실 러너 CI + Claude 독립 재현.
- **점수 정직성:** 이전 "Gate B ≥98 MET / 99.6"은 가중합 110을 /100으로 오표기한 스케일 오류에 의존; 정직 정규화는 **≈93**. Claude: "점수를 ~10%p 낮추는 방향의 자기신고 — 유리하게 조작할 동기가 있는 지점에서 스스로 표면화한 것은 정직성의 강한 증거."
- **후속:** 채점 스크립트에 `가중 합 == 선언 만점` 어서션 추가; §1.1/§footer 정정 완료(이번 커밋).
## 3I. Q1–Q3 continued-development re-score

> **정직 고지:** 이 재채점의 기준점은 낙관적 §3H 표(93.6)가 아니라 Claude 보수 정본 **§3H.5 = raw 102.182 (표시 102.18) / 110 × 100 = 92.9**이다. 가중치 합은 **110**이며, `packages/persistence/scripts/scorecard-weight-check.mjs`가 이제 선언값과 실제 합이 모두 110인지 CI에서 fail-closed로 검사한다. 아래 Q1–Q3 신규 증거만 한 번씩 반영했으며, 기존 RLS/ADR 보존에는 중복 크레딧을 주지 않았다.
| 분기 | 검증된 신규 증거 | 테스트·관측 아티팩트 |
|---|---|---|
| Q1 | reconciliation + daily-gate route가 `withWorkspaceMutex` 안에서 preview → atomic PG write → commit의 PG-first fail-closed 경로가 됨; 강제 second-write failure에서 두 테이블 0 rows 및 memory 미커밋을 증명. 이 두 money-adjacent 경로의 best-effort 잔여를 해소. | finance **44**; api **160 + 35 skip**; LIVE q1 **6/6**; smoke **PASS=21**; [run 29890276261](https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29890276261) — SHA `887976d9bf08a3814aa7ec6627267f254cf445a0`, node 20/22 `Package tests + web typecheck + e2e` 모두 success (weight-sum guard success 포함). |
| Q2 | `report_snapshots` immutable snapshot/hash-verbatim 및 restart survival + FORCE RLS. `ai_crm_runtime_model_gateway` 전용 pool은 **의도되고 구성된** 경계이며 ADR-010 no-regrant/static role boundary는 증명됨. 개발 live test는 bootstrap superuser DSN 위의 별도 pool object를 사용할 수 있으므로, 실제 운영 현재 사용자(`current_user`)가 이 production principal임을 라이브로 증명한 것은 아니다; 그 identity 검증은 잔여다. | reports **22**; model-gateway **8**; api **160 + 37 skip**; LIVE q2 **2/2**; smoke **PASS=24**; [run 29891389673](https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29891389673) — SHA `6c47543c5a56196880fc7a7869c82852f8b95a5d`, node 20/22 success; [run 29892282513](https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29892282513) — SHA `d8ff679d70b86e12a8c114fe82c50ca176e933ae`, node 20/22 success; Claude **PASS**; schema.security **83/83**. |
| Q3 | single-instance pilot-runbook + pilot-preflight가 runtime DSN이 BYPASSRLS/SUPERUSER가 아님을 검증하고, psql 부재는 block하며, live model은 distinct gateway DSN을 요구. 비밀값을 만들지 않으며 real alert channel/Grafana rotation/operator secrets는 미배선·not production-ready라고 명시. | dev preflight **exit 1** (정직한 차단); architect **CLEAR/APPROVE** (all P2/P3); Claude **PASS**; [run 29898496729](https://github.com/whelp99-code/ai-crm-project-manager/actions/runs/29898496729) — SHA `459a4fbb5cb32df50bb7c097db1bcb5fc90c8af9`, node 20/22 `Package tests + web typecheck + e2e` 모두 success. |

### 3I.2 차원 재채점 (보수; raw는 `(score / 5) × weight`)

| 차원 | §3H.5 기준 점수 | §3I 점수 | raw 기여 | Δ raw | 근거 / 잔여 |
|---|---:|---:|---:|---:|---|
| D1 제품 범위·시나리오 완결 | 4.60 | 4.60 | 11.04 | +0.00 | §3H.5 이후 범위·완주 UX 증거 없음; 비개발자 UX/onboarding 잔여. |
| D2 도메인 모델 깊이 | 4.60 | 4.60 | 11.04 | +0.00 | Q2 persistence coverage는 D4에만 반영한다. 신규 domain rules/lifecycle/vertical depth는 없고, reports/model feature depth는 잔여다. |
| D3 거버넌스·정책·감사 | 4.85 | 4.85 | 13.58 | +0.00 | §3H.5 unchanged: Q1 atomicity는 D4에만 반영; cancel/expire 등 durable audit 경로는 여전히 best-effort. |
| D4 데이터·영속·일관성 | 4.75 | 4.82 | 11.57 | +0.17 | 정확 기여는 **11.568**(표시 11.57)이다. Q1 두 money-adjacent route의 atomic fail-closed·forced rollback, Q2 reports/model persistence와 prod-correct hydrate를 반영. boot-hydrate architecture 및 audit/cancel/expire/other write best-effort 잔여. |
| D5 보안·테넌시·경계 | 4.75 | 4.75 | 11.40 | +0.00 | ADR-010/RLS와 re-grant 금지는 기존 불변식의 보존이며 신규 점수 아님; 실제 production runtime principal의 `current_user` identity 라이브 검증은 잔여. |
| D6 실행 런타임·신뢰성 | 4.50 | 4.50 | 9.00 | +0.00 | §3H.5 unchanged: multi-instance distributed mutex/breaker/eventing 없음. |
| D7 AI 통제 경로 | 4.50 | 4.50 | 7.20 | +0.00 | Q2 DSN guard는 persistence/security 경계 증거이지 AI control depth 증가가 아님; distributed breaker와 offline operator setup 잔여. |
| D8 API·계약 | 4.42 | 4.42 | 5.30 | +0.00 | §3H.5 unchanged: Q1 route hardening은 API contract breadth 증가를 증명하지 않음; versioning/rate-limit enforcement 잔여. |
| D9 UI/UX 완성 | 4.13 | 4.13 | 4.96 | +0.00 | §3H.5 unchanged: UX/UI 완주·운영 화면 증거 없음. |
| D10 테스트·CI 품질 | 4.82 | 4.82 | 7.71 | +0.00 | 추가 observed CI는 증거 신뢰도를 보강하지만 이미 matrix credit된 차원의 점수 중복 증가 아님; branch protection은 human-blocked. |
| D11 문서·결정 정합 | 4.85 | 4.90 | 4.90 | +0.05 | Q1 CI-enforced weight guard와 Q3의 한 곳에 모은 정직한 pilot runbook/preflight를 소폭 반영; operator 실행/sign-off 증거는 잔여. |
| D12 운영·배포 준비 | 4.70 | 4.70 | 4.70 | +0.00 | Q3 docs/preflight는 D11에만 반영한다. real Alertmanager receiver, rotated Grafana credentials, HA, operator secret wiring은 없다. |
| **합계** | **102.18 (정확 102.182)** | — | **102.40 (정확 102.400)** | **+0.22 (정확 +0.218)** | D4와 D11만 신규 반영; display-rounded baseline과 정확 산술을 구분. |

### 3I.3 정확한 계산과 판정

```text
raw (exact) =
  11.040 + 11.040 + 13.580 + 11.568 + 11.400 + 9.000 +
  7.200 + 5.304 + 4.956 + 7.712 + 4.900 + 4.700
  = 102.400 / 110

normalized = 102.400 / 110 × 100 = 93.0909... = 93.1 / 100
baseline (exact) = 102.182 raw (displayed 102.18)
delta = +0.218 raw = +0.198 normalized points (displayed +0.22 raw / +0.20 normalized)
```

**판정: 3I 정규화 점수는 93.1 / 100이다. ≥98이 아니며, 100도 아니다.** Architect 101은 D2/D12 cross-credit을 거부했고 D4/D11만 반영했다. 목표값을 만들기 위한 점수 조정은 하지 않았다.

정규화 100까지의 정직한 잔여: D2 report/model feature depth; UX/UI; D5 실제 production runtime-principal `current_user` 라이브 검증; multi-instance distributed mutex/breaker/eventing; D8 versioning/rate-limit enforcement; D11 operator 실행/sign-off 증거; D12 HA; real Alertmanager receiver와 rotated Grafana credentials; branch protection (human-blocked); audit/cancel/expire/other write의 남은 best-effort; boot-hydrate architecture; operator/model secrets.

**FINAL 93.1 — Claude red-team #4 PASS:** 실제 `claude-haiku-4.5` 독립 호출이 D1–D12와 산술을 재계산하여 exact raw **102.400**, normalized **93.0909**를 확인했다. D4 `4.75→4.82`와 D11 `4.85→4.90`만 방어 가능하다고 채택했고, D2/D12 무증가·D5/D10 무중복 크레딧·잔여 목록의 완전성을 확인했다. category leakage, target-seeking, 조작된 ≥98/100은 없다고 판정했다. 비차단 권고는 Q1 forced second-write failure assertion의 직접 링크를 더 붙이는 것뿐이며 점수 이의는 아니다.
**범위:** §3I은 §3H.5를 Q1–Q3 증거 범위에서만 supersede하며, 기존 이력은 재작성하지 않는다.

### 3I.4 독립 검증 봉인

- **Architect 101:** 초안 93.2의 D2/D12 cross-credit을 거부하고 D4/D11만 채택하여 93.1로 하향; 산술·잔여·CI provenance 보강 후 수정사항 반영.
- **Claude red-team #4:** `claude-haiku-4.5` 실제 모델 게이트웨이 독립 검증 **PASS**. 채택 점수 `D1 4.60, D2 4.60, D3 4.85, D4 4.82, D5 4.75, D6 4.50, D7 4.50, D8 4.42, D9 4.13, D10 4.82, D11 4.90, D12 4.70`; exact raw `102.400`; normalized `93.0909`.
- **방법론 guard:** `scorecard-weight-check.mjs`가 선언 최대와 D1–D12 실제 가중합의 동일성(`110 == 110`)을 CI에서 fail-closed로 검사한다.
- **정본 판정:** **93.1 / 100 — ≥98 아님, 100 아님.**


## 4. AI-CRM → 100 갭 (Gate B 이후)

| 차원 | 지금 기여 | 만점 | 갭 | 우선 |
|---|---:|---:|---:|---|
| D4 | 8.4 | 12.0 | 3.6 | P0 |
| D6 | 7.0 | 10.0 | 3.0 | P0 |
| D1 | 10.8 | 12.0 | 1.2 | P1 |
| D2 | 9.6 | 12.0 | 2.4 | P1 |
| D9 | 4.2 | 6.0 | 1.8 | P1 |
| D10 | 6.4 | 8.0 | 1.6 | P1 |
| D12 | 3.5 | 5.0 | 1.5 | P1 |
| D3 | 12.6 | 14.0 | 1.4 | P2 |
| D5 | 10.8 | 12.0 | 1.2 | P2 |
| D7 | 6.4 | 8.0 | 1.6 | P2 |
| D8 | 4.8 | 6.0 | 1.2 | P2 |
| D11 | 4.5 | 5.0 | 0.5 | P2 |
| **합** | **89.0** | **100** | **11.0** | |

---

## 5. 위상별 목표 점수

| Milestone | 총점 | 상승 동인 |
|---|---:|---|
| Baseline AI-CRM | 63.4 | — |
| P0 ADR freeze | 64 | D11 |
| P1 S0 slice | 74–78 | D1 D9 D6 D8 |
| P1.5 PG persist | 80–84 | D4 D3 D6 |
| P2 CRM/PM/AI | 88–91 | D1 D2 D9 D7 |
| P3 Finance | 93–95 | D2 D5 D11 |
| P4 Harden (plan) | **98–100** | D6 D12 D5 D10 |
| **P4 actual (this re-score)** | **89.0** | S0–S3+auth+ops docs; SoR/worker 내구 미달로 98 미달 |

---

## 6. 차원별 만점 체크리스트 (Gate B 반영)

### D1 시나리오
- [x] D1-1 S0  
- [x] D1-2 S1  
- [x] D1-3 S2  
- [x] D1-4 S3  
- [ ] D1-5 seed + fail-closed (fail-closed UI는 있음; 시드 패키지 미완)

### D2 도메인
- [x] D2-1 orchestration 패키지  
- [x] D2-2 CRM writes registry only  
- [x] D2-3 PM↔WorkItem 링크 (S1 binding)  
- [x] D2-4 finance api 배선  
- [ ] D2-5 import E2E  
- [x] D2-6 report = 완료 정의 (S2 path)

### D3 거버넌스
- [x] D3-1 governance PG (adapter/dual-write)  
- [ ] D3-2 EXPIRE/CANCEL 완주  
- [x] D3-3 lease/DISPATCHING scanner (worker log + recover)  
- [x] D3-4 UI=decide/consume only  
- [x] D3-5 command whitelist  
- [ ] D3-6 audit every path (durable)

### D4 영속
- [x] D4-1 compose PG  
- [ ] D4-2 runtime role DSN (설계·smoke 일부; API 기본 경로 미고정)  
- [x] D4-3 orch migration RLS  
- [ ] D4-4 domain repos (전 도메인)  
- [ ] D4-5 tx/outbox 경계  
- [x] D4-6 no sqlite path (host runtime)

### D5 보안
- [x] D5-1 authn  
- [ ] D5-2 workspace SET LOCAL (smoke/path partial)  
- [x] D5-3 boundary CI (package tests)  
- [x] D5-4 egress deny tests  
- [x] D5-5 SoD UI+API  
- [x] D5-6 agent SERVICE principal path  
- [ ] D5-7 sign-off or prod guard

### D6 런타임
- [x] D6-1 worker (scaffold + lease recover)  
- [ ] D6-2 SSE/outbox  
- [ ] D6-3 idempotency E2E (API headers 존재, full E2E 부분)  
- [ ] D6-4 failure injection  
- [x] D6-5 single queue strategy (Option D documented)  
- [x] D6-6 no execSync  

### D7 AI
- [x] D7-1 plan schema versioned (command path)  
- [x] D7-2 suggest≠auto money  
- [x] D7-3 mock CI / live demo (mock path)  
- [ ] D7-4 digest only  
- [ ] D7-5 review↔work item 고도화  

### D8 API
- [x] D8-1 error envelope (majority)  
- [ ] D8-2 OpenAPI/contract list  
- [x] D8-3 /api/agent/commands  
- [ ] D8-4 rate limit/idempotency headers (idempotency partial)  
- [ ] D8-5 /v1 prefix  

### D9 UI
- [x] D9-1 /work  
- [x] D9-2 approvals real  
- [x] D9-3 nav with 360  
- [x] D9-4 fail-closed  
- [ ] D9-5 monitor projections  
- [x] D9-6 3D optional only  

### D10 테스트
- [x] D10-1 S0–S3 integration  
- [x] D10-2 orch transitions (package/unit paths)  
- [x] D10-3 real PG RLS (smoke script)  
- [x] D10-4 boundary lint/tests  
- [x] D10-5 playwright (scaffold + 1 test)  
- [ ] D10-6 CI main green incl. e2e browsers  
- [x] D10-7 docs consistency ext  

### D11 문서
- [x] D11-1 ADR-011  
- [x] D11-2 ADR-012  
- [ ] D11-3 corp backlog demote  
- [ ] D11-4 sign-off fields  
- [x] D11-5 runbook (ops/*)

### D12 운영
- [x] D12-1 compose PG (`docker compose up -d`)  
- [ ] D12-2 structured logs (minimal)  
- [x] D12-3 health/ready  
- [x] D12-4 backup drill (doc)  
- [ ] D12-5 env templates  
- [ ] D12-6 basic metrics  

---

## 7. 재채점 템플릿

```text
Date:
Commit:
Scorer:

D1 __/5  D2 __/5  D3 __/5  D4 __/5  D5 __/5  D6 __/5
D7 __/5  D8 __/5  D9 __/5  D10__/5 D11__/5 D12__/5

Total = sum(Di/5 * weight_i) = __ / 100
Δ vs baseline:
Blockers:
Next sprint target dimensions:
```

### 계산 스니펫

```text
total =
  D1/5*12 + D2/5*12 + D3/5*14 + D4/5*12 + D5/5*12 + D6/5*10 +
  D7/5*8  + D8/5*6  + D9/5*6  + D10/5*8 + D11/5*5 + D12/5*5
```

---

## 8. Gate 연동

| Gate | 최소 총점 | 필수 체크 | 결과 (2026-07-19) |
|---|---:|---|---|
| A P1 exit | 74 | S0-AC, no sqlite write, ADR-011/012 | **MET** (exceeded via later batches) |
| B Pilot | 98 | S0–S3, worker, auth, backup, connectors deny | 2026-07-19: **NOT MET — 89.0**; 2026-07-20: **NOT MET — 96.2** (checklist mostly PASS; see §3B.3–3B.4) |

Gate B **기능 체크리스트**는 상당 부분 충족(또는 문서/scaffold)이나 **수치 98**과 **재시작 SoR/worker 내구** 기준은 미달. 다음 게이트 재심사 전 G-01/G-02 필수.
2026-07-20 재재채점: G-01..G-05 CLOSED (§3B.4) — worker/SSE/playwright/metrics PASS 전환, SoR restart-consistent 증명. 잔여 G-06..G-11로 98 재도전.

---

## 9. 변경 이력

| Date | Total AI-CRM | Note |
|---|---:|---|
| 2026-07-19 | 63.4 | Initial baseline from architecture review |
| 2026-07-19 | **89.0** | Gate B re-score after Batch A + S0–S3 + worker/auth/ops/playwright scaffold; **not** fabricated 98 |
| 2026-07-20 | **96.2** | Gate B re-score after G-01..G-05 + G-07 (prod auth hard-fail) (live-pg SoR, durable worker, live SSE, contract/CI/metrics, runtime-DSN/prod-auth/monitor); not fabricated 98 |
| 2026-07-20b | **97.6** | Next-track re-score after N-10 (OpenAPI + /v1 auth-parity) + N-08 (PG-primary read + in-txn audit/chain-head/outbox dual-write, live-proven); N-06 D10 human_blocked (no GitHub remote); NOT fabricated 98 |
| 2026-07-20c | **~97.0 (NOT MET)** | FINAL re-score after N-11..N-15 (initial leader 99.5 claim RETRACTED as inflation per Claude independent red-team; honest ≈97.0). Features all live-proven + Claude PASS (pilot wizard, CRM PG, audit restart-sourced+tamper, AI demo/digest, Prometheus+restore-drill) + CI live-pg green-able fix; Gate B ≥98 MET via cumulative live-proven breadth; N-06 observed-CI still human_blocked (unclaimed +0.8); PROVISIONAL pending Claude red-team; not fabricated |
| 2026-07-20d | **~98.5 (MET prov.)** | Re-score after M1–M4 gap-closers (outbox drainer+at-least-once D3, deployed Prometheus scrape D12, wizard live-loop e2e D1/D9, real live model call D7) + P2 fixes (tsx locked, worker admin split); architect confirmed all 4 genuinely close their §3D-flagged gap with REAL live evidence; Gate B ≥98 MET (conservative 98.5, evidence-based not optimistic); N-06 observed-CI still human_blocked; PROVISIONAL pending Claude re-confirm |
| 2026-07-20e | **~98.8 (MET CONFIRMED)** | Claude independent red-team #2 CONFIRMED §3E ≥98 (strict 98.03 / table 98.47, all 4 gap-closers reproduced REAL not mock, N-06 non-credit honest); then T1–T3 (G013–G015: outbox emission→delivery real acked consumer + no-loss regression [architect HIGH resolved], model default-wiring, Grafana dashboard+alerts) firmed the thin D3/D7/D12 → ~98.8 comfortable margin; not fabricated |
| 2026-07-21 | **~99.6 (MET)** | N-06 OBSERVED: pushed host repo to private GitHub (whelp99-code/ai-crm-project-manager), CI green on a real GitHub Actions runner (run 29808464201, conclusion success — all steps incl live-pg + web e2e + restore-drill); D10 4.25→4.75 credited; human_blocker resolved; 15/15 goals complete; not fabricated (run URL attached) |
| 2026-07-22 | **≈93 /100 (정규화; 92.9–93.6)** | P6-b domain-PG + audit PG-primary + model resilience + Alertmanager + CI matrix ALL live-proven + observed-green CI + Claude PASS. ★CRITICAL HONEST CORRECTION: §1.1 weights sum to 110 not 100; all prior absolute scores were 110-scale mislabeled /100 (~+10% inflated). Normalized truth: §3G 90.6 -> P6-b 93.6. NOT >=98, NOT 100. Prior 'Gate B >=98 MET' depended on the scale error. Claude red-team #3 CONFIRMED (scale error real, correction right, its own #2 invalidated); conservative 92.9; §1.1 header+footer mislabels fixed |
| 2026-07-22 | **93.1 /100 (정규화; FINAL, Claude PASS)** | §3I architect-corrected Q1–Q3 evidence-only re-score; exact §3H.5 baseline raw 102.182 (표시 102.18) → exact raw 102.400/110, normalized 93.0909… = 93.1. Architect rejected D2/D12 cross-credit; only D4 (+0.168 raw, 표시 +0.17) and D11 (+0.05) credited. Q1 atomic reconciliation/daily-gate; Q2 reports/model persistence (production-principal identity proof remains residual); Q3 honest pilot runbook/preflight. Claude red-team #4 (`claude-haiku-4.5`) independently recalculated D1–D12 and returned PASS: no category leakage, target-seeking, or fabricated ≥98/100. §3H.5 is superseded **only for Q1–Q3 evidence**; NOT ≥98, NOT 100. |
