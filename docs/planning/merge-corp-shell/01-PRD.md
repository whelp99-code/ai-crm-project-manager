# PRD — AI-CRM 중심 Company OS 통합 (CORP-OS Shell 흡수)

| 필드 | 값 |
|---|---|
| Status | Draft for approval |
| Date | 2026-07-19 |
| Product | AI-CRM + Project Manager (+ Agent Shell) |
| Host repo | `AI-CRM+Project Manager` |
| Source (absorb) | `corp-os-mvp` (reference only) |
| Owner | Product Owner + Architecture Owner |
| Companion | `02-TDD.md`, `03-BLUEPRINT.md`, `04-SCORECARD.md` |

---

## 1. 문제 정의

### 1.1 현재 상태

| 시스템 | 강점 | 공백 | 완성도 |
|---|---|---|---|
| **AI-CRM** | Registry/policy/governance, CRM·PM·원장 골격, RLS 설계, model-gateway | UX 빈약, 인메모리 영속, worker 없음, 시나리오 미연결 | **≈ 63/100** |
| **CORP-OS** | 명령→승인→진행 UX, TaskEngine, SSE, 데모 임팩트 | 테넌시·감사·원장 없음, executor 로컬 효과, SQLite | **≈ 46/100** |

둘 다 개발 초기이다. 그러나 “초기”의 종류가 다르다.

- AI-CRM = **규율 잡힌 코어 골격**
- CORP-OS = **체험 가능한 프로토타입**

### 1.2 문제

1. AI-CRM만으로는 비개발자가 **일감·승인·진행을 체감**하기 어렵다.  
2. CORP-OS만으로는 **고객·계약·전표·감사**를 믿을 수 없다.  
3. 디렉터리 병합·이중 SoR·executor 잔존 시 거버넌스 내러티브가 즉시 붕괴한다.

### 1.3 기회

AI-CRM을 **System of Record + 통제 평면**으로 고정하고, CORP-OS를 **Agent Shell (orchestration + UX)** 로만 재장착하면:

- 판매/파일럿 스토리: “통제된 에이전트 운영 + native CRM/원장”
- 기술 레버리지: Intent→ActionType 접기, 승인 UI↔control, SSE projection≠audit

---

## 2. 제품 비전

> **감사 가능한 CRM / PM / 원장 위에서, 등록된 액션만 에이전트 파이프라인으로 계획·실행·승인·검토하는 Company OS.**

### 2.1 한 줄 포지셔닝

| 아님 | 임 |
|---|---|
| 3D 아바타 데모 툴 | 운영 가능한 업무·재무 코어 + 에이전트 셸 |
| 또 하나의 외부 CRM 연동 허브 | Native SoR, import-only 외부 증거 |
| LLM이 돈을 보내는 자동화 | LLM은 추론만, 효과는 registry+인간 통제 |

### 2.2 성공 시 사용자 문장

1. “고객 360에서 예외를 보고, 같은 화면 흐름에서 일감을 만들어 승인까지 끝냈다.”  
2. “에이전트가 초안을 만들어도 전표는 내 승인 없이 안 올라간다.”  
3. “감사 로그로 누가 무엇을 허가·적용했는지 재현된다.”  
4. “서버를 재시작해도 대기 중 승인과 장부가 안 사라진다.”  

---

## 3. 목표 / 비목표

### 3.1 Goals (Merge-MVP ~ Pilot)

| ID | 목표 | 측정 |
|---|---|---|
| G1 | AI-CRM monorepo가 유일한 host | CORP 코드 전량 copy 없음 |
| G2 | PG가 유일한 SoR | SQLite/Prisma write path 0 |
| G3 | 모든 효과 = ActionType 경로 | 미등록 명령 BLOCK |
| G4 | S0–S3 시나리오 완주 | §6 수락 테스트 |
| G5 | 완성도 ≥ 98/100 | `04-SCORECARD.md` 재채점 |
| G6 | connectors remote 유지 deny | security 테스트 green |

### 3.2 Non-Goals (명시 제외)

