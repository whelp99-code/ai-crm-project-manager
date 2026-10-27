# packages/domain

Core domain-logic layer. Owns CRM / PM / delivery / workflow-graph services **and** the live Customer Work OS v2 domain (`src/customer-work-os-v2`). Pure TypeScript; persistence happens only through the RLS-scoped pg adapters exported here. Depends on `@ai-crm/contracts` + `@ai-crm/policy-engine`.

## OVERVIEW
Package entry `src/index.ts` re-exports crm/delivery/pm/workflow-graph + pg adapters. Subpath exports: `./crm`, `./pm`, `./delivery`, `./workflow-graph`, `./customer-work-os-v2`, `./pg-{crm,crm-sub,pm}-adapter`.

## STRUCTURE
```
src/
├── index.ts / crm.ts / pm.ts / delivery.ts / workflow-graph.ts
├── customer-work-os.ts + customer-work-os-graphs.ts     # v1 (intentionally lean here)
├── pg-crm-adapter.ts / pg-crm-sub-adapter.ts / pg-pm-adapter.ts   # InMemory repo variants shipped for tests
├── customer-work-os-v2/        # ⭐ the live domain
│   ├── index.ts + shared.ts + state / hash
│   ├── identity.ts psa.ts inbox.ts connectors.ts graphs.ts ai.ts
│   └── portal.ts admin.ts operations.ts platform.ts     # CustomerWorkOsV2Platform facade
```
test/ — per-package vitest (`test/` dir, tag-suffixed).

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| CRM/PM/delivery logic | `src/{crm,pm,delivery}.ts` | service classes + action-bound receipts |
| CWOS v2 domain | `src/customer-work-os-v2/` | pure logic; API layer (app.ts) is transport only |
| PG access | `src/pg-*-adapter.ts` | each ships an InMemory impl for tests |

## CONVENTIONS (this dir)
- Domain logic is **pure** — no I/O except through injected repos/clocks; pass `() => now` for determinism.
- Every pg adapter must also expose an InMemory version used by tests.
- `canonicalHashOf` (policy-engine) secures change-baseline versioning and mutation classification.

## ANTI-PATTERNS (THIS PROJECT)
- **PG-first ledger/audit** rules apply to adapters: hit PG before in-memory mutation; propagate PG failure; never call `commit*` after failure.
- No direct provider SDKs / `fetch(` — effects go through connectors / model-gateway only.
- Never downgrade `REQUIRE_APPROVAL` controls (a defect).
- Cross-workspace access is forbidden.
