# 06 — Architecture

## Target shape

```text
apps/web/app/v3
  -> GET/POST /api/cwos/v3/*
    -> V3 composition service in apps/api
      -> canonical CWOS domain/runtime services
      -> finance and governance services
      -> imports and AI suggestion stores
      -> PostgreSQL v3 action/pilot repositories
        -> existing canonical tables + migration 0020 additive tables
```

The v3 layer owns orchestration and read composition. It does not own duplicate Account, Engagement, Quote, Delivery, Financial Item, Settlement, Identity, or Audit aggregates.

Canonical mutations publish outbox events. The v3 projector derives action items idempotently; overview GET handlers never mutate. Existing and v3 engagement transition routes share one next-action guard so neither route bypasses the invariant.

## ADRs

### ADR-V3-001 — Additive versioning

Status: ACCEPTED / Date: 2026-08-15 / Related: REQ-COMPAT-001

Context: v2 has stable runtime routes and source tests. / Options: replace v2; mutate v2 in place; add v3 resources. / Decision: add `/api/cwos/v3/*` and `/v3`; preserve v2 unchanged. / Reason: compatibility and reversible rollout. / Consequences: temporary parallel API versions; explicit contract tests. / Rollback: unregister v3 routes and hide `/v3`.

### ADR-V3-002 — Compose canonical records

Status: ACCEPTED / Related: REQ-GOLD-001, REQ-FIN-001

Context: canonical CWOS CRM/PSA/finance tables already exist. / Options: v3 JSON snapshot; duplicate normalized tables; compose canonical records plus derived operational state. / Decision: compose canonical data and persist only the four derived operational tables named in ADR-V3-004; no Account, Engagement, Quote, Delivery, Financial Item, or Settlement copy is stored. / Reason: one source of truth. / Consequences: overview queries span repositories and projection health must be visible. / Rollback: disable v3 writers/consumers; canonical records remain intact.

### ADR-V3-003 — Human authority boundary

Status: ACCEPTED / Related: REQ-AI-001, REQ-APP-001

Context: AI may prepare but not approve consequential effects. / Options: autonomous adapters; policy threshold auto-approval; governance control consumed by human. / Decision: human-only approval and single-use consume. / Reason: project charter and safety. / Consequences: some workflows pause. / Rollback: reject/revoke pending controls; no external write has occurred.

### ADR-V3-004 — One additive migration

Status: ACCEPTED / Related: REQ-ACT-001, REQ-OPS-001

Context: v3 needs durable actions, pilot evidence, cutover reports, and a typed projection bridge. / Options: reuse snapshot JSON; reuse incompatible governance outbox; add many domain tables; add four operational tables in `0020`. / Decision: one migration for `cwos_v3_action_items`, `cwos_v3_pilot_runs`, `cwos_v3_reconciliation_reports`, and `cwos_v3_projection_outbox`. / Reason: indexed queries, auditable evidence, and an atomic canonical-event bridge without canonical duplication. / Consequences: repository, worker, and RLS tests expand. / Rollback: stop v3 writers/worker, export evidence, and use reviewed forward-fix before any separately approved table removal.

### ADR-V3-005 — Resource-specific commands

Status: ACCEPTED / Related: REQ-ACT-001, REQ-APP-001, REQ-OPS-001

Context: v2 uses a generic command switch with high complexity. / Options: extend switch; new generic v3 switch; resource-specific routes with typed bodies. / Decision: resource-specific v3 routes and OpenAPI schemas. / Reason: narrower authorization, errors, and tests. / Consequences: more endpoints, lower dispatch ambiguity. / Rollback: remove v3 route registrations.

OpenAPI implementation decision: PR-003 extends the current generator to consume Fastify route schema metadata. Every later v3 registrar supplies complete schemas; ordered PRs append contract assertions. Static hand-maintained path lists are not used for v3.

## Version and concurrency contract

- Every mutable v3 resource has integer `version >= 0`.
- Mutation bodies carry `expectedVersion`; stale writes return `409 VERSION_CONFLICT`.
- Every mutation requires `Idempotency-Key`; replay returns the original result and does not append duplicate audit/outbox records.
- Canonical entity writes use existing repository transaction boundaries; projection writes are in the same database transaction when the call path supports it, otherwise outbox processing converges idempotently.
