# 15 — Test Strategy

## Test-first sequence

1. Add or identify an acceptance test and observe the expected RED result.
2. Implement the smallest contract-compliant change.
3. Run focused typecheck/test.
4. Run affected package tests.
5. Run `pnpm check` before PR completion.
6. Run PostgreSQL/browser/full release gates only at their declared PR boundary.

## Layers

| Layer | Scope | Command |
|---|---|---|
| Static | all packages | `pnpm run typecheck` |
| Root regression | all Vitest | `pnpm check` |
| Contracts | domain/API v2/v3 | `pnpm --filter @ai-crm/domain test` and `pnpm --filter @ai-crm/api test` |
| Persistence | repositories/RLS | `pnpm --filter @ai-crm/persistence test` |
| Web build | Next production compile | `pnpm --filter @ai-crm/web build` |
| Browser | Action Hub/approval/Golden Flow | `pnpm --filter @ai-crm/web test:e2e` |
| Release | packages, security, integration | commands in v3 release workflow |

The v3 release workflow runs root `pnpm run test:security` and `pnpm run test:integration`. Recursive `pnpm -r --if-present` is forbidden for these two gates because no child package owns those script names and it can succeed with zero executed tests.

## PostgreSQL live gate

Apply every migration in lexical order to PostgreSQL 16 with `ON_ERROR_STOP=1`. Run the existing adversarial SQL, persistence tests, API memory-mode regression, explicit live-PG suites, two-workspace RLS cases, backup/restore, and a post-restore v3 overview/pilot query. Database URLs are injected by CI/manual environment and never written to evidence.

## Required scenarios

- Happy Golden Flow with partial receipt/payment.
- No-next-action transition rejection.
- Cross-workspace read/write denial.
- Idempotency replay and key/body conflict.
- Stale expected version.
- Prompt-injection quarantine.
- AI self-approval denial.
- Incomplete release evidence cannot pass.
- Import count and money mismatch blocks cutover.
- API unavailable causes `/v3` fail-closed UI.
- Existing canonical engagement transition route cannot bypass the shared next-action guard.
- Full inquiry→renewal Golden Flow exercises each canonical transition; a prebuilt final fixture does not satisfy the E2E.

## Flaky policy

A test that changes outcome across three isolated runs is `FLAKY`, not PASS. Quarantine requires a tracked owner, reproduction evidence, and a release-gate decision; v3 Golden Flow, RLS, approval, money, restore, and release-evidence tests cannot be waived.
