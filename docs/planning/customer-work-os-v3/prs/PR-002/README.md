# PR-002 — v3 contracts and PostgreSQL operations

Risk: R3 / Execution: SEQUENTIAL / Related: REQ-ACT-001, REQ-OPS-001 / Predecessor: PR-001 / Successor: PR-003.

Outputs: create typed v3 contracts, migration 0020, repository, and RLS/security tests; modify only contracts and persistence export barrels.

Allowed files: `packages/contracts/src/customer-work-os-v3.ts` CREATE, `packages/contracts/src/index.ts` MODIFY, `packages/persistence/migrations/0020_customer_work_os_v3_operations.sql` CREATE, `packages/persistence/src/cwos-v3-repository.ts` CREATE, `packages/persistence/src/index.ts` MODIFY, `packages/persistence/test/customer-work-os-v3-repository.security.test.ts` CREATE.

Forbidden: canonical CWOS table changes, v2 snapshot migration edits, handler SQL, migration down/drop logic.

Budget: modified 2, new 4, logical changes at most 500 lines, one migration.

Verify: `pnpm --filter @ai-crm/contracts typecheck && pnpm --filter @ai-crm/persistence typecheck && pnpm --filter @ai-crm/persistence test && pnpm check`; exit 0. PostgreSQL RLS/live behavior also runs in the PR evidence environment.

Dispatch:

```text
TASK: PR-002 — Implement typed v3 action/pilot contracts and their PostgreSQL 16 repository.
DELIVERABLE: six-file bounded diff; migration/RLS test output; adjustments report.
SCOPE: read 07-DATA-CONTRACTS.md and PR-002 SUB files; modify only the six listed files; preserve canonical tables and v2 migrations; no handler SQL or test weakening.
VERIFY: pnpm --filter @ai-crm/contracts typecheck && pnpm --filter @ai-crm/persistence typecheck && pnpm --filter @ai-crm/persistence test && pnpm check → exit 0; live PG RLS evidence required before merge.
Report WORKING status; report BLOCKED on a data-contract contradiction.
```
