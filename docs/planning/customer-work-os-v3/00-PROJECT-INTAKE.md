# Customer Work OS v3 — Project Intake

- Status: `READY_WITH_ASSUMPTIONS`
- Plan tier: `L`
- Plan date: 2026-08-15
- Baseline branch: `release/customer-work-os-v1-stabilization`
- Baseline commit: `cdefbeff4ba56782558d974a7a7dcb28f942d265`
- Baseline tree: `9e37bad8c86cd0c860f16501e5251ee95b47a46e`
- Product label: **Customer Work OS v3.0 — Pilot Operations**

## Goal

`CONFIRMED` v2.0.0 provides Identity, PSA, Inbox, connectors, graphs, AI Council, portal, operations, PostgreSQL snapshot persistence, audit chaining, tests, and a release gate. v3 must convert that broad implementation surface into one operator-visible Golden Flow that can be run with real PostgreSQL data and human approvals.

## User-visible outcome

An owner can open `/v3`, see prioritized work and evidence, move one customer engagement from inquiry through delivery and financial settlement, review AI proposals, approve every external or monetary effect, and complete a pilot run whose release evidence is fail-closed.

## In scope

- Restore the v2 baseline to a green local static/test gate before feature work.
- Preserve all `/api/cwos/v2/*` contracts while adding explicit v3 resources.
- Compose existing CWOS CRM, PSA, finance, governance, imports, AI, and operations modules.
- Add a PostgreSQL-backed action-item projection and pilot-run evidence record.
- Add the `/v3` Action Hub and Golden Flow E2E.
- Add cutover reconciliation, pilot evidence, and a v3 release gate.

## Out of scope

- Production deployment, DNS, GitHub Release, merge to `master`, or customer communication.
- Autonomous sending, payment, quote acceptance, deletion, or connector writes.
- Replacing PostgreSQL with another source of record.
- General-purpose accounting, tax filing, payroll, inventory optimization, or a multi-tenant billing platform.
- Removing v1/v2 routes or rewriting stable domain modules solely for naming consistency.
- OIDC provider procurement or external ERP selection; v3 only exposes integration contracts.

## Actors

- Owner/Operator: Jae Min Park; owns approval and pilot acceptance.
- Future Team Member: read/work permissions bounded by workspace membership.
- AI/Service Principal: proposal generation and read-only preparation only.
- Customer/Partner Portal Principal: allow-listed fields only.
- Release Reviewer: independent verifier of evidence and open findings.

## ASSUMED decisions

| ID | Assumption | Basis | Impact | Safe default | Rollback |
|---|---|---|---|---|---|
| A-001 | v3 means Pilot Operations, not a replacement platform. | v2 source is implemented but production evidence is explicitly absent. | Focuses work on real use and proof. | Preserve v2 and compose it. | Remove v3 routes/tables without touching v2. |
| A-002 | One owner workspace is the first pilot. | Project charter is 1-person-company first. | UI and metrics optimize for one operator. | Keep workspace isolation and multi-user-compatible IDs. | Disable delegated team action capability and return to owner-only operation. |
| A-003 | PostgreSQL 16 remains the only transactional source of record. | Existing charter and release gate. | New durable data uses RLS and transactions. | No dual-write to Notion. | Drop additive v3 projection after export. |
| A-004 | Existing `/api/cwos/*` domain endpoints remain canonical. | 94 existing routes cover CRM, delivery, finance, approvals, and imports. | v3 is an orchestration/read-model layer. | Do not clone canonical entities. | Disable v3 composition routes. |
| A-005 | External connectors stay read-first in v3. | Existing connector policy and human-authority doctrine. | No automatic send/write acceptance criterion. | Require a governance control and explicit consume step. | Revoke connector write capability. |
| A-006 | Korean owner-facing UI is the default. | Existing v2 page and user preference. | UI copy and operator runbooks are Korean. | Keep API identifiers English. | Restore the Korean static-copy surface if an experimental locale layer is rejected. |

## Batch questions

No blocking question remains. If the owner later selects a real pilot customer, identity provider, or production host, those values enter only the MANUAL gates in `19-DEFINITION-OF-DONE.md`; implementation starts with synthetic, non-sensitive fixtures.
