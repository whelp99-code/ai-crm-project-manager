# packages/persistence

PostgreSQL foundation: Drizzle-ORM schema, RLS policies, migrations, and gate scripts. **Currently has zero runtime consumers** (verified) — api/worker use their own pg adapters from domain/governance. Not on any hot path.

## OVERVIEW
Schema-only package (entry `src/schema.ts`): workspaces, principals, policy/control/intent with lease fencing, append-only audit chain, outbox, notifications, imports, model invocations. All tables FORCE RLS.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Table schema / RLS | `src/schema.ts` | canonical data model |
| Migrations | `migrations/` | 0001–0019, lexically ordered |
| RLS smoke | `scripts/pg-rls-smoke.sh` | refuses non-ai_crm DBs / port 5432 |
| Restore drill | `scripts/restore-drill.sh` | pg_dump → restore → verify |
| Gate helper | `scripts/scorecard-weight-check.mjs` | CI drift check |

## CONVENTIONS (this dir)
- RLS is mandatory (`FORCE RLS`); runtime roles must never bypass RLS / use superuser.
- `DATABASE_URL` must not point at the admin role; role-separated DSNs (runtime_api / admin / model_gateway).
- Policies must not read raw `current_setting`; append-only audit chain via DB triggers.

## ANTI-PATTERNS (THIS PROJECT)
- No SQLite / Prisma / in-app server truth — PG is the only source of truth.
- Never bypass RLS to simplify a query.
- Do not graft runtime consumers here silently; the existing dual-write adapters live in domain/governance.
