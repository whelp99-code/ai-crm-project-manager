---
document_id: CWOS-PROJ-001
project: JM AI-Native Customer Work OS
version: 1.0.0
status: Draft for Review
baseline: CWOS-BL-2026-08-14-01
created: 2026-08-14
updated: 2026-08-14
owner: Jae Min Park
reviewers: Product Owner, Architecture Owner, Finance Owner, Security Owner
connected_requirements: [REQ-CRM-001, REQ-PSA-001, REQ-ERP-001, REQ-FIN-001, REQ-AI-001, REQ-WFG-001]
---

# PROJECT CHARTER — JM AI-Native Customer Work OS

## 1. 프로젝트명

**JM AI-Native Customer Work OS**

호환 명칭:

- JM AI-Native CRM
- JM AI-Native CRM + PSA + ERP
- JM Customer Work OS
- `PAS`는 사용자 검색 호환어이며 정식 용어는 `PSA — Professional Services Automation`이다.

## 2. 한 줄 정의

> 고객 상담부터 영업·제안·계약·구매·구축·검수·청구·수금·지원·갱신까지를 하나의 고객사업 문맥으로 연결하고, AI가 다음 업무와 위험을 준비하되 중요한 행동은 대표가 승인하는 CRM·PSA·ERP 통합 운영체제.

## 3. 개발 목적

재민님의 실제 업무는 일반 CRM의 `고객 → 영업기회 → 계약`에서 끝나지 않는다.

```text
고객 문의
→ 기술 요구사항 분석
→ 현황·문제점 파악
→ 솔루션 설계
→ 제조사·총판·파트너 협의
→ BOM·원가·마진 계산
→ 견적서·제안서
→ 계약
→ 구매·발주·입고
→ 프로젝트 착수·구축·시험·검수
→ 완료보고
→ 청구·세금계산서·수금
→ 공급사 지급·파트너 정산
→ 유지보수·지원·갱신·추가 제안
```

현재 가장 큰 관리 공백은 **프로젝트를 수행하는 동안 비용·원가·청구·입금·출금이 고객·계약·변경요청과 끊기는 것**이다. 이 프로젝트의 목적은 고객 업무 전체와 프로젝트 수익성을 하나의 연결된 시스템으로 만드는 것이다.

## 4. 해결하려는 핵심 문제

### PROB-001 분리된 고객 문맥

메일, 회의, 카카오톡, 제안서, 계약서, 프로젝트 기록이 서로 떨어져 있어 현재 상황을 다시 읽고 정리해야 한다.

### PROB-002 영업에서 수행으로 정보 손실

수주 시 고객 요구사항, 제외범위, 약속, 검수 기준, 청구조건이 프로젝트 실행으로 완전하게 넘어가지 않는다.

### PROB-003 프로젝트 비용 가시성 부족

계약금액은 알지만 예상원가, 발주원가, 발생원가, 지급원가, 내부 인건비, 완료예상원가와 현금흐름이 실시간으로 연결되지 않는다.

### PROB-004 무상 범위 확대

고객의 추가 요청이 회의·메일에서 조금씩 늘어나지만 변경요청·추가견적·일정 영향으로 공식화되지 않는다.

### PROB-005 고객 약속 누락

고객·파트너·벤더와 누가 무엇을 언제까지 하기로 했는지 일반 할 일과 섞여 누락된다.

### PROB-006 반복 문서 작업

회의 준비, 요구사항 정리, 제안서, 견적 설명, 주간보고, 완료보고, 갱신 제안을 반복 작성한다.

### PROB-007 AI 자동화의 통제 위험

AI가 고객에게 임의 발송하거나 금액·계약·일정을 확정하면 큰 손실이 발생할 수 있다.

### PROB-008 개발 비용 과다

이미 존재하는 CRM·PSA·ERP 기능을 무조건 재개발하면 AI 개발비와 유지보수비가 실제 업무 절감효과를 초과한다.

## 5. 주요 사용자

### Persona A — Owner/Operator

재민님. 대표, 영업, 기술 아키텍트, 제안서 작성자, 프로젝트 관리자, 고객지원, 계약·정산 담당 역할을 전환하며 수행한다.

