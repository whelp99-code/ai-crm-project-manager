# ADR-003 — Accounting Environment: South Korea, KRW, Asia/Seoul; Standards Fixed at Step 0 via Certified Accounting Review

- **Status:** Accepted — 2026-07-15 (ralplan Architect pass 4 CLEAR/APPROVE, Critic pass 4 OKAY, user post-ralplan confirmation 2026-07-15; execution authorized for goal G001).
- **Deciders:** Controller/CFO Owner (environment fields, blocking-field finalization, certified accounting review sign-off); Architecture Owner (schema/policy-engine dependency on pack values, DR-03).
- **Source of truth:** `.gjc/_session-019f664d-ec44-7000-a908-b9002f1f9769/plans/ralplan/019f664d-ec44-7000-a908-b9002f1f9769/pending-approval.md` §ADR-003; the full, currently authoritative detail is `docs/finance/accounting-standard-pack.md`, which this ADR references rather than duplicates.

## Decision

Jurisdiction is 대한민국 (South Korea); functional/reporting currency is KRW; business timezone/day-close basis is Asia/Seoul. These three environment fields are user-confirmed (2026-07-15) and are **not blocking**. Detailed accounting standards — governing standard (K-IFRS vs K-GAAP for SMEs or another named standard), decimal precision/rounding, fiscal calendar, day-close cutoff time, chart of accounts, revenue recognition policy, direct-cost policy, AR/AP aging buckets, opening balances, close cadence, evidence retention window, reconciliation tolerance, and projection freshness SLA — are finalized in `docs/finance/accounting-standard-pack.md` during Step 0 with certified (공인) accounting review, and **remain `BLOCKING — unset` as named blocking configuration fields until that certified review supplies and signs real values.**

### Drivers

1. Ledger precision, the daily-gate day-close cutoff, and projection semantics (cash/AR/AP/profitability freshness) all derive directly from the pack's blocking fields — schema work cannot be meaningfully tested against a guessed value.
2. Multi-currency scope is explicitly out of MVP scope (single-currency KRW only), which removes FX-conversion rule complexity from the ledger schema and policy engine for this ADR's scope.
3. The three-role draft → verify → post separation-of-duty invariant (accounting-standard-pack §3, rule 4) and the `PROTECTED_ACTION_TYPES` permanent-approval set (`LEDGER_POST`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE` — `packages/policy-engine`) depend on the environment being fixed before any migration seeds ledger data.

### Alternatives considered

| Option | Why rejected/selected |
|---|---|
| Multi-currency support at MVP | Rejected: adds FX-conversion decimal/rounding rules not required for a single-company Korean service business at MVP scope; deferred explicitly, not silently dropped. |
| Deferring jurisdiction/timezone until implementation | Rejected: the day-close cutoff and qualifying-day gate (accounting-standard-pack §4) are implementation-binding; deferring the *environment* (not just the *standards detail*) would leave schema/policy work with no fixed timezone basis at all. |
| **Fix jurisdiction/currency/timezone now; fix standards detail via certified review at Step 0 (selected)** | **Selected**, user-confirmed. Separates what is genuinely decidable now (environment) from what legitimately requires a certified accounting reviewer's signature (standards detail), rather than guessing the latter to unblock schema work. |

### Consequences

- No migration, seed fixture, or policy-engine constant may hardcode a guessed value for any `BLOCKING — unset` field in `docs/finance/accounting-standard-pack.md` §2; a placeholder used during scaffolding must fail a startup/CI check asserting the value is still `BLOCKING — unset`. As of this writing, every row in that pack's §2 blocking-configuration table and §6 sign-off record remains `BLOCKING — unset` — no certified review has yet been recorded.
- The double-entry and evidence invariants in accounting-standard-pack §3 (balanced entries, evidence-linked posting, append-only/reversal-only corrections, three-role SoD, exception-on-variance) are fixed now, independent of the still-blocking detail values, and are already reflected in the `packages/persistence` migration/security tests and `packages/policy-engine`'s permanent-approval set.
- The 90-consecutive-qualifying-day daily gate (accounting-standard-pack §4) and the finance control matrix's `conservative → eligible → risk_tiered` tier progression (`docs/policy-matrix.md` §3) cannot begin real evaluation until the day-close cutoff is signed — this is a **design**, not yet a running evaluator, in the current codebase (`packages/policy-engine`'s `POLICY_MATRIX` implements only the conservative tier).
- `LEDGER_POST`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE` remain permanent `REQUIRE_APPROVAL` actions regardless of tier or environment finalization status (`docs/finance/accounting-standard-pack.md` §5; mirrored by `PROTECTED_ACTION_TYPES` in `packages/policy-engine`).

### Follow-ups

- Controller/CFO Owner records certified-reviewer name, certification reference, and date for each `BLOCKING — unset` field in `docs/finance/accounting-standard-pack.md` §2 and §6 before Step 1 finance schema work (`journal_entries`, `journal_lines`, `statement_imports`, `reconciliations`, `finance_exceptions`, daily-gate metric tables) begins.
- Any implementer who finds a `BLOCKING — unset` field still blocking a task must stop and escalate to the Controller/CFO Owner rather than infer a value — this is a standing process rule, not a one-time reminder.
- Before Step 6 risk-tier activation, Controller/CFO Owner signs daily metrics, streak results, and the versioned matrix activation (see `docs/policy-matrix.md` §3).
