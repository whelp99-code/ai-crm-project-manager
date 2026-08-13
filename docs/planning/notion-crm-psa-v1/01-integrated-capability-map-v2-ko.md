# JM AI-Native Customer Work OS — CRM·PSA·ERP 통합 기능 지도 v2.0

- 기준 문서: `00-canonical-master-plan-v2-ko.md`
- 목적: Notion 현재판, 자체 제품 목표, 외부 시스템 경계를 한눈에 고정한다.

---

# 1. 전체 제품 지도

```text
┌──────────────────────────────────────────────────────────────┐
│                    Experience Layer                          │
│  Today Cockpit / AI Inbox / Account 360 / Opportunity Room  │
│  Proposal Studio / PSA Workspace / Finance / Approval       │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                       JM CRM Brain                           │
│ Capture · Context · Recommendation · Prediction · Governance│
└──────────────┬──────────────────┬──────────────────┬─────────┘
               │                  │                  │
┌──────────────▼───────┐ ┌────────▼────────┐ ┌───────▼─────────┐
│ CRM + Commercial    │ │ PSA             │ │ Project ERP     │
│ 관계·영업·CPQ·계약 │ │ 수행·검수·지원 │ │ 구매·자산·재무 │
└──────────────┬───────┘ └────────┬────────┘ └───────┬─────────┘
               └──────────────────┼──────────────────┘
                                  ▼
                    PostgreSQL 16 / RLS / Audit
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
       Master Worker         Action Hub           AI Council
```

---

# 2. 기능 영역별 책임

## 2.1 CRM

| 기능 | 현재 Notion | 자체 제품 v1 목표 | 정본 |
|---|---|---|---|
| 회사·조직 | 고객·파트너 DB | Account·Alias·중복관리 | PostgreSQL |
| 담당자 | 회사 행 내부 텍스트 | Contact·직책·연락채널·역할 | PostgreSQL |
| 프로젝트별 관계역할 | 고객/파트너 Relation | Engagement Party Role | PostgreSQL |
| 문의·영업기회 | 프로젝트 DB 상태 | Opportunity + Engagement | PostgreSQL |
| 고객 문제·목표 | 프로젝트 본문 | 구조화 Problem/Goal | PostgreSQL |
| 이해관계자 | 수동 메모 | 의사결정자·기술·구매·영향력 | PostgreSQL |
| 활동 타임라인 | 활동·히스토리 DB | Activity·Communication·원문 근거 | PostgreSQL |
| 고객 건강도 | 수동 | 규칙+AI 설명 | PostgreSQL |
| 휴면·재접촉 | 다음 연락일 | 자동 정체·재접촉 후보 | PostgreSQL |

## 2.2 요구사항·지식·증거

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 요구사항 | 프로젝트 본문 | Requirement 객체 |
| 확인된 사실 | 메모 | Claim + Evidence |
| 미확인 사항 | 메모 | Unknown/Assumption 객체 |
| 변경사항 | 활동·프로젝트 메모 | Requirement Revision |
| 추적성 | 수동 | 요구→BOM→견적→계약→작업→검수→청구 |
| 근거 | 파일·링크 | Evidence Ref·페이지·셀·녹취 구간 |
| AI 신뢰도 | 없음 | confidence·reviewed_by_human |

## 2.3 CPQ·Commercial

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 제안제품 | 텍스트 | Product·Service Catalog |
| 벤더 가격 | 파일·메모 | Vendor Quote·Price Book |
| BOM | 파일 | BOM·Version·Line Item |
| 예상원가 | 재무·수동 | Cost Estimate |
| 목표마진 | 수동 계산 | Margin Rule·Approval |
| 견적서 | 파일 열 | Quote·Version·Line |
| 제안서 | 파일 열 | Proposal·Version·Traceability |
| 대안 A/B/C | 본문 | Solution Option |
| 할인 | 수동 | Discount Rule·Approval |
| 계약 | 파일 | Contract·Version·Clause |
| 판매주문 | 없음 | Sales Order |
| 청구조건 | 메모 | Billing Milestone |