| ID | 비목표 | 이유 |
|---|---|---|
| NG1 | CORP 41 intent 핸들러 이식 | effect 모델 충돌 |
| NG2 | executor `execSync` / 자유 파일 쓰기 | confinement 파괴 |
| NG3 | 라이브 은행·외부 CRM·결제 커넥터 | ADR-001/002 |
| NG4 | 3D 오피스를 MVP 게이트에 포함 | skin, P5 |
| NG5 | Temporal 필수 | worker+PG로 파일럿 가능 |
| NG6 | 멀티 테넌트 상용 SaaS 완전체 | 만점 정의 = 단일 WS 파일럿 |
| NG7 | Slack/Kakao 원격 업무 실행 | 승인/알림 채널만 |
| NG8 | CORP PRD 30기능을 동급 규범화 | backlog 강등 |

---

## 4. 페르소나 & 사용 맥락

| 페르소나 | 니즈 | 핵심 화면 |
|---|---|---|
| **Owner/PM** | 고객·납품 진행, 범위/일정 변경 통제 | Customer 360, Workboard |
| **Finance verifier/CFO** | draft→verify→post, SoD | Approvals, Finance views |
| **Import operator** | CSV/OFX 반입, quarantine 처리 | Import (API/UI 최소) |
| **Agent operator** | 자연어 명령, 진행 모니터 | `/work` command shell |
| **Auditor** | 불변 감사 연쇄 | Audit verify (read role) |
| **Service agent (principal)** | 최소 권한으로 step 수행 | (UI 없음, SERVICE role) |

---

## 5. 범위

### 5.1 In scope — 제품 기능

#### F-CORE — 통제 평면 (기존 AI-CRM 유지·강화)

| ID | 기능 | 우선 |
|---|---|---|
| F-CORE-01 | Action registry + policy matrix | P0 |
| F-CORE-02 | Control lifecycle + SoD | P0 |
| F-CORE-03 | Execution intent + lease fencing | P0 |
| F-CORE-04 | Append-only audit chain | P0 |
| F-CORE-05 | Workspace FORCE RLS | P0 |
| F-CORE-06 | Model gateway (non-effect) | P0 |
| F-CORE-07 | Connectors disabled | P0 |

#### F-DOM — 도메인 (기존 강화 + 영속)

| ID | 기능 | 우선 |
|---|---|---|
| F-DOM-01 | Native CRM (customer, contract, communication) | P0 |
| F-DOM-02 | Delivery / PM (plan, task, target) | P0 |
| F-DOM-03 | Finance ledger draft/verify/post | P1 (sign-off 후 P0) |
| F-DOM-04 | Bank/CRM/ledger import + quarantine | P1 |
| F-DOM-05 | Final report immutable snapshot | P1 |
| F-DOM-06 | AI execute + independent review | P1 |

#### F-SHELL — CORP에서 흡수하는 셸

| ID | 기능 | CORP 유래 | 우선 |
|---|---|---|---|
| F-SHELL-01 | Natural language command → plan | submitCommand / planner | P0 |
| F-SHELL-02 | Job / WorkItem orchestration | TaskEngine | P0 |
| F-SHELL-03 | Approval inbox UX bound to controls | Approval modal | P0 |
| F-SHELL-04 | Live timeline / SSE projections | Event timeline + SSE | P0 |
| F-SHELL-05 | Workboard / workflow monitor | dashboard panels | P1 |
| F-SHELL-06 | KPI projections (non-SoR) | KPI panel | P2 |
| F-SHELL-07 | Agent presence skin (optional) | Agent panel / 3D | P3 |

### 5.2 Out of scope — CORP kill list (제품 요구로 금지)

- Prisma SQLite `dev.db`를 SoR로 사용  
- `lib/executor` 스타일 로컬 쉘/파일 효과  
- 서버 Zustand를 상태 소유자로 사용  
- Next.js Route Handler를 mutation 진입점으로 재도입  
- mailbox 파일 큐를 에이전트 버스로 사용  
- `public/results/**` md 다수 생성을 “업무 완료”로 정의  

---

## 6. 사용자 시나리오 & 수락 기준

### 6.1 시나리오 매트릭스

