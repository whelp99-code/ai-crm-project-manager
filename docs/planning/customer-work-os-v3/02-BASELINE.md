# 02 — Baseline

## Immutable source baseline

| Check | Result | State |
|---|---|---|
| Branch | `release/customer-work-os-v1-stabilization` | `CONFIRMED` |
| HEAD | `cdefbeff4ba56782558d974a7a7dcb28f942d265` | `CONFIRMED` |
| Tree | `9e37bad8c86cd0c860f16501e5251ee95b47a46e` | `CONFIRMED` |
| Working tree before plan | clean | `CONFIRMED` |
| Root version | `2.0.0` | `CONFIRMED` |
| Node | `v22.23.1` | `CONFIRMED` |
| pnpm | `9.15.0` | `CONFIRMED` |

## Executed baseline commands

First command: `pnpm check` against the preserved pre-install `node_modules`.

Result: exit code `1`; it showed missing `pg` declarations plus unused imports. Dependency inspection confirmed `@types/pg` was already declared, so this first result was classified as stale local dependency state rather than a source dependency omission.

Second command: `pnpm install --frozen-lockfile && pnpm check`.

Install result: exit code `0`, lockfile unchanged, 17 packages synchronized.

Check result: exit code `1`; typecheck failed before Vitest execution.

Confirmed source failures after frozen install:

1. `apps/api/src/customer-work-os-v2-runtime-core.ts` imports `IdentityPrincipal`, `V2Actor`, and `WorkspaceMembership` but does not use them: 3 TS6133 diagnostics.
2. `apps/api/test/customer-work-os-v2.livepg.integration.test.ts` passes `readonly unknown[] | undefined` through a `pg` overload that expects another signature: 2 TS2769 diagnostics.

Focused command: `pnpm --filter @ai-crm/api exec vitest run test/customer-work-os-v2-runtime.integration.test.ts --no-file-parallelism`.

Focused result: exit code `1`; 1 passed and 1 failed. The concurrent initial command case expects `CONCURRENT_MODIFICATION` but receives `MEMBERSHIP_REQUIRED`. Root cause: after the first queued command creates the bootstrap principal, the second request passes read authorization, then command-membership authorization runs before the expected-version comparison. PR-001 moves the version check after authenticated read/idempotency handling but before command authorization; unauthorized actors remain blocked by read authorization before version disclosure.

Classification: `EXISTING_BASELINE_FAILURE`. Five typecheck diagnostics plus one deterministic concurrency test failure remain at the immutable v2 source commit after an exact frozen install. PR-001 must close them before any v3 feature PR may merge.

## Commands confirmed to exist

- `pnpm check`
- `pnpm --filter @ai-crm/api typecheck`
- `pnpm --filter @ai-crm/api test`
- `pnpm --filter @ai-crm/domain test`
- `pnpm --filter @ai-crm/persistence test`
- `pnpm --filter @ai-crm/web build`
- `pnpm --filter @ai-crm/web test:e2e`
- `pnpm -r --if-present run build`
- `pnpm run test:security`
- `pnpm run test:integration`

## Not run in planning

- PostgreSQL live suites: `NOT_RUN`; no planning-time database was started.
- Playwright E2E: `NOT_RUN`; v3 UI does not exist.
- GitHub Actions: `NOT_RUN`; repository Actions status is outside this local plan task.
- Production deployment, restore drill, and pilot: `NOT_RUN` and require MANUAL gates.

## Baseline gate

No v3 implementation branch may start PR-002 until `pnpm check` exits `0` on PR-001 and the exact failure output above is preserved in the PR evidence as the red baseline.
