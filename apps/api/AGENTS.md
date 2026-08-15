# apps/api

Composition root of the monorepo: builds the Fastify app and wires all domain services, PG pools, auth, and route registration. API is a **library** — no `listen()` here (boot via `apps/web/e2e/live-server.ts` style or `docs/ops/observability.md` tsx).

## OVERVIEW
Two-layer composition: `app.ts` wraps the v1 `app-base.ts` `createApp` and registers Customer Work OS v2 routes on top. v2 is additive over v1.

## STRUCTURE
```
src/
├── app.ts                    # @ai-crm/api entry; adds CWOS v2 routes onto base
├── app-base.ts               # 2,852 lines: auth, 3 PG pools, hydrate, ~15 dualWrite*, all v1 routes
├── command-map.ts            # S0 natural-command whitelist
├── openapi.ts / event-hub.ts / pg-notify.ts
├── customer-work-os-v2-{routes,runtime-core,commands,store,manager}.ts   # v2 transport
├── services/natural-command.ts
└── customer-work-os-*.ts     # ⚠ v1 — imported ONLY by tests (dead in prod)
```
test/ — 44 vitest files (tag-suffixed: unit/integration/security/contract/livepg).

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Add a v1 route | `app-base.ts` L1736-2848 | inline handlers; the refactor target |
| Add a v2 command | `customer-work-os-v2-runtime-commands.ts` | authz + 20-command dispatch switch |
| CWOS v2 wiring | `customer-work-os-v2-routes.ts` + `app.ts` | standalone app builder for e2e |
| DSN/pool resolution | `app-base.ts` L575-704 | main / admin / model-gateway pools |

## CONVENTIONS (this dir)
- Route registration via `app.inject()` in tests — no network.
- Use the v2 shapes (`routes → manager → commands → store`) for new endpoints; **do not** add inline handlers to `app-base.ts` looking like the v1 monolith.
- Live-PG tests: `*.livepg.integration.test.ts`, drained via `describe.skipIf(!LIVE)`.
- Boot fail-closed: `AUTH_REQUIRED_IN_PROD`, `MODEL_GATEWAY_DSN_REQUIRED_IN_PROD`, hydrate-on-boot never serves stale state.

## ANTI-PATTERNS (THIS PROJECT)
- Do **not** add to `app-base.ts` — it is the 2.8k-line complexity hotspot; extract route plugins / bootstrap instead.
- Unknown natural command → `UNMAPPED_COMMAND` (see `command-map.ts`), never mutate domain.
- PG-first: never call `commit*` after a PG failure; never swallow PG audit errors.
- v1 `customer-work-os-*.ts` are dead code — do not extend them; maintain v2.