| ID | 이름 | 액터 | 완료 정의 | 게이트 |
|---|---|---|---|---|
| **S0** | 통제된 명령 한 방 | Operator + Approver | 아래 S0-AC | Phase 1 |
| **S1** | 360 → 일감 | PM | 360에서 job 생성·추적 | Phase 2 |
| **S2** | 납품 AI 루프 | Executor≠Reviewer | report snapshot ACCEPTED | Phase 2 |
| **S3** | 재무 하루 | Import op ≠ Verifier ≠ CFO | daily gate qualify 가능 입력 | Phase 3 |

### 6.2 S0 — Merge-MVP (필수)

**스토리**  
운영자가 Work 화면에서 “고객 A 프로젝트에 작업 배정해줘”에 해당하는 명령을 넣는다.  
시스템이 plan(MODEL_INVOKE) 후 WorkItem을 만들고, `PM_TASK_ASSIGN`(또는 동등 registry 명령)을 authorize한다.  
정책이 CHECKPOINT/APPROVAL이면 두 번째 사용자가 승인한다.  
효과가 domain에 반영되고 audit에 남으며 SSE/새로고침으로 WorkItem이 done이다.

| AC ID | 수락 기준 | 검증 |
|---|---|---|
| S0-AC1 | 미인증/워크스페이스 헤더 없으면 실패 (401/4xx), 가짜 데이터 없음 | API/UI |
| S0-AC2 | plan은 model-gateway만 경유; raw SDK import 없음 | boundary test |
| S0-AC3 | 효과 전 ActionType 매핑; 미매핑 step은 FAILED, **부작용 0** | integration |
| S0-AC4 | APPROVAL/CHECKPOINT 항목은 타인 principal만 decide | SoD test |
| S0-AC5 | consume 시 payloadHash/resourceVersion 불일치면 STALE, 효과 없음 | integration |
| S0-AC6 | 성공 시 domain 상태 + audit event + work item done 일치 | integration |
| S0-AC7 | 동일 idempotencyKey 재전송 시 중복 효과 없음 | integration |
| S0-AC8 | connectors.dispatch 호출 시 CONNECTOR_DISABLED | security |

### 6.3 S1 — Customer 360 연계

| AC ID | 기준 |
|---|---|
| S1-AC1 | 동일 `workspace_id`에서 360 overview와 work job 공존 |
| S1-AC2 | 360 “다음 행동”에서 job 생성 시 resourceId가 customer/project에 바인딩 |
| S1-AC3 | finance 블록은 pack 없으면 `pending`, 추정 숫자 표시 금지 |

### 6.4 S2 — 납품·AI 리뷰

| AC ID | 기준 |
|---|---|
| S2-AC1 | execution 제출에 evidence manifest + requirement trace 필수 |
| S2-AC2 | reviewer principal ≠ executor |
| S2-AC3 | critical defect → REWORK_REQUIRED, work item 재오픈 |
| S2-AC4 | 최종 완료 = immutable report snapshot (파일 md 아님) |

### 6.5 S3 — 재무

| AC ID | 기준 |
|---|---|
| S3-AC1 | import operator ≠ ledger verifier/CFO on same batch |
| S3-AC2 | quarantine row는 ledger/CRM mutate 0 |
| S3-AC3 | `LEDGER_POST` / `INVOICE_ISSUE` / `PAYMENT_EXECUTE` 항상 REQUIRE_APPROVAL |
| S3-AC4 | “재무 보고서” 명령 ≠ 자동 LEDGER_POST (draft/report만) |
| S3-AC5 | signed finance pack 없거나 DEV 플래그 없으면 finance route 503 |

---

## 7. 기능 요구사항 (상세)

### 7.1 Natural command (F-SHELL-01)

| 필드 | 요구 |
|---|---|
| Input | `text` (1..500), `idempotencyKey`, workspace, principal |
| Process | MODEL_INVOKE(plan schema v1) → Job + N WorkItems |
| Map | 각 step `suggestedCommand` → 화이트리스트 → ActionType |
| Unmapped | step fail, job partial/failed policy 문서화 |
| Output | `202 { jobId, workItemIds[] }` |

**Plan schema v1 (논리적 필드)**

```text
steps[]: { title, suggestedCommand, resourceHint?, notes? }
riskSummary?: string
```

자유 텍스트 step 효과 없음.

### 7.2 Orchestration (F-SHELL-02)

**WorkItem 상태**

```text
queued → running → waiting_control → running → done
                 ↘ failed
any non-terminal → cancelled (dispatch 전)
```

