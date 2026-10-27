# 01 — Discovery

## Repository map

`CONFIRMED` by code graph index `ai-crm-project-manager-cwos-v2-local` at baseline commit:

| Area | Evidence | v3 use |
|---|---|---|
| API | `apps/api/src/app-base.ts`, 94 discovered routes | Register versioned read/composition routes; reuse auth and governance hooks. |
| v2 runtime | `apps/api/src/customer-work-os-v2-*.ts` | Preserve state/readiness/command behavior unchanged. |
| Domain | `packages/domain/src/customer-work-os.ts`, `customer-work-os-v2/` | Reuse canonical CRM/PSA/Identity/Inbox/Portal/Operations services. |
| Finance | `packages/finance/src/` | Reuse ledger, reconciliation, and daily-gate invariants. |
| Governance | `packages/governance/src/`, `/api/governance/controls/*` | Bind external and monetary effects to explicit controls. |
| Persistence | migrations `0001` through `0019` | Add one forward-only v3 operations migration after existing CWOS tables. |
| Imports | `packages/imports/src/`, `cwos_notion_import_plans` | Reuse dry-run, reconciliation, and event evidence. |
| AI | `packages/ai-orchestrator/`, `cwos_ai_suggestions` | Reuse evidence/confidence/review records; never grant direct effects. |
| Web | `apps/web/app/v2/page.tsx`, `/work`, `/approvals`, `/pilot` | Add `/v3` as operator Action Hub and keep existing routes. |
| Verification | `vitest.config.ts`, Playwright, `.github/workflows/customer-work-os-release-gate.yml` | Extend the same Node 20/22, PostgreSQL 16, browser, security, and restore gates. |

## Architectural facts

- `CONFIRMED` `CustomerWorkOsV2State` contains Identity, PSA, Inbox, connectors, graphs, AI Council, portal, admin, operations, milestones, findings, and manifests.
- `CONFIRMED` v2 exposes `GET /api/cwos/v2/state`, `GET /api/cwos/v2/readiness`, and `POST /api/cwos/v2/commands`.
- `CONFIRMED` v2 commands are a string switch and cover setup/operational modules, but do not provide one Golden Flow read model.
- `CONFIRMED` canonical CWOS endpoints already cover accounts, engagements, activities, commitments, quotes, contracts, delivery, purchase orders, assets, financial items, settlements, cockpit, AI suggestions, and Notion plans.
- `CONFIRMED` `0012_customer_work_os.sql` contains canonical business tables and FORCE RLS; `0019_customer_work_os_v2_runtime.sql` contains v2 snapshot/audit tables.
- `CONFIRMED` `/v2` is a readiness page, not an interactive operator cockpit.

## Product gap

`INFERRED` the principal gap is composition and real-pilot proof, not absence of domain breadth. Duplicating the canonical entities in a second v3 aggregate would create two sources of truth. v3 therefore adds a derived action projection, resource-specific orchestration APIs, an Action Hub, and evidence gates over existing canonical records.

## Stop-reading decision

Discovery is sufficient because the next implementation decisions are supported by exact route, table, test, and UI evidence. Implementation agents must inspect the named symbols at each Known Adjustment Point before editing.
