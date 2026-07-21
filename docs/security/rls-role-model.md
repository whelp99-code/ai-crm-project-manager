# RLS Role Model — ADR-005

- **Status:** Design accepted 2026-07-15 (DBA/Security, ADR-005). Roles marked **implemented** below exist in `packages/persistence/migrations/0001_foundation.sql` and `packages/persistence/migrations/0002_model_gateway_and_break_glass_roles.sql`; the follow-up migration closes the gap tracked in §9 below.
- **Owner:** DBA/Security.
- **Scope rule:** production role DDL never grants `BYPASSRLS` to any runtime role, and every workspace-owned table uses both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. This document is the authoritative role/grant design; `packages/persistence/migrations/*.sql` is the executable source of truth for what is actually deployed, and must not silently diverge from it.

## 1. Role inventory

| Role | Purpose | Login | `BYPASSRLS` | Table ownership | Status |
|---|---|---|---|---|---|
| `ai_crm_migration_owner` | Owns every table; the only role permitted to run DDL/migrations. | `NOLOGIN` (a deployment-time login role is granted membership out-of-band; this role itself carries no password) | **No** | Owns all tables | Implemented (`0001_foundation.sql`) |
| `ai_crm_break_glass_admin` | Offline, time-limited emergency access for incident response only. Never used for routine operations. | `NOLOGIN` by default (a time-boxed role membership/credential grant with expiry is provisioned out-of-band by the incident runbook; this role itself carries no standing password) | **No** — break-glass is audited elevated access via explicit, logged `SET ROLE`/session grant, not a standing RLS bypass | None | Implemented (`0002_model_gateway_and_break_glass_roles.sql`) |
| `ai_crm_runtime_api` | Fastify API runtime: registry-backed command/query handlers. | `LOGIN`, `NOINHERIT`, password provisioned out-of-band | **No** | None | Implemented |
| `ai_crm_runtime_worker` | Temporal worker/dispatcher runtime: lease acquire/renew/expire-recovery, dispatch, audit/outbox append, notification delivery. | `LOGIN`, `NOINHERIT`, password provisioned out-of-band | **No** | None | Implemented |
| `ai_crm_runtime_model_gateway` | `apps/model-gateway` runtime: writes only `model_invocations` rows tied to its own invocations; reads only what it needs to attribute an invocation to a workspace/principal. Disjoint credential from API/worker/dispatcher per ADR-001 §2 and ADR-010. | `LOGIN`, `NOINHERIT`, password provisioned out-of-band | **No** | None | Implemented (`0002_model_gateway_and_break_glass_roles.sql`) |
| `ai_crm_audit_verifier` | Read-only audit chain verifier; no write grants on any table. | `LOGIN`, `NOINHERIT`, password provisioned out-of-band | **No** | None | Implemented |
| *(future, disabled in MVP)* `ai_crm_runtime_connector_dispatcher` | `apps/connector-dispatcher` runtime: sole holder of any future remote-provider credential; lease/dispatch/result-write on `execution_intents` for `remote`-effect entries only. | `LOGIN`, `NOINHERIT` | **No** | None | **Not created** — MVP has no remote connector; creating this role is part of the connector-enablement gate in ADR-001 §2, not MVP scope |

**Invariant:** no role other than `ai_crm_migration_owner` may own a table, and no role in this inventory is ever granted `BYPASSRLS`. `FORCE ROW LEVEL SECURITY` on every workspace-bound table means even `ai_crm_migration_owner` is subject to RLS outside an explicit migration/maintenance session — the only way to see cross-workspace rows is a superuser session or an explicit, audited break-glass elevation, never routine query traffic from any application role.

## 2. FORCE RLS and policy shape

Every workspace-owned table (currently: `users`, `principals`, `policy_decisions`, `control_requests`, `control_claims`, `execution_intents`, `audit_chain_heads`, `audit_events`, `outbox_events`, `notifications`, `import_batches`, `import_rows`, `model_invocations`, and every future workspace-bound table — CRM/delivery/finance/PM-planning/reporting tables included) must:

1. `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;`
2. `ALTER TABLE <t> FORCE ROW LEVEL SECURITY;`
3. Define a single `workspace_isolation` policy (or an explicit per-operation set, if a table ever needs different `SELECT` vs `INSERT`/`UPDATE`/`DELETE` semantics) with **both** `USING` and `WITH CHECK`:

   ```sql
   CREATE POLICY workspace_isolation ON <t>
     USING (workspace_id = app_current_workspace_id())
     WITH CHECK (workspace_id = app_current_workspace_id());
   ```

`USING` alone would allow a row to be inserted/updated into a foreign workspace as long as it isn't read back in the same statement; `WITH CHECK` alone would allow reading rows across workspaces. Both clauses together are required so a row can neither be **read** nor **inserted/updated/moved** across the workspace boundary in either direction.

`workspaces` itself is the tenant boundary root and is **not** RLS-workspace-scoped (there is no `workspace_id` column to scope it against); runtime roles receive `SELECT`-only on `workspaces` and no `INSERT`/`UPDATE`/`DELETE`.

