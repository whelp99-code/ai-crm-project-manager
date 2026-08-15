# PR-004 — Finance and settlement visibility

Risk: R3 / Execution: SEQUENTIAL after PR-003 / Related: REQ-FIN-001.

Allowed: CREATE `apps/api/src/customer-work-os-v3-finance.ts`, `apps/api/test/customer-work-os-v3-finance.integration.test.ts`, `apps/worker/src/cwos-v3-projector.ts`, `apps/worker/test/cwos-v3-projector.live-pg.integration.test.ts`; MODIFY `apps/api/src/customer-work-os-v3-overview.ts`, `apps/api/src/customer-work-os-v3-routes.ts`, `apps/api/test/customer-work-os-v3.integration.test.ts`, `apps/api/test/openapi-contract.test.ts`, `apps/api/src/customer-work-os-runtime.ts`, `apps/api/src/customer-work-os-routes-durable.ts`, `apps/worker/src/main.ts`, `apps/worker/package.json`, `pnpm-lock.yaml`.

Output: exact receivable, payable, margin, settlement, and 30-day risk summary using existing finance/CWOS services. Overview is pure read. Durable financial/settlement routes pass typed events into runtime mutation; PostgreSQL compare-and-swap inserts them with snapshot/audit in one transaction; the worker claims them and opens one remediation action for ambiguous linkage.

Forbidden: floating-point money, statutory ledger redesign, route-handler SQL, a second non-atomic producer insert, governance-outbox payload assumptions, v1/v2 finance response changes.

Budget: modified 9, new 4, logical changes at most 500 lines, no migration.

Verify: `pnpm --filter @ai-crm/finance test && pnpm --filter @ai-crm/worker test && pnpm --filter @ai-crm/api test && pnpm check`; exit 0. Live PG evidence must prove both a linked settlement mapping and a null-engagement financial item using `account:{accountId}` flow producer→outbox→worker→one action, with replay producing no duplicate.

DECOMPOSITION: PENDING — split after PR-003 fixes overview extension points.

Dispatch:

```text
TASK: PR-004 — Add exact engagement finance, runtime outbox projection, and cash-risk visibility to v3.
DELIVERABLE: thirteen-file bounded diff over the exact allowed list, exact-money and live producer-to-worker-to-action output, adjustment report.
SCOPE: use REQ-FIN-001 and 07-DATA-CONTRACTS.md; allowed files are apps/api/src/customer-work-os-v3-finance.ts, apps/api/test/customer-work-os-v3-finance.integration.test.ts, apps/worker/src/cwos-v3-projector.ts, apps/worker/test/cwos-v3-projector.live-pg.integration.test.ts, apps/api/src/customer-work-os-v3-overview.ts, apps/api/src/customer-work-os-v3-routes.ts, apps/api/test/customer-work-os-v3.integration.test.ts, apps/api/test/openapi-contract.test.ts, apps/api/src/customer-work-os-runtime.ts, apps/api/src/customer-work-os-routes-durable.ts, apps/worker/src/main.ts, apps/worker/package.json, pnpm-lock.yaml; reuse finance services; no float, handler SQL, or non-atomic producer.
VERIFY: pnpm --filter @ai-crm/finance test && pnpm --filter @ai-crm/worker test && pnpm --filter @ai-crm/api test && pnpm check → exit 0; live PG linked-settlement and null-engagement account-partition producer-to-action evidence required.
Report WORKING/BLOCKED.
```