핵심 요구:

- 오늘 해야 할 일과 돈의 흐름을 한 화면에서 확인
- 고객 문맥을 다시 찾는 시간 최소화
- 다음 행동과 누락 위험 자동 탐지
- 프로젝트 손익·현금흐름 실시간 확인
- 중요한 행동은 직접 승인

### Persona B — Future Team Member

향후 영업, 엔지니어, 프로젝트 매니저, 재무 담당자.

핵심 요구:

- 역할별로 필요한 정보만 접근
- 영업→수행 인수인계
- 업무·증거·완료조건 명확화
- 구매·비용·변경 승인

### Persona C — External Reviewer

회계사, 법무·보안 검토자, 파트너, 고객 검수 담당자.

핵심 요구:

- 제한된 범위의 증거·문서 검토
- 변경 불가능한 승인·검토 기록
- 개인정보·민감정보 최소 공개

## 6. 핵심 사용 시나리오

### SCN-001 고객 문의에서 제안까지

이메일을 수신하면 AI가 고객·담당자·기존 프로젝트를 찾고 요구사항·미확인사항·약속·예상일정을 추출한다. 사용자가 연결을 승인하면 미팅 질문, 솔루션 대안, BOM, 견적·제안서 초안이 준비된다.

### SCN-002 수주에서 프로젝트 인수인계까지

수주 시 계약범위, 제외범위, 요구사항, 견적품목, 검수조건, 청구마일스톤, 고객 약속을 인수인계 패키지로 고정하고 PSA 프로젝트와 Master Worker 작업 생성을 제안한다.

### SCN-003 프로젝트 수행과 변경통제

새 요청이 계약범위를 벗어나면 AI가 추가 작업량·원가·일정 영향을 계산하고 Change Request 후보를 만든다. 대표가 무상·예비비·추가견적 중 하나를 승인하기 전에는 기준선을 바꾸지 않는다.

### SCN-004 프로젝트 재무 통제

장비·라이선스·외주·출장·내부시간을 프로젝트에 연결해 예상원가, 승인원가, 약정원가, 발생원가, 지급원가와 완료예상원가를 계산한다. 청구·입금·미수금·지급·미지급·현금흐름을 별도로 표시한다.

### SCN-005 운영·지원·갱신

납품 장비·라이선스·인증서·유지보수 계약을 고객과 연결하고 90·60·30일 전 갱신 루프를 실행한다.

## 7. 핵심 가치

1. **Context Continuity** — 문의부터 갱신까지 고객 문맥이 끊기지 않는다.
2. **Project Profitability** — 프로젝트 종료 전에 손실과 자금부족을 발견한다.
3. **Evidence-Based AI** — AI 결과가 원문·문서·수치 근거와 연결된다.
4. **Human Authority** — 금액·계약·발송·일정·지급 권한은 사람에게 남는다.
5. **One-Person First** — 1인기업이 매일 사용할 수 있을 만큼 단순하다.
6. **Scale Without Rewrite** — Notion 검증판에서 PostgreSQL 기반 자체 제품으로 단계적으로 전환한다.

## 8. 제품 구성

```text
CRM
├─ Account·Contact·관계망
├─ Opportunity·Activity
├─ Requirement·Unknown·Assumption
└─ Commitment·Evidence

CPQ / Commercial
├─ Product·Vendor Quote·BOM
├─ Cost·Price·Margin
├─ Quote·Proposal
└─ Contract·Billing Milestone

PSA
├─ Handover·Plan·Milestone
├─ Task·Deliverable·Risk
├─ Change Request·Acceptance
└─ Support·Maintenance·Renewal

Project ERP / Accounting
├─ Purchase Request·PO·Receipt
├─ Inventory·Serial·License·Asset
├─ Billing·AR·AP·Settlement
├─ Project Budget·Cost Stage·EAC
└─ Management Ledger·Bank Reconciliation

JM CRM Brain
├─ Capture·Link·Summarize
├─ Deal·Proposal·Delivery·Finance Guardian
├─ Dynamic Workflow Graph
├─ Approval·Policy·Audit
└─ Cost·Quality·Self-Improvement
```

## 9. 핵심 원칙

