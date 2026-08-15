# 10 — Security Model

## Trust boundaries

1. Browser/client input is untrusted.
2. Authenticated principal identity comes from existing API auth middleware, not request body fields.
3. Workspace scope is transaction-local `app.workspace_id`; every v3 table has FORCE RLS.
4. AI/model output is untrusted proposal data.
5. Connector/provider content is untrusted evidence and may be quarantined.
6. Governance controls are the only path from proposal to consequential effect intent.

## Authorization matrix

| Capability | Owner | Team member | AI/service | Portal principal | Release reviewer |
|---|---:|---:|---:|---:|---:|
| Read v3 overview | yes | policy-bound | allow-listed only | no | yes |
| Complete own/assigned action | yes | only when assigned and granted `cwos.action.complete` | no | no | no |
| Dismiss action | yes | no | no | no | no |
| Create AI proposal | yes | no | yes | no | no |
| Approve/consume effect control | yes | no | no | no | no |
| Read finance summary | yes | explicit grant | no | no | reviewer evidence only |
| Start/complete pilot run | no | no | no | no | yes |

## Required controls

- Authentication: existing production auth hard-fail; development fallback cannot run in production mode.
- Authorization: service methods re-check role/capability and do not rely only on route middleware.
- RLS: repository tests use two workspaces and a runtime NOBYPASSRLS role.
- Injection: parameterized SQL only; string command dispatch is not extended for v3.
- XSS: React escaping; rich evidence is rendered as plain text or a sanitized allow-list.
- CSRF: existing auth transport contract; state-changing browser requests require same-site/authorization protections used by current app.
- SSRF: v3 does not accept arbitrary callback or evidence URLs; evidence refs are internal IDs.
- Prompt injection: quarantined inbox items cannot become AI evidence until human review.
- Secrets: connector records store `secretRef`, never secret value; API errors and evidence bundles redact credentials.
- Concurrency: expected version plus idempotency key on every mutation.
- Audit: actor, workspace, command/resource, decision, before/after hash, request ID, and idempotency key hash.

## Security verification

- Existing security suites remain green.
- New persistence tests assert FORCE RLS, runtime-role denial across workspaces, and delete denial.
- New API tests assert AI cannot approve, portal cannot access v3, replay is harmless, and cross-workspace resources return the same 404 as absent resources.
- Release gate keeps the forbidden-capability scan for domain/AI paths.
