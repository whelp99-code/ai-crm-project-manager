## Vitest host remasure (2026-09-22)

Dropped `@esbuild/linux-x64@0.21.5` into `node_modules` (not committed).
Focused suites now collect:
- `apps/api/test/customer-work-os-v2-readiness.security.test.ts` — 2 passed, rc=0
- `packages/domain/test/customer-work-os-v2-mail-followup.unit.test.ts` — 2 passed, rc=0
Full `pnpm test` was not re-run. Live PG RLS still needs `LIVE_PG_TEST=1`.

The earlier `.git/index.lock` EROFS was a Codex sandbox restriction, not a
read-only disk. The owner confirmed Git metadata is writable and authorized
a Core5-only local checkpoint using elevated Git write permission. This is
an implementation checkpoint, not runtime acceptance: Vitest and live PG
validation have not passed. `pnpm run typecheck` and `git diff --check` passed.

## Company-memory donor (2026-09-23)

CRM-only `sb-company` donor publisher is in
`packages/domain/src/customer-work-os-v2/company-memory-donor.ts` with focused
unit tests. Outbox acknowledgement is fail-closed (matching receipt required).
Mail product adapter is explicitly not implemented. No worker production bind,
live company writes, personal `sb remember`, or shared signing key.
See `docs/core5/COMPANY-MEMORY-DONOR.md`.

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
