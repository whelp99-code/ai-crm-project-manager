# Codex 실행지시서 — Notion 기반 JM AI-Native CRM + PSA 통합 구축

- 기준일: 2026-08-14
- 대상 저장소: `whelp99-code/ai-crm-project-manager`
- 로컬 작업 경로: `/Users/jmpark/orca/projects/AI-CRM+Project Manager`
- 권장 브랜치: `plan/notion-based-crm-psa-v1`
- 기준 문서: `00-master-plan-ko.md`
- 실행 상태: **계획·문서화 우선**
- 코드 구현: Phase 0 문서·ADR Gate 통과 후 시작

---

## 1. 임무

현재 Notion `JM Business OS`에서 검증한 다음 운영 구조를 기존 AI-CRM Host의 제품 방향으로 승격한다.

```text
고객·파트너
    │
    ├──────────────┐
    ▼              ▼
Engagement ←── Activity / Commitment
    │
    ├── Artifact
    ├── Delivery / Change Request
    └── Project Finance
          ├── Financial Item
          └── Settlement
```

최종 제품은 다음을 한 시스템에서 연결해야 한다.

- CRM
- PSA, Professional Services Automation
- 프로젝트 재무
- 문서·증거
- AI Assist
- 승인·감사
- Notion 전환

---

## 2. 절대 규칙

1. 제품 Host는 `ai-crm-project-manager` 하나다.
2. CORP-OS를 별도 Host로 되살리지 않는다.
3. PostgreSQL 16만 자체 제품의 최종 System of Record로 사용한다.
4. Notion은 현재 운영판이자 import source이며, Cutover 후 금액·상태 원장이 아니다.
5. Notion과 PostgreSQL Dual-write 구조를 만들지 않는다.
6. 모든 mutation은 `apps/api`를 통과한다.
7. 모든 mutation은 Action Registry → Policy → Governance → Domain/Finance → Audit 순서를 따른다.
8. 모든 AI inference는 `packages/model-gateway`를 통과한다.
9. 자유 텍스트 모델 출력은 명령이 아니다.
10. 외부 발송, 금액, 계약, 일정 약속, 지급, 삭제는 사람 승인을 거친다.
11. 신규 orchestration 기능은 `packages/orchestration`에만 구현한다.
12. `packages/ai-orchestrator`에는 신규 기능을 추가하지 않는다.
13. 기존 과거 Notion DB와 신규 통합 DB를 자동 병합하지 말고 mapping·quarantine을 거친다.
14. 프로젝트 재무는 법정 회계·세무 ERP로 확장하지 않는다.
15. 증거 없는 완료와 simulated 결과의 실제 완료 표시는 금지한다.

---

## 3. 작업 시작 전 Preflight

다음 순서로 수행한다.

```bash
cd "/Users/jmpark/orca/projects/AI-CRM+Project Manager"

git status --short
git branch --show-current
git log -1 --oneline

test -f package.json
test -f packages/contracts/package.json
test -d packages/domain
test -d packages/finance
test -d packages/orchestration
test -d packages/persistence

pnpm install --frozen-lockfile
pnpm check
pnpm test:security
```

기준선 실패 시:

- 실패 로그를 보존한다.
- 현재 실패와 신규 변경 실패를 구분한다.
- 기존 실패를 숨기기 위해 테스트를 삭제하거나 완화하지 않는다.
- Phase 0 문서 작업은 계속할 수 있으나 코드 PR은 baseline 상태를 명시한다.

권장 브랜치:

```bash
git switch -c plan/notion-based-crm-psa-v1
```

기존 브랜치가 있으면 새로 만들지 말고 해당 브랜치 상태를 확인한다.

---

## 4. 먼저 생성할 문서

다음 문서가 코드보다 먼저 존재해야 한다.

```text
docs/planning/notion-crm-psa-v1/
├── 00-master-plan-ko.md
├── 01-notion-baseline-and-gap-analysis.md
├── 02-domain-model.md
├── 03-project-finance-model.md
├── 04-migration-and-cutover.md
├── 05-ai-governance.md
├── 06-implementation-roadmap.md
├── 07-requirements-traceability.md
└── 08-codex-execution-directive-ko.md
```

ADR:

```text
docs/adr/
├── 013-notion-to-postgres-cutover.md
├── 014-engagement-centered-crm-psa.md
├── 015-project-finance-item-settlement.md
├── 016-ai-suggestion-human-authority.md
└── 017-canonical-orchestration-package.md
```

ADR-001, ADR-002, ADR-011, ADR-012와 충돌 여부를 명시한다.

