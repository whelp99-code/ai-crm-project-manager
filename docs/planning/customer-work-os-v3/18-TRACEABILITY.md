# 18 — Requirement Traceability

| REQ | Acceptance | ADR | PR | SUB | Implementation | Verification | State |
|---|---|---|---|---|---|---|---|
| REQ-BASE-001 | ACCEPT-BASE-001A/B | N/A | PR-001 | SUB-001/002/003 | v2 imports, PG adapter typing, authenticated concurrency ordering | focused runtime + API + `pnpm check` | PLANNED |
| REQ-COMPAT-001 | ACCEPT-COMPAT-001A/B | ADR-V3-001 | PR-001, PR-003 | PR-001-SUB-002/003; PR-003 pending | v2 tests and v3 registration | API/domain tests | PLANNED |
| REQ-ACT-001 | ACCEPT-ACT-001A/B/C/D | ADR-V3-002/004/005 | PR-002/003/005 | PR-002-SUB-001/002; later pending | contracts, migration, repository, API, Action Hub | persistence/API/Playwright tests | PLANNED |
| REQ-GOLD-001 | ACCEPT-GOLD-001A/B | ADR-V3-002/005 | PR-003/005 | pending | overview service/routes and `/v3` | API + Playwright | PLANNED |
| REQ-GOLD-002 | ACCEPT-GOLD-002A/B | ADR-V3-002 | PR-003 | pending | domain composition and projection | domain/API tests | PLANNED |
| REQ-GOLD-003 | ACCEPT-GOLD-003A/B | ADR-V3-002/003/005 | PR-007/008 | pending | full canonical Golden Flow and release E2E | live-PG + Playwright + release gate | PLANNED |
| REQ-FIN-001 | ACCEPT-FIN-001A/B | ADR-V3-002 | PR-004 | pending | finance composition | finance/API tests | PLANNED |
| REQ-AI-001 | ACCEPT-AI-001A/B | ADR-V3-003/005 | PR-006 | pending | proposal service/routes | API security tests | PLANNED |
| REQ-APP-001 | ACCEPT-APP-001A/B | ADR-V3-003/005 | PR-006 | pending | governance control integration | API/governance tests | PLANNED |
| REQ-CUT-001 | ACCEPT-CUT-001A/B | ADR-V3-002 | PR-007 | pending | reconciliation/pilot service | API live-PG + report | PLANNED |
| REQ-OPS-001 | ACCEPT-OPS-001A/B | ADR-V3-004 | PR-007/008 | pending | pilot store, workflow, release docs | full validation matrix | PLANNED |

Coverage at plan time: 11/11 MUST requirements have normal and failure-path acceptance criteria, PR ownership, and a verification route. Implementation coverage remains 0/11 until evidence exists.
