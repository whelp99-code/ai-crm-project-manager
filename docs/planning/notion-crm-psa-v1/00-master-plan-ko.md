# JM AI-Native CRM + PSA 통합 구축 마스터 플랜 v1.0

- 작성 기준일: 2026-08-14
- 문서 상태: 실행 기준선 제안
- 대상 저장소: `whelp99-code/ai-crm-project-manager`
- 로컬 정본 경로: `/Users/jmpark/orca/projects/AI-CRM+Project Manager`
- 현재 운영 검증판: Notion `JM Business OS`
- 목표 제품명: **JM AI-Native CRM + PSA**
- 사용자 표현 호환명: **JM AI-Native CRM/PAS**
- PSA 정의: **Professional Services Automation**
- 최종 운영 원장: **PostgreSQL 16**
- 현재 원칙: **Notion에서 먼저 사용하고, 검증된 구조만 자체 제품으로 승격한다.**

---

## 1. 최종 결론

JM AI-Native CRM + PSA는 일반적인 고객 연락처 관리 도구가 아니다.

이 제품은 다음 전체 흐름을 하나의 고객·프로젝트 문맥으로 연결하는 **1인기업 우선형 고객사업 운영 시스템**이다.

```text
고객 문의
→ 요구사항 확인
→ 견적·제안
→ 계약
→ 프로젝트 수행
→ 변경요청
→ 검수·완료보고
→ 매출·매입
→ 청구·입금·출금
→ 프로젝트 손익·현금흐름
→ 유지보수·갱신·추가 제안
```

제품의 핵심 질문은 다섯 가지다.

1. 지금 누구와 어떤 사업을 진행하고 있는가?
2. 각 프로젝트에서 다음에 해야 할 일은 무엇인가?
3. 고객·파트너와 어떤 대화와 결정이 있었는가?
4. 프로젝트별로 얼마를 벌고, 얼마가 나가며, 얼마가 남는가?
5. AI가 누락·위험·추가 기회를 찾아 사람의 결정을 준비할 수 있는가?

따라서 제품의 정체성은 다음과 같이 고정한다.

> **고객관계(CRM), 전문서비스 수행(PSA), 프로젝트 재무(Project Finance)를 하나의 Engagement 중심 모델로 연결하고, AI가 다음 행동과 위험을 제안하되 외부 행동과 금액 변경은 사람이 승인하는 운영 시스템**

---

## 2. 명칭과 범위

### 2.1 CRM

CRM은 다음을 관리한다.

- 고객사, 파트너, 제조사, 벤더
- 담당자와 의사결정 관계
- 문의, 영업기회, 제안, 계약
- 이메일, 전화, 미팅, 메신저
- 관계상태, 최근 연락, 다음 연락
- 추가 제안과 갱신 기회

### 2.2 PSA

업계 표준 명칭은 `PSA`, 즉 Professional Services Automation이다.

본 제품에서 PSA는 다음을 의미한다.

- 고객 프로젝트 수명주기
- 프로젝트 단계와 건강상태
- 산출물과 완료조건
- 약속, 다음 행동, 업무
- 범위 변경과 추가 견적
- 투입시간과 수행비용
- 청구 준비와 프로젝트 수익성
- 완료 후 유지보수·갱신 전환

사용자가 사용한 `CRM/PAS` 표현은 문서 검색 호환성을 위해 별칭으로 남기되, 코드·ADR·API의 정식 용어는 `CRM + PSA`로 통일한다.

### 2.3 프로젝트 재무

프로젝트 재무는 법정 회계 프로그램을 대체하지 않는다.

포함 범위:

- 예상 매출과 계약 매출
- 예상 비용, 확정 비용, 실제 지급
- 청구, 입금, 미수금
- 지급 예정, 출금, 미지급금
- 공급가액, 부가세, 합계
- 프로젝트 예상이익과 이익률
- 프로젝트 현금잔액
- 30·60·90일 입출금 예상
- 변경요청에 따른 추가비용과 추가매출

제외 범위:

- 총계정원장과 복식부기 전 영역
- 부가세·법인세·원천세 신고
- 급여와 인사
- 법정 재무제표
- 제조·물류 중심 ERP
- 은행 송금과 세금계산서의 무승인 자동 실행

---

## 3. 현재 Notion 운영판에서 확인된 기준

현재 Notion의 `JM Business OS`는 다음 네 개의 핵심 데이터베이스를 중심으로 구성되어 있다.

```text
고객·파트너
    │
    ├──────────────┐
    ▼              ▼
프로젝트 ←──── 활동·히스토리
    │
    ▼
재무
```

### 3.1 프로젝트

현재 구현된 핵심 속성:

- 프로젝트명
- 프로젝트ID
- 상태, 중요도, 시작일, 종료일
- 고객, 파트너, 거래처
- 제안제품, 제안금액
- 다음 행동
- 견적서, 제안서, 계약서, 완료보고서
- 재무, 활동·히스토리 관계
- 매출, 원가, 미수금, 미지급금, 영업이익, 이익률 Rollup