### DECIDED-001 AI는 제안하고 사람은 확정한다

AI 자동 허용: 읽기, 요약, 분류, 연결 후보, 초안, 누락·충돌·위험 탐지, 계산 시뮬레이션.

명시적 승인: 고객 발송, 견적·할인, 계약·범위·일정, 세금계산서 요청, 지급, 삭제, 외부 시스템 쓰기.

### DECIDED-002 프로젝트 키로 전체 연결한다

모든 고객사업 데이터는 `project_key` 또는 Engagement ID로 연결한다.

### DECIDED-003 Notion은 검증판, PostgreSQL은 최종 원장이다

Cutover 전에는 Notion을 운영판으로 사용한다. Cutover 후 고객·프로젝트·거래·재무·승인·감사의 단일 원장은 PostgreSQL이다. Dual-write는 금지한다.

### DECIDED-004 그래프가 경로를, 루프가 품질을 통제한다

다음 노드는 실행 중 상태·검증·정책에 따라 결정된다. 루프는 최대 횟수·비용·시간·진행기준을 가져야 한다.

### DECIDED-005 완성 증거가 없는 완료는 금지한다

필수 산출물, Requirement Trace, 검증 결과, 사용자 승인 없이 프로젝트·작업·릴리스를 완료로 표시하지 않는다.

## 10. MVP 정의

MVP는 모든 ERP 기능을 한 번에 만드는 것이 아니다. 다음 Golden Flow를 실제 고객사업 한 건으로 관리하는 것이다.

```text
인프라·보안 고객 문의
→ AI Inbox 분류
→ 고객·영업기회 연결
→ 요구사항·미확인사항·약속
→ 미팅 준비·후속정리
→ BOM·원가·마진
→ 견적서·제안서
→ 대표 승인·발송
→ 계약·수주 인수인계
→ 프로젝트·변경요청·검수
→ 매입·지급·청구·부분입금
→ 프로젝트 손익·현금흐름
→ 완료보고·유지보수·갱신
```

MVP 성공은 이 흐름이 Mock이 아닌 실제 데이터와 승인·감사 기록으로 끝나는 것이다.

## 11. 성공 기준

- CRM 수동 입력시간 70% 이상 감소
- 미팅 준비·후속정리 시간 60% 이상 감소
- 제안서 초안 시간 70% 이상 감소
- 진행 중 사업의 다음 행동 보유율 100%
- 고객 약속 누락 50% 이상 감소
- 계약 밖 추가요청의 Change Request 후보 탐지율 90% 이상
- 프로젝트성 거래의 프로젝트 연결률 100%
- 미수금·미지급금 계산 정확도 100%
- 승인 없는 외부 행동 0건
- 핵심 AI 제안의 근거 연결률 100%
- 루프 무한반복 0건
- Notion→PostgreSQL 전환 시 건수·금액 합계 대조 100%

## 12. 주요 이해관계자

- Product/Business Owner: Jae Min Park
- Architecture Owner: 지정 필요
- Finance Owner/Controller: 초기 Owner, 정식 원장 Posting은 독립 검토자 필요
- Security Owner: 지정 필요
- Operator: Jae Min Park
- External Accountant/Tax Agent: 연동·검토 범위 추후 확정

## 13. 완료 상태

`v1.0.0 Production Ready`는 다음을 모두 만족해야 한다.

- Golden Flow E2E 실제 실행
- PostgreSQL 단일 원장
- RLS·감사·승인·멱등성 검증
- CRM·CPQ·PSA·Project ERP 핵심 기능
- 부분입금·부분지급·EAC·현금예측
- AI 근거·신뢰도·비용 기록
- 공격적·독립 검증
- 백업·복구·롤백 리허설
- 운영·사용자 문서
- 알려진 제한 공개

## 14. 향후 발전

- 1인기업 → 3~20인 팀
- OIDC·MFA·세분화된 RBAC
- 모바일 Action Hub
- 고객·파트너 포털
- 외부 ERP·전자세금계산서 Adapter
- Supabase 또는 관리형 PostgreSQL 선택
- 멀티테넌트 SaaS
- AI 자가개선 Canary·Rollback
