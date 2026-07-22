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
- **현재 점수 (2026-07-22 P6-b + 스케일 정정, Claude red-team #3 확정):** AI-CRM **≈93 / 100 (정규화; 보수 92.9 – 표값 93.6)** — ★정직: §1.1 가중 합이 100이 아니라 **110**이라 이전 절대치(…99.6)는 ~10% 부풀림. 정규화 정본: §3G 90.5 → P6-b 후 **≈93**. **정규화하면 어느 시점에도 ≥98 도달한 적 없음**(§3B 80.9/§3D 90.5/§3E 89.5/§3G 90.5). P6-b(도메인 전면 PG + audit PG-primary + resilience + Alertmanager + CI matrix)는 전부 라이브 실증 + observed-green CI + Claude 재현으로 진짜. 그러나 **100도 ≥98도 아님**. §1.1 헤더·footer 오표기 정정 완료. see `04-SCORECARD.md` §3H
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
