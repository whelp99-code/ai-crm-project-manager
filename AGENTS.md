> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

> 리포 간 결정·관례·라우팅 규칙은 [`../dev-wiki`](../dev-wiki/README.md) 를 정본으로 본다. 이 파일은 이 리포 내부 규칙만 담는다.

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-21T13:21:11Z
**Commit:** cbf4f3a
**Branch:** core5-c01-c02

## OVERVIEW
pnpm 9.15.0 TypeScript monorepo (Node `>=22 <23`, v2.0.0). Fastify API + Next.js 15 web + durable worker over PostgreSQL. Live domain is Customer Work OS v2. v1 `customer-work-os-*.ts` paths are test-only.

## STRUCTURE
```
AI-CRM+PM/
├── apps/
│   ├── api/        # Fastify library; app.ts adds v2 onto app-base.ts (3,073 lines)
│   ├── web/        # Next.js 15 App Router; mutations via POST /api/agent/commands
│   └── worker/     # Option D outbox/lease worker; no Temporal, no HTTP server
├── packages/
│   ├── contracts/       # Zod 3 branded ids; explicit workspaceId+resourceId+actionType
│   ├── policy-engine/   # Pure action-type → control; payload is not the control source
│   ├── domain/          # CRM/PM/delivery + CWOS v2 (subpath, not barrel) + pg adapters
│   ├── governance/      # Authz/intent/audit; barrel re-exports PG adapter
│   ├── persistence/     # Drizzle/RLS schema + migrations 0001–0023; zero runtime imports
│   ├── finance/         # Integer-KRW strings; posted lines immutable; corrections = reversals
│   ├── model-gateway/   # Sole LLM egress; Azure client stays inside this package
│   └── imports/ orchestration/ ai-orchestrator/ connectors/ reports/
├── ops/            # Prometheus/Grafana/Alertmanager; drill must not touch ai_crm volume
├── docs/           # ADRs, architecture, security, finance, ci, planning, policy-matrix
├── scripts/        # cwos-pilot-server.ts, cwos-pilot-scenario.ts, cwos-pg-adversarial.sql
├── vitest.config.ts
└── package.json
```
Child files: `packages/domain`, `packages/persistence`, `apps/api`, `packages/model-gateway`. No `apps/api/src` child.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| HTTP API wiring | `apps/api/src/app.ts` + `app-base.ts` | app.ts adds v2 routes onto base; no `listen()` |
| Customer Work OS v2 | `packages/domain/src/customer-work-os-v2/` | Subpath export; barrel does not export CWOS |
| CWOS v2 transport | `apps/api/src/customer-work-os-v2-*` | routes → manager → commands → store |
| Policy/authz | `packages/policy-engine/`, `packages/governance/` | Control from action type, not payload |
| DB schema/RLS | `packages/persistence/` | Unwired. Runtime adapters: domain, governance, finance, model-gateway |
| Finance PG | `packages/finance` subpaths | `./pg-finance-ledger-adapter`, `./pg-finance-recon-adapter` |
| Durable worker | `apps/worker/src/main.ts` | Durable only if `DATABASE_URL` set |
| Web mutations | `apps/web` | `POST /api/agent/commands` only |
| Tests | `apps/api/test/` (50 files), `packages/*/test/` | Filename tag is the suite filter |
| CI | `docs/ci/README.md` | Conflicts with frozen-lockfile below |
| Pilot DSNs | `docs/ops` | `DATABASE_URL` NOBYPASSRLS; `ADMIN_DATABASE_URL` BYPASSRLS for hydrate/outbox only |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createApp` | fn | `apps/api/src/app.ts` | v2 routes onto `app-base.ts` |
| `createApp` (base) | fn | `apps/api/src/app-base.ts` | Auth, pools, hydrate, routes |
| CWOS v2 | mod | `packages/domain/src/customer-work-os-v2/` | Live domain; import the subpath |
| `evaluatePolicy` / `canonicalHashOf` | fn | `packages/policy-engine/src/index.ts` | Decision + payload hash |
| `GovernanceAuthorizationService` | cl | `packages/governance/src/index.ts` | Effect registry + authz |
| `POLICY_MATRIX` / `PROTECTED_ACTION_TYPES` | const | `packages/policy-engine/src/index.ts` | Never-downgrade set |
| `createPg*Repository` | fn | `packages/domain/src/pg-*-adapter.ts` | Runtime PG adapters |
| Ledger / DailyGate | cl | `packages/finance/src/index.ts` | Integer-KRW; one gate row per workspace |
| ModelGateway | cl | `packages/model-gateway/src/index.ts` | Sole AI egress (ADR-010) |
| `ConnectorDispatcher.dispatch` | fn | `packages/connectors` | Always throws `CONNECTOR_DISABLED` |

## CONVENTIONS
- ESM. Package `exports` point at `.ts`; imports use `.js` specifiers. `import type` for type-only.
- Workspace deps `@ai-crm/<pkg>` (`workspace:*`). Deep imports only where `exports` declares them.
- No eslint/prettier. Gates are TS strict + tests + CI.
- Tests live in `<pkg>/test/`, never colocated. Tags: `*.unit|.integration|.security|.contract|.livepg.integration.test.ts`. Live PG is `describe.skipIf` unless `LIVE_PG_TEST=1`. Root vitest excludes `apps/web/e2e`.
- Strict tsconfig: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, NodeNext, composite.
- Fail-closed boot: `AUTH_REQUIRED_IN_PROD`, `MODEL_GATEWAY_DSN_REQUIRED_IN_PROD`. Incomplete `COMPANY_MEMORY_*` fails closed. Personal `sb` is rejected.
- PG-first writes. Memory never leads PG. Request-body tier/matrix/evidence fields are not trusted.

## ANTI-PATTERNS (THIS PROJECT)
- Unknown natural-command → `UNMAPPED_COMMAND`. Never mutate domain.
- Ledger postings hit PG before in-memory mutation. On PG failure propagate; do not call `commit*`. Never swallow PG audit errors. Posted journal lines are immutable; corrections are reversals.
- `REQUIRE_APPROVAL` never downgrades. `LEDGER_POST`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE` stay approval at every tier.
- NOTIFY/outbox keys only: `workspaceId, jobId, eventId, kind`. Never row bodies.
- SEC-01: orchestration src has no `child_process`/`exec*`/`spawn*` and no `fs.writeFile*`. Provider SDKs and `fetch(` stay in connectors + model-gateway. Azure client stays in model-gateway.
- Do not re-grant `model_invocations.write` to api/worker (ADR-010).
- Do not treat `packages/persistence` as the runtime SoR. `p7a211/` is a `tsconfig.tsbuildinfo` only.
- Do not guess the finance day-close cutoff (`BLOCKING — unset`). 90 days does not auto-activate the risk matrix.
- Connectors are frozen: `remoteWrite: false`, `providerCredential: false`, `egress: "none"`. A new connector is an ActionType + registry + ADR, not an adapter swap.
- `ops/obs-stack-drill.sh` (compose `ai-crm-obs-drill`) must not touch the `ai_crm` Postgres volume.
- Approver ≠ submitter (`SOD_VIOLATION`). Review principal ≠ executor (`INDEPENDENT_REVIEW_REQUIRED`).

