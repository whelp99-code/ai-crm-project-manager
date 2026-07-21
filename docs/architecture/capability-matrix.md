# Capability Matrix — CRM / Accounting / Banking Sources of Truth

- **Status:** Source choices user-confirmed (2026-07-15); accountable-owner operational sign-off remains blocking below. See ADR-001 §3 and `docs/adr/001-stack-and-boundaries.md`.
- **Owner/sign-off:** Product Owner (CRM row), Controller/CFO Owner (Accounting, Banking rows). Capability matrix owner signs this document and records review date before Step 1 schema work begins. Review date recorded below must be filled in as part of that sign-off — it is a blocking field, not a default.
- **Scope rule:** any later external CRM/accounting/bank/payment connector capability is a **new `ActionType` + registry entry + ADR**, never an adapter swap inside the rows below.

## Formal sign-off record

| Domain | Accountable owner | Review date | Signature/reference |
|---|---|---|---|
| CRM | Product Owner | `BLOCKING — unset` | `BLOCKING — unset` |
| Accounting | Controller/CFO Owner | `BLOCKING — unset` | `BLOCKING — unset` |
| Banking | Controller/CFO Owner | `BLOCKING — unset` | `BLOCKING — unset` |

The document is decision-complete but operational sign-off remains blocked until every field above is populated. “Signed” in the status means the user approved the source choices; it does not impersonate the accountable owners’ implementation sign-off.

## MVP decision summary

| Domain | MVP source of truth | Read/write scope | Freshness / idempotency | Owner / date / sign-off |
|---|---|---|---|---|
| CRM | **Native CRM** (`customers`, `customer_contracts`, `communications`, `delivery_projects`) | Native API/UI writes. Initial data load is **versioned CSV import only**. No external CRM connector, read or write. | Command idempotency key on every native write; import file SHA-256 digest + immutable, monotonic import version; query projections are transactional/current-as-of. | Product Owner; user-confirmed 2026-07-15; formal sign-off recorded in this document before Step 1. |
| Accounting | **Native double-entry ledger** (`journal_entries`/`journal_lines`) | Native evidence upload + versioned CSV/evidence import; draft → verify → post workflow. No external accounting connector. | Evidence object-version/digest; import version + source row key; ledger-posting intent idempotency key. | Controller/CFO Owner; user-confirmed 2026-07-15; finance sign-off before Step 1. |
| Banking | **OFX/CSV statement import** | Statement import only. No live bank API/read connector, no payment write connector. | Immutable file digest/version; account-period-statement identity + row fingerprint dedupe; freshness = `as_of` of the last successfully imported statement. | Controller/CFO Owner; user-confirmed 2026-07-15; finance sign-off before Step 1. |

External rows in every domain are **provenance evidence** captured through import, never an external system of authority. No production remote read or write occurs against CRM, accounting, or banking providers in the MVP.

## Field-by-field matrix

For every domain, the columns below are required by Step 0 acceptance. Rows marked `N/A — connector disabled` are explicit, not omitted: a blank cell would be ambiguous between "not evaluated" and "not applicable," so every disabled-connector field is written out.

