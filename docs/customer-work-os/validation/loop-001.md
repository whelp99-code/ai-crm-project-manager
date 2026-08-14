# CWOS Validation Loop 001

- Branch: `feat/customer-work-os-v1-full`
- Scope: CRM + CPQ + PSA + Project ERP + Project Accounting + AI Brain + Dynamic Graph
- Loop: BUILD → TYPECHECK → UNIT → INTEGRATION → ADVERSARIAL → FIX → REGRESSION

## Findings resolved

1. `exactOptionalPropertyTypes` violations in workflow and Notion import mapping.
2. Missing bounded procurement request-validation loop.
3. Missing delivery completion, asset quantity, settlement reversal-state, and engagement closure invariants.
4. Unused test-only graph type import.

## Current gate

Run Node 20/22 domain verification and full workspace regression at the current branch head. A release claim is forbidden while any required check is failing or unexecuted.