### 3.2 고객·파트너

현재 구현된 핵심 속성:

- 회사·조직명
- 구분: 고객, 파트너, 제조사, 기타
- 관계상태
- 담당자, 연락처, 이메일
- 중요도
- 최근 연락일, 다음 연락일
- 메일 송수신 요약
- 프로젝트, 재무, 활동 관계

### 3.3 활동·히스토리

현재 구현된 핵심 속성:

- 활동명
- 유형: 메일 수신·발신, 전화, 미팅, 메신저, 결정, 메모
- 활동일
- 요약, 결정사항
- 다음 행동, 다음 연락일
- 첨부
- 고객·파트너, 프로젝트 관계

### 3.4 재무

현재 구현된 핵심 속성:

- 거래명
- 구분: 매출, 매입, 기타입금, 기타출금
- 금액, 부가세, 합계
- 상태
- 예상 입금일, 예상 출금일
- 실제 처리일
- 입금·출금 처리 여부
- 세금계산서 상태
- 통장·결제수단
- 증빙
- 프로젝트, 거래처 관계
- 미수금, 미지급금 Formula

### 3.5 Notion 구현에서 유지할 장점

- 프로젝트가 모든 정보를 연결하는 중심이라는 점
- 고객과 파트너를 하나의 거래관계 원장으로 시작한 점
- 메일·전화·미팅을 활동 타임라인으로 분리한 점
- 매출·매입·입금·출금을 하나의 재무 목록에서 시작한 점
- 견적서부터 완료보고서까지 프로젝트에 연결한 점
- 1인기업이 실제로 입력할 수 있을 정도로 단순한 점

### 3.6 그대로 복제하면 안 되는 부분

현재 Notion은 운영 검증판이므로 자체 제품으로 옮길 때 다음을 정규화해야 한다.

- `프로젝트`에는 사업 프로젝트가 아닌 비용성 행이 섞일 수 있다.
- 진행 프로젝트 중 `다음 행동`, 제안제품, 제안금액이 비어 있는 행이 있다.
- 고객과 파트너가 회사 단위의 고정 구분으로 되어 있으나, 동일 회사가 프로젝트별로 다른 역할을 맡을 수 있다.
- 재무 한 행이 예상·청구·입금 또는 예상·발주·지급을 동시에 표현해 부분입금과 분할지급을 정확히 관리하기 어렵다.
- 파일이 프로젝트의 고정 열로만 존재해 여러 버전의 견적서·제안서·계약서를 관리하기 어렵다.
- 이메일 원문 근거, AI 추출 신뢰도, 사용자 확인 여부가 없다.
- 기존 과거 재무 DB와 신규 통합 재무 DB가 함께 있어 전환 시 중복 가능성이 있다.

결론적으로 Notion은 **화면과 업무 흐름의 검증판**이며, 자체 제품은 이를 그대로 복사하는 것이 아니라 정제된 도메인 모델로 승격해야 한다.

---

## 4. 제품 설계의 중심: Engagement

자체 제품에서는 `영업기회`와 `프로젝트`를 초기에 완전히 분리하지 않는다.

대신 `Engagement`를 중심 객체로 사용한다.

### 4.1 Engagement 정의

Engagement는 한 고객 문제나 사업기회를 문의부터 계약, 수행, 수금, 갱신까지 이어가는 단위다.

유형:

- `inquiry`: 신규 문의
- `opportunity`: 영업기회
- `consulting`: 컨설팅
- `delivery`: 구축·수행
- `support`: 기술지원·장애
- `maintenance`: 유지보수
- `renewal`: 갱신
- `internal`: 내부 운영

### 4.2 단계

```text
INQUIRY
→ DISCOVERY
→ PROPOSAL
→ NEGOTIATION
→ CONTRACTED
→ DELIVERY
→ ACCEPTANCE
→ BILLING
→ COLLECTION
→ CLOSED
```

예외 단계:

- `ON_HOLD`
- `LOST`
- `CANCELLED`

단계와 별도로 건강상태를 둔다.

- 정상
- 주의
- 위험

### 4.3 왜 Engagement인가

- 하나의 문의가 수주 후 같은 문맥으로 프로젝트가 된다.
- 고객 대화와 약속이 영업에서 구축으로 사라지지 않는다.
- 견적 변경이 계약, 수행범위, 비용, 청구에 연결된다.
- 유지보수와 갱신도 기존 고객 문맥에서 이어진다.
- 1인기업 단계에는 단순하지만 향후 조직 확장에도 유지할 수 있다.

---

## 5. 목표 도메인 모델

### 5.1 핵심 객체

