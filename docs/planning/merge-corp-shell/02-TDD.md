# TDD — 기술 설계 + 테스트 주도 계획

| 필드 | 값 |
|---|---|
| Status | Draft |
| Date | 2026-07-19 |
| PRD | `01-PRD.md` |
| Blueprint | `03-BLUEPRINT.md` |
| Stack baseline | AI-CRM ADR-001 (TS pnpm, Fastify, Next, PG16) |

본 문서는 **구현 전에 테스트를 먼저 고정**하는 TDD 계획과, 그에 필요한 **기술 설계 결정**을 함께 담는다.

---

## 1. TDD 원칙

### 1.1 규칙

1. **Red → Green → Refactor** 를 패키지 단위로 적용한다.  
2. 프로덕션 코드 없이 통과하는 테스트는 삭제하거나 강화한다 (tautology 금지).  
3. **경계 테스트** (import/egress/SoD/RLS)는 기능 테스트와 동급 P0.  
4. CORP에서 포팅하는 UX는 **계약 테스트 통과 후** UI 연결.  
5. “파일 생성 = 성공” 같은 CORP executor 검증은 **채택 금지**.

### 1.2 테스트 피라미드

```text
        E2E (Playwright)     소수: S0 UI 경로
       /                \
  API Integration         SSE/job hydrate
     /          \
Unit (pure)    Security/Boundary
orchestration  policy  contracts  connectors  gateway
```

| 층 | 도구 | 위치 |
|---|---|---|
| Unit | vitest | `packages/*/test` |
| Integration | vitest | `apps/api/test`, package integration |
| Security | vitest | `*.security.test.ts` |
| E2E | playwright | `apps/web/e2e` (신규) |
| Docs consistency | vitest | 기존 패턴 확장 |

### 1.3 명령

```bash
pnpm check                    # typecheck + test
pnpm test:unit
pnpm test:integration
pnpm test:security
pnpm --filter @ai-crm/web e2e # Phase 1+
```

CI: main에 `check` + security 필수. E2E는 P1 게이트부터.

---

## 2. 기술 설계 결정 (TDD가 고정하는 계약)

### 2.1 ADR 매핑

| 결정 | ADR | 테스트로 고정할 불변식 |
|---|---|---|
| Host = AI-CRM | 011 (신규) | CORP sqlite/executor path 부재 |
| WorkItem ≠ PM Task | 012 (신규) | 스키마/타입 분리 |
| Registry before effect | 001 | unmapped command no mutate |
| Two egress only | 001/010 | import boundary |
| Native SoR | 002 | no live connector |
| RLS | security doc | workspace isolation |

### 2.2 패키지 의존 그래프 (허용)

```text
contracts
  ↑
policy-engine, persistence(types)
  ↑
governance, domain, finance, imports, reports, model-gateway
  ↑
ai-orchestrator, orchestration, connectors
  ↑
apps/api
  ↑
apps/web (HTTP only)
apps/worker → governance, persistence, notifications
```

**금지 엣지 (lint/test)**

| From | To | 이유 |
|---|---|---|
| orchestration | finance/domain mutate APIs 내부 우회 | effect는 api+governance만 |
| orchestration | child_process, fs.write | CORP executor 재발 방지 |
| ai-orchestrator | provider SDK | gateway only |
| model-gateway | connectors | effect 혼합 금지 |
| web | persistence | 직접 DB 금지 |
| any | prisma (CORP) | host 무관 |

### 2.3 Orchestration 순수 도메인 (테스트 가능 설계)

```ts
// 의사코드 — 구현 전 테스트가 먼저 잠금
type WorkItemStatus =
  | "queued" | "running" | "waiting_control"
  | "done" | "failed" | "cancelled";

interface WorkItem {
  id: string;
  jobId: string;
  workspaceId: string;
  status: WorkItemStatus;
  controlId?: string;
  intentId?: string;
  actionType?: string;
  progress: number;
  errorCode?: string;
}

// pure transitions
assertTransition(from, to) // table-driven
bindControl(item, controlId) // only from running|queued → waiting_control
onControlApproved(item) // waiting_control → running
onControlRejected(item) // → failed REJECTED
markDone(item) // running → done only if intent applied ref present (api layer)
```

**효과 적용은 orchestration 밖** (api application service).

