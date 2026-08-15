# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-15
**Commit:** cdefbef
**Branch:** release/customer-work-os-v1-stabilization

## OVERVIEW
pnpm TypeScript monorepo for an AI-driven CRM + Project Manager (v2.0.0). Fastify API + Next.js web + durable worker over PostgreSQL, with a pure policy-engine/governance core. The live domain is **Customer Work OS v2** (`packages/domain/src/customer-work-os-v2`); v1 API paths are test-only dead code.

## STRUCTURE
```
ai-crm-project-manager/
├── apps/
│   ├── api/        # Fastify composition root (createApp); the big hotspot (app-base.ts)
│   ├── web/        # Next.js 15 App Router UI + Playwright e2e
│   └── worker/     # Durable outbox/lease worker (tick + outbox drain)
├── packages/
│   ├── contracts/       # Zod schema hub (bottom of dep graph; change-control boundary)
│   ├── policy-engine/   # Pure deterministic action→control policy + canonical hashing
│   ├── domain/          # CRM/PM/delivery logic + customer-work-os-v2 + pg adapters
│   ├── governance/      # Authz/intent/audit service + pg adapter
│   ├── persistence/     # Drizzle/PostgreSQL RLS schema + migrations (NO runtime consumers)
│   └── finance/ imports/ orchestration/ ai-orchestrator/ model-gateway/ connectors/ reports/
├── ops/            # Prometheus / Grafana / Alertmanager + observability drill
├── docs/           # ADRs, architecture, security, finance, ci, planning, policy-matrix
├── vitest.config.ts
└── package.json
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| HTTP API wiring | `apps/api/src/app.ts` + `app-base.ts` | app.ts adds v2 routes onto base |
| Customer Work OS v2 | `packages/domain/src/customer-work-os-v2/` | Pure logic; api is transport only |
| CWOS v2 transport | `apps/api/src/customer-work-os-v2-{routes,runtime-*.ts}` | routes → manager → commands → store |
| Policy/authz | `packages/policy-engine/`, `packages/governance/` | registry-before-execution |
| DB schema/RLS | `packages/persistence/src/schema.ts` + `migrations/` | Drizzle; currently unwired to runtime |
| Domain services | `packages/domain/src/{crm,pm,delivery,workflow-graph}.ts` | + pg-*-adapter |
| Durable worker | `apps/worker/src/main.ts` | outbox + lease recovery |
| Web pages | `apps/web/app/{work,monitor,pilot,approvals,v2}` | App Router |
| Tests (canonical) | `apps/api/test/`, `packages/*/test/` | tag-suffixed files |
| CI/release gates | `.github/workflows/*.yml` | see docs/ci/README.md |

## CODE MAP
Root of each package; full symbol inventory in the per-package entry `src/index.ts`.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `createApp` | fn | `apps/api/src/app.ts` | central | Builds Fastify instance; composition root |
| `createApp` (base) | fn | `apps/api/src/app-base.ts` | 100+ internal | v1 wiring: auth, pools, hydrate, all routes |
| `CustomerWorkOsV2Platform` / `*V2*` | cl | `packages/domain/src/customer-work-os-v2/` | 19 files | Live domain logic facade |
| `evaluatePolicy` / `canonicalHashOf` | fn | `packages/policy-engine/src/index.ts` | domain+governance | Deterministic policy decision + payload hash |
| `GovernanceAuthorizationService` / `ActionRegistry` | cl | `packages/governance/src/index.ts` | 12 files | Effect registry + authz enforcement |
| `POLICY_MATRIX` / `PROTECTED_ACTION_TYPES` | const | `packages/policy-engine/src/index.ts` | api, governance | Action→control mapping; never-downgrade set |
| `createPg{*,*Sub,Pm}Repository` | fn | `packages/domain/src/pg-*-adapter.ts` | api | RLS-scoped PG adapters |
| Ledger/Reconciliation/DailyGate | cl | `packages/finance/src/index.ts` | api | Double-entry accounting |
| ModelGateway | cl | `packages/model-gateway/src/index.ts` | api | Sole AI/invoke egress (ADR-010) |

## CONVENTIONS
- ESM (`"type": "module"`); `import type` for type-only imports (verbatimModuleSyntax).
- Internal deps via scoped workspace imports `@ai-crm/<pkg>` (`workspace:*`); deep subpaths only where `exports` declares them.
- **No eslint/prettier** — correctness gates are TS strict + tests + CI.
- Tests: `<pkg>/test/` dir (never colocated), filename encodes tag — `*.unit|.integration|.security|.contract|.livepg.integration.test.ts`. Root scripts filter by tag name. Real-PG tests gated by `describe.skipIf(!LIVE)` with `LIVE_PG_TEST=1`; excluded from `test:integration`.
- Strict tsconfig: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, NodeNext, composite.
- Fail-closed production boot: `AUTH_REQUIRED_IN_PROD` (API key), `MODEL_GATEWAY_DSN_REQUIRED_IN_PROD`, role-separated DSNs (runtime_api / admin / model_gateway).
- PG is the **only** source of truth; memory never leads PG (PG-first writes). Effect capabilities only via registry-mapped connectors/model-gateway.

## ANTI-PATTERNS (THIS PROJECT)
- Unknown natural-command → fail the work item with `UNMAPPED_COMMAND`, never mutate domain.
- PostgreSQL ledger postings: MUST hit PG before in-memory mutation; on PG failure propagate, **must not** call `commit*`; never swallow PG audit errors.
- `REQUIRE_APPROVAL` controls must never be downgraded (a defect, not config).
- `NOTIFY`/outbox payloads: keys only (`workspaceId, jobId, eventId, kind`) — never row bodies; never trust payload content.
- `SEC-01`: orchestration src must never `child_process`/`execSync`/`spawnSync`/`execFileSync` or file writes (`fs.writeFile*`). Not allowed to import provider SDKs/`fetch(` outside connectors + model-gateway (grep-banned in release gate).
- Prod must never silently run unauthenticated.
- `model_invocations.write` grants must never be re-granted to api/worker (ADR-010).
- Boot hydration is fail-closed: never serve stale in-memory state.
- No TODO/FIXME/HACK markers, no `@deprecated` tags — not an established rule, just current clean state.

## UNIQUE STYLES
- **PG-first accounting**: money postings dual-write; in-memory SoR mirrored to PG per entity via ~15 `dualWrite*` helpers in app-base.
- **Canonical hashing**: `canonicalize` + `stableStringify` + `canonicalHashOf` for verifiable intent/audit/report integrity.
- **Doc-first change control**: ADRs in `docs/adr/` are normative (001-012); `docs/policy-matrix.md`, `docs/finance/accounting-standard-pack.md`, `docs/ops/sor-persistence.md` are dense rule sources.
- **CWOS v2 shape** is the standard: routes → manager (queue/CAS/idempotency) → commands (authz+dispatch) → store (InMemory/Pg with hash-chained audit). Reuse it.

## COMMANDS
```bash
pnpm install --frozen-lockfile   # CI-frozen install (lockfile must match)
pnpm check                       # typecheck + full vitest (root)
pnpm run typecheck               # pnpm -r typecheck (tsc -b --noEmit)
pnpm test / test:unit / test:integration / test:security   # vitest filename-tag filters
pnpm --filter @ai-crm/<pkg> test# per-package vitest
pnpm --filter @ai-crm/web exec tsc --noEmit   # web typecheck
pnpm --filter @ai-crm/web test:e2e            # Playwright e2e (fail-closed, no API)
LIVE_PG_TEST=1 pnpm test -- --no-file-parallelism  # real-Postgres suites
```

## NOTES
- `apps/api` is a **library**, not a self-booting server — no `listen()` in src. Boot it like `apps/web/e2e/live-server.ts` (createApp → ready → listen) or the `docs/ops/observability.md` tsx boot.
- `packages/persistence` has **zero runtime consumers** (verified): api/worker use their own pg adapters from domain/governance. It's the planned-but-unwired RLS foundation — don't assume it's on the hot path.
- `apps/api/src/customer-work-os-*.ts` (v1: routes, routes-durable, runtime, identity, policy, controls, ai-store, notion) are imported **only** by tests — dead in production; v2 is maintained.
- CI builds/tests in `docs/ci/README.md` order: persistence → governance → orchestration → api → worker.
- Release gate's `test:security`/`test:integration` steps are no-ops (`pnpm -r` iterates packages, none define those scripts) — known quirk.
- On this machine there's a `.gjc/` dir with many session strays and no eslint/prettier config — build correctness is enforced via CI, not local lint.
