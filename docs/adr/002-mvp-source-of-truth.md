# ADR-002 — MVP Source of Truth: Native CRM + Native Double-Entry Ledger + OFX/CSV Bank Import

- **Status:** Accepted — 2026-07-15 (ralplan Architect pass 4 CLEAR/APPROVE, Critic pass 4 OKAY, user post-ralplan confirmation 2026-07-15; execution authorized for goal G001).
- **Deciders:** Product Owner (CRM source-of-truth row); Controller/CFO Owner (Accounting, Banking rows); Architecture Owner (registry/policy implications, DR-02).
- **Source of truth:** `.gjc/_session-019f664d-ec44-7000-a908-b9002f1f9769/plans/ralplan/019f664d-ec44-7000-a908-b9002f1f9769/pending-approval.md` §ADR-002 and the "Total Registry" section; the full field-by-field matrix is recorded durably in `docs/architecture/capability-matrix.md`, which this ADR does not duplicate.

## Decision

CRM data lives in the application's own native CRM (`customers`, `customer_contracts`, `communications`, `delivery_projects`), with an initial data load via versioned CSV import only. Accounting lives in the application's own native double-entry ledger (`journal_entries`/`journal_lines`) with CSV/evidence import and a draft → verify → post workflow. Banking uses OFX/CSV statement import only. External CRM, external accounting, and any live/real-time bank or payment connector are excluded from the MVP.

Every import path is registry-mapped: `CRM_IMPORT`, `ACCOUNTING_IMPORT`, `BANK_STATEMENT_IMPORT` (`packages/imports/src/index.ts` `IMPORT_ACTION_TYPES`), all at `checkpoint` control tier (`packages/policy-engine`). No import path bypasses the registry/policy gateway.

### Drivers

1. Conservative single-company scope — a full external-connector integration surface is not required to deliver a usable CRM + delivery + finance MVP.
2. No production remote write in MVP — this keeps the disabled-connector boundary (`packages/connectors`, ADR-001 §2) trivially true rather than merely configured-off.
3. Audit/evidence integrity must be provable inside one transactional boundary (single PostgreSQL database) before any cross-system reconciliation problem is introduced.

### Alternatives considered

| Option | Benefit | Cost/risk | Decision |
|---|---|---|---|
| Bidirectional external CRM connector (hosted CRM SaaS) | avoids re-implementing CRM UX | introduces a live remote-write path before the connector-confinement/reconciliation design (ADR-008/009 follow-up) is closed; weakens conservative scope | not selected |
| External accounting SaaS integration | avoids re-implementing ledger UX | same remote-write/reconciliation risk; also collides with the certified-accounting-review gate in `docs/finance/accounting-standard-pack.md` | not selected |
| Live bank API/read connector and payment write connector | real-time cash visibility, could eventually support automated payment | payment write connector is exactly the kind of remote effect ADR-001's confinement boundary is designed to keep disabled in MVP; live read connector adds an unaudited freshness/availability dependency | not selected |
| **Native CRM + native ledger + OFX/CSV import (selected)** | keeps 100% of MVP writes inside the transactional/audit boundary; import is checkpoint-controlled, quarantines invalid rows, and is fully auditable | historical/bulk onboarding is import-only, not live-synced; a future external connector requires a new ADR revision, not a silent adapter swap | **Selected**, user-confirmed |

### Consequences

- Every native write and import batch is registry-mapped and audited (`audit_events`, `import_batches`, `import_rows`); there is no code path that writes CRM/ledger/bank data outside the registry.
- Import rows that fail schema, type, or referential validation are quarantined (`import_rows.status = 'QUARANTINED'` with a non-empty `error_reason`); a batch reaches `COMPLETED` only when every non-quarantined row has been processed. Quarantined rows never post to the ledger or create/mutate a CRM record.
- A future external CRM/accounting/bank/payment connector capability is **a new `ActionType` + registry entry + ADR**, never an adapter swap inside the existing rows (`docs/architecture/capability-matrix.md` "Scope rule"). This ADR does not authorize any such connector with a live credential.
- `docs/architecture/capability-matrix.md`'s formal sign-off record (Product Owner for CRM; Controller/CFO Owner for Accounting and Banking) remains `BLOCKING — unset` for the accountable-owner operational review date/signature as of this writing; the *source-choice* decision itself is user-confirmed and closed, but Step 1 schema work is separately gated on that operational sign-off being recorded.

### Follow-ups

- Record the accountable-owner review date/signature in `docs/architecture/capability-matrix.md`'s formal sign-off record before Step 1 schema work proceeds on the strength of this ADR alone.
- Any later external CRM/accounting/bank/payment connector proposal must revise this ADR (and ADR-001 §2's connector-confinement boundary) rather than adding an ad hoc adapter.
