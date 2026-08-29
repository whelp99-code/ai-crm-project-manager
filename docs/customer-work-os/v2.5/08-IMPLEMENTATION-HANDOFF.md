# Customer Work OS v2.5.0 — Implementation Handoff

Status: **SOURCE IMPLEMENTED / PRODUCTION RELEASE GATE REQUIRED**

## 포함

- v2.1 Baseline Builder
- v2.2 Universal Capture
- v2.3 Clarification & Personal Learning
- v2.4 Background Read-only Sync
- v2.5 AI Manager Daily Briefing
- PostgreSQL RLS Snapshot·Append-only Audit
- `/api/cwos/v2.5/*` API
- `/capture`, `/review`, `/today` Web 화면
- 고정 Seed 1,000건 입력 테스트

## 핵심 사용 방식

```text
사용자 입력 1회
→ 고객·프로젝트·일정·약속·재무 후보 동시 생성
→ 저위험·고신뢰 Auto-ready
→ 저신뢰 최대 3개 질문
→ 금액·계약·범위는 사람 승인
→ AI Manager 일일 예외 브리핑
```

## 정직한 운영 경계

소스 구현은 완료됐지만 실제 외부 서비스 OAuth, 실제 운영 DB 마이그레이션, GitHub Actions 전체 Gate, 브라우저 E2E, Backup·Restore, 7~14일 Shadow Pilot은 배포환경에서 별도 증명해야 한다.