### 2.4 Application service (api) — 트랜잭션 스토리

```text
NaturalCommandService.execute:
  1. verify principal + workspace
  2. idempotency lookup → return existing job if hit
  3. modelGateway.invoke(planSchema)  // MODEL_INVOKE
  4. orch.createJob(plan)
  5. for step of plan:
       cmd = mapCommand(step.suggestedCommand) // pure
       if !cmd: orch.fail(step, UNMAPPED); continue
       authz = governance.authorize(cmd...)
       if ALLOW: applyDomain(); governance.markIntentApplied(); orch.done(step)
       if NEED_CONTROL: orch.bindControl(step, control.id); emit SSE
  6. return jobId
```

TDD: step 5 분기를 표 기반 통합 테스트로 고정.

### 2.5 Command → ActionType map (pure)

```ts
// packages/orchestration or apps/api/src/command-map.ts
export const COMMAND_MAP: Record<string, ActionType> = {
  "pm.task_assign": "PM_TASK_ASSIGN",
  "pm.plan_revise": "PM_PLAN_REVISE",
  "finance.draft": "FINANCE_DRAFT",
  // ...
};
export function mapCommand(s: string): ActionType | null
```

- 미등록 → `null` (BLOCK/ no effect)  
- 신규 키 추가 = contracts 변경과 동일 리뷰 등급  

### 2.6 Persistence

| 단계 | governance | orchestration | domain |
|---|---|---|---|
| P1 | in-memory OK (문서화) | in-memory OK | 기존 서비스 |
| P1.5 | **PG required** | **PG required** | repo 착수 |
| P2+ | PG | PG | PG |

테스트 더블: in-memory fakes implement same ports.

```ts
interface GovernancePort { authorize(...); decideControl(...); consumeControl(...); }
interface OrchPort { createJob(...); getJob(...); }
interface DomainPort { assignTask(...); draftJournal(...); }
```

---

## 3. 테스트 카탈로그 (먼저 작성할 스펙)

### 3.1 Unit — `packages/orchestration`

| Test ID | 설명 | Red 조건 |
|---|---|---|
| ORCH-U-01 | 상태 전이 표 허용/거부 | 불법 전이 throw |
| ORCH-U-02 | createJob: steps 순서 sequence 부여 | |
| ORCH-U-03 | bindControl: controlId 필수, status=waiting_control | |
| ORCH-U-04 | reject → failed + errorCode=REJECTED | |
| ORCH-U-05 | cancel only before dispatch-equivalent (not done) | |
| ORCH-U-06 | progress 계산 0..100 | |
| ORCH-U-07 | workspaceId 없는 입력 거부 | |
| ORCH-U-08 | job event append-only for UI log | |

### 3.2 Unit — command map

| Test ID | 설명 |
|---|---|
| MAP-U-01 | 모든 map 값이 ACTION_TYPES 멤버 |
| MAP-U-02 | 모르는 문자열 null |
| MAP-U-03 | 대소문자/공백 normalize 정책 고정 |

### 3.3 Unit — policy/governance (기존 확장)

| Test ID | 설명 |
|---|---|
| POL-U-01 | matrix exhaustive (기존) |
| GOV-U-01 | SoD decide (기존) |
| GOV-U-02 | stale payloadHash consume fail |
| GOV-U-03 | single-use consume |
| GOV-U-04 | lease fencing token mismatch |
| GOV-U-05 | **NEW** control EXPIRE transition |
| GOV-U-06 | **NEW** recoverExpiredLeases epoch monotonic |

### 3.4 Integration — S0 (`apps/api/test/s0-natural-command.integration.test.ts`)

| Test ID | PRD AC | 시나리오 |
|---|---|---|
| S0-I-01 | AC1 | missing x-workspace-id → 4xx |
| S0-I-02 | AC2 | mock ModelClient called; no other egress |
| S0-I-03 | AC3 | plan step `rm -rf` / unknown → step failed, DB unchanged |
| S0-I-04 | AC4 | requester cannot approve | 
| S0-I-05 | AC5 | tampered payload after approve → no apply |
| S0-I-06 | AC6 | happy path assignTask + audit rows + job done |
| S0-I-07 | AC7 | duplicate idempotencyKey |
| S0-I-08 | AC8 | remote registry entry → CONNECTOR_DISABLED |
| S0-I-09 | NFR | mock model latency path deterministic |