특히 ADR-002의 native CRM·native ledger 원칙과 다음처럼 조정한다.

- 현재 Notion은 자체 제품 개발 전 임시 운영판
- 자체 제품 초기에는 Notion read-only shadow import
- Cutover 후 PostgreSQL native CRM/finance가 정본
- 외부 SaaS와의 bidirectional SoR가 아님

---

## 5. Workstream 구조

### WP-00 — Baseline and Decision Gate

#### T-101 저장소 Baseline

작업:

- package/app/package 구조 확인
- 현재 migration 확인
- 기존 CRM·PM·Delivery·Finance API 확인
- `packages/ai-orchestrator`와 `packages/orchestration` 사용처 조사
- 기존 테스트와 CI 확인

산출물:

- `01-notion-baseline-and-gap-analysis.md`
- repository capability matrix
- duplicate responsibility report

인수기준:

- 구현됨·부분 구현·문서만 존재·미구현을 구분
- 기존 기능을 새로 만들었다고 주장하지 않음
- 삭제 없이 현재 상태 기록

#### T-102 ADR 작성

작업:

- ADR-013~017 작성
- 기존 ADR 링크와 supersede/extend 관계 표시

인수기준:

- Notion → PG 전환 책임이 명확함
- Dual SoR 금지
- Engagement와 project finance 정의 고정
- AI 권한 경계 고정
- canonical orchestration package 고정

#### T-103 Requirements Traceability

다음 Requirement ID를 생성한다.

```text
REQ-CRM-001 Account and Contact
REQ-CRM-002 Engagement Lifecycle
REQ-CRM-003 Engagement Party Roles
REQ-ACT-001 Activity Timeline
REQ-ACT-002 Commitment and Next Action
REQ-DOC-001 Artifact Versioning
REQ-PSA-001 Delivery Lifecycle
REQ-PSA-002 Change Request
REQ-FIN-001 Financial Item
REQ-FIN-002 Settlement
REQ-FIN-003 Receivable and Payable
REQ-FIN-004 Project Profitability
REQ-FIN-005 Cash Forecast
REQ-AI-001 Capture and Link
REQ-AI-002 Finance Guardian
REQ-GOV-001 Human Approval
REQ-GOV-002 Audit and Evidence
REQ-MIG-001 Notion Snapshot
REQ-MIG-002 Quarantine and Reconciliation
REQ-MIG-003 Single SoR Cutover
```

각 Requirement를 schema, API, UI, test, migration에 연결한다.

---

### WP-01 — Notion Baseline and Import Contract

#### T-104 Notion Schema Snapshot

대상 Data Source:

- 프로젝트
- 고객·파트너
- 활동·히스토리
- 재무
- 기존 매입/비용 DB
- 기존 미수금/입금관리
- 기존 자금흐름 DB

저장 형식:

```text
fixtures/notion/
├── schema/
├── mappings/
├── samples-redacted/
└── expected-reconciliation/
```

필수:

- source database ID
- property ID
- property type
- option values
- relation target
- formula/rollup은 computed source로 표시
- snapshot version과 hash

고객 정보·메일·금액 원문 fixture는 비식별 또는 synthetic만 저장한다.

#### T-105 Mapping Contract

매핑 예:

```text
Notion 프로젝트
→ Engagement

프로젝트ID
→ legacy_project_key

프로젝트명
→ engagement.name

상태
→ engagement.stage / state

고객·파트너 + 파트너
→ engagement_parties

견적서·제안서·계약서·완료보고서
→ artifacts

다음 행동
→ commitments

재무 Relation
→ financial_items
```

데이터 품질 규칙:

- 프로젝트 DB의 비용성 행은 quarantine
- ID 누락은 deterministic candidate ID 생성 후 승인
- 동일 거래처명은 alias 후보
- 금액 없는 완료 프로젝트는 경고이지 자동 오류가 아님
- 진행 프로젝트의 다음 행동 누락은 remediation queue
- 기존·신규 재무 DB 중복 후보는 source+date+amount+memo hash로 탐지

#### T-106 Import Batch

구현 위치:

- `packages/imports`
- `packages/persistence`
- 필요 시 `apps/api` import endpoint

상태:

```text
RECEIVED
→ VALIDATING
→ MAPPED
→ QUARANTINED | READY
→ IMPORTING
→ COMPLETED | FAILED
```

필수:

- idempotency key
- source snapshot hash
- row-level status
- error reason
- imported target ID
- retry without duplication
- audit event

MVP는 Notion live connector가 아니라 snapshot 또는 controlled read import로 시작한다.

---

