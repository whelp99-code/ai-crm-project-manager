# PR-001-SUB-003-DETAIL-001 — Version-check ordering

File: `apps/api/src/customer-work-os-v2-runtime-manager.ts` / Symbol: `CustomerWorkOsV2RuntimeManager.command`.

Input: authenticated actor, expected version, idempotency key, command payload. / Output: unchanged command/replay result or existing typed error. / Side effects: none before all authorization/concurrency checks.

Steps: preserve read authorization; preserve replay lookup; relocate the existing stale-version block immediately after replay handling and before command-specific authorization; leave all error codes/messages unchanged; run the focused two-test file and full API/root gates.

Verify: `pnpm --filter @ai-crm/api exec vitest run test/customer-work-os-v2-runtime.integration.test.ts --no-file-parallelism`; expected exit 0 and 2 passed.
