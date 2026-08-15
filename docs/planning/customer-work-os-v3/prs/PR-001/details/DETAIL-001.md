# PR-001-SUB-001-DETAIL-001 — Import cleanup

File: `apps/api/src/customer-work-os-v2-runtime-core.ts` / Location: type-only import block.

Input: current import specifiers. / Output: same import block without `IdentityPrincipal`, `V2Actor`, `WorkspaceMembership`. / Error behavior: N/A. / Side effects: none.

Steps: inspect references with code search; remove only confirmed unused specifiers; save; run API typecheck.

Verify: `pnpm --filter @ai-crm/api typecheck`; expected result after all PR-001 details is exit 0.
