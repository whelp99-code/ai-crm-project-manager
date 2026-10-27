# PR-006 — Evidence-bound AI proposal and human approval

Risk: R3 / Execution: SEQUENTIAL after PR-005 / Related: REQ-AI-001, REQ-APP-001.

Allowed: CREATE `apps/api/src/customer-work-os-v3-proposals.ts`, `apps/api/test/customer-work-os-v3-proposals.security.test.ts`; MODIFY v3 routes, v3 integration test, and OpenAPI contract test after PR-005.

Output: typed proposal create/review routes backed by existing AI suggestion/governance services; canonical PROPOSED→REVIEWED→ACCEPTED|REJECTED states, evidence ownership, confidence, model/prompt/cost metadata, quarantine, human-only decision, and separately tested single-use control consume.

Forbidden: model provider import in domain, autonomous effect, AI self-review, approval bypass, raw provider content in error/evidence.

Budget: modified 3, new 2, logical changes at most 500 lines, no migration.

Verify: API, AI-orchestrator, governance, security, and root checks; exit 0.

DECOMPOSITION: PENDING — split after PR-005 fixes the owner interaction and approval-link contract.

Dispatch:

```text
TASK: PR-006 — Add evidence-bound AI proposals with human-only approval.
DELIVERABLE: five-file bounded diff over apps/api/src/customer-work-os-v3-proposals.ts, apps/api/test/customer-work-os-v3-proposals.security.test.ts, apps/api/src/customer-work-os-v3-routes.ts, apps/api/test/customer-work-os-v3.integration.test.ts, and apps/api/test/openapi-contract.test.ts; security output; adjustment report.
SCOPE: use REQ-AI-001/REQ-APP-001 and 10-SECURITY-MODEL.md; only those five files; no direct effect or provider SDK in domain.
VERIFY: pnpm --filter @ai-crm/api test && pnpm --filter @ai-crm/ai-orchestrator test && pnpm --filter @ai-crm/governance test && pnpm run test:security && pnpm check → exit 0.
Report WORKING/BLOCKED.
```