| 객체 | 역할 | Notion 원형 |
|---|---|---|
| `accounts` | 고객사·파트너·제조사·벤더 | 고객·파트너 |
| `contacts` | 개인 담당자 | 고객·파트너 내 담당자 |
| `engagements` | 문의·영업·프로젝트·지원·갱신 | 프로젝트 |
| `engagement_parties` | 프로젝트별 고객·파트너·벤더 역할 | 고객/파트너 Relation |
| `activities` | 메일·전화·미팅·메신저·결정 | 활동·히스토리 |
| `commitments` | 고객 약속·내부 할 일·다음 행동 | 다음 행동 |
| `artifacts` | 견적서·제안서·계약서·완료보고서·증빙 | 파일 속성 |
| `financial_items` | 예상·확정 매출/비용과 청구·지급 의무 | 재무 |
| `settlements` | 실제 입금·출금과 부분처리 | 재무 처리여부 |
| `finance_documents` | 세금계산서·영수증·발주서 | 세금계산서·증빙 |
| `change_requests` | 추가 요구와 범위·금액·일정 영향 | 향후 신설 |
| `approvals` | 금액·발송·범위·일정 승인 | 향후 신설 |
| `ai_suggestions` | AI 추출·추천과 근거·신뢰도 | 향후 신설 |
| `audit_events` | 모든 변경과 승인·실행 기록 | 기존 감사 구조 |
| `import_batches` | Notion/CSV 전환 및 오류 격리 | 기존 imports |

### 5.2 Account 역할은 프로젝트별로 관리

회사 자체에 하나의 고정 역할만 부여하지 않는다.

예:

```text
A 프로젝트
- 선진엔지니어링: 고객
- 총판 B: 파트너
- 제조사 C: 제조사
- 외주 D: 수행 협력사

E 프로젝트
- 총판 B: 고객
- 선진엔지니어링: 소개 파트너
```

이를 위해 `engagement_parties`에 다음을 둔다.

- engagement_id
- account_id
- role
- primary_flag
- commercial_responsibility
- delivery_responsibility
- relationship_owner
- notes

---

## 6. 프로젝트 재무 모델

### 6.1 한 행에 예정과 실제를 섞지 않는다

Notion의 단일 재무 행은 입력은 쉽지만 부분입금·분할지급·변경계약이 생기면 한계가 있다.

자체 제품에서는 다음 두 계층으로 나눈다.

```text
Financial Item
받거나 지급해야 하는 계획·의무

Settlement
실제로 들어오거나 나간 돈
```

예:

```text
Financial Item
- 잔금 매출 70,000,000원
- 예상 입금일 2026-09-30
- 상태 BILLED

Settlement 1
- 2026-09-30 입금 30,000,000원

Settlement 2
- 2026-10-15 입금 40,000,000원
```

### 6.2 Financial Item

주요 필드:

- engagement_id
- account_id
- direction: `IN` / `OUT`
- category
- lifecycle: `PLANNED`, `APPROVED`, `CONFIRMED`, `BILLED`, `INCURRED`, `PARTIAL`, `SETTLED`, `OVERDUE`, `CANCELLED`
- net_amount
- vat_amount
- gross_amount
- expected_date
- contractual_due_date
- actualized_at
- source_artifact_id
- budget_revision
- memo

매출 분류:

- 제안 매출
- 최초 계약
- 추가 계약
- 유지보수
- 갱신
- 기타 수입

비용 분류:

- 장비
- 라이선스
- 외주
- 출장
- 운송
- 클라우드
- 내부 인건비
- 기타 직접비
- 공통 운영비

### 6.3 Settlement

주요 필드:

- financial_item_id
- direction
- amount
- settled_at
- account_or_card
- bank_reference
- evidence_artifact_id
- reconciliation_status
- memo

### 6.4 핵심 계산

```text
계약매출
= 최초 계약 + 승인된 추가계약

예상 최종매출
= 계약매출 + 승인 가능성이 확정된 변경매출

완료예상원가
= 발생원가 + 확정 미발생원가 + 남은 예상원가

예상 최종이익
= 예상 최종매출 - 완료예상원가

예상 이익률
= 예상 최종이익 / 예상 최종매출

청구잔액
= 청구 가능 금액 - 청구 완료액

미수금
= 청구액 - 입금액

미지급금
= 발생·확정 비용 - 출금액

프로젝트 현금잔액
= 실제 입금 - 실제 출금

향후 순현금
= 기간 내 예상 입금 - 기간 내 예상 출금
```

### 6.5 재무 불변조건

- 금액은 항상 공급가액, 부가세, 합계로 분리한다.
- Settlement 합계는 취소·환불을 제외하면 Financial Item 합계를 초과할 수 없다.
- 모든 프로젝트성 재무 항목은 Engagement와 연결한다.
- 프로젝트와 무관한 법인 공통비는 `corporate_overhead`로 명시한다.
- 비용성 기록을 프로젝트 행으로 만들 수 없다.
- 금액 변경은 이전 값을 덮어쓰지 않고 revision 또는 audit event를 남긴다.
- AI는 금액을 확정·청구·지급 상태로 직접 전환하지 않는다.
- 실제 입출금과 증빙 연결은 사용자 확인 또는 규칙 기반 대조 승인을 거친다.

