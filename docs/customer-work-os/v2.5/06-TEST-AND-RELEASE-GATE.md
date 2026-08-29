# v2.5.0 Test & Release Gate

## 검증 루프

```text
BUILD
→ STRICT TYPECHECK
→ DOMAIN TEST
→ API IDEMPOTENCY TEST
→ PERSISTENCE/RLS TEST
→ ADVERSARIAL INPUT
→ UX BUILD/E2E
→ FIX
→ FULL REGRESSION
```

## 열 가지 시야

1. 제품 생산성: 한 번 입력 원칙을 지키는가
2. 데이터 품질: 원본·근거·충돌을 보존하는가
3. 보안: Workspace·Human Approval을 우회할 수 없는가
4. 재무: 금액을 임의 확정하지 않는가
5. AI: 저신뢰를 질문하고 Prompt Injection을 격리하는가
6. 동시성: CAS·Idempotency가 중복을 막는가
7. Connector: Cursor·Retry·Dedup가 안전한가
8. UX: 질문이 3개 이하이고 메뉴 이동이 최소인가
9. 운영: Snapshot·Audit·복구가 가능한가
10. 회귀: 기존 v2 API와 화면을 깨지 않는가

## 종료조건

- 예상 밖 테스트 실패 0
- 고위험 자동승인 0
- Cross-workspace 누출 0
- 중복 생성 0
- 미해결 Critical Finding 0
- Typecheck·Unit·Integration·Security·Build·E2E 동일 SHA 통과

GitHub Actions 외부 차단이 있으면 소스 구현 완료와 Production Release 완료를 구분한다.