### WP-02 — Canonical Domain Schema

#### T-107 Account and Contact

테이블:

- workspaces
- accounts
- account_aliases
- contacts
- contact_channels

필수:

- workspace scope
- normalized name
- account type는 복수 역할의 보조 분류일 뿐
- project-specific role은 engagement_parties
- duplicate candidate
- soft delete
- audit

#### T-108 Engagement

테이블:

- engagements
- engagement_parties
- engagement_stage_history
- engagement_health_events

필수 필드:

- engagement_key
- legacy_project_key
- type
- stage
- state
- health
- owner
- start/end/target dates
- next_action_due
- source
- version

불변조건:

- active Engagement는 open Commitment가 필요
- CLOSED는 필수 Artifact와 재무 closure 조건 확인
- LOST/CANCELLED는 reason 필수
- stage transition은 domain service만 수행

#### T-109 Activity and Commitment

테이블:

- activities
- activity_participants
- commitments

필수:

- source URI와 occurred_at
- activity type
- summary/decision
- evidence reference
- AI extraction metadata
- commitment owner/counterparty/due/status
- completion evidence

#### T-110 Artifact

테이블:

- artifacts
- artifact_versions
- artifact_links

필수:

- type
- version
- status
- storage URI
- hash
- source Activity
- approval and sent state
- supersede chain

---

### WP-03 — Project Finance

#### T-111 Financial Item

테이블:

- financial_items
- financial_item_revisions
- finance_documents

필수:

- direction
- category
- lifecycle
- net/vat/gross
- expected/contractual dates
- engagement and account
- source Artifact
- revision history

#### T-112 Settlement

테이블:

- settlements
- settlement_allocations
- reconciliation_events

필수:

- 부분입금·부분지급
- 한 Settlement를 여러 항목에 배분 가능 여부는 명시적으로 결정
- bank/card/cash reference
- evidence
- reconciliation status
- reversal 지원

#### T-113 Project Finance Projection

서비스:

```text
getEngagementFinanceSummary()
calculateEac()
calculateForecastProfit()
calculateCashPosition()
calculateReceivableAging()
calculatePayableAging()
forecastCashWindow()
```

불변조건 테스트:

- 미수금 음수 금지
- 미지급금 음수 금지
- VAT 분리
- cancellation/reversal 일관성
- settlement over-allocation 금지
- revision audit 보존
- 동일 idempotency key 중복 처리 금지

#### T-114 Finance Approval

다음 ActionType를 등록한다.

```text
FINANCE_ITEM_CREATE
FINANCE_ITEM_REVISE
FINANCE_ITEM_CONFIRM
FINANCE_ITEM_BILL
SETTLEMENT_RECORD
SETTLEMENT_REVERSE
FINANCE_DOCUMENT_ATTACH
PROJECT_FINANCE_CLOSE
```

금액 임계값과 lifecycle에 따라:

- ALLOW
- CHECKPOINT
- DENY

를 결정한다.

AI principal은 `CONFIRM`, `BILL`, `SETTLEMENT_RECORD`, `REVERSE`, `CLOSE`를 직접 수행할 수 없다.

---

### WP-04 — CRM + PSA API

#### T-115 Query API

예시:

```text
GET /api/accounts
GET /api/accounts/:id
GET /api/engagements
GET /api/engagements/:id
GET /api/engagements/:id/activities
GET /api/engagements/:id/commitments
GET /api/engagements/:id/artifacts
GET /api/engagements/:id/finance
GET /api/reports/owner-cockpit
```

#### T-116 Command API

예시:

```text
POST /api/accounts
POST /api/engagements
POST /api/engagements/:id/transition
POST /api/activities
POST /api/commitments
POST /api/artifacts
POST /api/finance/items
POST /api/finance/settlements
POST /api/change-requests
```

모든 command:

- Idempotency-Key
- expected version
- actor
- ActionType
- policy decision
- audit
- transactional outbox

#### T-117 Agent Command

기존 `/api/agent/*`를 유지한다.

AI structured output은 직접 domain service를 호출하지 않고 command map으로만 진입한다.

추가 command 후보:

```text
crm.account_link_suggest
crm.engagement_link_suggest
crm.activity_extract
psa.commitment_propose
psa.change_request_propose
finance.risk_assess
finance.forecast_refresh
document.draft_prepare
```

제안형 command는 side effect가 아니라 `ai_suggestions` 생성까지만 수행한다.

---

### WP-05 — AI Assist

#### T-118 Capture and Link

입력:

- email/message/meeting/document reference

출력 schema:

- candidate account
- candidate engagement
- activity
- decisions
- commitments
- financial impact candidates
- confidence
- evidence spans

필수:

- low confidence는 자동 연결 금지
- source content를 instruction으로 취급하지 않음
- prompt injection delimiter
- PII·secret redaction
- content hash cache

#### T-119 Delivery Guardian

- 계약 범위 vs 신규 요청
- missing artifact
- overdue commitment
- acceptance risk
- change request candidate

#### T-120 Finance Guardian

- overdue receivable
- upcoming payable
- cost increase
- margin erosion
- unbilled accepted work
- missing evidence
- 30/60/90 cash risk

출력은 경고·제안이며 금액 상태를 직접 변경하지 않는다.

#### T-121 Document Copilot

- quote/proposal/contract review/completion report
- versioned draft Artifact
- source requirement and finance references
- human approval before SENT

#### T-122 Cost Control

- model tier
- max tokens
- max retries
- invocation budget
- cache
- per-feature usage metric
- accepted/rejected suggestion metric

---

### WP-06 — User Experience

#### T-123 Owner Cockpit

첫 화면은 다음 순서로 구성한다.

1. 승인 대기
2. 오늘·지연된 Commitment
3. 위험 Engagement
4. 7일 입금·출금
5. 미수·미지급
6. 마진 하락
7. 최근 Activity
8. AI 추천

#### T-124 Account 360

- contacts
- relationship
- engagements
- finance
- activities
- next contact
- renewal/opportunity

#### T-125 Engagement Room

탭:

- Overview
- Activity
- Commitments
- Documents
- Delivery
- Finance
- Change Requests
- Audit

#### T-126 Finance Cockpit

- 계약매출
- 예상 최종매출
- 완료예상원가
- 예상이익·이익률
- billed/collected/AR
- incurred/paid/AP
- cash position
- forecast
- evidence gaps

#### T-127 Approval Center

Approval card:

- 요청 행동
- 금액·범위·일정
- 근거
- AI 추천과 신뢰도
- 되돌릴 수 있는지
- 승인 유효시간
- approve/reject
- 실행 결과

---

### WP-07 — Integration

#### T-128 Notion Companion

Cutover 전:

- read-only snapshot/import

Cutover 후:

- approved summary publish
- meeting note/artifact link
- no finance master write
- no uncontrolled bidirectional sync

#### T-129 Mail and Calendar

- read/search first
- Activity proposal
- meeting brief
- outbound send behind approval
- connector idempotency and audit

#### T-130 Master Worker Adapter

- Commitment → approved WorkItem request
- WorkItem progress → Engagement update proposal
- time/cost → internal labor cost proposal
- products remain separate System of Record

#### T-131 Action Hub Adapter

- quick capture
- mobile approval
- today queue

#### T-132 Council Adapter

- risk/amount/uncertainty routing
- decision result stored as evidence
- Council has no execution authority

---

### WP-08 — Migration and Cutover

#### T-133 Shadow Import

- regular snapshot
- deterministic import
- data quality report
- no Notion mutation

#### T-134 Remediation

queues:

- missing ID
- missing next action
- orphan finance
- duplicate account
- mixed project/expense
- duplicate legacy/new finance
- missing artifact

#### T-135 Reconciliation

필수 보고:

- account count
- engagement count
- activity count
- artifact count
- finance item count
- net/vat/gross totals
- receivable/payable totals
- relation orphan count
- quarantine count
- source-to-target hash manifest

#### T-136 Cutover

- change freeze
- final snapshot
- import
- reconciliation
- approval
- PG write enable
- Notion operational views read-only
- post-cutover smoke test

#### T-137 Rollback

Cutover rollback 조건:

- count mismatch
- money mismatch
- orphan above zero
- RLS failure
- audit failure
- command idempotency failure

Rollback:

- PG write gate close
- restore pre-cutover snapshot
- Notion operational use reopen
- incident and evidence record
- root cause before retry

---

## 6. 테스트 전략

### Unit

- state transitions
- financial formulas
- partial settlement
- VAT
- aging
- EAC
- margin
- policy decisions
- mapping functions

### Property/Invariant

- no negative unexplained receivable/payable
- no settlement over-allocation
- revisions preserve history
- idempotency replay returns same result
- AI cannot execute restricted ActionType
- closed Engagement satisfies closure rule

### Integration

- API → registry → policy → domain/finance → audit
- import → quarantine → target
- outbox → worker
- approval → resume
- connector disabled path

### Migration

- fixture snapshot replay
- duplicate source rows
- missing relation
- malformed date/amount
- legacy formula/rollup ignored or recomputed
- count and sum reconciliation

