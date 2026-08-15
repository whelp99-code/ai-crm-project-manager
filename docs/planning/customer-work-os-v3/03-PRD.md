# 03 — Product Requirements Document

## Product statement

Customer Work OS v3.0 — Pilot Operations turns the v2 platform into a daily operating surface for a one-person company. It prioritizes commitments, advances one engagement across sales/delivery/finance states, prepares evidence-bound AI proposals, requires owner approval for consequential actions, and records pilot/release evidence.

## Problem

`CONFIRMED` v2 exposes broad modules and readiness evidence. `CONFIRMED` the repository also contains canonical CWOS business endpoints. `INFERRED` an owner still lacks one surface that answers:

1. What must I do today and why?
2. Which customer promise, delivery item, invoice, or settlement is blocked?
3. What did AI propose, with which evidence and confidence?
4. Which action requires my approval?
5. Can this exact build be accepted for a controlled pilot?

## Primary workflow

Inbox event → account and engagement link → commitment and next action → quote and approval → contract and delivery handover → purchase/delivery progress → financial item and settlement → profitability/cash view → maintenance/renewal action → pilot evidence completion.

## v3 success measures

| Measure | Acceptance target |
|---|---|
| Active engagement next-action coverage | 100% in Golden Flow fixture and pilot report |
| Canonical record workspace linkage | 100% of v3 responses scoped to authenticated workspace |
| Unauthorized external or monetary effects | 0 |
| AI proposal evidence refs | at least 1 valid evidence ref per actionable proposal |
| Idempotent command replay | same result, no duplicate row/event |
| Golden Flow E2E | pass in PostgreSQL mode and production web build |
| Cutover count and money reconciliation | exact equality before cutover acceptance |
| Pilot release findings | 0 open CRITICAL/HIGH findings |

## Functional slices

- Baseline repair and compatibility contract.
- v3 action projection and overview API.
- Golden Flow sales-to-delivery composition.
- Finance/settlement and cash-risk composition.
- Action Hub and approval inbox integration.
- Evidence-bound AI proposal lifecycle.
- Import/cutover reconciliation and pilot operations.
- Release gate, runbook, and controlled pilot evidence.

## Non-functional constraints

- PostgreSQL 16, FORCE RLS, transaction-scoped `app.workspace_id`.
- v2 HTTP behavior remains byte-compatible for existing contract tests.
- API errors never include stack traces, secrets, provider payloads, or cross-workspace identifiers.
- All mutations require authentication, authorization, an idempotency key, and audit evidence.
- Browser surfaces fail closed when API evidence is unavailable.
- One migration per PR maximum and forward-fix rollback for applied migrations.

## Release boundary

Source completion, local tests, GitHub Actions, controlled pilot, production approval, merge, tag, and deployment are distinct states. v3 source completion does not authorize any outward-facing action.
