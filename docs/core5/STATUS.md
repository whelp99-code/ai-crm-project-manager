## BLOCKED — test runner host platform (2026-09-22)

The targeted Vitest suites cannot start on this Linux x64 host because the
checkout's existing `node_modules` contains only `@esbuild/darwin-arm64`.
Vite fails before collecting tests. This is an external dependency-install
condition; no install loop or node_modules replacement was attempted.

The earlier `.git/index.lock` EROFS was a Codex sandbox restriction, not a
read-only disk. The owner confirmed Git metadata is writable and authorized
a Core5-only local checkpoint using elevated Git write permission. This is
an implementation checkpoint, not runtime acceptance: Vitest and live PG
validation have not passed. `pnpm run typecheck` and `git diff --check` passed.

## Progress

- C01 and C02 are complete in their existing evidence documents.
- C03 implementation is in `apps/api/src/customer-work-os-v2-routes.ts` and
  the v2 composition root accepts an explicit `customerWorkOsV2Store`. The
  focused readiness/security suite is present. API typecheck passes.
- C04 adds provider/mailbox/source-locator mapping, inbox dedupe, keys-only
  outbox records, and additive migration `0023_cwos_mail_work_inbox_outbox`.
- C05 is documented in `docs/core5/C05-donor-mapping.md` with OpenFGA kept
  shadow-only.
- C06 adds separate mail-handling/customer-work follow-up states, correction
  reasons, and reconciliation evidence requirements.
- Vitest remains pending until a Linux-compatible dependency install is
  available. No production activation or database was attempted.