**테스트 데이터 빌더:** `makePrincipal`, `makeWorkspace`, `mockPlan(steps)`.

### 3.5 Integration — S1/S2/S3

| Test ID | Phase |
|---|---|
| S1-I-01 360 resource binding | P2 |
| S2-I-01 review SoD + REWORK | P2 |
| S2-I-02 report immutability | P2 |
| S3-I-01 import quarantine no post | P3 |
| S3-I-02 LEDGER_POST always approval | P3 |
| S3-I-03 finance pack missing → 503 | P3 |
| S3-I-04 report command does not post ledger | P3 |

### 3.6 Security / Boundary

| Test ID | 불변식 |
|---|---|
| SEC-01 | `orchestration` source has no `child_process` / `fs.writeFile` |
| SEC-02 | no import of model provider SDK outside model-gateway |
| SEC-03 | no import of connectors from model-gateway |
| SEC-04 | CONNECTOR_CAPABILITY all false |
| SEC-05 | RLS SQL contains FORCE + app_current_workspace_id |
| SEC-06 | **PG container** two workspaces isolation (P1.5+) |
| SEC-07 | runtime role cannot DDL |
| SEC-08 | SERVICE principal cannot decide own control |

구현 힌트: SEC-01..03은 ts-morph 또는 eslint 커스텀/dep-cruise.

### 3.7 Docs consistency (확장)

| Test ID | 설명 |
|---|---|
| DOC-01 | ACTION_TYPES ⊆ policy-matrix.md 표 |
| DOC-02 | GOVERNANCE_COMMANDS values ⊆ ACTION_TYPES |
| DOC-03 | COMMAND_MAP values ⊆ ACTION_TYPES |
| DOC-04 | PRD kill list strings not present in apps/packages runtime |

### 3.8 E2E Playwright

| Test ID | 단계 | 통과 |
|---|---|---|
| E2E-S0-01 | login/key → /work → command → /approvals → approve → job done | P1 |
| E2E-S0-02 | finance block shows pending without pack | P1 |
| E2E-S1-01 | 360 → create work | P2 |

---

## 4. TDD 스프린트 플레이북

### Sprint T0 — 계약 고정 (0.5–1주)

**Red first**

1. `packages/orchestration` 스켈레톤 + ORCH-U-01..08 failing  
2. MAP-U-01..03 failing  
3. SEC-01..04 failing (또는 skip with explicit TODO only if package empty — prefer implement lint harness first)  
4. ADR-011/012 draft  

**Green**

1. pure orchestration in-memory  
2. command map with 3–5 entries for S0  
3. boundary harness green  

**금지:** UI, executor 포팅.

### Sprint T1 — S0 API (1–2주)

**Red**

1. S0-I-01..09 파일 작성 (fail)  
2. NaturalCommandService 미구현  

**Green**

1. api route + service  
2. mock ModelClient  
3. wire existing PmService + Governance  

**Refactor**

1. ports/adapters 정리  
2. error envelope 통일  

**Gate:** PRD Gate A 테스트 부분집합.

### Sprint T1.5 — Persistence (1주)

**Red**

1. “restart simulation”: serialize store → new service → control still PENDING  
2. SEC-06 PG isolation  

**Green**

1. drizzle/pg repos for orch + governance  
2. migrations `0003_orchestration.sql`  

### Sprint T2 — UI + E2E

**Red:** E2E-S0-01  
**Green:** /work, approvals bind  
**Refactor:** CORP 패널 패턴 이식 시 presentational only  

### Sprint T3 — S2/S3

기존 finance/ai 테스트 + S2/S3 integration red-green.

---

## 5. 테스트 데이터·픽스처 규약

```text
fixtures/
  workspace.json          # fixed UUIDs
  principals.json         # owner, member, service, approver
  plans/
    s0-assign.json
    s0-unmapped.json
    s3-finance-report.json
```

- 시간: `TestClock` 주입 (lease expiry)  
- 난수/UUID: 주입 가능 factory  
- 금지어: production secrets in fixtures  

---

## 6. 커버리지·품질 게이트