| Field | CRM (native + CSV import) | Accounting (native ledger + CSV/evidence import) | Banking (OFX/CSV import) |
|---|---|---|---|
| Authentication | N/A — connector disabled (native writes use platform OIDC/API auth, not a supplier credential) | N/A — connector disabled | N/A — connector disabled |
| Tenant/account identity | Single workspace id (`workspaces.id`); no external tenant mapping | Single workspace id; ledger has no external company id | Bank account identity is an internal reference field set on import, not a live account binding |
| Customer/contract/communication fields | `customers`, `customer_contracts` (external/reference contract id, scope snapshot, effective dates, value), append-only `communications` | N/A (not a CRM field set) | N/A |
| Ledger / AR / AP / cash / reconciliation source | N/A (native is the source) | Native `journal_entries`/`journal_lines` is the sole ledger source; AR/AP/cash are evidence-linked projections over it | `statement_imports`/`statement_rows` feed `reconciliations` against the native ledger; the bank statement itself is the cash-side evidence source |
| Freshness / rate limits | Query projections are transactional/current-as-of; no external rate limit applies | Draft/verify/post has no external latency; freshness = evidence/import timestamp | Freshness = `as_of` of last **successfully imported and validated** statement; no polling interval because there is no live connection |
| Sandbox | N/A — connector disabled (no external sandbox exists to configure) | N/A — connector disabled | N/A — connector disabled |
| Webhook signature | N/A — connector disabled | N/A — connector disabled | N/A — connector disabled |
| Export / retention | Import files retained per accounting evidence retention (`docs/finance/accounting-standard-pack.md`) with SHA-256 digest; native export is a query, not a connector feature | Evidence objects are versioned/WORM where supported; retention window fixed in the accounting pack | Statement files retained under the same evidence retention window; row-level fingerprint retained for dedupe audit |
| Inbound / outbound idempotency | Inbound: import file digest + row fingerprint dedupe. Outbound: N/A (no outbound calls) | Inbound: import file digest + source row key. Outbound: ledger-posting intent idempotency key (`execution_intents.idempotency_key`) | Inbound: file digest + account-period-statement identity + row fingerprint. Outbound: N/A |
| Remote id / reference | Optional free-text external reference field on `customer_contracts`, never resolved against a live system | Optional free-text external reference on evidence rows | N/A — connector disabled (no remote id resolution) |
| Rate / error semantics | Native API standard error envelope; import errors are retained on `import_rows.error_reason` with the row status | Same import error handling; posting errors are policy `DENY`/`BLOCK` results, never silent | Import parse/validation errors are retained on `import_rows.error_reason`; malformed OFX/CSV rows are quarantined, not partially imported |
| Write capability | Native write only, always through the registry/policy gateway | Native write only (draft/verify/post), always through the registry/policy gateway | Import-only; no write capability of any kind against a bank |
| Audit evidence | Every native write and import batch is registry-mapped and audited (`audit_events`, `import_batches`, `import_rows`) | Every evidence upload, import, draft, verify and post is audited; postings are append-only/reversal-only | Every statement import and reconciliation action is audited |
| Data residency / DPA | N/A — connector disabled (no data leaves the workspace's own database/object store to a CRM supplier) | N/A — connector disabled | N/A — connector disabled |
| Kill switch | N/A — connector disabled (there is no live connection to kill; disabling import is an operational config change, not a kill switch) | N/A — connector disabled | N/A — connector disabled |

## Import operations model

| Property | Rule |
|---|---|
| Import formats | CRM: versioned CSV (schema version pinned per `import_batches.source_kind = 'CRM'`). Accounting: versioned CSV + evidence object upload. Banking: OFX or CSV statement files. |
| Import operator role | A distinct import-operator principal invokes the explicit `CRM_IMPORT`, `ACCOUNTING_IMPORT`, or `BANK_STATEMENT_IMPORT` registry action. The import operator is never the same principal as the ledger verifier/CFO approver on the same batch; SoD applies to import-driven postings exactly as it does to manual ones. |
| Validation / quarantine | Every row is parsed against the pinned schema version before acceptance. A row that fails schema, type, or referential validation is written to `import_rows` with `status = 'QUARANTINED'` and a non-empty `error_reason`; quarantined rows never post to the ledger or create/mutate a CRM record. A batch is `COMPLETED` only when every non-quarantined row has been processed; quarantined rows require an explicit human-reviewed re-import, not silent auto-correction. |
| Retention | Import files and evidence objects are retained for the accounting pack's evidence retention window (see `docs/finance/accounting-standard-pack.md`); retention is enforced by object-store lifecycle policy, never by deleting `import_batches`/`import_rows` rows themselves (those are audit history). |
| Source row identity | CRM/accounting: `(import_batch_id, row_fingerprint)` unique constraint. Banking: `(account, statement_period, row_fingerprint)` identity prevents re-importing the same statement row under a different file digest. |
| Source coverage | CRM/accounting native writes cover 100% of MVP scope; CSV import covers historical/bulk onboarding only. Banking coverage is exactly the set of successfully imported statements — there is no live fallback, so any period without an imported statement is explicitly "no data," never silently treated as zero-balance. |
| Stale-data banner | Any UI/report surface showing bank-derived cash position must display the `as_of` date of the last successfully imported statement; a business day that has passed without a new import is a stale-data condition the UI must surface, not hide. |

## Test obligations (Step 0 acceptance closure)

1. Import validation/quarantine round-trip: malformed row → `import_rows.status = 'QUARANTINED'` with non-empty `error_reason`; well-formed row → `VALID` → posts/creates record; batch cannot reach `COMPLETED` with unresolved non-quarantined rows.
2. Duplicate-import rejection: re-importing an identical file digest (CRM/accounting) or an identical statement row fingerprint (banking) is rejected as a duplicate, not silently re-applied.
3. Freshness invariant: banking `as_of` reflects the true last-imported statement date even across multiple accounts/periods; a report/projection must not claim fresher data than the last import.
4. Provenance invariant: every ledger posting and every CRM record sourced from import carries a traceable link back to its `import_batch_id`/`row_fingerprint`/evidence object version; deleting or losing that link is not permitted (append-only history).
5. SoD invariant: the import operator principal on a batch is distinct from the principal that verifies/approves any protected `LEDGER_POST` action resulting from that batch's data.
6. Negative-connector invariant: no runtime process can establish an outbound connection to a CRM/accounting/banking provider endpoint; this is asserted the same way as the ADR-001 connector-dispatcher confinement tests (dependency lint + runtime egress-denial test), proving the `N/A — connector disabled` fields above are structurally true, not merely documented.
