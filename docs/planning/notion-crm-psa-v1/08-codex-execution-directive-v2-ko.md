# Codex 실행지시서 v2.0 — JM AI-Native CRM + PSA + ERP

- 정본 계획: `00-canonical-master-plan-v2-ko.md`
- 기능 지도: `01-integrated-capability-map-v2-ko.md`
- 대상 저장소: `whelp99-code/ai-crm-project-manager`
- 로컬 경로: `/Users/jmpark/orca/projects/AI-CRM+Project Manager`

> 기존 v1 실행지시서의 CRM·PSA·프로젝트 재무 중심 범위를 폐기하고, CRM + CPQ + PSA + Project ERP + Accounting + AI Brain을 통합 범위로 사용한다.

## 절대 원칙

1. Host는 `ai-crm-project-manager` 하나다.
2. PostgreSQL 16만 자체 제품 전환 후 정본이다.
3. Notion은 현재 운영판·전환 데이터 원천·향후 문서 포털이다.
4. Notion과 PostgreSQL을 동시에 정본으로 운영하지 않는다.
5. 모든 변경은 API, 정책, 승인, 도메인, 감사 경로를 통과한다.
6. 신규 오케스트레이션은 `packages/orchestration`에만 구현한다.
7. AI는 후보·초안·경고를 만들고 중요한 외부 행동은 사용자가 승인한다.
8. 프로젝트성 고객·작업·구매·재무·자산은 공통 `project_key`로 연결한다.
9. 실제 실행하지 않은 테스트나 연동을 완료로 표시하지 않는다.

## 구현 Workstream

```text
WS-00 저장소 기준선·ADR·요구사항 추적
WS-01 Notion Snapshot·Mapping·Quarantine
WS-02 CRM: Account·Contact·Opportunity·Activity·Requirement·Commitment
WS-03 CPQ: Product·Vendor·BOM·원가·마진·견적·제안·계약
WS-04 PSA: Engagement·인수인계·일정·위험·변경·산출물·검수·지원·갱신
WS-05 ERP: 구매요청·발주·입고·재고·시리얼·라이선스·자산
WS-06 Finance/Accounting: 청구·매입·입출금·미수·미지급·은행대조·복식부기
WS-07 Project Finance: 예산·원가단계·EAC·이익·현금예측
WS-08 Governance: Action Registry·승인·감사·멱등성·RLS
WS-09 AI Brain: Capture·Deal·Proposal·Delivery·Finance·Procurement·Renewal
WS-10 UI: Owner Cockpit·AI Inbox·Account 360·CRM/PSA/ERP Workspace
WS-11 Integration·Migration·Cutover·Backup·Rollback
```

## 우선 ADR

```text
ADR-013 Notion → PostgreSQL 전환
ADR-014 Engagement 중심 CRM·PSA
ADR-015 Project ERP·Accounting 범위
ADR-016 Financial Item·Settlement·Ledger
ADR-017 AI 제안과 사람 승인
ADR-018 Build/Buy·Adapter 경계
ADR-019 Canonical Orchestration
```

## PR 순서

```text
PR-V2-01 정본 문서·ADR
PR-V2-02 Notion Snapshot·Mapping
PR-V2-03 CRM Core
PR-V2-04 CPQ·계약
PR-V2-05 PSA Core
PR-V2-06 구매·재고·자산
PR-V2-07 청구·매입·입출금·은행대조
PR-V2-08 Ledger·Project Finance
PR-V2-09 Governance
PR-V2-10 CRM·PSA·ERP UI
PR-V2-11 AI Brain
PR-V2-12 외부 Adapter
PR-V2-13 Migration·Cutover·운영
```

## 첫 실행

첫 목표는 전체 코드 구현이 아니라 `PR-V2-01 정본 문서·ADR`이다.

1. 현재 저장소 기능을 구현·부분구현·문서만 존재·미구현으로 구분한다.
2. 기존 ADR과 v2 정본의 충돌을 기록한다.
3. Notion 현재 Schema를 CRM·PSA·ERP 모델에 매핑한다.
4. ADR-013~019와 요구사항 추적표를 작성한다.
5. 사용자 검토 후 다음 PR로 진행한다.

## 완료 정의

v1.0은 CRM·CPQ·PSA·ERP·Project Finance·AI·승인·감사·Notion 전환이 실제 Golden Flow로 검증되고, PostgreSQL 단일 원장·백업·복구·롤백이 확인된 경우에만 선언한다.
