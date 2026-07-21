# Policy Matrix — Control Tiers and Finance Control Matrix

- **Status:** Accepted — reflects `packages/policy-engine/src/index.ts` (`POLICY_MATRIX`, `POLICY_VERSION`, `PROTECTED_ACTION_TYPES`) as implemented, plus the plan's finance control-tier design (`.gjc/_session-019f664d-ec44-7000-a908-b9002f1f9769/plans/ralplan/019f664d-ec44-7000-a908-b9002f1f9769/pending-approval.md` §"Finance Control Matrix and Daily Gate").
- **Implementation note:** only the **conservative** tier is implemented today. `packages/policy-engine`'s `POLICY_MATRIX` is a single, fixed mapping from `ActionType` to control; it has no `eligible`/`risk_tiered` variant, no 90-day streak counter, and no daily-gate qualifying-day evaluator in code yet. The "Eligible" / "Risk-tiered" columns below describe the **design** the plan commits to for a future policy-engine version bump, not a currently active runtime mode. Treat those columns as forward-looking documentation, not a description of current behavior.

## 1. Current control tiers (`POLICY_MATRIX`, `POLICY_VERSION = 1`)

`evaluatePolicy` resolves every registered `ActionType` to exactly one of three required controls; there is no partial/conditional resolution inside `packages/policy-engine` — the same `ActionType` always maps to the same control at a given `POLICY_VERSION`. An unmapped `ActionType` is a TypeScript compile error (`POLICY_MATRIX` is `satisfies Record<ActionType, PolicyMatrixEntry>`), not a runtime `BLOCK` fallback — the type system prevents an incomplete matrix from being expressed at all pre-registry.

| Control | ActionType | Reason (verbatim from `POLICY_MATRIX`) |
|---|---|---|
| `allow` | `INTERNAL_REVERSIBLE_UPDATE` | Internal update is reversible and workspace-scoped; no external effect. |
| `allow` | `MODEL_INVOKE` | Model invocation alone has no external side effect. |
| `allow` | `PM_PLAN_CREATE` | Creating a draft plan is reversible and has no external commitment yet. |
| `allow` | `FINANCE_DRAFT` | Drafting a financial figure is reversible and not yet asserted as verified. |
| `checkpoint` | `PM_PLAN_REVISE` | Revising an existing plan changes prior commitments; requires a checkpoint. |
| `checkpoint` | `PM_TASK_ASSIGN` | Assigning a task commits a team member's time; requires a checkpoint. |
| `checkpoint` | `PM_TARGET_SET` | Setting a target establishes a tracked commitment; requires a checkpoint. |
| `checkpoint` | `CRM_IMPORT` | CRM imports can create many internal records and require an operator checkpoint. |
| `checkpoint` | `ACCOUNTING_IMPORT` | Accounting imports affect draft financial records and require an operator checkpoint. |
| `checkpoint` | `BANK_STATEMENT_IMPORT` | Bank statement imports affect reconciliation inputs and require an operator checkpoint. |
| `checkpoint` | `FINANCE_VERIFY` | Verifying a financial figure asserts correctness downstream; requires a checkpoint. |
| `approval` | `CUSTOMER_SEND` | Action is externally visible to a customer; always requires human approval. |
| `approval` | `SCOPE_CHANGE` | Scope changes affect committed deliverables; always requires human approval. |
| `approval` | `SCHEDULE_CHANGE` | Schedule changes affect committed deliverables; always requires human approval. |
| `approval` | `CONTRACT_CHANGE` | Contract terms are legally binding; always requires human approval. |
| `approval` | `INVOICE_ISSUE` | Issuing an invoice creates a customer-facing financial obligation. |
| `approval` | `PAYMENT_EXECUTE` | Executing payment moves money; always requires human approval. |
| `approval` | `DELETE_RECORD` | Deletion is destructive and may be irreversible; always requires human approval. |
| `approval` | `PERMISSION_CHANGE` | Permission changes affect the security boundary; always requires human approval. |
| `approval` | `LEDGER_POST` | Posting to the ledger is a durable financial record; always requires human approval. |

`REQUIRED_CONTROLS` in code is `["ALLOW", "CHECKPOINT", "REQUIRE_APPROVAL", "BLOCK"]`; `BLOCK` is reserved for an unmapped/unregistered action type at the `ActionRegistry` layer (a command string that does not resolve to any known `ActionType`), never for a mapped `ActionType` in `POLICY_MATRIX` — every mapped type resolves to one of the other three tiers.

## 2. Permanent-approval (protected) actions

`PROTECTED_ACTION_TYPES` is computed directly from `POLICY_MATRIX` (`ACTION_TYPES.filter(type => POLICY_MATRIX[type].control === "REQUIRE_APPROVAL")`) — it is not a separately hand-maintained list, so it cannot drift from the matrix above. As implemented, the protected set is:

