# 검증 증거 — 2026-09-19

코드 실행 장소: ChatGPT 격리 컨테이너. 실제 Ubuntu 또는 GitHub 임시 runner가 아니다.
검증 소스 SHA: `7b7067ea00d9c562516458ac77cff1d6e0859d78`.
이 SHA는 별도 전달되는 격리 후보의 커밋이며 이 GitHub 브랜치의 커밋이라고 주장하지 않는다.

아래 파일은 `AI_CRM_PM_RESUME_20260919.zip` 안에 들어 있다.

| 증거 | 결과와 범위 |
|---|---|
| FINAL-EVIDENCE.json | 동결 소스 SHA/tree, 명령, exit code, 로그 SHA-256, 미검증 조건 |
| evidence/frozen-1-native.tap | 153 pass / 0 fail / 0 skip; 선택된 실제 TS 소스 컴파일·네이티브 규칙 시험 |
| evidence/frozen-2-native.tap | 동일 SHA에서 153 pass / 0 fail / 0 skip 재실행 |
| evidence/frozen-1-audit.log | Python 읽기 전용 대조 도구 13개 통과 |
| evidence/frozen-2-audit.log | 동일 SHA에서 Python 13개 재통과 |
| evidence/resume-defects-before.tap | 최초 추가 시험에서 11개 실패 재현 |
| evidence/quarantine-reanalysis-before.tap | 격리 지속/재분석 차단 문제 2개 재현 |
| evidence/schema-defects-before.tap | 출력 Schema 문제 3개 재현 |
| evidence/labeled-1000-results.json | 이번 소스에서 다시 실행한 합성 규칙 1,000건. 실제 AI 정확도가 아님 |
| evidence/input-integrity.json | 원본 패키지 체크섬 17개 검증 |
| evidence/target-package-comparison.json | 현재 서버 package.json이 원본 before/after 모두와 다름; 다른 70개 미대조 |
| evidence/gateway-entrypoint-syntax.json | Gateway 진입점 구문 검사만; 전체 typecheck가 아님 |
| source/docs/resume/REVIEW-10-PERSPECTIVES.md | 10개 관점 자체 검토. 별도 독립 검토자 없음 |

도구 환경: Node 22.16.0, 사전 설치 TypeScript 5.8.3, 사전 설치 @types/node 25.1.0.
잠금파일 기반 전체 의존성 설치가 아니다. 실제 원본 PDF 2건은 부재로 미실행이다.
전체 monorepo strict typecheck/Vitest/Next build, 실제 Fastify·Next 브라우저 E2E, 실제 AI·Outlook·PostgreSQL·복원·배포는 통과 처리하지 않는다.
이 브랜치에 저장된 체크포인트는 테스트 실행 증거의 위치와 상태를 기록하는 문서이며 런타임 통합 완료 증거가 아니다.
