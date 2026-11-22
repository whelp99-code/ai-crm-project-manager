> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# packages/persistence

PostgreSQL foundation: Drizzle-ORM schema, RLS policies, migrations, and gate scripts. **Currently has zero runtime consumers** (verified) — api/worker use their own pg adapters from domain/governance. Not on any hot path.

## OVERVIEW
Schema-only package. There is no `index.ts`; `package.json` exports `"."` at `src/schema.ts`. Tables: workspaces, principals, policy/control/intent with lease fencing, append-only audit chain, outbox, notifications, imports, model invocations, orch job tables. All business tables FORCE RLS and carry NOT NULL `workspaceId` (workspaces is the tenant root).

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Table schema / RLS | `src/schema.ts` | canonical data model |
| Migrations | `migrations/` | 0001–0023, lexical; latest `0023_cwos_mail_work_inbox_outbox.sql` |
| RLS smoke | `scripts/pg-rls-smoke.sh` | refuses any DB other than `ai_crm`; port must be 5432 unless `AI_CRM_SMOKE_ALLOW_NONDEFAULT_PORT=1` |
| Restore drill | `scripts/restore-drill.sh` | pg_dump → restore → verify |
| Gate helper | `scripts/scorecard-weight-check.mjs` | CI drift check |

## CONVENTIONS (this dir)
- RLS is mandatory (`FORCE RLS`); runtime roles must never bypass RLS / use superuser.
- `DATABASE_URL` must not point at the admin role; role-separated DSNs (runtime_api / admin / model_gateway).
- Policies must not read raw `current_setting`; append-only audit chain via DB triggers.
- SQL migrations own roles, `FORCE RLS`, triggers, and grants. `schema.ts` is table shape and TypeScript types only. No drizzle-kit journal in this package.
- Persistence may `import type` from `@ai-crm/contracts`. Migrations must run without that package.

## ANTI-PATTERNS (THIS PROJECT)
- No SQLite / Prisma / in-app server truth — PG is the only source of truth.
- Never bypass RLS to simplify a query.
- Do not graft runtime consumers here silently; the existing dual-write adapters live in domain/governance.
- Do not point the smoke script at sangfor (`:5434`) or unified (`:5433`).
