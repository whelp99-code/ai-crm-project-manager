# 13 — File Ownership

The PR listed as owner may modify the file. A later PR may modify a previously owned integration file only after its predecessor merges; parallel edits are forbidden.

| File or path | Owner | Mode |
|---|---|---|
| `apps/api/src/customer-work-os-v2-runtime-core.ts` | PR-001 | MODIFY |
| `apps/api/src/customer-work-os-v2-runtime-manager.ts` | PR-001 | MODIFY version-check ordering after read authorization |
| `apps/api/test/customer-work-os-v2.livepg.integration.test.ts` | PR-001 | MODIFY |
| `packages/contracts/src/customer-work-os-v3.ts` | PR-002 | CREATE |
| `packages/contracts/src/index.ts` | PR-002 | MODIFY |
| `packages/persistence/migrations/0020_customer_work_os_v3_operations.sql` | PR-002 | CREATE |
| `packages/persistence/src/cwos-v3-repository.ts` | PR-002 | CREATE |
| `packages/persistence/src/index.ts` | PR-002 | MODIFY |
| `packages/persistence/test/customer-work-os-v3-repository.security.test.ts` | PR-002 | CREATE |
| `packages/domain/src/customer-work-os-v3.ts` | PR-003 | CREATE |
| `packages/domain/src/index.ts` | PR-003 | MODIFY |
| `packages/domain/test/customer-work-os-v3.integration.test.ts` | PR-003 | CREATE |
| `apps/api/src/customer-work-os-v3-overview.ts` | PR-003 | CREATE; PR-004 may MODIFY after PR-003 |
| `apps/api/src/customer-work-os-v3-routes.ts` | PR-003 | CREATE; PR-004/006/007 modify in dependency order |
| `apps/api/src/app-base.ts` | PR-003 | MODIFY registration and `onRoute` schema-metadata capture |
| `packages/domain/src/customer-work-os.ts` | PR-003 | MODIFY shared next-action transition guard |
| `apps/api/src/customer-work-os-routes-durable.ts` | PR-003 | MODIFY canonical transition route/error regression |
| `apps/api/src/openapi.ts` | PR-003 | MODIFY generator for Fastify v3 schema metadata |
| `apps/api/test/openapi-contract.test.ts` | PR-003 | MODIFY; PR-004, PR-006, PR-007 append assertions in dependency order |
| `apps/api/test/customer-work-os-v3.integration.test.ts` | PR-003 | CREATE; later API PRs append isolated describes sequentially |
| `apps/api/src/customer-work-os-v3-finance.ts` | PR-004 | CREATE |
| `apps/api/test/customer-work-os-v3-finance.integration.test.ts` | PR-004 | CREATE |
| `apps/worker/src/cwos-v3-projector.ts` | PR-004 | CREATE |
| `apps/worker/test/cwos-v3-projector.live-pg.integration.test.ts` | PR-004 | CREATE |
| `apps/worker/src/main.ts` | PR-004 | MODIFY projection tick registration and runtime invocation |
| `apps/worker/package.json`, `pnpm-lock.yaml` | PR-004 | MODIFY add workspace persistence dependency |
| `apps/api/src/customer-work-os-runtime.ts` | PR-004 | MODIFY optional typed projection event and atomic outbox insert |
| `apps/api/src/customer-work-os-routes-durable.ts` | PR-003 then PR-004 | MODIFY shared guard first; typed finance/settlement event producers second |
| `apps/web/app/v3/page.tsx` | PR-005 | CREATE |
| `apps/web/app/v3/action-hub-client.tsx` | PR-005 | CREATE |
| `apps/web/e2e/customer-work-os-v3.spec.ts` | PR-005; PR-008 may extend after PR-005 | CREATE/MODIFY |
| `apps/api/src/customer-work-os-v3-proposals.ts` | PR-006 | CREATE |
| `apps/api/test/customer-work-os-v3-proposals.security.test.ts` | PR-006 | CREATE |
| `apps/api/src/customer-work-os-v3-pilot.ts` | PR-007 | CREATE |
| `apps/api/test/customer-work-os-v3-pilot.integration.test.ts` | PR-007 | CREATE |
| `apps/api/src/customer-work-os-notion.ts` | PR-007 | MODIFY through existing import-plan service |
| `docs/customer-work-os/v3/cutover-runbook.md` | PR-007 | CREATE |
| `.github/workflows/customer-work-os-v3-release-gate.yml` | PR-008 | CREATE |
| `docs/customer-work-os/releases/v3.0.0-release-candidate.md` | PR-008 | CREATE |
| root `package.json` version | PR-008 | MODIFY after all code PRs |

FORBIDDEN for every PR: deleting `0012`..`0019` migrations, removing v1/v2 routes, changing production credentials, pushing/deploying, or weakening existing tests.
