# ADR-012 — Orchestration WorkItems vs PM Tasks

| Field | Value |
|---|---|
| Status | **Proposed** (2026-07-19) |
| Deciders | Architecture Owner, Product Owner |
| Relates | ADR-011; `packages/orchestration` (planned); domain PM |

## Context

CORP-OS used a single `Task` concept for agent execution. AI-CRM already has (or will have) **delivery/PM tasks** as business entities bound to projects, scope, and approvals.

Collapsing both into one table/type causes:

- Wrong `resourceId` bindings for governance  
- Confusion between “step finished” and “deliverable accepted / ledger posted”  
- UI and audit talking past each other  

## Decision

1. Introduce **`packages/orchestration`** owning:  
   - `Job` — one natural-language or API-triggered unit of agent work  
   - `WorkItem` — ordered step inside a job  
   - `JobEvent` — UI timeline only (not audit chain)  

2. **PM/Delivery Task** remains in `packages/domain` (business backlog item).  

3. **Resource binding (required shape):** `orch_work_items` carry nullable **`resource_type`** (text/enum: `customer` | `project` | `pm_plan` | `pm_task` | …) **and** **`resource_id`** (uuid/text). Governance bindings and S1+ jobs **MUST** set both when linking a domain resource. **Bare `resource_id` without `resource_type` is invalid for S1+ bindings.** Optional link only — may point at a PM task or customer id when a step mutates that resource; never reverse ownership (PM does not own orchestration rows).

4. **Completion semantics**

   | Object | “Done” means |
   |---|---|
   | WorkItem done | Orchestration step finished (may still need no finance post) |
   | Intent SUCCEEDED | Authorized effect applied (or explicitly finished) |
   | PM Task done | Delivery domain state |
   | Ledger POSTED | Accounting fact |
   | Report snapshot | Immutable project close artifact |

5. Orchestration **must not** call `child_process`, write arbitrary files, or import provider SDKs.  

6. Persistence: `orch_*` tables are workspace-scoped with FORCE RLS (migration `0003_orchestration.sql`).  
7. Package publish name is **`@ai-crm/orchestration`**. Do not alias or re-export WorkItem APIs through `@ai-crm/ai-orchestrator`.

## Consequences

- APIs and UI must not use bare name `task` without prefix (`pm` vs `workItem`).  
- CORP TaskEngine is a reference implementation only; state machine is re-specified under governance bindings (`control_id`, `intent_id`).  
- Tests must cover illegal status transitions and “unmapped command → no domain mutate”.  

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Reuse PM tasks as agent steps | Pollutes delivery semantics; approval matrix mismatch |
| Reuse CORP Task table in SQLite | Violates ADR-011 SoR |
| No orchestration package (api-only ad hoc) | Duplicated state machines; untestable UI progress |

## Follow-ups

- [ ] Land `packages/orchestration` + unit tests (TDD T0)  
- [ ] Migration 0003 + RLS security tests  
- [ ] Document command-map keys next to GOVERNANCE_COMMANDS  
