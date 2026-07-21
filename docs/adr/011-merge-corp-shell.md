# ADR-011 — Merge CORP-OS as Agent Shell into AI-CRM Host

| Field | Value |
|---|---|
| Status | **Proposed** (planning complete 2026-07-19; awaiting sign-off) |
| Date | 2026-07-19 |
| Deciders | Architecture Owner, Product Owner, Security |
| Relates | ADR-001, ADR-002, ADR-010; `docs/planning/merge-corp-shell/*` |

## Context

Two codebases exist:

- **AI-CRM+Project Manager** — governance-first CRM/PM/ledger core (~63/100 completeness).
- **corp-os-mvp (CORP-OS)** — agent workroom prototype with TaskEngine/UX (~46/100).

Uncoordinated merge (dual SoR, executor side effects, Next+Fastify both writing) would destroy AI-CRM invariants.

## Decision

1. **Host repository** is AI-CRM+Project Manager (pnpm modular monolith).  
   **host_repo_path (locked):** `/Users/jmpark/orca/projects/AI-CRM+Project Manager`  
   Preflight: `test -f packages/contracts/package.json`. Product work must not target nested empty `corp-os-mvp/CORP-OS/`.  
2. **CORP-OS is not a host.** Absorb only: orchestration *concepts* and UX *patterns*, rewritten against `@ai-crm/*` contracts.  
3. **PostgreSQL remains the only System of Record.** SQLite/Prisma/Zustand-server truth paths are forbidden in the host runtime.  
4. **All effects** go through ActionType → policy-engine → governance → domain/finance.  
5. **Egress** remains the two allowlisted boundaries (model-gateway; connector-dispatcher disabled in MVP).  
6. **Kill list (non-negotiable):**  
   - `execSync` / free filesystem writes as task completion  
   - CORP 41-intent executor port  
   - Next.js Route Handlers as mutation gateway  
   - mailbox file bus  
   - `public/results/**` as business completion  
   - SQLite/Prisma write path as SoR  
   - server Zustand as SoR  
   - live external connectors in MVP  
   - Temporal as required path inside T-001..T-020 (see ADR-001 Option D pilot note)  
   - agent principals seeded as OWNER  
   - product commits in nested empty `CORP-OS/`  
7. **Natural language commands** produce plans via `MODEL_INVOKE` (**gateway service principal**), then map to a **whitelist** of registry commands; unmapped steps fail with zero side effects. Job `created_by` remains the operator principal.  
8. **Agent principals** are `SERVICE` (or narrower), never seeded as OWNER; cannot approve their own controls (SoD).  
9. **Pilot durable workflow** for this merge = **ADR-001 Option D** (`apps/worker` + PG). Temporal is **not** required for T-001..T-020 / Gate B.  
10. Orchestration package npm name is **`@ai-crm/orchestration`** (dir `packages/orchestration`), distinct from existing `@ai-crm/ai-orchestrator`.  
11. Detailed PRD/TDD/Blueprint live under `docs/planning/merge-corp-shell/`.  
12. **T-001 hard gate:** ADR-001 Option D note + this ADR + ADR-012 `resource_type` language must land before T-002 code merge.

## Consequences

- Merge-MVP is a vertical slice (S0), not a full CORP feature port.  
- CORP repo becomes read-only reference / archive after port.  
- Completeness target: scorecard ≥ 98 before pilot (`04-SCORECARD.md`).  
- Requires ADR-012 (orchestration naming and schema).  
- Engineering cost concentrates on persistence (governance/orch PG), `/work` UX, and tests — not on 3D or intent handlers.
- **Pilot durable workflow for this merge = ADR-001 Option D (worker+PG); Temporal is not required for T-001..T-020 / Gate B.** Dual-queue (Temporal + worker) for agent jobs is forbidden without ADR-001 revision.
- API surface for the agent shell is **`/api/agent/*`** (not `/v1/agent/*`).
- S0 command-map is the five-key whitelist in the merge Blueprint; finance money keys are out of P1.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| CORP-OS as host | Security/ledger/governance rewrite cost dominates |
| Side-by-side dual SoR with sync | Consistency failure mode |
| Git monorepo dump of both trees | Dependency and invariant contamination |
| Keep executor “for demo only” | Permanent bypass of registry |

## Follow-ups

- [ ] Product/Architecture/Security sign-off on this ADR  
- [ ] Implement packages/orchestration per Blueprint  
- [ ] Demote CORP PRDs to non-normative backlog  
- [ ] Remove nested empty `CORP-OS/` git repo when approved  