---

## 7. 문서와 증거 모델

견적서, 제안서, 계약서, 완료보고서를 프로젝트의 고정 열로만 관리하지 않는다.

`artifacts`에 버전으로 관리한다.

종류:

- 고객 요청서
- 현황자료
- 벤더 견적
- 고객 견적서
- 제안서
- 계약서
- 발주서
- 설계서
- 구축계획서
- 회의록
- 변경요청서
- 시험·검수 증적
- 완료보고서
- 세금계산서
- 영수증
- 입출금 증빙

주요 필드:

- artifact_type
- engagement_id
- account_id
- title
- version
- status: `DRAFT`, `REVIEW`, `APPROVED`, `SENT`, `ACCEPTED`, `SUPERSEDED`
- storage_uri
- content_hash
- source_activity_id
- effective_date
- approved_by
- provenance

이 구조로 견적서 v1, v2, 최종본과 계약서·추가계약을 구분한다.

---

## 8. 활동, 약속, 다음 행동

### 8.1 Activity

Activity는 외부·내부 사건의 원본 타임라인이다.

- 이메일 수신
- 이메일 발신
- 전화
- 미팅
- 메신저
- 현장방문
- 문서 수신·발송
- 결정
- 메모
- 재무 사건

추가 필드:

- source_system
- source_uri
- occurred_at
- participants
- raw_content_ref
- summary
- decisions
- extracted_requirements
- ai_confidence
- reviewed_by_human
- sensitivity

### 8.2 Commitment

다음 행동은 단순 텍스트가 아니라 약속·업무 객체로 승격한다.

- 내가 고객에게 약속
- 고객이 나에게 약속
- 파트너가 나에게 약속
- 내부 할 일
- AI 추천 행동

필드:

- engagement_id
- activity_id
- owner
- counterparty
- description
- due_at
- status
- priority
- financial_impact
- approval_required
- completion_evidence

### 8.3 필수 규칙

- 진행 중 Engagement에는 완료되지 않은 다음 행동이 최소 하나 있어야 한다.
- 기한이 지난 약속은 Owner Cockpit에 자동 표시한다.
- 약속의 근거 Activity 또는 사용자 입력을 연결한다.
- 프로젝트가 `CLOSED`가 되려면 필수 약속과 완료 산출물이 닫혀 있어야 한다.

---

## 9. AI-Native 기능

AI를 화면 옆의 챗봇으로 붙이지 않는다.

AI는 모든 업무 사건을 읽고 구조화하며, 다음 작업을 준비하는 운영 계층이다.

### 9.1 Capture & Link

입력:

- 이메일
- 회의록
- 메신저 복사
- 음성 메모
- 문서
- 수동 입력

출력:

- 고객·파트너 후보
- 관련 Engagement 후보
- Activity
- 결정사항
- 요구사항
- Commitment
- 재무 영향 후보
- 다음 행동

확신이 낮으면 자동 연결하지 않고 후보를 보여준다.

### 9.2 Relationship & Deal Controller

- 최근 연락과 다음 연락 관리
- 의사결정자·기술담당자·구매담당자 식별
- 장기 무응답과 정체 탐지
- 제안 이후 다음 일정 누락 탐지
- 갱신·추가 제안 기회 추천
- 고객 건강상태 설명

### 9.3 Delivery Guardian

- 계약 범위와 실제 요청 비교
- 누락된 완료조건과 산출물 탐지
- 일정 지연과 검수 위험 탐지
- 추가 요구사항을 Change Request 후보로 생성
- 완료보고서와 고객 보고서 초안 생성

### 9.4 Finance Guardian

- 미청구·미수·미지급 탐지
- 예상 입금·출금 지연 경고
- 프로젝트 원가 상승 탐지
- 완료예상원가와 예상이익 갱신 제안
- 무상 범위 확대 탐지
- 30·60·90일 현금흐름 브리핑
- 증빙 누락과 중복 거래 후보 탐지

### 9.5 Document Copilot

- 미팅 준비자료
- 회의 요약
- 견적 설명
- 제안서
- 계약 검토 질문
- 변경요청서
- 완료보고서
- 고객 회신 초안

### 9.6 Executive Briefing

매일 또는 요청 시 다음만 보여준다.

```text
오늘 답변할 고객
오늘 마감되는 약속
정체된 사업
위험 프로젝트
이번 주 입금 예정
이번 주 출금 예정
연체 미수금
예상이익이 하락한 프로젝트
대표 승인이 필요한 항목
```

---

## 10. AI 권한과 승인 원칙

### 10.1 자동 허용

- 읽기
- 분류
- 요약
- 연결 후보 제안
- 다음 행동 추천
- 초안 생성
- 위험·누락 탐지
- 내부 대시보드 갱신
- 계산과 시뮬레이션

### 10.2 사용자 확인 후 반영

