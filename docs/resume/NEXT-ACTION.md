# 현재 체크포인트에서 재개

프로젝트/workername은 AI-CRM+PM, 제품은 JM AI-Native Customer Work OS다.
Chatgpt2codex-Ubuntu 내부 프로젝트 ID는 ai-crmpm이다.

1. 프로젝트 선택은 안전 검사에서 차단됐고 실제 셸 명령은 LEASE_REQUIRED였다. 정식 접근 권한/연결이 복구된 후에만 실행한다. 다른 실행기로 우회하지 않는다.
2. 첫 실제 명령은 읽기 전용 hostname/id/pwd/git remote/branch/HEAD/status/docker ps/ports 확인이다. Secret·환경변수 값은 출력하지 않는다.
3. 현재 관측된 pilot/cwos-pilot-01의 변경·미추적 27개 경로를 보존한다. 실제 HEAD·origin은 아직 확인되지 않았다. 별도 worktree에서만 대조·통합한다.
4. 과거 20260916 패키지와 새 AI_CRM_PM_RESUME_20260919.zip을 구분한다. 새 후보의 검증 SHA는 7b7067ea00d9c562516458ac77cff1d6e0859d78이다. 이는 ChatGPT 격리 소스 커밋으로, 서버/GitHub에 존재한다고 가정하지 않는다.
5. 새 패키지의 scripts/cwos-handoff-audit.py를 사용해 사전 해시를 읽기 전용으로 대조한다. 이 도구는 파일을 적용하지 않는다. package.json은 과거 before/after 모두와 충돌하므로 일괄 덮어쓰기/강제 reset/자동 적용 금지다.
6. ALREADY_APPLIED / PENDING_* / USER_CHANGE_REVIEW / CONFLICT를 구분하고 필요한 수정만 검토·통합한다. 사용자 작업과 운영 DB는 보존한다.
7. REMAINING.md의 A~E를 실제 환경에서 진행한다. canonical 이중 원장 차단과 승인 정책을 우회하지 않는다. OAuth 동의/실제 인증정보/고위험 변경에 필요한 사항만 구체적으로 요청한다.
8. 구현→10개 관점 검토→수정→회귀→동일 소스 SHA 검증으로 진행한다. 검증된 런타임 변경만 브랜치/PR에 저장하고 실제 Ubuntu 배포 SHA·접속 주소·재시작 보존을 확인한다.

이 브랜치의 이번 추가 변경은 네 개 체크포인트 문서뿐이다. 격리 후보의 런타임 수정은 아직 이 브랜치에 적용하지 않았다.
전체 재기획/플러그인 검색부터 다시 시작하지 않는다. 포괄 개발 승인을 반복 요구하지 않는다.
