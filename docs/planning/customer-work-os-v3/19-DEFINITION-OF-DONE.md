# 19 — Definition of Done

## Product completion

v3.0 source is complete only when all 11 MUST requirements in `04-REQUIREMENTS.md` are implemented, their normal and failure criteria pass, the traceability table has evidence links, v2 compatibility remains green, and no CRITICAL/HIGH finding is open.

Production readiness additionally requires MANUAL V9/V10/V11 evidence. Source completion alone cannot set production approval.

## AUTONOMOUS segment

An implementation agent may execute PR-001 through the local portion of PR-008: source edits, migrations in local/CI databases, tests, builds, Playwright, documentation, evidence bundles, and draft release manifest. It may not push, merge, deploy, contact customers, activate provider writes, or use real customer data without a separate instruction.

## MANUAL segment

| ID | Owner | When | Action | Blocks |
|---|---|---|---|---|
| M-001 | Repository owner | after PR-008 local gate | authorize push/PR and observe GitHub Actions | V9 and release candidate |
| M-002 | Product owner | after V9 | select consented pilot customer/data set and approve privacy handling | V10 |
| M-003 | Product owner + release reviewer | after controlled pilot | sign pilot acceptance and residual-risk record | v3.0 approval |
| M-004 | Infrastructure/security owner | before production | choose host, inject credentials, verify backup/restore and access policy | V11 |
| M-005 | Product owner | after V11 | explicitly authorize deployment and connector write capabilities | production effect |

## Known Adjustment Points

| # | Planned assumption | Why it may differ | Implementation-agent check |
|---|---|---|---|
| 1 | `apps/api/src/app-base.ts` owns v3 registration | registration may move during PR-001 | trace callers of `createApp` and `registerCustomerWorkOsV2Routes` |
| 2 | contracts export from `packages/contracts/src/index.ts` | package export map may use another barrel | inspect package.json exports and current index |
| 3 | persistence exports from `packages/persistence/src/index.ts` | repository pattern may use per-adapter files | inspect existing PG adapter exports |
| 4 | existing auth exposes owner/reviewer roles | role names may differ | trace `actor(request)` and governance authorization |
| 5 | existing AI suggestions support v3 fields | stored contract may require metadata extension | inspect migration 0016 and AI store before editing |
| 6 | overview can read one consistent transaction | existing repositories may open independent connections | trace pool/client ownership and add an explicit read-session adapter if required |
| 7 | web E2E server exposes `/v3` with existing fixture tools | fixture helpers may be route-specific | inspect `apps/web/e2e/live-server.ts` and current specs |

At these points, if source differs from the plan, the implementation agent must inspect the actual symbol and adapt the mechanical integration without changing the requirement or security contract, then report the adjustment. A contract contradiction is `BLOCKED` and requires owner review.

## Evidence hygiene

- Store commands, exit codes, changed paths, test counts, and commit SHA.
- Redact secrets, authorization headers, cookies, connection strings, raw customer text, and personal data.
- Label every gate PASS, FAIL, BLOCKED, or NOT_RUN.
- Never convert CI/local/manual evidence from one layer into a claim about another.

## REVIEW LOG

| Pass | Verdict at pass time | Findings | Disposition |
|---|---|---|---|
| 1 | FAIL | CRITICAL 6 / HIGH 7 / MEDIUM 2 / LOW 1 | Fixed false-green commands, pilot cycle, OpenAPI ownership, pure-read conflict, exact 404, canonical AI states, full Golden Flow, cutover contract, overview schema, PR ordering, dismiss/transition contracts, rollback, authorization, counts, and assumption rollback. |
| 2 | FAIL | CRITICAL 4 / HIGH 3 / MEDIUM 1 / LOW 0 | Fixed app-base metadata scope, dedicated reconciliation persistence, repository dismiss, actual durable transition ownership, inherited concurrency failure/scope, runtime worker projection ownership, and dispatch counts. |
| 3 | FAIL | CRITICAL 1 / HIGH 2 / MEDIUM 3 / LOW 1 | Added atomic typed projection producer/outbox/worker path; defined canonical report hashing; narrowed cutover side effects; corrected ADR table count, traceability, and PR-001 command count. |
| 4 | FAIL | CRITICAL 1 / HIGH 0 / MEDIUM 1 / LOW 0 | Made engagement linkage nullable, added deterministic account partitioning and exact financial/settlement mappings, added null-link live evidence, and aligned ADR-V3-002 with all four derived tables. |
| 5 | PASS | CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 0 | Independent final review confirmed nullable-link mappings, four-table architecture, commands, ownership, budgets, dependencies, and mechanical checks with no remaining finding. |

All pass-1 through pass-4 findings have concrete contract or ownership changes in this plan. Pass 5 is the delivery gate and has no remaining finding.
