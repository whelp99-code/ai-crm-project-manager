# v2.5.0 — 1,000건 입력 검증 결과

- 실행일: 2026-08-29
- Seed: `250829`
- 실행기: `scripts/cwos-v25-1000-input-test.ts`
- 검증 범위: 텍스트·이메일·메시지·회의·음성전사·문서·일정·거래·Notion·이미지 입력

## 결과

```json
{
  "status": "PASS",
  "seed": 250829,
  "total": 1000,
  "rejectedAsDesigned": 100,
  "duplicateReplays": 50,
  "needsReview": 741,
  "autoReady": 159,
  "totalMutations": 2665,
  "financialMutations": 151,
  "changeMutations": 95,
  "highRiskAutoApproved": 0,
  "maxQuestionsPerEvent": 2,
  "unexpectedFailures": 0,
  "storedSources": 950,
  "storedPlans": 950,
  "stateHash": "fnv1a64:1986c6d85278e676"
}
```

## 해석

- 1,000건 모두 처리 루프가 끝났다.
- Prompt Injection 50건과 안전하지 않은 첨부 50건은 의도대로 격리됐다.
- 동일 Provider Event 50건은 새 자료를 만들지 않고 기존 결과를 재생했다.
- 알려진 고객·프로젝트의 저위험 기록 159건은 질문 없이 Auto-ready가 됐다.
- 일정·약속·금액·범위가 포함된 741건은 Review 대상으로 분류됐다.
- 재무 후보 151건과 범위 변경 후보 95건이 생성됐지만 자동 승인된 고위험 항목은 0건이다.
- 이벤트당 최대 질문 수는 2개로 정책 상한 3개를 넘지 않았다.
- 예상 밖 예외는 0건이다.

## 검증 중 발견·수정한 결함

초기 구현에서 같은 배치에 동일 메일이 두 번 들어오면 Duplicate 기록이 Accepted 기록의 ID를 덮어쓰는 문제가 발견됐다.

수정:

```text
기존 ID = connector + externalId + contentHash
수정 ID = batch + itemIndex + connector + externalId + contentHash
```

재검증 후 Accepted·Duplicate·Quarantined가 각각 독립 기록으로 보존됐다.

또한 동일 Baseline Snapshot을 다른 Plan ID로 다시 처리하면 빈 Plan이 생성될 수 있는 재실행 문제를 발견해, Snapshot Hash를 처리 전에 대조하도록 수정했다.

## 제한

이 결과는 새 v2.1–v2.5 도메인 계층의 로컬 결정론 테스트다. 실제 Gmail·Notion·Drive OAuth, 실제 PostgreSQL 16, GitHub Actions, 브라우저 E2E와 운영 Pilot 결과는 별도 Release Gate 증거로 관리한다.
