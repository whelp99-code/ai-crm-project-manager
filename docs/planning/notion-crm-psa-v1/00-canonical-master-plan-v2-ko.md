# JM AI-Native Customer Work OS v2.0

## CRM + PSA + ERP 통합 구축 정본 계획서

- 기준일: 2026-08-14
- 저장소: `whelp99-code/ai-crm-project-manager`
- 현재 운영판: Notion `JM Business OS`
- 장기 제품: **JM AI-Native Customer Work OS**
- 구성: **CRM + CPQ/Commercial + PSA + Project ERP/Accounting + AI Brain**
- 정식 용어: **PSA — Professional Services Automation**
- `PAS`는 사용자 검색 호환 별칭으로만 유지한다.
- 최종 데이터 원장: PostgreSQL 16

> 이 문서는 기존 `00-master-plan-ko.md`의 범위를 바로잡은 **v2 정본**이다. 기존 문서는 참고 이력이며 신규 기획·개발 판단에는 이 문서를 우선한다.

---

# 1. 제품 정의

## 1.1 한 줄 정의

> **고객 상담부터 영업·제안·계약·구매·구축·검수·청구·수금·지원·갱신까지를 하나의 사업 문맥으로 연결하고, AI가 다음 업무와 위험을 준비하되 중요한 행동은 대표가 승인하는 고객사업 운영체제**

## 1.2 왜 일반 CRM으로 부족한가

일반 CRM은 보통 다음에서 끝난다.

```text
고객 → 영업기회 → 견적 → 계약
```

재민님의 실제 업무는 다음과 같다.

```text
고객 문의
→ 기술 요구사항 분석
→ 현재 환경·문제점 확인
→ 솔루션 설계
→ 제조사·총판·파트너 협의
→ BOM·원가·마진 계산
→ 견적서·제안서
→ 협상·계약
→ 구매요청·발주·입고
→ 프로젝트 착수·설계·구축
→ 시험·검수·완료보고
→ 세금계산서·청구·수금
→ 공급사 지급·파트너 정산
→ 유지보수·지원·장애
→ 라이선스·계약 갱신
→ 추가 제안
```

따라서 최종 제품은 CRM만이 아니라 **CRM + PSA + ERP가 연결된 AI-Native Work OS**여야 한다.

## 1.3 핵심 원칙

```text
CRM
= 고객과 사업기회의 문맥

PSA
= 고객에게 약속한 일의 실행

ERP
= 판매·구매·자산·돈의 사실

AI Brain
= 세 영역을 읽고 연결하고 예측하는 두뇌
```

사람이 모든 내용을 CRM에 반복 입력하는 것이 아니라 AI가 수집·정리·연결·초안을 준비한다.

- AI: 읽기, 요약, 분류, 연결 후보, 초안, 누락·위험 탐지, 예측
- 사용자: 외부 발송, 금액 확정, 할인, 계약, 일정 약속, 발주, 지급, 삭제 승인

---

# 2. 5개 제품 계층

## 2.1 CRM Core

관리 대상:

- 고객사·잠재고객
- 파트너·총판·제조사·벤더·외주사
- 담당자·의사결정자·기술담당자·구매담당자
- 문의·영업기회
- 고객 문제·목표
- 요구사항·확인된 사실·미확인 사항·가정
- 경쟁상황
- 이메일·전화·미팅·메신저
- 고객 약속·다음 행동
- 관계상태·건강도·휴면·재접촉

CRM의 목적은 연락처 저장이 아니라 다음을 기억하는 것이다.

> 왜 고객이 연락했고, 무엇을 해결해야 하며, 누가 결정하고, 다음에 무엇을 해야 하는가.

## 2.2 CPQ & Commercial

관리 대상:

- 제품·서비스 카탈로그
- 제조사·벤더 가격
- BOM
- 예상 원가
- 예상 매출·마진
- 솔루션 대안 A/B/C
- 견적 버전
- 제안서 버전
- 할인
- 견적 유효기간
- 계약 범위·제외 범위
- 계약금·중도금·잔금
- 판매주문
- 변경계약

재민님의 프로젝트는 장비·라이선스·설치·외주·컨설팅·유지보수가 섞이므로 CPQ와 상업조건 관리가 필수다.

## 2.3 PSA Core

관리 대상:

- 영업→수행 인수인계
- 프로젝트·WBS·마일스톤
- 고객 약속·내부 작업
- 일정·담당자·파트너 배정
- 위험·이슈
- 변경요청
- 산출물·시험·검수
- 완료보고
- 투입시간·경비
- 고객 주간보고
- 지원·장애·SLA
- 유지보수·갱신

PSA는 단순 일정관리가 아니라 다음을 연결한다.

```text
프로젝트 일정
+
고객 계약
+
청구 조건
+
투입 원가
+
수익성
+
지원·갱신
```

## 2.4 Project ERP & Accounting

### 판매·매출

- 견적
- 계약·판매주문
- 납품
- 청구 마일스톤
- 고객 청구서
- 세금계산서 상태
- 입금
- 미수금·매출채권

### 구매·매입

- 벤더 견적
- 구매요청
- 구매승인
- 발주
- 입고
- 매입 확정
- 매입 세금계산서
- 지급
- 미지급금·매입채무
- 파트너 정산

### 품목·자산·라이선스

- 제품·제조사·모델
- 수량·시리얼
- 라이선스·구독
- 고객 배정
- 납품 상태
- 보증·유지보수
- EOL·EOS
- 인증서·갱신일

### 자금·회계

- 법인통장·카드·현금
- OFX·CSV 통장내역 Import
- 입출금 대조
- 프로젝트별 손익
- 프로젝트별 현금흐름
- 부가세 구분
- 관리회계용 복식부기
- 증빙
- 월 마감
- 회계사 전달용 Export

### v1.0 이전 제외

ERP는 포함하지만 한국 법정 세무 전체를 즉시 만들지는 않는다.

- 부가세·법인세 신고 자동 제출
- 급여·원천세
- 감가상각 전 영역
- 법정 재무제표 자동 제출
- 무승인 은행 송금
- 무승인 전자세금계산서 발행
- 제조 MRP·복잡한 물류

이 기능은 외부 회계·세무 Adapter 또는 후속 Native ERP 확장으로 둔다.

## 2.5 JM CRM Brain

- 이메일·회의·문서 이해
- 고객·영업·프로젝트 연결 후보
- 요구사항·약속·금액·일정 추출
- 미확인 사항·위험 탐지
- 제안서·견적·완료보고 초안
- 무상 범위 확대 탐지
- 완료예상원가·마진·현금흐름 예측
- 미청구·미수·미지급 탐지
- 갱신·추가 제안
- 승인 요청
- 모델 비용·근거·감사 관리

---

# 3. 7개 연결 흐름

## 3.1 Relationship Lifecycle

```text
잠재고객 → 상담 → 제안 → 계약 → 운영 → 장기고객 → 갱신·확장
```

회사는 고정적으로 고객 또는 파트너가 아니다. 프로젝트별로 다음 역할을 가진다.

- 최종고객
- 계약 고객
- 소개 파트너
- 총판
- 제조사
- 공급사
- 수행 협력사
- 외주사
- 정산 상대

## 3.2 Lead-to-Opportunity

```text
문의 → 고객·담당자 식별 → 문제·목표 → 예산·일정·기술 확인 → 영업기회 검증 → 다음 행동
```

평가 기준:

- 문제 명확성
- 긴급성
- 예산
- 의사결정 구조
- 기술 적합성
- 수행 가능성
- 수익성
- 현금흐름
- 전략 가치
- 경쟁·계약·납기 위험

정보가 없으면 0점이 아니라 `미확인`이다.

## 3.3 Opportunity-to-Quote

```text
요구사항 → 솔루션 대안 → BOM → 벤더 가격 → 내부 인건비 → 원가·마진 → 견적·제안 → 승인·발송
```

## 3.4 Quote-to-Contract

```text
견적 승인 → 협상·할인 → 계약 범위·제외 범위 → 납기·검수·청구 조건 → 계약·판매주문
```

## 3.5 Contract-to-Delivery

```text
수주 → 인수인계 → 구매·파트너 준비 → 설계 → 구축 → 시험 → 검수 → 완료보고
```

인수인계 패키지:

- 요구사항
- 제안 범위·제외 범위
- 계약 조건
- 견적 품목
- 장비·라이선스
- 고객·파트너 담당자
- 약속 일정
- 미확인 사항
- 위험
- 검수 기준
- 청구·유지보수 조건

## 3.6 Procure-to-Pay