## 2.4 PSA

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 수주 인수인계 | 프로젝트 본문 | 자동 Handover Package |
| 프로젝트 단계 | 상태 Select | Engagement Stage Machine |
| 일정 | 시작·종료일 | Workstream·Milestone·Dependency |
| 고객 약속 | 다음 행동 텍스트 | Commitment 원장 |
| 실제 작업 | 체크리스트·외부 | Master Worker Adapter |
| 위험·이슈 | 메모 | Risk·Issue·Owner·Mitigation |
| 변경요청 | 메모 | Change Request·영향·승인 |
| 산출물 | 파일 열 | Deliverable·Version·Status |
| 시험·검수 | 본문 | Acceptance Criteria·Evidence |
| 완료보고 | 파일 열 | Completion Artifact |
| 투입시간 | 없음 | Time Entry·역할 단가 |
| 경비 | 재무 | Expense·Approval |
| 지원·장애 | 메모 | Support Case·SLA |
| 유지보수 | 프로젝트 | Service Contract |
| 갱신 | 다음 연락 | Renewal Opportunity·90/60/30 |

## 2.5 ERP — 판매·매출

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 계약매출 | 재무 매출 | Contract/Sales Order Amount |
| 납품 | 프로젝트 메모 | Delivery/Shipment/Acceptance |
| 고객 청구 | 재무 상태 | Customer Invoice |
| 세금계산서 | 상태 Select | Tax Document Metadata |
| 입금 | 처리여부 | Settlement |
| 부분입금 | 부분처리 | Settlement Allocation |
| 미수금 | Formula | AR Aging |
| 연체 | 상태 | Due Date·Aging·Collection Action |

## 2.6 ERP — 구매·매입

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 벤더 견적 | 파일 | Vendor Quote |
| 구매요청 | 없음 | Purchase Request |
| 구매승인 | 없음 | Approval Policy |
| 발주 | 메모 | Purchase Order |
| 입고 | 메모 | Goods Receipt |
| 매입확정 | 재무 매입 | Vendor Bill |
| 지급 | 처리여부 | Settlement |
| 부분지급 | 부분처리 | Settlement Allocation |
| 미지급금 | Formula | AP Aging |
| 파트너 정산 | 메모 | Partner Settlement |

## 2.7 ERP — 품목·자산·라이선스

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 제품·모델 | 제안제품 텍스트 | Product Catalog |
| 수량 | 문서 | Line Item |
| 시리얼 | 파일·메모 | Serial Number |
| 라이선스 | 메모 | License·Seat·Key Ref |
| 입고·납품 | 메모 | Inventory Movement |
| 고객 배정 | 프로젝트 | Asset Assignment |
| 보증·유지보수 | 메모 | Warranty·Service Contract |
| EOL·EOS | 수동 | Lifecycle Date·Alert |
| 갱신 | 수동 | Renewal Schedule |

## 2.8 ERP — 프로젝트 재무·회계

| 기능 | 현재 Notion | 자체 제품 v1 목표 |
|---|---|---|
| 예상매출 | 제안금액 | Forecast Revenue |
| 계약매출 | 재무 | Contract Revenue |
| 최초 예산 | 없음/수동 | Project Budget Baseline |
| 승인원가 | 없음 | Approved Budget |
| 약정원가 | 없음 | PO/Contract Committed Cost |
| 발생원가 | 매입 | Incurred Cost |
| 지급원가 | 출금완료 | Paid Cost |
| 내부 인건비 | 없음 | Time × Internal Rate |
| EAC | 없음 | Forecast Service |
| 예상이익·이익률 | Rollup·Formula | Project Profitability |
| 현금잔액 | 단순 합계 | Cash Position |
| 30·60·90일 예측 | 없음 | Cash Forecast |
| 통장 Import | 수동 | OFX/CSV Import |
| 입출금 대조 | 수동 | Bank Reconciliation |
| 복식부기 | 없음 | Journal Entry/Line |
| 월 마감 | 없음 | Accounting Period |
| 회계사 Export | 파일 | CSV·증빙 Package |

---

# 3. 핵심 객체 간 추적성

```text
Account
→ Opportunity
→ Requirement
→ Solution Option
→ BOM / Quote Line
→ Proposal Section
→ Contract Clause
→ Sales Order
→ Engagement / Project
→ Purchase Order / Work Item
→ Deliverable / Acceptance
→ Customer Invoice
→ Settlement
→ Project Profit / Cash Flow
→ Service Contract / Renewal
```