| 규칙 | 내용 |
|---|---|
| R1 | WorkItem done ≠ 회계 posted; posted는 intent+ledger만 |
| R2 | waiting_control 중 bound controlId 필수 |
| R3 | control REJECTED → work item failed (code=REJECTED) |
| R4 | PM Task와 ID 공간 분리 (`orch_work_items` vs pm tasks) |

### 7.3 Approvals UX (F-SHELL-03)

- 목록: PENDING controls for workspace  
- 액션: approve/reject + reason  
- API: 기존 governance decide only  
- 금지: UI에서 domain 직접 PATCH  

### 7.4 Projections & SSE (F-SHELL-04)

- 스트림: `work_item.updated`, `job.updated`, `control.updated` (projection)  
- hydrate: GET job snapshot  
- Event timeline UI는 `orch_job_events` (audit 대체 금지)  

### 7.5 Domain commands (기존 유지)

`GOVERNANCE_COMMANDS` 및 policy-matrix 준수.  
신규 ActionType 필요 시:

1. `packages/contracts`  
2. `POLICY_MATRIX` exhaustive  
3. ADR/policy-matrix 문서  
4. consistency test  

---

## 8. 비기능 요구사항

| ID | 분류 | 요구 | 목표 |
|---|---|---|---|
| NFR-01 | 일관성 | 단일 SoR = PostgreSQL 16 | 재시작 후 control/intent/domain 복원 |
| NFR-02 | 보안 | FORCE RLS, runtime NOBYPASSRLS | 타 workspace row 0 |
| NFR-03 | 보안 | egress allowlist 2 only | CI boundary |
| NFR-04 | 감사 | 효과 경로 audit append | verifier 재계산 가능 |
| NFR-05 | 멱등 | command/intent idempotency | 중복 효과 0 |
| NFR-06 | 가용 | api+worker+pg compose | one-command up |
| NFR-07 | 관측 | requestId, /health /ready | ready=PG ping |
| NFR-08 | 성능 (파일럿) | S0 p95 < 5s (mock model) | 로컬 |
| NFR-09 | 실패 폐쇄 | finance/model 미설정 시 503 | 가짜 데이터 금지 |
| NFR-10 | 테스트 | `pnpm check` + security + S0 integration | main green |

---

## 9. 정보 구조 (논리)

```text
Workspace
 ├─ Principals (OWNER|ADMIN|MEMBER|SERVICE|SYSTEM)
 ├─ CRM: Customers → Contracts, Communications
 ├─ Delivery: Projects → Plans → PM Tasks
 ├─ Finance: Journals, Lines, Reconciliations, DailyGate
 ├─ Imports: Batches → Rows (VALID|QUARANTINED|IMPORTED)
 ├─ Governance: Controls, Intents, Notifications
 ├─ Audit: Events (hash chain)
 ├─ AI: ModelInvocations, Executions, Reviews
 ├─ Reports: FinalReport snapshots
 └─ Orchestration: Jobs → WorkItems → JobEvents (UI)
```

---

## 10. UX 요구

### 10.1 정보 구조 (apps/web)

| Route | 목적 | Phase |
|---|---|---|
| `/` | Customer 360 | 기존 |
| `/approvals` | Control inbox | 기존 강화 |
| `/work` | Command + jobs | Phase 1 |
| `/work/jobs/[id]` | Job detail + timeline | Phase 1 |
| `/projects/...` | PM (최소) | Phase 2 |
| `/office` | 3D optional | Phase 5 |

### 10.2 UX 원칙

1. **Fail-closed:** 오류 시 빈 추정 UI 금지 (기존 360 철학 유지)  
2. **승인 무게 노출:** REQUIRE_APPROVAL vs CHECKPOINT 라벨  
3. **진행과 증명의 분리:** 타임라인(연출) vs “감사 보기”(증명)  
4. **모바일 비목표** (파일럿 데스크톱)  

---

## 11. 릴리스 단계 (제품)