```text
원가계획 → 벤더 견적 → 구매요청 → 승인 → 발주 → 입고·라이선스 수령 → 고객 배정 → 매입 확정 → 지급
```

## 3.7 Delivery-to-Cash-to-Renewal

```text
마일스톤 완료 → 청구 준비 → 세금계산서 → 수금 → 미수 관리 → 프로젝트 마감 → 유지보수 → 90·60·30일 갱신 → 추가 제안
```

---

# 4. 핵심 데이터 모델

## 4.1 전체 모델

```text
Account ─ Contact
   │
   ├─ Activity / Communication
   └─ Opportunity
        ├─ Requirement / Unknown / Assumption
        ├─ Stakeholder / Competitor
        ├─ Solution / BOM
        ├─ Quote / Proposal
        └─ Contract / Sales Order
                 │
                 ▼
             Engagement / Project
        ├─ Party Roles
        ├─ Commitment / Work
        ├─ Milestone / Risk / Issue
        ├─ Change Request
        ├─ Deliverable / Acceptance
        ├─ Time / Expense
        ├─ Purchase / Inventory / Asset
        ├─ Billing / Receivable
        ├─ Payable / Settlement
        ├─ Profitability / Cash Flow
        └─ Service / Renewal
```

## 4.2 CRM 객체

- `accounts`, `account_aliases`
- `contacts`, `contact_channels`
- `relationship_roles`
- `opportunities`
- `stakeholders`, `competitors`
- `activities`, `communications`
- `requirements`
- `unknowns_assumptions`
- `commitments`

## 4.3 CPQ·계약 객체

- `products`, `services`, `vendors`
- `price_books`, `vendor_quotes`
- `solution_options`, `boms`
- `quotes`, `quote_versions`, `quote_lines`
- `cost_estimates`, `proposals`
- `contracts`, `contract_versions`
- `sales_orders`, `billing_milestones`

## 4.4 PSA 객체

- `engagements`, `engagement_parties`
- `workstreams`, `milestones`, `work_items`
- `risks`, `issues`, `change_requests`
- `deliverables`, `acceptance_criteria`, `acceptance_evidence`
- `time_entries`, `expenses`
- `support_cases`, `service_contracts`, `renewal_opportunities`

## 4.5 ERP·회계 객체

- `purchase_requests`, `purchase_orders`, `purchase_order_lines`
- `goods_receipts`
- `inventory_items`, `serial_numbers`, `licenses`, `asset_assignments`
- `vendor_bills`, `customer_invoices`
- `financial_items`, `settlements`
- `bank_transactions`, `bank_reconciliations`
- `tax_documents`
- `journal_entries`, `journal_lines`, `accounting_periods`
- `project_budgets`, `project_forecasts`

## 4.6 AI·통제 객체

- `source_events`, `evidence_refs`, `claims`
- `ai_suggestions`, `context_packs`, `model_invocations`
- `approval_requests`, `policy_decisions`, `audit_events`
- `import_batches`, `import_rows`

---

# 5. 반드시 필요한 특별 객체

## 5.1 Commitment

일반 Task와 별도로 고객·파트너와의 약속을 관리한다.

- 누가 누구에게 무엇을 언제까지 약속했는가
- 어느 대화가 근거인가
- 어떤 Opportunity·Project와 연결되는가
- 금액·일정 영향은 무엇인가
- 완료 증거는 무엇인가

실제 작업은 Master Worker에 생성할 수 있지만, 고객 약속의 원장은 CRM/PSA다.

## 5.2 Unknown & Assumption

- 확인할 내용
- 확인 책임자·기한
- 미확인 시 영향
- 임시 가정
- 근거
- 견적·제안·계약·검수 반영 여부

AI가 사실과 추측을 섞지 않게 한다.

## 5.3 Requirement Traceability

```text
요구사항
→ 솔루션 구성요소
→ BOM·견적 품목
→ 제안서 문단
→ 계약 범위
→ 프로젝트 작업
→ 산출물
→ 시험·검수 기준
→ 청구 마일스톤
→ 완료 증거
```

요구사항 변경 시 기술·수량·원가·매출·마진·일정·검수·계약 영향을 계산한다.

## 5.4 Evidence

AI 정보는 다음 근거와 연결한다.

- 이메일·메신저
- 회의 녹취
- 문서 페이지·견적서 셀·계약 조항
- 입출금 내역
- 사용자 입력