- 고객·프로젝트 확정 연결
- Commitment 생성
- 예상금액 변경
- 문서 상태 변경
- Master Worker 작업 생성
- Notion 요약 게시

### 10.3 명시적 승인 필수

- 고객에게 이메일·메시지 발송
- 회의 초대 발송
- 견적 금액 확정
- 할인 적용
- 계약·범위 변경
- 고객 일정 약속
- 세금계산서 발행 요청
- 지급·송금
- 외부 시스템 쓰기
- 삭제와 복구 불가능한 변경

### 10.4 AI 결과의 필수 메타데이터

- 근거
- 신뢰도
- 사용 모델
- 프롬프트 버전
- 생성 시각
- 비용
- 사용자 수정 여부
- 승인자
- 최종 실행 결과

---

## 11. 목표 아키텍처

기존 저장소의 단일 Host 원칙을 유지한다.

```text
apps/web
  ↓
apps/api
  ├─ 유일한 mutation gateway
  ├─ Action Registry
  ├─ Policy Engine
  ├─ Governance / Approval
  ├─ CRM / Engagement Domain
  ├─ PSA / Delivery Domain
  ├─ Project Finance
  └─ Audit
  ↓
PostgreSQL 16 + FORCE RLS
  ↓
Transactional Outbox
  ↓
apps/worker
```

외부 경계:

```text
Model inference
→ packages/model-gateway
→ 비효과성 구조화 출력만 허용

External effects
→ packages/connectors / future dispatcher
→ 승인·정책·idempotency·audit 후 실행
```

### 11.1 저장소 패키지 역할

| 패키지 | 역할 |
|---|---|
| `packages/contracts` | API·이벤트·도메인 계약 |
| `packages/domain` | Account, Contact, Engagement, Activity, Commitment, Artifact, Delivery |
| `packages/finance` | Financial Item, Settlement, Profitability, Cash Forecast, Reconciliation |
| `packages/orchestration` | Job, WorkItem, durable workflow |
| `packages/governance` | 승인과 정책 집행 |
| `packages/policy-engine` | ActionType, registry, control tier |
| `packages/model-gateway` | 구조화 AI 추론 |
| `packages/connectors` | Notion·메일·캘린더·Drive 등 Adapter |
| `packages/imports` | Notion·CSV snapshot과 격리 |
| `packages/reports` | Owner Cockpit와 프로젝트 보고 |
| `packages/persistence` | PostgreSQL migration, repository, outbox |

### 11.2 Orchestrator 정리

현재 저장소에는 `packages/ai-orchestrator`와 `packages/orchestration`이 함께 존재한다.

신규 기능은 `packages/orchestration`에만 구현한다.

- `packages/orchestration`을 canonical로 고정
- `packages/ai-orchestrator`는 신규 기능 금지
- 사용처를 조사한 뒤 compatibility façade 또는 deprecated package로 전환
- 동일 책임의 이중 실행 경로 금지
- 제거는 migration과 회귀검증 후 별도 PR에서 수행

---

## 12. Notion과 자체 시스템의 관계

### 12.1 현재

```text
Notion
= 실제 1인기업 운영판
= UX·필드·업무흐름 실험실
= 현재 수동 입력 원장
```

### 12.2 자체개발 초기

```text
Notion
→ 읽기 전용 snapshot/import
→ PostgreSQL staging
→ 검증·격리·수정
→ 자체 시스템 shadow dashboard
```

이 단계에서는 자체 시스템이 Notion을 자동 수정하지 않는다.

### 12.3 전환

전환 시점에 다음을 수행한다.

1. Notion 변경 동결
2. 최종 snapshot
3. 중복·누락·금액 합계 검증
4. legacy ID 보존
5. PostgreSQL 정본 전환
6. 자체 시스템에서 첫 신규 거래 생성
7. Notion은 문서·요약·보조 포털로 축소

### 12.4 전환 후

```text
PostgreSQL
= 고객·프로젝트·재무·승인·감사의 단일 원장

Notion
= 사람이 보는 브리핑, 회의록, 제안 문서, 읽기 전용 요약
```

Notion과 PostgreSQL에 동시에 사람이 같은 값을 입력하는 Dual SoR 구조는 금지한다.

---

## 13. 외부 시스템 연계

### 13.1 Notion

- 초기: schema snapshot, read-only import
- 중기: 프로젝트 브리핑·회의록 게시
- 전환 후: 문서·요약 중심 companion
- 금액·승인·상태의 정본은 PostgreSQL

### 13.2 Gmail·Outlook

- 이메일 검색·읽기
- 고객·프로젝트 후보 연결
- Activity 생성 제안
- 회신 초안
- 발송은 승인 필수

### 13.3 Calendar

- 고객 미팅 읽기
- 사전 브리핑
- 회의 후 후속 행동
- 초대 발송은 승인 필수

### 13.4 Drive·MinIO

