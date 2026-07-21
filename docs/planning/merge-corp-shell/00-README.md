# CORP-OS → AI-CRM 통합 계획서 세트

| 문서 | 역할 | 규범 여부 |
|---|---|---|
| [01-PRD.md](./01-PRD.md) | 제품 요구·범위·시나리오·수락 기준 | **규범** |
| [02-TDD.md](./02-TDD.md) | 기술설계 + 테스트 주도(TDD) 계획 | **규범** |
| [03-BLUEPRINT.md](./03-BLUEPRINT.md) | 시스템 블루프린트·패키지·API·데이터·단계 | **규범** |
| [04-SCORECARD.md](./04-SCORECARD.md) | 완성도 수치·만점 갭·재채점 | 추적 |

## 결정 요약

- **Host:** 본 저장소 — **host_repo_path (locked):** `/Users/jmpark/orca/projects/AI-CRM+Project Manager`
- **Preflight:** `test -f packages/contracts/package.json` · packageManager `pnpm@9.15.0` · node `>=22 <23`
- **Absorb:** `corp-os-mvp`의 orchestration 개념 + UX 패턴만 (`@ai-crm/orchestration`, **not** `ai-orchestrator`)
- **Kill:** SQLite/Prisma SoR, executor `execSync`/자유 fs, Next `app/api` mutation, 서버 Zustand 진실, 41 intent 직효과, nested `CORP-OS/` 제품 커밋, T-001..T-020 내 Temporal 필수 경로
- **Pilot workflow:** ADR-001 **Option D** (worker+PG); Temporal은 merge Gate B 밖
- **T-001 hard gate:** ADR-001 Option D 문구 + ADR-011/012(`resource_type`) 반영 전에는 T-002 코드 머지 금지
- **만점 정의:** 단일 워크스페이스 실운영 파일럿 가능 Company OS (100점)
- **현재 점수 (2026-07-20e Gate B FINAL):** AI-CRM **~98.8 (CONFIRMED, 보수 하한 98.5)** / 궤적 96.2→97.6→(99.5 철회)→97.0→98.5→98.8 / baseline 63.4 · pilot gate ≥ 98 → **MET (CONFIRMED — Claude 독립 red-team #2가 ≥98 확인: 엄격 98.03/표 98.47; T1–T3가 유일 약점 D3를 firming)** · N-06 observed-CI human_blocked(미청구) · see `04-SCORECARD.md` §3F
- **승인 합의:** ralplan revision s3 `3967ba29…` · pending `1d3ac013…` (Architect CLEAR/APPROVE + Critic OKAY)

## 충돌 시 우선순위

1. 기존 ADR-001 / 002 / 010 (**+ ADR-001 Option D pilot note**)  
2. ADR-011 / ADR-012  
3. 본 세트의 PRD → TDD → Blueprint  
4. `docs/backlog/corp-legacy-ideas.md` (작성 예정, 비규범)  
5. corp-os-mvp 내 PRD/로드맵  

## 관련 ADR (작성 필요)

- ADR-011: Merge — AI-CRM host, CORP shell, kill list, **host_repo_path**, Option D pilot  
- ADR-012: Orchestration — WorkItem ≠ PM Task; **`resource_type` + `resource_id`**; `@ai-crm/orchestration`  

## CORP 쪽 미러

참조 복사본:  
`~/Downloads/01.Pilot_Coding/corp-os-mvp/docs/planning/merge-to-ai-crm/`  
(동일 파일명. **수정은 본 AI-CRM 경로만** 한다.)