상태:

- 확인된 사실
- AI 추론
- 사용자 제안
- 가정
- 기각
- 이전 버전

---

# 6. 프로젝트 재무·회계

## 6.1 구분해야 할 숫자

```text
예상 최종이익 = 예상 최종매출 - 완료예상원가
미청구액 = 청구 가능 매출 - 청구 완료액
미수금 = 청구액 - 입금액
미지급금 = 매입 확정액 - 지급액
프로젝트 현금잔액 = 실제 입금 - 실제 출금
```

수익성과 현금흐름은 반드시 별도 표시한다.

## 6.2 원가 5단계

```text
예상원가 → 승인원가 → 약정원가(발주·계약) → 발생원가(입고·매입확정) → 지급원가
```

원가:

- 장비·라이선스
- 외주·설치·컨설팅
- 출장·운송·클라우드
- 내부 인건비
- 유지보수 원가
- 예비비

## 6.3 내부 인건비

```text
내부 인건비 = 실제 투입시간 × 역할별 내부 시간단가
```

Master Worker의 시간·진행률과 연결한다.

## 6.4 완료예상원가

```text
EAC = 실제 발생원가 + 미발생 약정원가 + 남은 예상원가
```

## 6.5 Financial Item과 Settlement

Notion에서는 예정과 실제를 한 행에 두지만, 자체 제품은 분리한다.

```text
Financial Item
= 받아야 하거나 지급해야 하는 계획·의무

Settlement
= 실제 입금·출금
```

부분입금·분할지급·환불·취소를 정확히 처리한다.

## 6.6 복식부기

사용자 화면은 매출·매입·입금·출금 중심으로 단순하게 제공하되 내부에는 Native Double-Entry Ledger를 둔다.

```text
Draft → Verified → Posted → Reversed
```

회계사에게 월별 CSV·증빙·계정 매핑을 Export한다.

---

# 7. 핵심 화면

| 화면 | 역할 |
|---|---|
| Today / Owner Cockpit | 오늘 답변, 승인, 미팅, 프로젝트 위험, 입출금, 갱신 |
| AI Inbox | 메일·메신저·통화·문서 수집과 연결 후보 |
| Account 360 | 관계·담당자·영업·프로젝트·계약·자산·재무·지원 |
| Opportunity Room | 요구사항·대안·이해관계자·수주가능성·다음 행동 |
| Proposal & CPQ Studio | BOM·원가·마진·견적·제안서·검증 |
| Delivery / PSA Workspace | 인수인계·일정·약속·위험·변경·검수·완료 |
| Procurement & Asset Desk | 구매요청·발주·입고·시리얼·라이선스·지급 |
| Project Finance Cockpit | 예산·EAC·이익·미청구·미수·미지급·현금예측 |
| Service & Renewal Radar | 유지보수·지원·SLA·EOL/EOS·90/60/30일 갱신 |
| Approval Center | 발송·가격·계약·범위·발주·지급·삭제 승인 |
| Ask Business OS | 자연어 질의와 실행 초안 |

---

# 8. AI 에이전트

1. **Capture & Understand Agent** — 메일·대화·문서 구조화
2. **Deal Architect Agent** — 영업기회·이해관계자·정체·실주 위험
3. **Proposal & CPQ Agent** — 대안·BOM·원가·견적·제안서
4. **Delivery Guardian Agent** — 인수인계·일정·약속·검수·변경요청
5. **Finance Guardian Agent** — EAC·마진·미청구·미수·현금 위험
6. **Procurement & Asset Agent** — 발주·납기·입고·자산·라이선스
7. **Relationship & Renewal Agent** — 고객 건강도·휴면·유지보수·갱신

기본 루프:

```text
이벤트 수신
→ AI 해석
→ CRM·PSA·ERP 객체 연결
→ 사실·요구사항·약속·금액 후보
→ 상태·수익성·위험 재평가
→ 행동·문서·승인 제안
→ 사용자 승인
→ 실행
→ 결과 확인
→ 원장·감사 업데이트
```

---

# 9. 승인 정책

## 자동 허용

- 읽기·요약·분류
- 연결 후보
- 내부 초안
- 누락·충돌·위험 탐지
- 계산·시뮬레이션
- 대시보드 갱신

## 확인 후 반영