- 원본 문서와 대용량 증빙
- Notion에는 링크와 요약
- 자체 제품은 Artifact metadata와 hash 관리

### 13.5 JM-AI Master Worker

- 실제 작업·실행·시간·진행률
- CRM/PSA의 Commitment가 승인 후 작업으로 전달
- Master Worker 결과가 프로젝트 진행률과 내부 인건비 후보로 돌아옴
- 두 제품의 원장을 합치지 않고 Adapter로 연결

### 13.6 JM-AI Action Hub

- 모바일 빠른 입력
- 오늘의 우선순위
- 승인 Inbox
- 고객 미팅 직후 음성·텍스트 등록

### 13.7 AI Council OS

다음 경우에만 호출한다.

- 고액 제안
- 기술 불확실성이 큼
- 계약·보안 위험
- 마진이 기준 이하
- 요구사항 충돌
- 처음 수행하는 기술

모든 고객·프로젝트에 Council을 강제하지 않는다.

### 13.8 Shared Knowledge / Obsidian

- 승인된 기술지식·템플릿 조회
- 완료 프로젝트의 교훈을 후보 지식으로 제출
- 고객별 사실과 일반 지식을 분리

### 13.9 ProofGraph

- 소프트웨어 개발형 Engagement의 증거 검증에만 사용
- 일반 CRM·회계 Runtime으로 확장하지 않음

---

## 14. 핵심 화면

### 14.1 Owner Cockpit

- 오늘 할 일
- 다음 연락
- 진행·위험 프로젝트
- 미청구·미수·미지급
- 7일 입금·출금
- 예상이익 하락
- 승인 대기
- 최근 AI 경고

### 14.2 AI Inbox

- 이메일·회의·메신저·문서
- 고객·Engagement 연결 후보
- 결정·약속·금액 영향 추출
- 사용자 승인 후 반영

### 14.3 Account 360

- 회사 개요
- 담당자와 역할
- 진행 Engagement
- 최근 Activity
- 매출·입금·미수
- 관계상태
- 다음 연락
- 갱신·추가 제안

### 14.4 Engagement Room

- 현재 단계와 건강상태
- 다음 행동
- 고객·파트너
- 요구사항
- 활동 타임라인
- 견적·제안·계약·완료보고
- 변경요청
- 프로젝트 손익
- 청구·입금·출금
- 위험과 AI 추천

### 14.5 Project Finance Cockpit

- 계약매출
- 완료예상원가
- 예상이익·이익률
- 청구·미청구
- 입금·미수금
- 지급·미지급금
- 프로젝트 현금잔액
- 30·60·90일 예상
- 원가 초과와 무상 추가업무

### 14.6 Approval Center

- 고객 발송
- 금액·할인
- 범위·일정
- 세금계산서 요청
- 외부 시스템 쓰기
- 삭제

### 14.7 Artifact Center

- 견적서
- 제안서
- 계약서
- 변경요청서
- 완료보고서
- 증빙
- 버전과 승인상태

---

## 15. Golden Workflow

```text
1. Capture
   고객 문의·메일·회의·메신저·문서 수신

2. Identify
   고객·파트너·기존 Engagement 연결

3. Discover
   요구사항·예산·일정·의사결정자·미확인 사항 정리

4. Propose
   견적서·제안서·대안·예상 매출·예상 비용 작성

5. Approve & Send
   금액·범위·외부 발송 승인

6. Contract
   계약·추가계약·청구 마일스톤 확정

7. Deliver
   작업·산출물·약속·위험·파트너 수행 관리

8. Control Change
   계약 밖 요구 감지 → 변경요청 → 영향·추가견적

9. Accept
   검수·완료보고·미완료 항목 확인

10. Bill & Settle
    청구·세금계산서·입금·출금·미수·미지급

11. Close & Learn
    최종 손익·교훈·유지보수·갱신·추가 제안
```

---

## 16. 단계별 구축 로드맵

### Phase 0 — Notion 기준선과 ADR 확정

구축:

- Notion 4개 DB schema snapshot
- 기존 과거 DB와 신규 DB 구분
- 데이터 품질 리포트
- 제품 용어와 범위 고정
- Notion → PostgreSQL 전환 ADR
- Engagement 중심 ADR
- 프로젝트 재무 ADR
- AI 승인 경계 ADR
- canonical orchestration ADR 보완

완료 기준:

- 코드보다 문서가 먼저 병합됨
- 금지 범위와 단일 SoR 전환 규칙이 명확함
- 기존 ADR-001/002/011/012와 충돌이 해소됨

### Phase 1 — Notion 안정화와 데이터 정리

구축:

- 프로젝트 고유 ID 규칙
- 진행 프로젝트의 다음 행동 필수화
- 비용성 행의 프로젝트 DB 분리
- 고객·파트너 중복 정리
- 재무 신규 DB 사용 시작
- 문서·증빙 링크 정리
- snapshot export 절차

완료 기준:

