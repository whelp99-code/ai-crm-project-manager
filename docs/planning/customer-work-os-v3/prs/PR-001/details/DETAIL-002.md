# PR-001-SUB-002-DETAIL-001 — Query overload compatibility

File: `apps/api/test/customer-work-os-v2.livepg.integration.test.ts` / Location: local wrapper calls reported at baseline lines 23 and 32.

Input: SQL string and optional values. / Return: the same Promise-based query result used by `PgCwosV2StateStore`. / Exceptions: native PG rejection propagates. / Side effects: test database query only.

Steps: inspect installed `Pool.query` overload and production scoped-pool interface; choose a typed wrapper signature whose parameter values match both; preserve query text/values; run the three PR commands.

Verify: `pnpm --filter @ai-crm/api typecheck && pnpm --filter @ai-crm/api test && pnpm check`; expected exit 0.