| 게이트 | 기준 |
|---|---|
| P1 merge | S0-I-01..08 green; ORCH unit green; SEC-01..04 green |
| P1.5 | restart test + SEC-06 |
| P2 | E2E-S0-01 + S2-I-* |
| P4 | full pyramid; scorecard ≥ 98 |

커버리지 숫자 강제보다 **불변식 테스트 존재**를 우선한다.  
단 `policy-engine`, `orchestration` transitions는 line 고커버리지 유지.

---

## 7. 실패 주입 목록 (신뢰성 TDD)

| 주입 | 기대 |
|---|---|
| ModelClient timeout | job failed, no domain mutate |
| Domain apply throw after approve | intent FAILED, work item failed, audit |
| Duplicate decide | 409/CONTROL_NOT_PENDING |
| Wrong lease token | STALE_LEASE_TOKEN |
| Worker crash mid-DISPATCHING | scanner → UNKNOWN (remote 없을 땐 internal apply 경로 문서화) |
| Missing finance pack | 503 |

각 주입 = 최소 1 integration test.

---

## 8. 성능·결정론

| 항목 | 전략 |
|---|---|
| CI | 항상 mock model |
| Live demo | `EXECUTION_MODE=live` + real ModelClient, not in unit |
| Time | fake timers / clock port |
| Order | canonical hash tests remain order-independent |

---

## 9. 마이그레이션 테스트

| Test | 내용 |
|---|---|
| MIG-01 | 0001+0002+0003 apply clean on empty PG |
| MIG-02 | rollback note (forward-only OK if documented) |
| MIG-03 | RLS policies present after migrate |

---

## 10. CORP 회귀 방지 테스트 (흡수 시)

| Test ID | 금지 회귀 |
|---|---|
| REG-01 | no dependency on `better-sqlite3` / prisma in host runtime packages |
| REG-02 | no `public/results` write as success criterion |
| REG-03 | no server-side zustand store as SoR |
| REG-04 | agent principal cannot be OWNER in seed |

---

## 11. 구현 체크리스트 (개발자용)

새로운 효과 1개를 추가할 때:

1. [ ] contracts ActionType (필요 시)  
2. [ ] POLICY_MATRIX row  
3. [ ] COMMAND_MAP or GOVERNANCE_COMMANDS  
4. [ ] unit policy  
5. [ ] authorize→apply integration  
6. [ ] audit assertion  
7. [ ] DOC consistency  
8. [ ] PRD AC 링크  

UI만 바꿀 때:

1. [ ] 기존 control/api 계약 테스트 그대로 green  
2. [ ] E2E 갱신  
3. [ ] 직접 DB/domain import 없음  

---

## 12. 리스크 (테스트 관점)

| 리스크 | 대응 |
|---|---|
| 인메모리로 S0만 green, 재시작 실패 | Gate에 restart test 필수 |
| UI E2E flaky | mock api / deterministic seed |
| RLS SQL text-only tests | P1.5 실 PG 추가 |
| 과도한 E2E | S0 1–2개로 제한 |

---

## 13. 완료 정의 (TDD 문서)

이 TDD 계획이 “이행 중”이 아니라 “작동”으로 바뀌려면:

1. ORCH unit + MAP unit + S0 integration + SEC-01..04 가 main CI 필수  
2. 새 코드가 Red-first PR 문화로 리뷰됨 (PR 템플릿에 테스트 ID)  
3. CORP executor 경로를 성공 조건으로 쓰는 테스트 0건  

---

## 부록 — 샘플 테스트 스케치 (S0-I-06)

```ts
it("S0-I-06 happy path PM_TASK_ASSIGN", async () => {
  const app = createApp({
    modelClient: mockPlan([{ suggestedCommand: "pm.task_assign", title: "Assign" }]),
    // financePack omitted
  });
  const res = await app.inject({
    method: "POST",
    url: "/agent/commands",
    headers: {
      "x-workspace-id": ws,
      "x-principal-id": operator,
      "idempotency-key": "idem-1",
    },
    payload: { text: "작업 배정해줘" },
  });
  expect(res.statusCode).toBe(202);
  const { jobId, needsApproval } = res.json();
  // ... decide as approver ...
  // ... expect pm assignment + audit + job done ...
});
```

구현 전 이 스케치를 실제 파일로 옮기고 실패시키는 것이 T1 첫 커밋이다.
