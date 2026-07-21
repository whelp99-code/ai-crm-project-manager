# Next Track — Gate B 96.2 → ≥98 → 100

- **Status:** Draft for ralplan consensus (2026-07-20)
- **Host:** `/Users/jmpark/orca/projects/AI-CRM+Project Manager`
- **Predecessor:** merge-corp-shell Gate B re-score **96.2 / 100** (see `docs/planning/merge-corp-shell/04-SCORECARD.md` §3B). Gate B target ≥98 → **NOT MET** (honest, not fabricated).
- **Prior track closed:** T-001..T-020 + Batch A + Gate-B-close G-01..G-05 + G-07 (prod-auth hard-fail). Full package + live-pg + web suites green.

## 1. Objective

Take the AI-CRM pilot from an honest **96.2** to a genuinely-earned **Gate B ≥98**, then to **100**, WITHOUT fabricating scores. Every point must be backed by real code, tests, live evidence, or observed CI.

## 2. Fixed constraints (inherited, non-negotiable)

- Host = AI-CRM monorepo only; nested `corp-os-mvp/CORP-OS/` is orchestration meta/ledger only.
- SoR = PostgreSQL only; no SQLite/Prisma dual SoR; Temporal out of scope (Option D worker+PG).
- Effect path: NL → MODEL_INVOKE(service principal) → 5-key COMMAND_MAP → policy → control/intent → domain → audit.
- API `/api/agent/*` only; `@ai-crm/orchestration` ≠ `@ai-crm/ai-orchestrator`.
- COMMAND_MAP stays exactly the S0 five keys; finance money keys only in GOVERNANCE_COMMANDS.
- FORCE RLS on every workspace-bound table; runtime role `ai_crm_runtime_api` NOBYPASSRLS.
- No fabricated scores; MET only when earned; honest residuals otherwise.

## 3. Remaining deltas to ≥98 (from scorecard §3B.4, ≈ +1.8)

| ID | Gap | Dim | What ≥98 needs | Est. |
|----|-----|-----|----------------|------|
| **N-06** | Playwright/package CI never observed green on a real GitHub Actions runner (local + valid YAML only) | D10 | A real GH Actions run: `playwright install` + `test:e2e` + package suites + `LIVE_PG_TEST` job green; attach run link/log | S |
| **N-08** | Request path is memory-hydrated, not live PG-primary read; audit/outbox not restart-sourced | D4 | Route reads through PG (or restart-consistent load of audit/outbox); PG-primary read path with RLS scoping + live test | L |
| **N-09** | Worker/eventing confined to a single process (no cross-process broker) | D6 | `pg` LISTEN/NOTIFY (or documented single-instance constraint made explicit + tested) so a second process sees events | M |
| **N-10** | `agent-openapi.md` is human-readable, not machine OpenAPI; no rate-limit/versioning | D8 | OpenAPI 3.x spec generated + served; `/v1` prefix decision; rate-limit + idempotency response headers | M |
| **N-11** | No non-developer pilot onboarding/completion wizard | D1, D9 | S0→approval→work click-through wizard + seed/onboarding flow; e2e proving a pilot can complete the loop | M |

Closing N-06 + N-08 alone re-clears the two hardest axes and pushes the honest total to ~98.

## 4. Path to 100 (after ≥98)

| ID | Gap | Dim | Target |
|----|-----|-----|--------|
| **N-12** | Import E2E + full-domain PG repositories (CRM/PM/finance durable) | D2 | every domain aggregate PG-backed with restart survival |
| **N-13** | Durable audit chain restart-sourced (chain-head continuity across restart) | D3 | audit_events/audit_chain_heads dual-written + hydrated; tamper-evident across restart |
| **N-14** | AI live demo / digest / review↔work round trip hardening | D7 | live model-gateway demo path + report digest e2e |
| **N-15** | Metrics scrape integration + automated restore gate | D12 | Prometheus/OpenMetrics scrape endpoint + a CI restore-drill gate that runs pg_dump→restore→verify |

## 5. Proposed goal decomposition (for ralplan → Ultragoal)

1. **G-A (N-06 + N-10):** CI observed-green + OpenAPI 3.x/versioning/rate-limit — API contract & CI hardening (D8, D10). Independent, mostly additive.
2. **G-B (N-08):** PG-primary read path + audit/outbox restart-sourcing (D4, D3-partial). Largest; live-pg proof required. Depends on nothing but is the critical path.
3. **G-C (N-09):** cross-process eventing via pg LISTEN/NOTIFY or explicit single-instance contract (D6). Depends on G-B's PG session discipline.
4. **G-D (N-11):** pilot onboarding/completion wizard + e2e (D1, D9).
5. **G-E (N-12 + N-13):** full-domain PG repos + durable audit chain (D2, D3) — the bulk of 98→100.
6. **G-F (N-14 + N-15):** AI live demo + metrics scrape + automated restore gate (D7, D12) — final 100 close + Gate B numeric re-score.

Sequencing: **G-A ∥ G-B** first (independent), then **G-C** (after G-B), then **G-D**, then re-score to confirm ≥98; **G-E, G-F** for 100.

## 6. Verification doctrine (unchanged from prior track)

- Every goal: targeted tests → ai-slop-cleaner → architect (CLEAR/APPROVE) → executor QA/red-team → checkpoint.
- Live surfaces proven live: PG changes via `LIVE_PG_TEST=1` against docker postgres:16 + `pg-rls-smoke.sh`; web via playwright; CLI via argv replay.
- After each goal: independent Claude verification (Orca terminal) → proceed on PASS.
- No fabricated ≥98/100; honest residuals recorded in `04-SCORECARD.md`.

## 7. Success criteria

- **≥98 (Gate B MET):** N-06 + N-08 closed with real evidence (observed CI + PG-primary live test), honest re-score ≥98 in `04-SCORECARD.md`.
- **100:** all dimensions at max with backing evidence; Gate B numeric MET; scorecard changelog row `100`.
