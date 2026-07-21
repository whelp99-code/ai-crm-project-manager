# Blueprint — AI-CRM 중심 통합 시스템 설계도

| 필드 | 값 |
|---|---|
| Status | Draft |
| Date | 2026-07-19 |
| PRD | `01-PRD.md` |
| TDD | `02-TDD.md` |

---

## 1. 한 장 개요

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/web (Next.js)                                                       │
│  /  Customer 360                                                         │
│  /approvals  Control inbox                                               │
│  /work       Command · Jobs · Timeline                                   │
│  (P5 /office 3D skin)                                                    │
│  Zustand = client cache only                                             │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │ HTTPS
                                 │ x-workspace-id · x-principal-id · auth
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/api (Fastify)  *** only mutation gateway ***                        │
│  NaturalCommandService · Governance routes · Domain routes               │
│  Application layer wires ports                                           │
└─────┬───────────────┬───────────────┬───────────────┬────────────────────┘
      │               │               │               │
      ▼               ▼               ▼               ▼
 orchestration   governance     domain/finance    model-gateway
 WorkItems       controls       imports/reports   (infer only)
      │          intents              │               │
      │          audit                │               │
      └───────────────┬───────────────┘               │
                      ▼                               │
              packages/persistence ◄──────────────────┘
              PostgreSQL 16 FORCE RLS
                      ▲
                      │
              apps/worker (P4)
              lease recover · notify · outbox