- 고객·프로젝트 확정 연결
- 요구사항·약속 생성
- 예상값 변경
- Master Worker 작업 생성
- Notion 요약 게시

## 명시적 승인

- 고객 발송·회의 초대
- 견적 금액·할인
- 계약·일정 약속
- 프로젝트 범위 변경
- 구매요청·발주
- 예산 초과·지급·송금
- 세금계산서 요청
- 외부 시스템 변경·삭제

모든 행동에는 요청자·AI·승인자·근거·변경 전후·정책·모델·비용·오류·롤백을 기록한다.

---

# 10. Notion-first 발전 전략

## v0.1 현재

```text
고객·파트너
프로젝트
재무
활동·히스토리
```

기능 수보다 실제 입력 습관과 데이터 품질을 검증한다.

## v0.2 Notion 확장

필요가 발생할 때만 추가한다.

- 담당자
- 요구사항·미확인 사항
- 약속·다음 행동
- 계약·자산·라이선스
- 프로젝트 예산
- 비용·매입·지급
- 매출·청구·수금

## v0.3 JM CRM Brain

- AI Inbox
- Gmail·Calendar·Drive
- 근거·신뢰도
- 다음 행동·위험·재무 경고
- 승인
- 원본 MinIO 보관

## Shadow System

```text
Notion → 읽기 전용 Snapshot → Import·Quarantine → PostgreSQL Shadow Model → 자체 Dashboard
```

## Cutover

```text
Notion 동결 → 최종 Snapshot → 건수·관계·금액 대조 → PostgreSQL 정본 → 자체 시스템 신규 입력 → Notion 문서 Portal
```

Notion과 PostgreSQL Dual SoR는 금지한다.

---

# 11. 기술 아키텍처

```text
[메일·메신저·통화·회의·문서·웹]
                  ↓
             Intake Gateway
                  ↓
      Source Event / Evidence Store
                  ↓
             JM CRM Brain
     ┌────────────┼────────────┐
     │            │            │
  AI 추출      Policy       Workflow
     │         Approval         │
     └────────────┼────────────┘
                  ↓
 ┌─────────────────────────────────────┐
 │ CRM │ CPQ │ PSA │ ERP │ Accounting │
 └─────────────────────────────────────┘
                  ↓
          PostgreSQL 16 + FORCE RLS
                  ↓
 Transactional Outbox / Worker / Audit
                  ↓
[Master Worker / Action Hub / Council / Notion / Drive]
```

기존 저장소 역할:

- `apps/web`: 화면
- `apps/api`: 유일한 Mutation Gateway
- `apps/worker`: 장기작업·Outbox·재시도
- `packages/domain`: CRM·PSA·Delivery
- `packages/finance`: ERP 재무·원장·대조
- `packages/orchestration`: Job·WorkItem·Workflow
- `packages/governance`: 승인
- `packages/policy-engine`: Action Registry
- `packages/model-gateway`: AI 추론
- `packages/connectors`: 외부 Adapter
- `packages/imports`: Notion·CSV·OFX Import
- `packages/reports`: Cockpit·보고서
- `packages/persistence`: PostgreSQL

`packages/orchestration`만 신규 Orchestration 정본으로 사용하고 `packages/ai-orchestrator`에는 신규 기능을 추가하지 않는다.

---

# 12. 기반 제품 재사용

| 후보 | 역할 | 원칙 |
|---|---|---|
| Notion | 현재 운영·향후 문서 Portal | 초기 검증판, Cutover 후 거래 정본 아님 |
| Twenty | CRM Shell 후보 | 필수 의존성 아님, 라이선스·중복 평가 |
| ERPNext·Odoo | ERP Engine 후보 | Adapter 또는 Backend 후보 |
| 이카운트 | 한국 회계·전자세금계산서 후보 | API 검증 후 Adapter |
| 자체 JM Host | 고객 문맥·AI·승인·통합 | 핵심 차별화 계층 |

최종 Build/Buy는 구현비·월비용·데이터 소유·API·한국 회계·라이선스·복구·제품화를 기준으로 ADR에서 결정한다.

---

# 13. JM 시스템 역할

