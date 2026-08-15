# PR-001 — Restore inherited green baseline

Risk: R2 / Execution: SEQUENTIAL / Related: REQ-BASE-001, REQ-COMPAT-001 / Predecessor: none / Successor: PR-002.

## Purpose

Close only the confirmed v2 typecheck failures before v3 work. Do not alter runtime behavior.

## Outputs

- MODIFY `apps/api/src/customer-work-os-v2-runtime-core.ts`: remove three unused type imports.
- MODIFY `apps/api/test/customer-work-os-v2.livepg.integration.test.ts`: make the local PG query adapter signature compatible with installed `@types/pg` while preserving runtime calls.
- MODIFY `apps/api/src/customer-work-os-v2-runtime-manager.ts`: after read authorization and idempotency lookup, compare `expectedVersion` before command-specific membership authorization so an authenticated stale bootstrap request receives `CONCURRENT_MODIFICATION`.
- No new file, migration, API, or behavior.

## Forbidden

- TypeScript strictness changes, `ts-ignore`, ambient `declare module 'pg'`, test skip/delete/assertion weakening, moving the version check before read authorization, v2 route/response changes, dependency version changes.

## Change budget

Direct modified files 3; new files 0; logical changes at most 60 lines; migrations 0.

## Verification

1. `pnpm --filter @ai-crm/api typecheck` → exit 0.
2. `pnpm --filter @ai-crm/api exec vitest run test/customer-work-os-v2-runtime.integration.test.ts --no-file-parallelism` → exit 0; 2 tests pass.
3. `pnpm --filter @ai-crm/api test` → exit 0.
4. `pnpm check` → exit 0.

## Completion

All confirmed baseline errors disappear, no new warning/error appears, and existing v2 tests pass without weakened assertions.

## Dispatch prompt

```text
TASK: PR-001 — Restore the inherited v2 green baseline without behavior change.

DELIVERABLE:
- Diff limited to the three allowed files.
- Output and exit code for the four verification commands.
- Planned-vs-actual adjustments, or "none".

SCOPE:
- Read docs/planning/customer-work-os-v3/prs/PR-001/README.md and all three SUB files first.
- MODIFY only apps/api/src/customer-work-os-v2-runtime-core.ts, apps/api/src/customer-work-os-v2-runtime-manager.ts, and apps/api/test/customer-work-os-v2.livepg.integration.test.ts.
- Do not change dependencies, strictness, runtime routes, migrations, or test assertions.
- If the local PG adapter differs, inspect the installed pg typings and preserve the same SQL/params runtime behavior.

VERIFY: pnpm --filter @ai-crm/api typecheck && pnpm --filter @ai-crm/api exec vitest run test/customer-work-os-v2-runtime.integration.test.ts --no-file-parallelism && pnpm --filter @ai-crm/api test && pnpm check → exit 0; focused runtime reports 2 passed.
Report WORKING status; report BLOCKED on a contract contradiction.
```