```

**법 4조**

1. SoR = PostgreSQL only  
2. Effect = ActionType via governance only  
3. Egress = model-gateway (+ future connector-dispatcher, MVP deny)  
4. Shell has no side effects beyond calling api  

---

## 2. 레포 블루프린트

### 2.1 Target tree

```text
AI-CRM+Project Manager/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts                 # existing composition root
│   │   │   ├── routes/
│   │   │   │   ├── agent-commands.ts  # NEW
│   │   │   │   ├── governance.ts      # extract over time
│   │   │   │   └── ...
│   │   │   ├── services/
│   │   │   │   └── natural-command.ts # NEW
│   │   │   └── command-map.ts         # NEW pure map
│   │   └── test/
│   │       └── s0-natural-command.integration.test.ts
│   ├── web/
│   │   └── app/
│   │       ├── page.tsx               # 360
│   │       ├── approvals/
│   │       └── work/                  # NEW
│   └── worker/                        # NEW P4
│       └── src/main.ts
├── packages/
│   ├── contracts/                     # KEEP
│   ├── policy-engine/                 # KEEP
│   ├── governance/                    # KEEP → PG adapter
│   ├── domain/                        # KEEP
│   ├── finance/                       # KEEP
│   ├── imports/                       # KEEP
│   ├── reports/                       # KEEP
│   ├── model-gateway/                 # KEEP
│   ├── ai-orchestrator/               # KEEP
│   ├── connectors/                    # KEEP disabled
│   ├── persistence/                   # KEEP + 0003_orchestration.sql
│   ├── orchestration/                 # NEW
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── machine.ts
│   │   │   ├── types.ts
│   │   │   └── memory-store.ts
│   │   └── test/
│   └── shell-projections/             # OPTIONAL DTO helpers
├── docs/
│   ├── adr/
│   │   ├── 011-merge-corp-shell.md    # NEW
│   │   └── 012-orchestration.md       # NEW
│   └── planning/merge-corp-shell/     # this set
└── docker-compose.yml                 # NEW pg(+ optional stack)
```

### 2.2 CORP-OS 처분

| CORP path | 처분 |
|---|---|
| `lib/engine/task-engine.ts` | 개념 참조 → `packages/orchestration` 재작성 |
| `components/dashboard/*` | UX 패턴 참조 → `apps/web` presentational |
| `app/api/*` | **폐기** (Fastify로) |
| `lib/executor/*` | **폐기** |
| `prisma/*` | **폐기** |
| `stores/corp-os-store.ts` | hydrate/SSE 패턴만 참조 |
| `docs/prd/*` | backlog 강등 |
| nested `CORP-OS/` empty git | 삭제 (manual) |
| 원본 repo | archive read-only |

물리 copy-paste monorepo merge **금지**.

---

## 3. 런타임 토폴로지

### 3.1 Phase 1 (개발)

```text
[developer browser]
       → web :3000
       → api :3001
            → memory governance/orch
            → mock ModelClient
            → (optional) PG if available
```

### 3.2 Phase 1.5+ (파일럿 최소)

```text
web → api → PostgreSQL
         ↘ model-gateway adapter (mock|live)
worker → PostgreSQL (lease/notify)
```

### 3.3 프로세스 책임

| Process | 책임 | 금지 |
|---|---|---|
| web | SSR/CSR UI, BFF 아닌 순수 클라이언트 | DB, secrets to browser beyond public api |
| api | authz, command, domain apply, audit | long blocking shell, raw provider SDK |
| worker | recover leases, notifications, outbox fanout | user-facing HTTP |
| postgres | SoR | app logic |

---

## 4. 논리 컴포넌트 명세

### 4.1 `packages/orchestration`

| 항목 | 내용 |
|---|---|
| 책임 | Job/WorkItem 수명주기, UI events, 배정 메타 |
| 비책임 | policy, money, CRM mutate, LLM HTTP, fs/shell |
| 입력 | plan DTO, control outcomes (from api) |
| 출력 | snapshots, domain events (in-proc) |
| 영속 | P1 memory / P1.5 PG `orch_*` |

**상태 기계 (WorkItem)**

```text
queued --start--> running --need_control--> waiting_control
                      |                         |
                      |<------approved----------|
                      |------rejected--------> failed
                      |------apply_ok--------> done
                      |------apply_err-------> failed
queued|running|waiting_control --cancel--> cancelled
done|failed|cancelled terminal
```

### 4.2 `NaturalCommandService` (api)

| Step | Port |
|---|---|
| Plan | `ModelGateway` |
| Map | `command-map` pure |
| Authz | `GovernancePort` |
| Effect | `DomainPort` / `FinancePort` |
| Track | `OrchPort` |
| Project | outbox / SSE hub |

### 4.3 Governance (existing)

Control: PENDING → APPROVED/REJECTED → CONSUMED  
Intent: QUEUED → LEASED → DISPATCHING → terminal  
Internal ALLOW: markIntentApplied short path  

P1.5: same semantics on PG with row locks order:

```text
resource → control → intent
```

### 4.4 Model gateway (existing)

- Action `MODEL_INVOKE`  
- structured output only  
- digests persisted  
- no effect tables beyond `model_invocations`  

### 4.5 Connectors (existing)

`dispatch` always `CONNECTOR_DISABLED`.

---

## 5. 데이터 블루프린트

### 5.1 기존 (유지)

- workspaces, principals  
- execution_intents, controls (schema-ready)  
- audit_events, audit_chain_heads  
- imports, model_invocations  
- domain/finance tables as implemented/planned  

### 5.2 신규 migration `0003_orchestration.sql`

```sql
-- logical columns (types illustrative)
orch_jobs (
  id uuid PK,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source text NOT NULL,              -- natural_command | api
  raw_text text NOT NULL,
  plan_invocation_id uuid NULL,     -- model_invocations
  status text NOT NULL,             -- open|partial|done|failed|cancelled
  created_by_principal_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

orch_work_items (
  id uuid PK,
  job_id uuid NOT NULL REFERENCES orch_jobs(id),
  workspace_id uuid NOT NULL,
  sequence int NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  suggested_command text NULL,
  action_type text NULL,
  assigned_principal_id uuid NULL,
  control_id uuid NULL,
  intent_id uuid NULL,
  resource_id uuid NULL,
  resource_version int NULL,
  progress int NOT NULL DEFAULT 0,
  error_code text NULL,
  result_ref jsonb NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

orch_job_events (
  id uuid PK,
  job_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  at timestamptz NOT NULL
);
```

**공통**

- NOT NULL workspace_id  
- ENABLE + FORCE RLS  
- policy using `app_current_workspace_id()`  
- grants to `ai_crm_runtime_api` / `ai_crm_runtime_worker`  

### 5.3 완료 의미 매트릭스

| 상태 | UI | 감사/재무 |
|---|---|---|
| WorkItem done | 스텝 완료 | 부족 |
| Intent SUCCEEDED | | 효과 허가·적용 증거 |
| Ledger POSTED | | 장부 확정 |
| Report submitted | 보고서 확정 | immutable snapshot |
| Job done | 모든 필수 step terminal | 파생 |

### 5.4 명시적 비저장 (SoR 금지)

- agent avatar coordinates (optional ephemeral)  
- stress level theatre  
- raw model prompts (digest only)  
- CORP public/results files as truth  

---

## 6. API 블루프린트

### 6.1 신규 Agent API

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/v1/agent/commands` | `{ text, idempotencyKey? }` | `202 { jobId, workItemIds, status }` |
| GET | `/v1/agent/jobs/:id` | — | `200 snapshot` |
| GET | `/v1/agent/jobs/:id/events` | SSE | stream |
| POST | `/v1/agent/jobs/:id/cancel` | — | `200` |

Headers: `x-workspace-id`, principal/auth.

### 6.2 기존 API (유지·정합)

- CRM / delivery / PM  
- finance (pack-gated)  
- imports  
- governance authorize/decide  
- model invoke  
- reports  
- customer overview  

### 6.3 오류 봉투

```json
{
  "error": {
    "code": "STALE_CONTROL_BINDING",
    "message": "human readable",
    "requestId": "uuid"
  }
}
```

### 6.4 SSE events (projection)

```text
event: job.updated
data: { jobId, status, ... }

event: work_item.updated
data: { jobId, workItemId, status, progress, errorCode? }

event: control.updated
data: { controlId, status, workItemId? }
```

---

## 7. 시퀀스 블루프린트

### 7.1 S0 happy path (approval)

```text
UI                API                 GW        Gov        Orch       Domain    Audit
 |--POST command-->|                   |          |          |          |         |
 |                 |--MODEL_INVOKE---->|          |          |          |         |
 |                 |<--plan steps------|          |          |          |         |
 |                 |--createJob---------------------------->|          |         |
 |                 |--authorize------------------>|          |          |         |
 |                 |<--control PENDING------------|          |          |         |
 |                 |--bindControl-------------------------->|          |         |
 |                 |--append audit---------------------------------------------->|
 |<-202 jobId------|                   |          |          |          |         |
 |--SSE waiting----|                   |          |          |          |         |
 |--decide OK----->|--decideControl-------------->|          |          |         |
 |                 |--consume-------------------->|          |          |         |
 |                 |--apply------------------------------------------->|         |
 |                 |--mark applied--------------->|          |          |         |
 |                 |--markDone---------------------------------------->|         |
 |                 |--audit----------------------------------------------------->|
 |<-SSE done-------|                   |          |          |          |         |
```

### 7.2 Unmapped step

```text
plan step unknown → orch.fail(UNMAPPED) → no authorize → no domain → audit optional JOB_STEP_FAILED
```

---

## 8. 보안 블루프린트

```text
                  ┌────────────┐
   Browser token  │  API auth  │  → PrincipalContext
                  └─────┬──────┘
                        │ SET LOCAL app.workspace_id
                        ▼
                  ┌────────────┐
                  │  FORCE RLS │
                  └─────┬──────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
     api role       worker role    audit_verifier
     DML scoped     DML scoped     SELECT audit
```

| Control | 구현 |
|---|---|
| Tenant | workspace_id + RLS |
| Authz | registry + policy + SoD |
| Egress | gateway/connectors packages only |
| Agent power | SERVICE role, no self-approve |
| Secrets | env/secret manager, never CORP .env commit |

---

## 9. UI 블루프린트

### 9.1 `/work` wireframe (논리)

```text
┌─────────────────────────────────────────────────────────────┐
│ Company OS · Work                      [Approvals (3)] [360]│
├─────────────────────────────────────────────────────────────┤
│ Command: [________________________] [Run]                   │
│ idempotency auto / advanced                                 │
├──────────────────────────┬──────────────────────────────────┤
│ Jobs                     │ Job detail                       │
│ • job_123 open           │ steps:                           │
│ • job_122 done           │ 1 assign  waiting_control [..]   │
│                          │ Timeline                         │
│                          │ · planned · control · ...        │
└──────────────────────────┴──────────────────────────────────┘
```

### 9.2 상태 배지

| status | color intent |
|---|---|
| waiting_control | attention |
| running | progress |
| done | ok |
| failed | danger |
| cancelled | muted |

### 9.3 데이터 fetch

- Server components: overview 패턴 유지 가능  
- Workboard: client hydrate + SSE (CORP LiveSync 패턴)  
- Cache invalidation on control decide  

---

## 10. 구현 페이즈 블루프린트

```text
P0 Freeze
  ADR-011/012 · scorecard baseline · backlog corp-legacy
       │
P1 S0 Slice
  orchestration pkg · command-map · NaturalCommandService
  /work + approvals bind · S0 tests
       │
P1.5 Persist
  0003 SQL · gov PG · restart tests · compose pg
       │
P2 CRM/PM/AI
  S1 S2 · ai-orchestrator bind · reports
       │
P3 Finance
  sign-off · S3 · daily gate paths
       │
P4 Harden
  worker · auth · backup · e2e CI · score ≥98
       │
P5 Skin
  3D optional · KPI flair
```

### 10.1 작업 분해 (엔지니어링 티켓 수준)

| ID | 작업 | Phase | 의존 | 테스트 ID |
|---|---|---|---|---|
| T-001 | ADR-011/012 작성·머지 | P0 | — | DOC |
| T-002 | `packages/orchestration` scaffold | P1 | T-001 | ORCH-U-* |
| T-003 | command-map + tests | P1 | T-002 | MAP-U-* |
| T-004 | boundary lint SEC-01..04 | P1 | T-002 | SEC-* |
| T-005 | NaturalCommandService + route | P1 | T-003 | S0-I-* |
| T-006 | SSE hub minimal | P1 | T-005 | S0-I-06 |
| T-007 | web `/work` | P1 | T-005 | E2E-S0-01 |
| T-008 | approvals bind real controls | P1 | T-005 | E2E |
| T-009 | migration 0003 | P1.5 | T-002 | MIG-* |
| T-010 | governance PG adapter | P1.5 | T-009 | restart |
| T-011 | orch PG adapter | P1.5 | T-009 | restart |
| T-012 | docker-compose pg | P1.5 | — | MIG |
| T-013 | S1 360 link | P2 | T-011 | S1-I-* |
| T-014 | S2 AI/report | P2 | T-011 | S2-I-* |
| T-015 | S3 finance | P3 | sign-off | S3-I-* |
| T-016 | apps/worker | P4 | T-010 | GOV-U-06 |
| T-017 | authn | P4 | — | S0-I-01 |
| T-018 | backup/health/runbook | P4 | T-012 | ops |
| T-019 | playwright CI | P4 | T-007 | E2E |
| T-020 | scorecard re-score ≥98 | P4 | all | 04-SCORECARD |

---

## 11. 설정·환경

| Var | Process | 설명 |
|---|---|---|
| `DATABASE_URL` | api/worker | runtime role DSN |
| `DATABASE_URL_MIGRATE` | CI/migrate | owner role |
| `API_BASE_URL` | web | |
| `WORKSPACE_ID` | web demo | |
| `MODEL_*` | api | gateway only |
| `EXECUTION_MODE` | api | mock\|live |
| `DEV_UNSIGNED_FINANCE_PACK` | api | non-prod only |
| `AUTH_*` | api | P4 |

---

## 12. 관측·운영

| 신호 | 출처 |
|---|---|
| `http_request` + requestId | api |
| intent status counts | worker metrics |
| approval wait age | SQL gauge |
| model latency | model_invocations |
| /health | liveness |
| /ready | PG select 1 |

Backup: nightly pg_dump + restore drill log in `docs/ops/`.

---

## 13. 안티패턴 (블루프린트 위반)

| 안티패턴 | 올바른 대안 |
|---|---|
| Next route에서 ledger write | Fastify + governance |
| orch 패키지에서 fs.write | evidence service via registry |
| UI가 승인 없이 domain PATCH | control decide |
| EventLog를 audit로 청구 | audit_events chain |
| SQLite “임시 진실” | PG only |
| Agent=OWNER seed | SERVICE |
| 41 intent switch 이식 | command-map 접기 |
| Temporal+in-proc 이중 큐 | 하나만 |

---

## 14. 용량·파일럿 가정

| 항목 | 가정 |
|---|---|
| Workspaces | 1 (확장 스키마는 멀티 가능) |
| DAU | < 20 |
| Jobs/day | < 500 |
| Concurrent approvals | < 20 |
| HA | 단일 노드 OK |

초과 시 별도 용량 ADR.

---

## 15. 매핑: PRD ↔ Blueprint

| PRD | Blueprint section |
|---|---|
| G1–G6 | §1 laws, §2 repo |
| F-SHELL-* | §4.1, §6.1, §9 |
| F-CORE-* | §4.3–4.5, §8 |
| S0 | §7.1, T-005..008 |
| Kill list | §2.2, §13 |
| Phases | §10 |

---

## 16. 다음 구현 커밋 순서 (권장)

1. `docs/adr/011` + `012`  
2. `packages/orchestration` + unit tests (RED then GREEN)  
3. `command-map` + `s0` integration RED  
4. `NaturalCommandService` GREEN  
5. web `/work` skeleton  
6. compose + 0003  

이 순서를 지키면 TDD 문서와 블루프린트가 동일 궤도를 유지한다.