| 시스템 | 원장 |
|---|---|
| JM AI-Native Customer Work OS | 고객·영업·계약·프로젝트·거래·자산·프로젝트 회계 |
| JM-AI Master Worker | 실제 작업·검토·복구·투입시간 |
| JM-AI Action Hub | 모바일 입력·오늘 우선순위·승인 |
| AI Council OS | 고위험 제안·설계·계약 검토 |
| LLM Wiki·Obsidian | 재사용 지식·템플릿·교훈 |
| Notion | 초기 운영판, 이후 사람용 문서·브리핑 |
| Drive·MinIO | 원본 문서·증빙 |
| 외부 회계·세무 | 법정 신고·세무대리인 협업 |

---

# 14. 개발 로드맵

| 버전 | 목표 |
|---|---|
| v0.1.0 | Notion Business OS 4개 DB와 HOME |
| v0.2.0 | Notion CRM·PSA·재무 확장 |
| v0.3.0 | JM CRM Brain·AI Inbox·승인 |
| v0.4.0 | Native CRM + CPQ: Account·Opportunity·Requirement·BOM·Quote·Contract |
| v0.5.0 | PSA: Engagement·Milestone·Commitment·Risk·Change·Acceptance·Support |
| v0.6.0 | Project ERP: Purchase·Inventory·Asset·Invoice·AR/AP·Settlement·Ledger |
| v0.7.0 | AI Agents·Finance/Delivery/Procurement Guardian |
| v0.8.0 | Master Worker·Action Hub·Council·Notion·메일·회계 Adapter와 Cutover |
| v0.9.0 | 멀티유저·RLS·OIDC·MFA·Portal·모바일 |
| v1.0.0 | Golden Flow·Backup/Restore·감사·실제 Pilot·운영 안정화 |

---

# 15. 첫 Golden Workflow

```text
인프라·보안 고객 문의
→ AI 요구사항 정리
→ 미팅 준비·회의 반영
→ 솔루션·BOM
→ 벤더 가격·원가·마진
→ 견적·제안서
→ 승인·발송
→ 계약·판매주문
→ 구매요청·발주·입고
→ Master Worker 프로젝트
→ 구축·검수·완료보고
→ 청구·세금계산서 상태
→ 부분입금·잔금
→ 공급사 지급
→ 프로젝트 최종 손익
→ 자산·유지보수·갱신
```

적용 사업:

- HCI·서버 구축
- 네트워크·보안 컨설팅
- SIEM·로그 통합
- AI 컨설팅·자동화
- 자체 솔루션 판매
- 기술지원·유지보수
- 라이선스·장비 갱신

---

# 16. 성공 지표

## 시간

- CRM 입력 70% 감소
- 미팅 준비·후속 60% 감소
- 제안서 초안 70% 감소
- 인수인계 80% 자동화
- 구매·입출금 대조 60% 감소

## 영업·PSA

- 다음 행동 없는 영업 5% 미만
- 고객 약속 누락 50% 감소
- 요구사항 추적 95% 이상
- 검수 기준 없는 프로젝트 0건
- 무상 범위 확대 후보 탐지

## ERP·재무

- 프로젝트성 거래 Project Key 연결률 100%
- 부분입금·부분지급 정확성 100%
- 미수·미지급 정확성 100%
- 예산 없는 발주 탐지
- 검수 완료 후 미청구 탐지
- 30일 현금 부족 사전 경고
- 예상 대비 실제 원가 원인 추적

## AI 안전

- 핵심 AI 결과 근거 연결률 100%
- 승인 없는 외부 행동 0건
- AI 금액 임의 확정 0건
- 모델·프롬프트·비용·수정 이력 100%

---

# 17. 최종 결론

현재는 Notion을 가장 단순하게 사용한다.

장기 제품은 다음으로 고정한다.

```text
JM AI-Native Customer Work OS
= CRM + CPQ + PSA + Project ERP + Accounting + AI Brain
```

우리의 독자 경쟁력은 다음이다.

1. 고객 대화에서 요구사항·약속·사업기회를 구조화한다.
2. CRM·PSA·ERP를 프로젝트 번호 하나로 연결한다.
3. 무상 추가업무·원가 상승·미청구·현금 부족을 미리 찾는다.
4. AI가 준비하고 사람이 승인하는 안전한 실행 체계를 제공한다.

> **이 제품은 많은 고객을 저장하는 CRM이 아니라, 한 명의 대표가 영업·기술·제안·구매·프로젝트·회계·운영을 동시에 수행해도 고객 약속과 프로젝트 이익을 놓치지 않게 만드는 AI 기반 통합 사업 운영체제다.**