## 3. Guarded workspace context function

All policies call `app_current_workspace_id()` rather than comparing directly against `current_setting('app.workspace_id', true)`:

```sql
CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw_value text := current_setting('app.workspace_id', true);
BEGIN
  IF raw_value IS NULL OR btrim(raw_value) = '' THEN
    RAISE EXCEPTION 'app.workspace_id is not set for this session/transaction; workspace context is required'
      USING ERRCODE = '28000';
  END IF;
  RETURN raw_value::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.workspace_id is malformed (expected uuid): %', raw_value
      USING ERRCODE = '22023';
END;
$$;
```

**Fail-closed rationale:** a missing or malformed `app.workspace_id` **raises**, it never silently evaluates to an empty result set. An empty result set is indistinguishable from "workspace has no matching rows"; a raised exception is unambiguous "context was never set" and aborts the transaction instead of returning a plausible-looking but wrong answer.

## 4. Transaction-scoped context and pool reset

1. Every request/job transaction sets workspace context with **`SET LOCAL app.workspace_id = '<uuid>'`** — never session-global `SET`. `SET LOCAL` is automatically undone at transaction end (`COMMIT`/`ROLLBACK`), so it cannot leak into the next transaction on a pooled connection.
2. The API runtime derives the workspace id from the verified OIDC session/request context before opening the transaction that performs the write; it is never taken from an unvalidated request body field.
3. The worker runtime derives the workspace id from the durable Temporal workflow input (server-recorded at workflow start/signal time), not from any value re-supplied by an activity caller at execution time.
4. The model-gateway runtime derives the workspace id from the invocation's originating registry-mapped request context, exactly like the API/worker paths — it does not accept a bare workspace id as unauthenticated input.
5. **Pool release invariant:** on every connection return to the pool — success or error — the connection performs `RESET ALL` (or the driver's discard-on-error equivalent) before it can be reused. A connection that still carried a stale `SET LOCAL`-scoped value would not actually leak (transaction-scoped `SET LOCAL` is already gone at commit/rollback), but `RESET ALL` also clears any accidental session-level `SET` a bug might have introduced, so this is defense in depth against a coding mistake that used `SET` instead of `SET LOCAL`.
6. Object storage access uses workspace-prefixed, short-lived credentials (`workspace/{workspaceId}/...` key layout); object key/version/digest and evidence workspace are rechecked against the caller's workspace context before use, not trusted from the object key alone.

## 5. Grants (least privilege, non-owner)

Grants are additive and explicit; nothing is assumed from PostgreSQL's default `PUBLIC` grants (`REVOKE ALL ... FROM PUBLIC` style statements are used where a table must not be reachable by `PUBLIC` at all).

| Role | Grant shape |
|---|---|
| `ai_crm_runtime_api` | `SELECT, INSERT, UPDATE` on business/governance tables it authors (`users`, `principals`, `policy_decisions`, `control_requests`, `control_claims`, `execution_intents`, `notifications`, `import_batches`, `import_rows`); `SELECT, INSERT` on `audit_events`, `outbox_events`; `SELECT, UPDATE` on `audit_chain_heads` (head-advance only, never row delete); `SELECT` on `workspaces`. No `DELETE` anywhere. |
| `ai_crm_runtime_worker` | `SELECT, INSERT, UPDATE` on `execution_intents`, `control_requests`, `control_claims`, `notifications`, `import_batches`, `import_rows` (lease/dispatch/result/delivery lifecycle columns); `SELECT, INSERT` on `audit_events`, `outbox_events`; `SELECT, UPDATE` on `audit_chain_heads`; `SELECT` on `users`, `principals`, `policy_decisions`, `workspaces`. No `DELETE` anywhere. |
| `ai_crm_runtime_model_gateway` | `SELECT, INSERT` on `model_invocations` only (its own invocation records); `SELECT` on `principals`, `workspaces` (to attribute/validate an invocation's principal and workspace). **No** access to `execution_intents`, `control_requests`, `control_claims`, or any effect-bearing table — this is the DB-level enforcement of "the model gateway cannot create/lease/dispatch intents" from ADR-001 §2. |
| `ai_crm_audit_verifier` | `SELECT` only on `audit_events`, `audit_chain_heads`, `outbox_events`, `execution_intents`, `control_requests`, `control_claims`, `policy_decisions`, `principals`, `users`. No `INSERT`/`UPDATE`/`DELETE` anywhere. |
| `ai_crm_break_glass_admin` | No standing grants. Access is a time-boxed, audited role-membership elevation used only during a declared incident; the runbook that grants it must itself write an audit trail entry outside the normal `app.workspace_id`-scoped path (e.g., a security-log table or external SIEM record), since break-glass access is explicitly the path used when normal audit assumptions may not hold. |
| `ai_crm_runtime_connector_dispatcher` *(future, not created in MVP)* | Would receive `SELECT, UPDATE` on `execution_intents` (lease/dispatch/result columns for `remote`-effect entries only) and `SELECT, INSERT` on `audit_events`/`outbox_events`; only this role would ever hold a live provider credential. Not created until the connector-enablement gate in ADR-001 §2 is closed. |

Defense in depth alongside RLS/grants: `audit_events` additionally has an application-level `BEFORE UPDATE OR DELETE` trigger that raises on any mutation attempt, and `UPDATE`/`DELETE` on `audit_events` is explicitly revoked from every runtime role and `PUBLIC` — so even a grant mistake would still be caught by the trigger, and even a trigger mistake would still be caught by the missing grant.

## 6. Break-glass access model

1. Break-glass is **offline**: it is not a role any application ever authenticates as during normal operation.
2. Break-glass is **time-limited**: role membership/credential is granted for a bounded window (e.g., an expiring temporary grant tied to an incident ticket), not a standing credential.
3. Break-glass is **audited**: every session that uses break-glass access records who invoked it, the incident/ticket reference, the queries/mutations performed, and when access was revoked. This audit trail is separate from the workspace-scoped `audit_events` chain (which assumes `app.workspace_id` is set and RLS is in force) — break-glass exists precisely for situations where that assumption may not hold (e.g., diagnosing a workspace-context bug itself).
4. Break-glass **never** receives `BYPASSRLS`; if the incident genuinely requires cross-workspace visibility, that requires a superuser session under the same offline/time-limited/audited discipline, escalated explicitly, not a standing grant on `ai_crm_break_glass_admin`.

## 7. Security-definer prohibition

`SECURITY DEFINER` functions/views are prohibited unless explicitly reviewed and documented as an exception in this file (none exist yet); `SECURITY INVOKER` is the default for all functions, including `app_current_workspace_id()`, so that RLS is evaluated as the calling role, not as the function owner.

## 8. Required tests (RLS/isolation acceptance)

1. **Non-owner/no-bypass assertion:** for every runtime role, assert `rolbypassrls = false` and that the role does not own any table (`pg_tables.tableowner`), failing CI/migration acceptance if violated.
2. **FORCE RLS coverage:** assert every workspace-bound table listed in §2 has both `relrowsecurity` and `relforcerowsecurity` set; a new table added without both flags fails a migration-linter check, not just a manual review.
3. **`USING`/`WITH CHECK` coverage:** assert every workspace-bound table's policy defines both clauses; a policy with only one clause fails the same linter check.
4. **Missing-context fail-closed:** a transaction that never issues `SET LOCAL app.workspace_id` and attempts any query against a workspace-bound table raises `28000`, not an empty result set.
5. **Malformed-context fail-closed:** a transaction that sets `app.workspace_id` to a non-UUID value raises `22023`.
6. **Cross-workspace read/write denial:** seed two workspaces; a session scoped to workspace A cannot `SELECT` workspace B's rows, and cannot `INSERT`/`UPDATE` a row with `workspace_id` set to workspace B even if the row's other foreign keys resolve correctly (proves `WITH CHECK`, not just `USING`).
7. **Pool reuse leak test:** acquire a pooled connection, `SET LOCAL app.workspace_id` to workspace A inside a transaction, commit, return to pool, re-acquire the same physical connection without setting context, and assert the missing-context fail-closed behavior from test 4 still applies (proves `SET LOCAL` did not leak and/or `RESET ALL` cleared it).
8. **Migration-owner-not-bypass test:** even connected as `ai_crm_migration_owner` outside an explicit migration session, cross-workspace queries against a FORCE-RLS table are denied (proves `FORCE ROW LEVEL SECURITY`, not just `ENABLE`).
9. **Model-gateway grant-boundary test** *(role now created by `0002_model_gateway_and_break_glass_roles.sql`; test still requires a live PostgreSQL connection and is not yet exercised in CI)*: assert the model-gateway runtime role cannot `SELECT`/`INSERT`/`UPDATE` `execution_intents`, `control_requests`, or `control_claims` — a grant/permission-denied error, not an RLS-empty-result, proves the effect-table exclusion is real.
10. **Break-glass audit test:** a break-glass session performs a mutation and the incident audit trail records invoker/ticket/timestamp/queries; the session cannot obtain `BYPASSRLS` implicitly.

## 9. Outstanding gap to close before Step 5 / production (closed)

- **Closed by `0002_model_gateway_and_break_glass_roles.sql`.** This migration creates `ai_crm_runtime_model_gateway` and `ai_crm_break_glass_admin` and moves `model_invocations` write grants from `ai_crm_runtime_api`/`ai_crm_runtime_worker` to `ai_crm_runtime_model_gateway` only, per §1 and §5. Step 5 (AI execution via model gateway) can now claim ADR-010 boundary compliance, and a break-glass runbook can rely on the `ai_crm_break_glass_admin` role existing (offline/`NOLOGIN` by default, elevated only via a time-boxed, out-of-band, audited grant per §6).
- This section is kept as a historical record of the gap and how it was closed, not deleted, so the migration history and the design rationale for why `0001_foundation.sql` originally let `ai_crm_runtime_api`/`ai_crm_runtime_worker` write `model_invocations` remain traceable.
