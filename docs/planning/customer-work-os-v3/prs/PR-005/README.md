# PR-005 — Owner Action Hub

Risk: R2 / Execution: SEQUENTIAL after PR-004 / Related: REQ-GOLD-001, REQ-ACT-001.

Allowed: create `apps/web/app/v3/page.tsx`, `apps/web/app/v3/action-hub-client.tsx`, `apps/web/e2e/customer-work-os-v3.spec.ts`; modify `apps/web/app/page.tsx` only to add a v3 navigation link.

Output: Korean owner screen with TODAY/OVERDUE/WAITING_APPROVAL/RISK sections, evidence/source links, completion and owner-only dismissal interactions, and INITIAL/LOADING/SUCCESS/EMPTY/401/403/409/503/RETRYING states. Keyboard and landmark accessibility are required.

Forbidden: fabricated zero/READY state, client-side workspace override, embedding API secrets, modifying `/v2`.

Budget: modified 1, new 3, logical changes at most 500 lines, no migration.

Verify: web typecheck, production build, Playwright v3 spec, root check; exit 0.

DECOMPOSITION: PENDING — split after PR-004 publishes the final overview finance schema and error behavior.

Dispatch:

```text
TASK: PR-005 — Build the owner-facing v3 Action Hub and its fail-closed browser test.
DELIVERABLE: four-file bounded diff, build/Playwright evidence, accessibility and adjustment report.
SCOPE: use 08-API-CONTRACTS.md; listed files only; preserve /v2; never expose credentials or invent READY data.
VERIFY: pnpm --filter @ai-crm/web typecheck && pnpm --filter @ai-crm/web build && pnpm --filter @ai-crm/web test:e2e && pnpm check → exit 0.
Report WORKING/BLOCKED.
```
