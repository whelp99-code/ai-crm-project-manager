---
document_id: CWOS-DEV-250
project: JM AI-Native Customer Work OS
version: 2.5.0
status: Implemented Candidate
created: 2026-08-29
owner: Jae Min Park
baseline_commit: cdefbeff4ba56782558d974a7a7dcb28f942d265
---

# Customer Work OS v2.1.0–v2.5.0 단계별 개발계획

## 1. 방향 고정

v2.1.0부터 v2.5.0의 목적은 메뉴와 입력 폼을 늘리는 것이 아니다.

> 사용자는 업무 사건을 한 번만 입력하고, AI가 기존 자료와 연결해 고객·프로젝트·일정·약속·재무·문서의 업데이트 계획을 만들며, 확신이 낮거나 위험한 항목만 짧게 질문한다.

제품의 핵심 KPI는 기능 수가 아니라 다음이다.

- Universal Capture 및 자동수집 비율 80% 이상
- 메뉴 이동을 통한 직접 입력 비율 20% 이하
- 이벤트 1건의 평균 사용자 확인시간 15초 이하
- 질문 수 이벤트당 최대 3개
- 고위험 데이터의 무단 자동반영 0건
- 동일 데이터 중복 생성 0건
- 다음 행동 없는 진행 프로젝트 0건

## 2. 목표 사용자 흐름

```text
기존 데이터 Snapshot
→ Baseline Builder
→ 고객·프로젝트·재무·문서 1차 자료
→ 불확실한 항목만 사용자 확인

새 이메일·메모·회의·파일
→ Universal Capture
→ 고객·프로젝트 자동 연결
→ 다중 Update Plan
→ 저위험·고신뢰는 자동 준비
→ 저신뢰는 최대 3개 질문
→ 금액·계약·범위·외부행동은 명시적 승인
→ 적용·대조·감사
→ AI Manager 일일 브리핑
```

## 3. 버전별 개발선

### v2.1.0 — Baseline Builder

기존 Notion·메일·캘린더·파일·CSV 자료를 정규화하고 중복 고객·프로젝트를 통합한다. 충돌하는 날짜·금액·프로젝트 키는 원본 근거와 함께 Review Queue에 보낸다.

### v2.2.0 — Universal Capture

텍스트·이메일·메신저·회의·음성전사·문서·거래 입력을 하나의 Source Event로 받고, 한 입력에서 활동·고객연결·프로젝트연결·일정·약속·변경요청·재무 항목을 동시에 제안한다.

### v2.3.0 — Clarification & Personal Learning

AI가 확신하지 못한 항목만 선택형 질문으로 제시한다. 사용자가 확정한 고객·프로젝트 별칭과 안전한 분류 습관은 학습하지만 가격·계약·승인·삭제·보안 정책은 자동 학습하지 않는다.

### v2.4.0 — Background Connectors

Gmail·Outlook·Calendar·Notion·Drive·CSV를 Read-only로 수집할 수 있는 배치·커서·재시도·중복·격리 계층을 제공한다. 외부 쓰기는 이번 범위에 포함하지 않는다.

### v2.5.0 — AI Manager

다음 행동 없음, 기한 초과 약속, 정체 프로젝트, 낮은 마진, 연체 미수, 임박한 지급, 음수 현금흐름, 미승인 범위 변경, 갱신 임박, 확인 대기를 매일 점검해 Owner Briefing을 생성한다.

## 4. 공통 불변조건

- 모든 데이터는 workspace 범위를 가진다.
- 모든 원본은 sourceRef 또는 evidenceRef를 가진다.
- 금액·계약·범위·실제 입출금·외부발송은 자동 확정하지 않는다.
- 질문은 이벤트당 최대 3개다.
- 같은 providerEventId 또는 contentHash는 중복 생성하지 않는다.
- Prompt Injection 의심 입력과 안전하지 않은 첨부는 격리한다.
- 상태 변경은 expectedVersion과 Idempotency-Key를 요구한다.
- PostgreSQL Snapshot은 삭제할 수 없고 Audit Event는 수정·삭제할 수 없다.
- AI 학습은 사용자 확인이 있는 안전한 별칭·분류만 허용한다.

## 5. 구현 구조

```text
packages/domain/src/customer-work-os-v25/
├── baseline.ts
├── capture.ts
├── clarification.ts
├── sync.ts
├── manager.ts
├── platform.ts
└── shared.ts

apps/api/src/
├── customer-work-os-v25-runtime.ts
└── customer-work-os-v25-routes.ts

apps/web/app/
├── capture/
├── review/
└── today/

packages/persistence/migrations/
└── 0020_customer_work_os_v25_automation.sql
```

## 6. 요구사항 추적

| 요구사항 | 기능 | 코드 | 검증 |
|---|---|---|---|
| REQ-BL-001 기존 데이터 중복 통합 | Baseline Builder | `baseline.ts` | 동일 Project Key 병합 |
| REQ-BL-002 충돌값 확인 | Baseline Review | `baseline.ts` | 날짜 충돌 질문 |
| REQ-CAP-001 한 번 입력 | Universal Capture | `capture.ts` | 한 메모→다중 Mutation |
| REQ-CAP-002 고위험 자동확정 금지 | Risk Gate | `capture.ts` | 재무·변경 AUTO 0건 |
| REQ-CLR-001 최대 3개 질문 | Clarification Budget | `clarification.ts` | 4개 입력→3개 생성 |
| REQ-CLR-002 안전한 개인화 | Learning Rule | `clarification.ts` | Alias 허용, 가격정책 거부 |
| REQ-SYNC-001 중복 없는 배치 | Background Sync | `sync.ts` | 정상·중복·격리 각각 보존 |
| REQ-SYNC-002 Cursor·Retry | Sync Runtime | `sync.ts` | Sequence 및 Retry 검사 |
| REQ-MGR-001 일일 위험 브리핑 | AI Manager | `manager.ts` | 10종 탐지기 검증 |
| REQ-DATA-001 영속성과 감사 | Snapshot/Audit | migration 0020 | RLS·Append-only 정적검사 |

## 7. 완료 기준

- 엄격 TypeScript 검사 통과
- Baseline 충돌과 중복 검증 통과
- 한 입력에서 최소 4개 도메인 변경 후보 생성 가능
- 고위험 변경의 자동 승인 0건
- 질문 수 최대 3개
- 안전한 Alias 학습 및 보호정책 학습 거부
- Background Sync의 정상·중복·격리 결과가 모두 보존됨
- AI Manager의 재무·일정·범위·갱신 탐지
- 상태 Export/Hydrate 후 Hash 일치
- API Idempotency 충돌 차단
- PostgreSQL RLS·Audit 불변조건
- Web Capture·Review·Today 화면 제공

## 8. 릴리스 경계

이 버전은 자동 입력·관리 계층의 소스 구현 완료를 의미한다. 실제 Gmail·Notion·Drive OAuth 연결, 실제 음성 전사, 운영 배포와 장기간 Pilot은 별도의 환경·자격증명·운영 증거가 필요하며 소스 구현만으로 성공했다고 표시하지 않는다.