- 진행 프로젝트의 다음 행동 보유율 100%
- 모든 프로젝트성 돈 기록이 프로젝트와 연결됨
- 새 비용성 기록이 프로젝트 DB에 생성되지 않음

### Phase 2 — PostgreSQL Shadow Model

구축:

- Account, Contact, Engagement, Activity, Commitment, Artifact schema
- Financial Item, Settlement schema
- Notion import batch와 quarantine
- legacy Notion page ID 보존
- 읽기 전용 shadow dashboard
- count·relation·금액 reconciliation

완료 기준:

- Notion을 수정하지 않고 반복 import 가능
- 동일 snapshot 재처리가 idempotent
- 오류 행이 격리되고 정상 행을 오염시키지 않음
- 합계와 연결 검증 결과가 보고서로 남음

### Phase 3 — CRM + PSA 핵심 Vertical Slice

구축:

- Account 360
- Engagement Room
- Activity Timeline
- Commitment·다음 행동
- Artifact 버전
- 프로젝트 단계·건강상태
- 승인 없는 내부 CRUD

완료 기준:

- 신규 문의부터 계약·수행 준비까지 자체 시스템에서 관리 가능
- 진행 Engagement는 다음 행동 없이 저장되지 않음
- 모든 변경이 registry·policy·audit를 통과함

### Phase 4 — Project Finance

구축:

- Financial Item
- Settlement
- 미수·미지급
- 프로젝트 손익
- 완료예상원가
- 현금흐름
- 세금계산서·증빙 상태
- 비용·금액 변경 승인

완료 기준:

- 한 프로젝트에서 매출·원가·입금·출금·미수·미지급을 확인
- 부분입금·부분지급 가능
- 금액 불변조건과 reconciliation 테스트 통과
- AI 없이도 대표가 재무 상태를 이해할 수 있음

### Phase 5 — AI Assist와 Governance

구축:

- Capture & Link
- 회의·메일 요약
- Commitment 추출
- 위험·정체 탐지
- Finance Guardian
- 문서 초안
- Approval Center
- AI 비용·근거·신뢰도 기록

완료 기준:

- AI가 근거 없이 확정값을 쓰지 않음
- 승인 없는 외부 행동 0건
- 모델 출력은 schema 검증 후에만 내부 제안으로 저장
- 동일 문서 재분석 방지와 비용 예산 적용

### Phase 6 — 실행 시스템 연계

구축:

- Master Worker
- Action Hub
- AI Council
- Notion companion
- Gmail·Calendar·Drive read-first connector
- transactional outbox와 재시도

완료 기준:

- 중복 실행 없음
- Idempotency-Key 재전송 안전
- 외부 효과는 승인·정책·감사 후에만 실행
- Connector 장애가 CRM/재무 원장을 손상시키지 않음

### Phase 7 — Cutover

구축:

- Notion 최종 snapshot
- freeze·reconciliation
- PostgreSQL 단일 SoR 전환
- Notion 읽기 전용/문서 companion
- 백업·복구·rollback drill

완료 기준:

- 프로젝트·고객·활동·금액 count와 합계 일치
- 중복 또는 orphan 재무 0건
- 신규 거래는 자체 시스템에서만 생성
- 복구 리허설 통과

### Phase 8 — 팀·제품화

구축:

- 멀티유저
- 역할·권한
- Workspace 격리
- OIDC·MFA
- 고객 포털
- 모바일 앱
- 멀티테넌트 선택

완료 기준:

- 1인기업 UX를 훼손하지 않음
- Owner·Manager·Member·Finance Reviewer 역할 분리
- 모든 데이터에 workspace scope와 RLS 적용

---

## 17. 버전 제안

| 버전 | 의미 |
|---|---|
| `v0.1.0` | Notion 운영판 기준선 |
| `v0.2.0` | Notion 데이터 정리·운영 안정화 |
| `v0.3.0` | PostgreSQL shadow import |
| `v0.4.0` | CRM + PSA 핵심 화면 |
| `v0.5.0` | 프로젝트 재무 완성 |
| `v0.6.0` | AI Assist + Approval |
| `v0.7.0` | 외부 시스템 Adapter |
| `v0.8.0` | PostgreSQL cutover |
| `v0.9.0` | 멀티유저·운영 안정화 |
| `v1.0.0` | 자체 JM AI-Native CRM + PSA 정식 운영 |

---

## 18. AI 비용 통제

자가개발 목적이 AI 비용 낭비가 되어서는 안 된다.

### 원칙

- 전체 고객 히스토리를 매번 모델에 보내지 않는다.
- 변경된 Activity와 문서만 증분 처리한다.
- 고객·Engagement별 Context Pack을 유지한다.
- 날짜·금액·메일 분류는 규칙 또는 저비용 모델을 우선한다.
- 고성능 모델은 제안서·고위험 판단·복잡한 분석에만 사용한다.
- AI Council은 모든 건에 호출하지 않는다.
- 동일 파일 hash는 재분석하지 않는다.
- 모델 호출마다 비용 상한과 최대 반복 횟수를 둔다.
- AI 결과 수정률과 실제 채택률이 낮은 기능은 자동 중단 후보로 표시한다.

