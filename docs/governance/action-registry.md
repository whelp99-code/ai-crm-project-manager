# Action Registry — Total Registered Operations

- **Status:** Accepted — reflects the operations actually registered in code as of this writing (`apps/api/src/app.ts` `GOVERNANCE_COMMANDS`, `packages/imports/src/index.ts` `IMPORT_ACTION_TYPES`, `packages/model-gateway/src/index.ts` `MODEL_GATEWAY_ACTION`), plus the disabled remote-connector boundary (`packages/connectors`, `@ai-crm/connectors`).
- **Source of truth for ActionTypes/control tiers:** `packages/contracts/src/index.ts` (`ACTION_TYPES`, `ActionTypeSchema`) and `packages/policy-engine/src/index.ts` (`POLICY_MATRIX`, `PROTECTED_ACTION_TYPES`). This document is a projection of those two files plus the import and model-gateway registries; if this table and the code ever disagree, the code wins and this file must be corrected, not the other way around.
- **Plan alignment:** the ralplan `pending-approval.md` §"Total Registry, Policy and Capability Confinement" describes a broader conceptual ActionType set (e.g. `JOURNAL_DRAFT`, `JOURNAL_POST`, `TAX_FILING`, `EXTERNAL_WRITE`). As implemented, those concepts map onto the narrower, concrete `ACTION_TYPES` enum below (`FINANCE_DRAFT`/`FINANCE_VERIFY`/`LEDGER_POST` cover the journal draft/verify/post lifecycle; `DELETE_RECORD` covers generic deletion; `PERMISSION_CHANGE` covers role/permission changes; there is no `TAX_FILING` or `EXTERNAL_WRITE` ActionType yet — both remain unmapped and therefore rejected as `BLOCK` per the capability matrix's explicit statement that tax filing is out of MVP scope).

Columns:
- **Surface** — where the operation is invoked from: `api` (Fastify HTTP command), `import` (versioned batch import), `model` (model-gateway inference call), `connector-disabled` (rejected-by-design remote effect boundary).
- **Command/operation id** — the registry key as it appears in code.
- **ActionType** — the `packages/contracts` `ActionType` the operation is bound to.
- **Effect** — `none` (no state change outside the gateway's own audit row), `internal-reversible` (workspace-scoped state change that can be corrected by a further internal action), `internal-irreversible` (workspace-scoped but not casually correctable, e.g. deletion, permanent financial posting), `remote-disabled` (would leave the transactional boundary; rejected unconditionally in MVP).
- **Control** — the control tier actually enforced today by `packages/policy-engine`'s `POLICY_MATRIX`: `allow`, `checkpoint`, `approval`.
- **Notes** — enforcement detail / caller-facing behavior.

## 1. API commands (`apps/api/src/app.ts` → `GOVERNANCE_COMMANDS`)

Every command below is dispatched through `POST /api/governance/authorize`, which resolves the command to its `ActionType` (`ActionRegistry.resolve`), evaluates `packages/policy-engine`, and — for `checkpoint`/`approval` tiers — creates a `ControlRequest` that must be independently decided (`/api/governance/controls/:id/decide`) and consumed (`/api/governance/controls/:id/consume`) before the resulting `ExecutionIntent` can be dereferenced by the protected HTTP route. Callers never choose the `ActionType` themselves; it is looked up server-side from the command string.

| Surface | Command | ActionType | Effect | Control | Notes |
|---|---|---|---|---|---|
| api | `customer.send` | `CUSTOMER_SEND` | internal-reversible (customer-visible communication record) | approval | Externally visible to a customer; `PROTECTED_ACTION_TYPES` — never downgradable. |
| api | `project.scope_change` | `SCOPE_CHANGE` | internal-irreversible (baseline commitment) | approval | Affects a committed deliverable baseline (`/api/projects/:id/baseline`). |
| api | `project.schedule_change` | `SCHEDULE_CHANGE` | internal-irreversible (baseline commitment) | approval | Same baseline-protection path as `SCOPE_CHANGE`. |
| api | `contract.change` | `CONTRACT_CHANGE` | internal-irreversible (legal terms) | approval | Contract terms are legally binding. |
| api | `finance.invoice_issue` | `INVOICE_ISSUE` | internal-irreversible (customer-facing financial obligation) | approval | Permanent-approval finance action (accounting-standard-pack §5). |
| api | `finance.payment_execute` | `PAYMENT_EXECUTE` | internal-irreversible (moves money) | approval | Permanent-approval finance action. |
| api | `finance.ledger_post` | `LEDGER_POST` | internal-irreversible (durable ledger posting) | approval | Permanent-approval finance action; posted `journal_entries`/`journal_lines` are never updated/deleted (append-only/reversal-only per accounting-standard-pack §3). |
| api | `record.delete` | `DELETE_RECORD` | internal-irreversible | approval | Deletion may be irreversible; always requires human approval. |
| api | `permission.change` | `PERMISSION_CHANGE` | internal-irreversible (security boundary) | approval | Affects the security boundary. |
| api | `pm.plan_revise` | `PM_PLAN_REVISE` | internal-reversible | checkpoint | Revising a prior plan commitment; operator checkpoint (not full approval) unless it touches a protected baseline, in which case the baseline route separately requires `SCOPE_CHANGE`/`SCHEDULE_CHANGE` approval. |
| api | `pm.task_assign` | `PM_TASK_ASSIGN` | internal-reversible | checkpoint | Commits a team member's time. |
| api | `pm.target_set` | `PM_TARGET_SET` | internal-reversible | checkpoint | Establishes a tracked commitment/target. |
| api | `pm.plan_create` | `PM_PLAN_CREATE` | internal-reversible | allow | Draft plan creation; reversible, no external commitment yet. Also used by `packages/domain`'s `PM_COMMAND_ACTIONS.createPlan` and the S0 natural-command map. |
| api | `finance.verify` | `FINANCE_VERIFY` | internal-reversible | checkpoint | Asserts correctness of a drafted financial figure downstream of a `FINANCE_DRAFT`. |
| api | `internal.update` | `INTERNAL_REVERSIBLE_UPDATE` | internal-reversible | allow | No external effect; workspace-scoped and reversible. |

Not yet exposed as an HTTP `GOVERNANCE_COMMANDS` entry (registered as `ActionType`s but only reachable via other surfaces or not yet wired to a command):
- `FINANCE_DRAFT` — `allow` tier (drafting a financial figure, reversible, not yet asserted as verified); precedes `FINANCE_VERIFY`.
- `CRM_IMPORT`, `ACCOUNTING_IMPORT`, `BANK_STATEMENT_IMPORT` — see §2, import surface.
- `MODEL_INVOKE` — see §3, model surface.

## 2. Import batches (`packages/imports/src/index.ts` → `IMPORT_ACTION_TYPES`)

Every `ImportService.submitBatch` call maps its `ImportSourceKind` to an `ActionType`; callers never choose it.

| Surface | Operation | ActionType | Effect | Control | Notes |
|---|---|---|---|---|---|
| import | `CRM` batch (`IMPORT_ACTION_TYPES.CRM`) | `CRM_IMPORT` | internal-reversible | checkpoint | Versioned CSV import (`IMPORT_SCHEMAS.CRM`, schema version 1: `customer_id`, `name`, `status`, `created_at`); can create many internal records; requires an operator checkpoint. Rows fail schema/type/referential validation are quarantined (`import_rows.status = 'QUARANTINED'`), never posted/applied. |
| import | `LEDGER` batch (`IMPORT_ACTION_TYPES.LEDGER`) | `ACCOUNTING_IMPORT` | internal-reversible | checkpoint | Versioned CSV/evidence import (`IMPORT_SCHEMAS.LEDGER`, schema version 1: `entry_id`, `entry_date`, `account_code`, `debit_krw`, `credit_krw`, `description`, `evidence_ref`); affects draft financial records, not posted ones. |
| import | `BANK_STATEMENT` batch (`IMPORT_ACTION_TYPES.BANK_STATEMENT`) | `BANK_STATEMENT_IMPORT` | internal-reversible | checkpoint | OFX/CSV statement import (`IMPORT_SCHEMAS.BANK_STATEMENT`, schema version 1: `account`, `statement_period`, `posted_at`, `amount_krw`, `balance_krw`, `description`); feeds reconciliation, no live bank connection. |

Import batches never write to the ledger's `POSTED` state directly: `ACCOUNTING_IMPORT`/`BANK_STATEMENT_IMPORT` create draft/reconciliation-input rows only, and the separate `LEDGER_POST` action (§1, `approval` tier) remains the sole path to a posted journal entry.

## 3. Model gateway (`packages/model-gateway/src/index.ts`, `apps/api/src/app.ts` `/api/model/invoke`)

| Surface | Operation | ActionType | Effect | Control | Notes |
|---|---|---|---|---|---|
| model | `POST /api/model/invoke` (`ModelGateway.invoke`) | `MODEL_INVOKE` | none | allow | The single allowlisted non-effect LLM inference path (`packages/model-gateway`). `MODEL_GATEWAY_ACTION` is a fixed constant, not caller-selected; `OperationResolver` must resolve every operation id to `MODEL_INVOKE` or the gateway rejects it (`NON_MODEL_OPERATION`). Requires the dedicated gateway service principal (`PRINCIPAL_DENIED` otherwise); redacts the prompt before egress (`defaultRedactor` scrubs emails, long digit runs, KR RRNs); validates structured output against an explicit `OutputFieldSchema` before it can re-enter orchestration (`SCHEMA_VIOLATION` otherwise); discards free-text provider output — it can never become a command. The gateway holds no effect capability: no intent lease/dispatch, no connector import, no effect-table grants beyond its own `model_invocations` audit rows. **Fail-closed:** `apps/api` only constructs the gateway when a `ModelClient` is injected; absent that, `/api/model/invoke` returns HTTP `503` (`MODEL_GATEWAY_UNSET`) rather than any default/mock inference. |

## 4. Disabled connector boundary (`packages/connectors` / `@ai-crm/connectors`)

**Every remote-effect operation is rejected in MVP.** There is no live external CRM, accounting, banking, or payment connector, and no `ActionType`/operation id is allowlisted for remote dispatch.

| Surface | Operation | ActionType | Effect | Control | Notes |
|---|---|---|---|---|---|
| connector-disabled | `ConnectorDispatcher.dispatch(entry: RemoteRegistryEntry)` — any `{ operationId, actionType, effect: "remote" }` | *(any `ActionType` from `packages/contracts`; none is pre-registered as remote)* | remote-disabled | — (unconditional rejection; no policy evaluation needed) | Always throws `ConnectorDomainError` with code `CONNECTOR_DISABLED`, citing ADR-008 and the required connector-enablement follow-ups (new ADR, provider outcome-query capability, `DISPATCHING`-deadline-scan/crash→`UNKNOWN` reconciliation ownership — see `docs/adr/010-model-gateway.md` and ADR-008/009). No specific operation id is exempt: any entry constructed with any `ActionType` is rejected uniformly, because MVP allowlists nothing for remote effect. |
| connector-disabled | capability flags (`CONNECTOR_CAPABILITY`) | n/a | remote-disabled | — | Frozen constant `{ remoteWrite: false, providerCredential: false, egress: "none" }`; `assertNoConnectorCapability()` throws `CONNECTOR_CAPABILITY_ENABLED` if any flag is ever flipped truthy, giving a structural (not just documented) assertion that the boundary is closed. |

This mirrors `docs/architecture/capability-matrix.md`'s field-by-field `N/A — connector disabled` rows for CRM, Accounting, and Banking: authentication, sandbox, webhook signature, remote id resolution, data residency/DPA, and kill switch are all explicitly not applicable because no remote connection exists to configure, sign, or kill.

## 5. Every registered ActionType, cross-referenced

Every member of `packages/contracts`' `ACTION_TYPES` appears in this document:

`INTERNAL_REVERSIBLE_UPDATE` (§1), `CUSTOMER_SEND` (§1), `SCOPE_CHANGE` (§1), `SCHEDULE_CHANGE` (§1), `CONTRACT_CHANGE` (§1), `INVOICE_ISSUE` (§1), `PAYMENT_EXECUTE` (§1), `DELETE_RECORD` (§1), `PERMISSION_CHANGE` (§1), `MODEL_INVOKE` (§3), `PM_PLAN_CREATE` (§1), `PM_PLAN_REVISE` (§1), `PM_TASK_ASSIGN` (§1), `PM_TARGET_SET` (§1), `CRM_IMPORT` (§2), `ACCOUNTING_IMPORT` (§2), `BANK_STATEMENT_IMPORT` (§2), `FINANCE_DRAFT` (§1, not-yet-commanded note), `FINANCE_VERIFY` (§1), `LEDGER_POST` (§1).

Any `ActionType` not listed above does not exist in `packages/contracts` as of this writing; a future addition must update `ACTION_TYPES`, `POLICY_MATRIX`, and this document together, or CI/startup enumeration will fail (unmapped registry entries resolve to `BLOCK` at runtime, never a silent default).
