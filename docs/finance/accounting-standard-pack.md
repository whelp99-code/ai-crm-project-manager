# Accounting Standard Pack — South Korea / KRW / Asia/Seoul

- **Status:** Environment fixed (jurisdiction, currency, timezone) — user-confirmed 2026-07-15. **Detail standards below are not yet certified-accounting-reviewed and are blocking configuration fields, not defaults.** No `pnpm test:*`/`pnpm typecheck`/schema migration for finance tables may proceed on the basis of a guessed value in this document.
- **Owner:** Controller/CFO Owner. Finalization requires certified (공인) accounting review; sign-off is recorded in this file with reviewer name, certification reference, and date before Step 1.
- **Consumers:** planned `packages/domain` finance aggregates, `packages/persistence` ledger schema, `packages/policy-engine` finance control matrix, `docs/architecture/capability-matrix.md`, and Step 6A/6B finance tests.

## 1. Fixed environment (user-confirmed, not blocking)

| Field | Value | Confirmed |
|---|---|---|
| Jurisdiction | 대한민국 (South Korea) | 2026-07-15 |
| Functional / reporting currency | KRW | 2026-07-15 |
| Business timezone / day-close basis | Asia/Seoul | 2026-07-15 |
| Multi-currency scope | Out of MVP scope — single-currency KRW only; decimal/FX conversion rules are therefore not required for MVP ledger entries | 2026-07-15 |

## 2. Blocking configuration fields (certified accounting review required)

The fields in this table are **not implementation assumptions**. Each is a named blocking input: it has an owner, a required validation rule, and an explicit non-default state (`BLOCKING — unset`) until certified review supplies and signs a real value. No migration, seed fixture, or policy-engine constant may hardcode a guessed number for any of these fields; a placeholder used during scaffolding must fail a startup/CI check that asserts the value is still `BLOCKING — unset`.