| Phase | 이름 | 출시 가능 정의 | 목표 점수 |
|---|---|---|---|
| P0 | Freeze | ADR-011/012 머지, kill list 공지 | 63→64 |
| P1 | Slice S0 | S0-AC 전부, /work+approvals | 74–78 |
| P1.5 | Persist | orch+governance PG, 재시작 생존 | 80–84 |
| P2 | CRM/PM/AI | S1+S2 | 88–91 |
| P3 | Finance | S3 + sign-off | 93–95 |
| P4 | Harden | worker, backup, auth, CI boundary | 98–100 |
| P5 | Skin | 3D, KPI flair | 100 유지 |

---

## 12. 의존성 & 리스크

| ID | 리스크 | 영향 | 완화 |
|---|---|---|---|
| RK1 | 이중 SoR 타협 | 신뢰 전멸 | PRD kill list, CI |
| RK2 | executor 밀수 | 보안/감사 붕괴 | dependency lint |
| RK3 | finance sign-off 지연 | S3 블록 | DEV pack 플래그, prod 거부 |
| RK4 | 인메모리 governance 장기화 | 재시작 유실 | P1.5 필수 게이트 |
| RK5 | Task 명명 혼동 | 잘못된 resource 바인딩 | ADR-012, 스키마 분리 |
| RK6 | 스코프 폭발 (3D/41 intent) | 일정 실패 | Non-goals |
| RK7 | 데모 체감 하락 | 이해관계자 불만 | S0 영상 + 명시적 승인 UX |
| RK8 | Temporal premature | 복잡도 | worker 먼저 |

---

## 13. 마일스톤 게이트 (Go/No-Go)

### Gate A — P1 exit (Merge-MVP)

- [ ] S0-AC1..8 pass  
- [ ] ADR-011/012 merged  
- [ ] No Prisma/sqlite write in host runtime  
- [ ] Score ≥ 74  

### Gate B — Pilot-ready (P4 exit)

- [ ] S0–S3 pass  
- [ ] Score ≥ 98  
- [ ] compose up, backup drill logged  
- [ ] authn on  
- [ ] connectors disabled assert  
- [ ] sign-off or prod build blocks unsigned finance  

---

## 14. 오픈 이슈 (제품)

| ID | 이슈 | 기본 가정 | 결정 필요자 |
|---|---|---|---|
| O1 | 인증 방식 | 파일럿 API key → OIDC | Security |
| O2 | 자연어 언어 | ko+en plan prompts | PO |
| O3 | Job partial success UX | 실패 step 표시, job=partial | PO |
| O4 | 3D 투자 여부 | P5 optional | PO |
| O5 | 제품 표기명 | AI-CRM Company OS | PO |

---

## 15. 추적 가능성

| 본 PRD | TDD | Blueprint | Score |
|---|---|---|---|
| S0–S3 | § tests S0–S3 | § phases | D1 |
| F-CORE | packages governance… | layer diagram | D3 D5 |
| F-SHELL | packages/orchestration | API agent/* | D6 D9 |
| NFR | test/security/ops | compose/worker | D4 D10 D12 |
| Kill list | boundary tests | forbidden deps | D5 D7 |

---

## 16. 승인

| 역할 | 이름 | 날짜 | 서명 |
|---|---|---|---|
| Product Owner | | | |
| Architecture Owner | | | |
| Security | | | |
| Controller/CFO (S3) | | | |

---

## 부록 A — 명령 매핑 원칙 (제품)

| 사용자 말 (예시) | 허용 결과 | 금지 |
|---|---|---|
| 작업 배정/계획 수정 | PM_* / INTERNAL_* | 쉘 배포 |
| 고객에게 보내 | CUSTOMER_SEND + 승인 | 메일 SDK 직행 |
| 견적/계약 | CONTRACT_CHANGE 등 + 승인 | |
| 재무 보고서 | MODEL_INVOKE + report/draft | 자동 LEDGER_POST |
| 서버 점검/배포 | 제품 외 | orchestration 흡수 금지 |

## 부록 B — 용어

| 용어 | 정의 |
|---|---|
| SoR | System of Record — PostgreSQL |
| WorkItem | 오케스트레이션 스텝 (구 CORP Task) |
| PM Task | 납품 도메인 작업 |
| Control | 인간/체크포인트 허가 객체 |
| Intent | 허가된 실행 의도 (lease 가능) |
| Projection | UI용 파생 뷰, 감사 대체 불가 |