### 기능별 비용 등급

| 등급 | 예시 | 처리 |
|---|---|---|
| L0 | 날짜·금액 파싱, 상태 계산 | 규칙·SQL |
| L1 | 분류·짧은 요약 | 저비용 모델 |
| L2 | 미팅 브리핑·위험 분석 | 중급 모델 |
| L3 | 제안서·계약·고위험 설계 | 고성능 모델 |
| L4 | AI Council | 명시 조건 충족 시만 |

---

## 19. 성공 지표

### 운영

- 진행 Engagement의 다음 행동 보유율 100%
- 고객 문의와 프로젝트 연결 누락 0건
- 계약 밖 추가요청의 변경요청 후보 생성
- 검수 완료 후 미청구 건 자동 탐지
- 만료·갱신 누락 0건

### 재무

- 프로젝트성 거래의 Engagement 연결률 100%
- 부분입금·부분지급 정확성 100%
- 미수금·미지급금과 원본 증빙 연결
- 예상이익과 실제이익 차이 원인 추적 가능
- 30일 현금 부족 위험 사전 표시

### AI

- 핵심 AI 제안의 근거 연결률 100%
- 승인 없는 외부 행동 0건
- AI가 확정 금액을 임의 변경한 사건 0건
- 모델·프롬프트·비용·사용자 수정 이력 100% 기록
- 반복 업무 시간은 줄이고 승인 피로는 증가시키지 않음

### 전환

- Notion과 PostgreSQL count reconciliation 100%
- 금액 합계 reconciliation 100%
- orphan relation 0건
- Dual SoR 기간 0일
- rollback과 restore drill 통과

---

## 20. 주요 위험과 방어

| 위험 | 방어 |
|---|---|
| ERP·회계 전체로 범위 확대 | 프로젝트 재무까지만 제품 범위 |
| Notion 데이터 오염 | snapshot, quarantine, mapping review |
| 고객·파트너 중복 | canonical account + alias |
| 프로젝트와 비용 혼재 | Engagement/Financial Item DB 분리 |
| 부분입금 오류 | Settlement 별도 원장 |
| AI 환각 | 근거·신뢰도·사람 확인 |
| 무승인 외부 행동 | Action Registry + Approval |
| 승인 피로 | 위험도·금액 기반 차등 승인 |
| 이중 Orchestrator | `packages/orchestration`만 canonical |
| Dual SoR | shadow import 후 단일 cutover |
| AI 비용 증가 | delta, cache, model tier, budget |
| 문서와 코드 불일치 | ADR/requirements traceability/CI gate |

---

## 21. 제안 ADR

### ADR-013 — Notion Operational Prototype to PostgreSQL Cutover

- Notion은 현재 운영 검증판
- Shadow import는 read-only
- Cutover 후 PostgreSQL 단일 SoR
- Dual-write 금지

### ADR-014 — Engagement-Centered CRM + PSA Domain

- 문의·영업·프로젝트·지원·갱신을 Engagement로 연결
- 단계와 유형을 분리
- Account 역할은 Engagement별로 관리

### ADR-015 — Project Finance Item and Settlement Model

- 예상·확정 의무와 실제 입출금 분리
- 부분입금·부분지급 지원
- Project profitability와 cash forecast 정의

### ADR-016 — AI Suggestion and Human Authority

- AI는 제안·초안·경고까지만 자동
- 외부 발송, 금액, 계약, 일정, 지급은 승인
- 근거·신뢰도·비용 필수

### ADR-017 — Canonical Orchestration Package

- `packages/orchestration`만 신규 개발
- `packages/ai-orchestrator` 신규 기능 금지
- compatibility migration 후 제거 판단

---

## 22. 최종 제품 정의

> **JM AI-Native CRM + PSA는 고객·파트너 관계, 문의·영업·프로젝트 수행, 문서, 활동, 약속, 매출·매입·입금·출금, 프로젝트 손익을 Engagement 하나로 연결하고, AI가 누락·위험·다음 행동을 준비하되 중요한 외부 행동은 대표가 승인하는 고객사업 운영 시스템이다.**

현재는 Notion으로 이 운영 방식을 검증한다.

규모가 커지거나 반복 입력·권한·성능·자동연동 문제가 실제로 발생하면, 검증된 Notion 구조를 PostgreSQL 기반 자체 시스템으로 승격한다.

자체개발의 목표는 기존 솔루션을 모두 다시 만드는 것이 아니라 다음 네 가지 차별점을 완성하는 것이다.

1. 고객 대화와 프로젝트 실행의 연결
2. 프로젝트별 실시간 수익성과 현금흐름
3. 계약 밖 추가업무와 누락된 청구의 AI 탐지
4. 사람 승인 중심의 안전한 AI 업무 실행