## UNIQUE STYLES
- PG-first dual-write via `dualWrite*` helpers in app-base. Canonical hash: `canonicalize` + `stableStringify` + `canonicalHashOf`.
- CWOS v2 shape: routes → manager (queue/CAS/idempotency) → commands (authz+dispatch) → store (InMemory/Pg, hash-chained audit).
- ADRs in `docs/adr/` are normative. Pilot: exactly one API and one worker. Finance pack injection is unsigned and dev/test only.
- Worker job ids are `prefix-` + counter, not UUIDs. `ADMIN_DATABASE_URL` is a second pool so the runtime DSN can be `NOBYPASSRLS`.
- Imports have no network I/O. Callers pass file text. Header mismatch fails the batch. Callers do not choose `IMPORT_ACTION_TYPES`.

## COMMANDS
```bash
pnpm install --frozen-lockfile          # this file's install rule
pnpm check                              # typecheck, then vitest
pnpm run typecheck                      # pnpm -r typecheck
pnpm test / test:unit / test:integration / test:security
pnpm --filter @ai-crm/<pkg> test        # and typecheck
pnpm --filter @ai-crm/worker start      # tsx src/main.ts
pnpm --filter @ai-crm/web typecheck
pnpm --filter @ai-crm/web test:e2e      # fail-closed; ignores pilot-live-loop.spec.ts
pnpm --filter @ai-crm/web test:e2e:live # playwright.live.config.ts
LIVE_PG_TEST=1 pnpm test -- --no-file-parallelism
```

## NOTES
- Digest present: `.omo/init-deep/digests/crm-w01.md` only. No other digest. Facts below that file are not invented.
- `apps/api` is a library. Boot via `apps/web/e2e/live-server.ts` (createApp → ready → listen).
- v1 `apps/api/src/customer-work-os-*.ts` (not v2-prefixed) are test-only.
- `docs/ci/README.md` documents `pnpm install --frozen-lockfile=false`. That conflicts with the frozen-lockfile command above. Keep both visible.
- Release-gate `test:security` / `test:integration` are no-ops: `pnpm -r` finds no package scripts by those names.
- Memory-mode tests omit `DATABASE_URL`. `finance_daily_gate_state.policyVersion` is not stored.
- `buildOwnerCockpit` is not on the reports export map.


<!-- github-development-management:v1:start -->
## GitHub 기반 개발 작업 관리 (사용자 지정 기본 흐름)
개발·수정·개선·고도화 요청을 받으면 `~/ops/github-development-management/WORKFLOW.md`를 읽고 자동 적용한다. 이 섹션은 같은 작업을 Linear/별도 보드에 중복 관리하라는 기존 안내보다 우선한다. 모델·권한·전문 검증 지침은 바꾸지 않는다.
- 실제 remote/registry로 대상 확인 → 기존 Issue/PR 검색·재사용(없을 때만 생성) → 목표·범위·인수 조건 기록 → 통합 Project 연결 → 구현·검증 → 근거 기록 → GitHub 재조회.
- 해당 작업의 Issue/Project 등록·상태·검증 댓글 갱신은 사용자 상시 승인 범위다. commit/push/PR/merge/deploy/삭제/권한 변경은 별도 기존 승인 범위를 따른다. 원격이 미확정이면 임의 저장소에 쓰지 않는다.
- 시작/종료 보고에 Issue URL을 남긴다. 등록 실패는 로컬 pending으로 보존하고 미등록이라고 밝힌다. 단순 질문·번역·읽기 전용 조사에는 생성하지 않는다.
- 상태 Backlog → In Progress → Verify → Done. 실제 인수 근거 없이 Done 처리하지 않는다. 코드 존재·테스트·배포·실사용을 구분한다. HANDOFF draft/사람 ready 규칙을 유지한다.
- 상세 원본: `~/ops/github-development-management/WORKFLOW.md`; 연결표: `~/ops/github-development-management/registry.json`; 도구: `python3 ~/ops/github-development-management/manage.py`.
<!-- github-development-management:v1:end -->