### Security

- FORCE RLS
- workspace isolation
- service principal scopes
- prompt injection
- secret redaction
- connector egress deny
- approval self-bypass
- stale approval
- replay with changed payload

### E2E Golden Flow

```text
문의 수신
→ Account/Engagement 생성
→ Activity/Commitment
→ 견적·제안 Artifact
→ 승인
→ 계약
→ Delivery
→ 변경요청
→ 완료보고
→ 청구
→ 부분입금
→ 잔금입금
→ 프로젝트 close
```

---

## 7. Gate

### Gate N0 — 문서·ADR

- ADR-013~017
- mapping
- requirements traceability
- baseline report
- 기존 ADR 충돌 해소

### Gate N1 — Shadow Import

- idempotent import
- quarantine
- reconciliation
- Notion no-mutation proof

### Gate N2 — CRM + PSA Core

- Account 360
- Engagement Room
- Activity/Commitment/Artifact
- registry/policy/audit

### Gate N3 — Project Finance

- Financial Item/Settlement
- AR/AP
- project profitability
- cash forecast
- invariant tests

### Gate N4 — AI and Approval

- structured output
- evidence/confidence
- human authority
- cost budget
- no autonomous external effect

### Gate N5 — Cutover Ready

- migration report
- security
- backup/restore
- rollback drill
- operator runbook

---

## 8. 완료 정의

다음이 모두 충족되어야 `v1.0.0`으로 표시한다.

- 고객·파트너·담당자·Engagement·Activity·Commitment·Artifact 정본 구현
- 프로젝트 매출·비용·입금·출금·미수·미지급 구현
- 부분입금·부분지급 구현
- 프로젝트 예상이익·현금흐름 구현
- 변경요청과 추가비용 연결
- Notion migration count·money reconciliation 100%
- PostgreSQL 단일 SoR
- FORCE RLS와 권한 검증
- 승인 없는 외부 행동 0건
- AI 근거·신뢰도·비용 기록
- backup/restore/rollback drill
- E2E Golden Flow 통과
- 설치·운영·전환 문서
- 실제 사용자 pilot evidence

다음은 완료로 주장하지 않는다.

- 문서만 존재
- mock response
- simulated integration
- 수동으로 수정한 DB
- 실행하지 않은 테스트
- 승인되지 않은 외부 connector
- Notion과 PostgreSQL이 동시에 정본인 상태

---

## 9. PR 순서

```text
PR-N01 Docs and ADR
PR-N02 Notion snapshot and mapping
PR-N03 Canonical schema and migrations
PR-N04 Account and Engagement
PR-N05 Activity, Commitment and Artifact
PR-N06 Financial Item and Settlement
PR-N07 Project finance projections
PR-N08 Governance and Action Registry
PR-N09 Owner/Account/Engagement UI
PR-N10 AI Capture and Guardians
PR-N11 Integration adapters
PR-N12 Migration reconciliation
PR-N13 Cutover and operations
```

원칙:

- 각 PR은 한 책임만 가진다.
- migration과 domain code를 한 거대 PR로 묶지 않는다.
- schema 변경에는 rollback 또는 forward-fix 전략을 포함한다.
- 신규 endpoint에는 contract·authorization·audit test를 포함한다.
- docs와 code의 Requirement ID를 연결한다.

---

## 10. Codex 최종 보고 형식

각 Phase 또는 PR 완료 후 다음 형식으로 보고한다.

```text
1. 목표
2. 변경 파일
3. 구현된 기능
4. 구현되지 않은 기능
5. 실행한 명령
6. 테스트 결과
7. 보안·재무 불변조건 결과
8. Evidence 경로
9. 알려진 제한
10. 다음 PR
```

금지 표현:

- 실행하지 않았는데 통과
- mock인데 실제 연동
- 계획인데 구현 완료
- 파일을 만들었는데 기능 완료
- Notion import를 검증하지 않았는데 migration 완료

---

## 11. 첫 실행 명령

Codex는 첫 작업에서 코드 전체 구현을 시작하지 않는다.

첫 목표:

```text
PR-N01 Docs and ADR
```

실행 순서:

1. 저장소 baseline
2. Notion schema와 본 계획 대조
3. `docs/planning/notion-crm-psa-v1` 생성
4. ADR-013~017 생성
5. requirements traceability 생성
6. existing ADR conflict review
7. 문서 lint·link 검증
8. PR 생성
9. 사용자 검토 대기

사용자가 후속으로 전체 개발을 명시하면 PR-N02부터 Gate 순서로 진행한다.
