# PR-007 — Cutover reconciliation and pilot operations

Risk: R3 / Execution: SEQUENTIAL / Related: REQ-CUT-001, REQ-GOLD-003, REQ-OPS-001 / Predecessor: PR-006.

Allowed: CREATE `apps/api/src/customer-work-os-v3-pilot.ts`, `apps/api/test/customer-work-os-v3-pilot.integration.test.ts`, `docs/customer-work-os/v3/cutover-runbook.md`; MODIFY v3 routes, v3 integration test, `apps/api/src/customer-work-os-notion.ts`, and OpenAPI contract test.

Output: start/complete pilot routes with typed V0..V9 results; immutable commit/evidence gate; canonical PLANNED→APPROVED→APPLIED import-plan integration; exact count/money/hash append-only reconciliation report row; and write-freeze/replay runbook. Source fixtures are synthetic; real customer pilot is MANUAL.

Forbidden: Notion/PostgreSQL dual-write, automatic cutover, secret/private source data in Git, PASS with missing evidence.

Budget: modified 4, new 3, logical changes at most 500 lines, no migration.

Verify: imports/API tests, explicit live-PG pilot test, web Golden Flow E2E, root check; exit 0.

DECOMPOSITION: PENDING — split after PR-006 publishes the final finance, UI, and approval evidence shapes.

Dispatch:

```text
TASK: PR-007 — Implement exact cutover reconciliation and controlled pilot evidence.
DELIVERABLE: seven-file bounded diff over apps/api/src/customer-work-os-v3-pilot.ts, apps/api/test/customer-work-os-v3-pilot.integration.test.ts, docs/customer-work-os/v3/cutover-runbook.md, apps/api/src/customer-work-os-v3-routes.ts, apps/api/test/customer-work-os-v3.integration.test.ts, apps/api/src/customer-work-os-notion.ts, and apps/api/test/openapi-contract.test.ts; live-PG/E2E evidence; runbook; adjustment report.
SCOPE: use REQ-CUT-001/REQ-OPS-001 and validation matrix; only those seven files; synthetic data only; no automatic cutover or PASS on missing evidence.
VERIFY: pnpm --filter @ai-crm/imports test && pnpm --filter @ai-crm/api test && pnpm --filter @ai-crm/web test:e2e && pnpm check → exit 0; live-PG evidence required.
Report WORKING/BLOCKED.
```