| Field | Current value | Owner | Validation rule before it can leave `BLOCKING — unset` |
|---|---|---|---|
| Governing standard (K-IFRS vs K-GAAP for SMEs, or another named standard) | `BLOCKING — unset` | Controller/CFO Owner, certified accounting reviewer | Must cite the specific standard name/version applicable to a single-company Korean service business; reviewer certification reference recorded alongside the value. |
| Decimal precision / rounding rule for KRW (KRW has no minor unit in circulation, but ledger precision must still be fixed) | `BLOCKING — unset` | Controller/CFO Owner | Must state exact decimal scale used in `journal_lines` amount columns and the rounding mode (e.g., banker's rounding vs round-half-up) applied at posting time; must be a single fixed scale, not "whatever the input has." |
| Fiscal calendar (fiscal year start/end; whether it matches calendar year) | `BLOCKING — unset` | Controller/CFO Owner | Must state fiscal year start month/day; if it diverges from calendar year, must state how period boundaries interact with the day-close cutoff below. |
| **Day-close cutoff time (Asia/Seoul)** | `BLOCKING — unset; MUST NOT be guessed` | Controller/CFO Owner, certified accounting reviewer, explicit sign-off required | Must be an exact `HH:mm` Asia/Seoul wall-clock cutoff (e.g., a specific end-of-business time), plus the rule for what happens to a metric/import that lands exactly at the boundary. This field is the single most implementation-binding value in this pack (see §4) and requires a dedicated, separately recorded sign-off line — it is never inferred from "midnight" or any other convenient default. |
| Chart of accounts | `BLOCKING — unset` | Controller/CFO Owner, certified accounting reviewer | Must be an enumerated, versioned list of account codes/names/types (asset/liability/equity/revenue/expense) sufficient to post every MVP transaction type (evidence intake, reconciliation adjustment, invoice, payment, close adjustment); the seed fixture in `packages/persistence` may not invent account codes not present in this list. |
| Revenue recognition policy | `BLOCKING — unset` | Controller/CFO Owner, certified accounting reviewer | Must state the recognition trigger (e.g., milestone completion, delivery acceptance, time-based) per the delivery-project contract model in the capability matrix, and must be testable against a seeded delivery-project fixture. |
| Direct-cost policy | `BLOCKING — unset` | Controller/CFO Owner | Must state which cost categories are capitalized vs expensed and at what trigger, consistent with the project profitability projection. |
| AR / AP aging buckets | `BLOCKING — unset` | Controller/CFO Owner | Must be an explicit bucket boundary list (e.g., current / 30 / 60 / 90+) used by the finance UI due/overdue projections; cannot be left to per-query ad hoc bucketing. |
| Opening balances | `BLOCKING — unset` | Controller/CFO Owner | Must be a signed, evidence-linked opening journal entry set (or an explicit "zero opening balance, single-company greenfield" statement) before any seed/migration creates a non-zero ledger balance. |
| Close cadence | `BLOCKING — unset` | Controller/CFO Owner | Must state close frequency (e.g., monthly) and its relationship to the daily qualifying-day gate in §3; a close adjustment is represented as a `LEDGER_POST` action with a `close_adjustment` subtype and therefore retains permanent human approval. |
| Evidence retention window | `BLOCKING — unset` | Controller/CFO Owner | Must be a duration (e.g., N years) consistent with 대한민국 statutory bookkeeping retention requirements; drives the capability-matrix import/evidence retention rule and object-store lifecycle policy. |
| Reconciliation tolerance | `BLOCKING — unset` | Controller/CFO Owner | Must be an explicit currency amount or percentage tolerance below which a bank-vs-ledger variance auto-closes as immaterial vs. above which it must open a `finance_exceptions` row; cannot be zero-tolerance by silent default without an explicit decision that it is zero. |
| Projection freshness SLA | `BLOCKING — unset` | Controller/CFO Owner | Must state the maximum acceptable staleness for cash/AR/AP/profitability projections shown in the finance UI, consistent with the capability matrix's `as_of` banner rule. |

**Sign-off gate:** Step 1 schema/migration work for finance tables (`journal_entries`, `journal_lines`, `statement_imports`, `reconciliations`, `finance_exceptions`, daily-gate metric tables) may not begin until every row above is moved from `BLOCKING — unset` to a signed value with reviewer name/certification reference/date recorded in this file. Any implementer who finds a `BLOCKING — unset` field still blocking a task must stop and escalate to the Controller/CFO Owner rather than infer a value.

## 3. Double-entry and evidence invariants (not blocking — architecture-level, fixed now)

These rules are fixed regardless of the specific chart-of-accounts/recognition values above, because they are structural, not jurisdiction-specific:

1. Every `journal_entries` row has one or more `journal_lines`; `sum(debit) = sum(credit)` for the entry at the pack's fixed decimal precision (once §2 supplies that precision) — an unbalanced entry cannot be persisted.
2. Every posting-eligible journal entry links to at least one immutable, object-versioned `evidence` record; a journal entry with no evidence reference cannot reach `POSTED`.
3. Corrections are reversals plus new entries — `journal_entries`/`journal_lines` are never updated or deleted once posted; a posted-ledger UPDATE/DELETE is rejected at the database level (mirrors the audit-events append-only trigger pattern in `packages/persistence`).
4. Draft → verify → post is a three-role workflow: the principal who creates/drafts a journal entry, the principal who verifies it, and the CFO/approver who authorizes posting must be pairwise distinct. `control_claims`, `control_requests`, and principal-role validation enforce the same separation-of-duty rule as `control_requests_approver_validator_distinct`.
5. Bank/AR/AP variance detected during reconciliation always creates a `finance_exceptions` row; a variance is never silently absorbed into a "rounding" account without an explicit reconciliation resolution action.

## 4. Daily qualifying-day gate and 90-consecutive-day reset rule

This section is implementation-binding once the day-close cutoff (§2) is supplied; the *rule shape* below is fixed now so schema/policy work can proceed against it.

1. Daily metrics are evaluated in the accounting pack's business timezone (**Asia/Seoul**) against the single explicit day-close cutoff recorded in §2.
2. A day **qualifies** only when all required integrity/cash/profitability inputs for that day are complete and passing by the cutoff. "Complete and passing" means: every expected import batch for the day reached `COMPLETED` (not `QUARANTINED`/`PENDING`), every posted journal entry for the day balances, and no unresolved `finance_exceptions` remain open against that day's data as of cutoff.
3. A day that is **failed, missing, late, or backfilled** is recorded as **non-qualifying** and **resets the consecutive-qualifying-day streak to zero**. "Late" means data for day N arrives and is processed after day N's cutoff has passed; "backfilled" means a correction is applied to a day already closed. Neither a late arrival nor a backfill may retroactively mark day N as qualifying after the fact.
4. A later correction to a non-qualifying day may create an **auditable historical correction record**, but it cannot retroactively restore an already-reset qualifying streak. Restoring eligibility after a reset requires a fresh controller-approved policy evaluation, not a data patch.
5. Any change to the policy version, the qualifying-day threshold, or the finance control matrix **resets the streak** — a policy edit is never applied retroactively to already-counted days.
6. **90 consecutive qualifying closed days** moves the finance control tier from `conservative` to `eligible`. A separately, explicitly approved **active** matrix version is required to move `eligible` to `risk_tiered`; reaching 90 days alone never auto-activates the risk-tiered matrix.
7. `required_consecutive_days = 90` is a **versioned policy configuration value**, not a hardcoded constant; changing it requires a new policy version and resets the streak per rule 5.

### Required tests

- 89/90/91 consecutive passing-day boundary: day 89 stays `conservative`; day 90 makes the workspace `eligible` (not yet `risk_tiered`); day 91 remains `eligible` without further state change.
- Fail/missing/late/backfilled-day discontinuity: each of the four conditions independently resets an in-progress streak to zero, including a streak that was already at 89.
- Timezone boundary: a metric landing exactly at the Asia/Seoul cutoff boundary is deterministically assigned to exactly one day, never double-counted or dropped.
- Policy-version reset: bumping the policy version or the finance control matrix version mid-streak resets the streak, even if the underlying data would otherwise still qualify.
- Streak-restoration guard: a historical correction to a previously non-qualifying day does not silently re-inflate a later streak count without a new controller-approved evaluation.

## 5. Protected finance actions requiring human approval

Regardless of conservative/eligible/risk-tiered tier, the following registered `ActionType`s are permanent, always-`REQUIRE_APPROVAL` actions and are never downgradable by tier activation (mirrors `PROTECTED_ACTION_TYPES` in `packages/policy-engine`):

| ActionType | Approval requirement |
|---|---|
| `LEDGER_POST` | Human pre-approval before any journal entry, including a close adjustment subtype, transitions to `POSTED`. |
| `INVOICE_ISSUE` | Human pre-approval before an invoice is issued or recorded as sent. |
| `PAYMENT_EXECUTE` | Human pre-approval before any payment instruction or payment record is created. |

Tax filing is outside MVP scope and has no registered ActionType. A future tax-filing capability must add a new explicit ActionType, default to `BLOCK` while unmapped, and receive permanent human-approval policy before implementation.

Risk-tier activation (§4 rule 6) may only change listed low-risk internal reversible actions (`FINANCE_DRAFT`, `FINANCE_VERIFY` under its checkpoint rule, evidence intake, arithmetic validation, and reconciliation proposal drafts). It can never alter the protected table above. A policy-engine change that downgrades any protected action below `REQUIRE_APPROVAL` is a defect, not a valid configuration.

## 6. Certified accounting review sign-off record

| Field | Reviewer name | Certification reference | Date |
|---|---|---|---|
| Governing standard | `BLOCKING — unset` | `BLOCKING — unset` | `BLOCKING — unset` |
| Chart of accounts | `BLOCKING — unset` | `BLOCKING — unset` | `BLOCKING — unset` |
| Day-close cutoff | `BLOCKING — unset` | `BLOCKING — unset` | `BLOCKING — unset` |
| Full pack (all §2 fields) | `BLOCKING — unset` | `BLOCKING — unset` | `BLOCKING — unset` |

This table must be fully populated — no row left `BLOCKING — unset` — before Step 1 finance schema work begins, per the Escalation/Risk Gate: "Before Step 1: ... Controller/CFO signs accounting pack (KR/KRW/Asia/Seoul + certified review)."
