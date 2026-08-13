---
document_id: CWOS-INDEX-001
project: JM AI-Native Customer Work OS
version: 1.0.0
status: Draft for Review
baseline: CWOS-BL-2026-08-14-01
created: 2026-08-14
updated: 2026-08-14
owner: Jae Min Park
---

# JM AI-Native Customer Work OS — 문서 정본 후보

## 1. 목적

이 폴더는 `CRM + CPQ/Commercial + PSA + Project ERP/Accounting + AI Brain`을 하나의 제품으로 설계하기 위한 연결 문서 세트다.

제품의 한 줄 정의는 다음과 같다.

> 고객 상담부터 영업·제안·계약·구매·구축·검수·청구·수금·지원·갱신까지를 하나의 고객사업 문맥으로 연결하고, AI가 다음 업무와 위험을 준비하되 중요한 행동은 대표가 승인하는 운영체제.

이 문서 세트는 기존 `docs/planning/notion-crm-psa-v1/00-canonical-master-plan-v2-ko.md`를 입력 기준으로 사용하되, 프로젝트 정의에서 운영까지 추적 가능하도록 재구성한 **정본 후보**다. 사용자의 승인 전까지 코드 구현 권한을 자동으로 부여하지 않는다.

## 2. 문서 구조

```text
왜 만드는가
├── 00-project/PROJECT-CHARTER.md
├── 00-project/VISION-AND-GOALS.md
├── 00-project/SCOPE-AND-NON-GOALS.md
└── 00-project/CURRENT-STATE-BASELINE.md

무엇을 만드는가
├── 01-product/PRD.md
├── 01-product/REQUIREMENTS.md
├── 01-product/FUNCTIONAL-SPEC.md
└── 01-product/USE-CASES-AND-USER-FLOWS.md

어떻게 보이고 동작하는가
└── 02-design/UX-UI-SPEC.md

어떻게 만드는가
├── 03-architecture/SYSTEM-ARCHITECTURE.md
├── 03-architecture/DATA-AND-API-SPEC.md
├── 03-architecture/ADR-INDEX.md
├── 04-ai/AI-AGENT-SPEC.md
├── 04-ai/WORKFLOW-LOOP-GRAPH.md
└── 05-security/APPROVAL-AND-PERMISSION-POLICY.md

어떻게 개발하고 증명하는가
├── 06-development/DEVELOPMENT-PLAN.md
├── 07-validation/TEST-EVALUATION-AND-RELEASE-GATE.md
└── TRACEABILITY-MATRIX.md

어떻게 설치·운영·사용하는가
└── 08-operations/DEPLOYMENT-OPERATIONS-AND-USER-GUIDE.md
```

## 3. 문서 우선순위

충돌 시 다음 순서를 적용한다.

1. 사용자 승인으로 Accepted가 된 ADR
2. `PROJECT-CHARTER.md`
3. `SCOPE-AND-NON-GOALS.md`
4. `REQUIREMENTS.md`
5. `PRD.md`
6. 시스템·데이터·AI·보안 설계
7. 기능·UX 명세
8. 개발·테스트·운영 계획
9. 기존 기획 문서와 참고자료

상태가 `Draft`인 문서끼리 충돌하면 임의로 구현하지 말고 `UNKNOWN` 또는 Decision Gate로 등록한다.

## 4. 공통 상태 표기

- **CONFIRMED**: 저장소 코드, 실제 Notion, 실행 증거로 확인됨
- **DECIDED**: 제품 기준으로 채택했으나 구현 여부는 별도
- **ASSUMED**: 현재 계획을 위한 임시 가정
- **UNKNOWN**: 추가 확인이 필요함
- **DEFERRED**: 후속 버전으로 연기
- **REJECTED**: 검토 후 제외

## 5. 핵심 추적 체계

```text
GOAL
 ↓
REQ
 ↓
FEAT
 ↓
USE CASE / USER FLOW
 ↓
GRAPH / NODE / LOOP
 ↓
COMPONENT / API / DATA
 ↓
TEST / EVALUATION
 ↓
ACCEPTANCE / RELEASE GATE
```

식별자 예시:

```text
GOAL-CRM-01
REQ-CRM-001
FEAT-CRM-001
UC-CRM-001
GRAPH-DEAL-001
NODE-DEAL-010
TEST-CRM-001
AC-CRM-001
```

모든 핵심 요구사항은 `TRACEABILITY-MATRIX.md`에서 코드·테스트·릴리스까지 연결한다.

## 6. 루프·그래프 원칙

루프는 단순 반복문이 아니다. 모든 루프는 다음을 가진다.

- 목적
- 입력 상태
- 노드와 조건부 Edge
- 성공·실패·중단 종료조건
- 최대 반복 횟수
- 시간·토큰·비용 예산
- 진행 없음 탐지
- Human Approval 지점
- 증거와 감사기록
- 실패 후 복구·재개 지점

그래프는 실행 중 상태와 검증 결과에 따라 다음 경로가 결정되는 동적 상태 그래프다. 자유 텍스트가 Edge를 결정하지 않으며, 검증된 구조화 결과와 정책만 라우팅 조건으로 사용한다.

## 7. 코드 기준선

현재 저장소는 TypeScript pnpm 모노레포이며 `apps/web`, `apps/api`, `apps/worker`, PostgreSQL·RLS·감사·정책·승인·오케스트레이션·CRM·PM·Delivery·Finance 기반 코드가 존재한다. 세부 구현 상태와 목표 차이는 `CURRENT-STATE-BASELINE.md`에 기록한다.

## 8. 개발 착수 Gate

다음이 모두 충족되기 전에는 대규모 기능 구현을 시작하지 않는다.

- Project Charter, Scope, Requirements가 Review 완료
- 핵심 ADR 승인
- Notion Snapshot·Mapping 계획 승인
- 현재 코드와 목표 데이터 모델 충돌 확인
- Graph/Loop 종료조건과 예산 확정
- 요구사항 추적표에 Critical Gap 없음
- 테스트·롤백 계획 존재

## 9. 완료에 대한 정직한 표현

다음은 `완료`가 아니다.

- 문서만 생성됨
- Mock·Synthetic 결과만 존재
- 실행하지 않은 테스트
- Notion과 PostgreSQL이 동시에 정본인 상태
- 승인되지 않은 외부 Connector
- AI가 근거 없이 만든 상태·금액
- Required Evidence가 없는 프로젝트 완료

완료는 코드, 실제 실행 결과, 독립 검증, 인수조건, 운영 가능성까지 증명된 상태만 의미한다.