어느 한 단계가 변경되면 이후 영향을 계산한다.

예: 고객이 로그 보관을 180일에서 365일로 변경

```text
Requirement Revision
→ 스토리지 BOM 증가
→ 벤더 가격 재확인
→ 원가·마진 변경
→ 견적·제안서 변경
→ 계약 변경요청
→ 구축 일정·시험 기준 변경
→ 추가 청구 마일스톤
```

---

# 4. 프로젝트 번호 규칙

모든 시스템은 공통 `Project Key`를 사용한다.

```text
PRJ-YYYY-NNN
```

예:

```text
PRJ-2026-001 선진엔지니어링 HCI 구축
PRJ-2026-002 A사 SIEM 로그 통합
PRJ-2026-003 B사 AI 업무자동화
```

연결 대상:

- Opportunity
- Quote·Proposal·Contract
- Sales Order
- Vendor Quote·Purchase Order
- Goods Receipt·Vendor Bill
- Customer Invoice·Settlement
- Master Worker Work Item
- Meeting·Commitment
- Change Request
- Completion Report
- Asset·License·Service Contract

---

# 5. Source of Truth

| 데이터 | 현재 단계 | Cutover 후 |
|---|---|---|
| 고객·파트너 | Notion | PostgreSQL CRM |
| 프로젝트·약속 | Notion | PostgreSQL PSA |
| 매출·매입·입출금 | Notion | PostgreSQL ERP/Finance |
| 작업 실행·시간 | 수동/외부 | Master Worker |
| 원본 문서·증빙 | Drive/Notion | MinIO/Drive + Artifact Registry |
| AI 추천·승인 | ChatGPT/수동 | JM CRM Brain/Governance |
| 법정 세무·신고 | 홈택스·세무사 | 외부 회계·세무 Adapter |
| 사람용 문서 | Notion | Notion Companion |

Cutover 이후 Notion과 PostgreSQL에 동일 거래를 이중 입력하지 않는다.

---

# 6. AI 역할과 금지사항

| AI 역할 | 자동 허용 | 승인 필요 |
|---|---|---|
| 고객·프로젝트 연결 | 후보 생성 | 확정 연결 |
| 요구사항·약속 추출 | 후보 생성 | 원장 반영 |
| 견적·제안 | 초안·비교 | 금액 확정·발송 |
| 프로젝트 | 위험·변경 후보 | 범위·일정 확정 |
| 구매 | 필요성·벤더 비교 | 발주 |
| 재무 | 계산·예측·경고 | 청구·지급·역분개 |
| 지원·갱신 | 대상 탐지·초안 | 고객 발송·계약 |

AI 금지:

- 가격·할인 자동 확정
- 계약 자동 체결
- 고객 일정 자동 약속
- 무승인 발주·지급·송금
- 증거 없는 완료
- 자유 텍스트를 명령으로 실행

---

# 7. 구현 우선순위

## 우선순위 A — 지금 돈과 일정이 새는 구멍

1. Project Key
2. 다음 행동·Commitment
3. 매출·매입·입금·출금
4. 미수·미지급
5. 예상 입금·출금일
6. 프로젝트 EAC·이익·현금흐름
7. 무상 변경요청 탐지

## 우선순위 B — 영업·제안 병목

1. 요구사항·미확인 사항
2. 고객·담당자·의사결정자
3. BOM·벤더 가격
4. 견적·제안 버전
5. 승인·발송

## 우선순위 C — 수행·갱신

1. 인수인계
2. 마일스톤·검수
3. 자산·라이선스
4. 지원·장애
5. 유지보수·갱신

---

# 8. 최종 범위 선언

JM AI-Native Customer Work OS는 다음을 포함한다.

```text
CRM
+
CPQ/Commercial
+
PSA
+
Project ERP
+
Project Accounting
+
AI Brain
+
Human Approval
```

다만 v1.0 이전에는 모든 세무·급여·제조 ERP를 만들지 않는다.

핵심은 **고객 프로젝트를 중심으로 영업·수행·구매·돈·자산을 연결하는 ERP**이며, 법정 신고는 외부 시스템과 안전하게 연결한다.
