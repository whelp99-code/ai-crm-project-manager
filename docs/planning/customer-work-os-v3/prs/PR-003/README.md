# PR-003 — Golden Flow walking skeleton

Risk: R3 / Execution: SEQUENTIAL / Related: REQ-COMPAT-001, REQ-ACT-001, REQ-GOLD-001, REQ-GOLD-002 / Predecessor: PR-002.

Outputs: domain v3 composition service, shared canonical transition guard, overview/action routes, app registration, Fastify-schema OpenAPI generation, and domain/API/OpenAPI integration tests.

Allowed: CREATE `packages/domain/src/customer-work-os-v3.ts`, `packages/domain/test/customer-work-os-v3.integration.test.ts`, `apps/api/src/customer-work-os-v3-overview.ts`, `apps/api/src/customer-work-os-v3-routes.ts`, `apps/api/test/customer-work-os-v3.integration.test.ts`; MODIFY `packages/domain/src/index.ts`, `packages/domain/src/customer-work-os.ts`, `apps/api/src/app-base.ts`, `apps/api/src/customer-work-os-routes-durable.ts`, `apps/api/src/openapi.ts`, `apps/api/test/openapi-contract.test.ts`.

Forbidden: v2 route files, canonical schema edits, generic string command switch, direct SQL in handlers.

Budget: modified 6, new 5, logical changes at most 500 lines, no migration.

Walking flow: canonical engagement+commitment → shared domain transition guard → atomic canonical snapshot/outbox → worker action projection → `GET /api/cwos/v3/overview` → complete/dismiss action; missing action blocks ACTIVE transition through both durable canonical and v3 routes.

Verify: domain test, API test, root check; exit 0.

DECOMPOSITION: PENDING — create SUB/DETAIL only after PR-002 reports final contract/repository signatures.

Dispatch:

```text
TASK: PR-003 — Implement the thinnest canonical engagement-to-v3-overview walking skeleton.
DELIVERABLE: bounded diff, RED/GREEN integration evidence, adjustment report.
SCOPE: use 06/08 contracts and this README; edit only listed files; preserve every v2 route; no handler SQL or new canonical aggregate.
VERIFY: pnpm --filter @ai-crm/domain test && pnpm --filter @ai-crm/api test && pnpm check → exit 0; OpenAPI test must contain overview, list, complete, dismiss, and engagement-transition schemas.
Report WORKING status; report BLOCKED if PR-002 signatures contradict the plan.
```
