# PR-008 — v3 release gate and candidate

Risk: R3 / Execution: EXCLUSIVE / Related: REQ-OPS-001 / Predecessor: PR-007.

Allowed: create `.github/workflows/customer-work-os-v3-release-gate.yml` and `docs/customer-work-os/releases/v3.0.0-release-candidate.md`; modify root `package.json` version and v3 Playwright spec after all predecessors.

Output: Node 20/22 check/build/security/integration with non-zero test counts, PG16 migrations/RLS/live/restore, web production E2E that drives the full inquiry→renewal flow, dependency audit, v2 compatibility, v3 pilot V0..V9 evidence, and final fail-closed aggregator. Set version `3.0.0` only on the immutable candidate commit.

Forbidden: claiming unobserved Actions PASS, production approval, merge, tag, release, or deploy.

Budget: modified 2, new 2, logical changes at most 450 lines, no migration.

Verify locally: `pnpm check && pnpm -r --if-present run build && pnpm run test:security && pnpm run test:integration && pnpm --filter @ai-crm/web test:e2e`; exit 0 with non-zero security/integration test counts. GitHub and MANUAL gates remain NOT_RUN/BLOCKED until separately authorized and observed.

DECOMPOSITION: PENDING — split after PR-007 publishes exact evidence commands and paths.

Dispatch:

```text
TASK: PR-008 — Assemble the fail-closed v3 release workflow and source candidate marker.
DELIVERABLE: four-file bounded diff, local release output, exact NOT_RUN/BLOCKED external gates, adjustment report.
SCOPE: use 16-VALIDATION-MATRIX.md; listed files only; do not push, merge, tag, release, deploy, or claim unobserved CI.
VERIFY: pnpm check && pnpm -r --if-present run build && pnpm run test:security && pnpm run test:integration && pnpm --filter @ai-crm/web test:e2e → exit 0 with non-zero security/integration test counts.
Report WORKING/BLOCKED.
```