`CUSTOMER_SEND`, `SCOPE_CHANGE`, `SCHEDULE_CHANGE`, `CONTRACT_CHANGE`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE`, `DELETE_RECORD`, `PERMISSION_CHANGE`, `LEDGER_POST`.

This matches the accounting-standard-pack's (`docs/finance/accounting-standard-pack.md` §5) explicit "permanent, always-`REQUIRE_APPROVAL`, never downgradable by tier activation" finance list (`LEDGER_POST`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE`), extended in code to the full non-finance protected set above. A policy-engine change that would downgrade any of these below `approval` is a defect, not a valid configuration change — enforced today only by code review and the type-level `satisfies` constraint, since there is no automated CI assertion of this invariant yet beyond the unit tests in `packages/policy-engine/test`.

## 3. Finance control matrix (plan design; only the conservative row is implemented)

The plan's finance control matrix is a three-tier design keyed by a workspace's 90-consecutive-qualifying-day streak (`docs/finance/accounting-standard-pack.md` §4). **`conservative` is the only tier implemented**; the matrix below documents `eligible`/`risk_tiered` as the target design for a future `POLICY_VERSION` bump, gated on Controller/CFO sign-off per the plan's Escalation/Risk Gate ("Before Step 6 risk-tier activation: Controller/CFO signs daily metrics, streak results and versioned matrix activation").

| Action class | Conservative (implemented) | Eligible (design, not implemented) | Risk-tiered (design, not implemented) | Always true |
|---|---|---|---|---|
| Evidence intake, journal draft (`FINANCE_DRAFT`), arithmetic validation | `allow` only for low-risk; uncertain/medium routes to checkpoint | same | same low-risk `allow` | Evidence/audit/SoD invariants always apply. |
| Reconciliation proposal, cash/profitability refresh | `checkpoint` | listed low-risk internal `allow` | listed low-risk internal `allow` | A variance always opens a `finance_exceptions` row; never silently absorbed. |
| Journal verification / close-preparation draft (`FINANCE_VERIFY`) | `approval` | `checkpoint` for listed low-risk internal draft/verification | `allow` only for listed low-risk reversible preparation | Creator/verifier/CFO separation of duty always applies (three pairwise-distinct principals). |
| Journal post (`LEDGER_POST`), close adjustment, invoice (`INVOICE_ISSUE`), payment (`PAYMENT_EXECUTE`), tax filing, external write | `approval` | `approval` | `approval` | **Permanent human pre-approval regardless of tier** — this row never changes, matching `PROTECTED_ACTION_TYPES` above. |

Tier-transition rules (design, from the accounting-standard-pack and plan):
- A day **qualifies** only when every expected import batch for the day reached `COMPLETED`, every posted journal entry balances, and no unresolved `finance_exceptions` remain open as of the Asia/Seoul day-close cutoff (accounting-standard-pack §2, `BLOCKING — unset` until certified review; this cutoff value cannot be guessed and blocks daily-gate schema work).
- Failed, missing, late, or backfilled days are non-qualifying and reset the streak to zero; a later correction can create an auditable historical record but never retroactively restores an already-reset streak.
- 90 consecutive qualifying closed days moves `conservative → eligible`; a separately, explicitly Controller/CFO-approved active matrix version is required to move `eligible → risk_tiered` — reaching 90 days alone never auto-activates the risk-tiered matrix.
- Any change to policy version, the qualifying-day threshold, or the finance control matrix itself resets the streak.
- Tax filing has **no registered `ActionType`** in `packages/contracts` today (out of MVP scope per the capability matrix); a future tax-filing capability must add a new explicit `ActionType`, default to `BLOCK` while unmapped, and receive permanent `approval` policy before implementation — it may not silently inherit any existing tier.

## 4. Canonicalization and hashing (enforcement mechanism, not a control tier)

`packages/policy-engine` binds every policy/control decision to a `canonicalHashOf(actionType, payload, schema)` — a schema-versioned (`CANONICALIZATION_SCHEMA_VERSION = 2`), deterministic SHA-256 hash over a canonicalized payload (sorted object keys, exponent-free decimal strings, explicit ISO-8601 UTC timestamps, deterministic set ordering). This hash is bound to the specific `actionType` string, so an identical payload under a different `ActionType` produces a different hash — a control/intent cannot be silently replayed against a different registered operation. `GovernanceAuthorizationService.consumeControl` re-checks `workspaceId`, `resourceId`, `resourceVersion`, `payloadHash`, and `policyVersion` against the approved control before allowing consumption (`STALE_CONTROL_BINDING` otherwise), so a payload, resource-version, or policy-version mutation after approval invalidates the control rather than silently applying stale intent.
