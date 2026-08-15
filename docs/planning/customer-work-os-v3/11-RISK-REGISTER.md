# 11 — Risk Register

Risk score = Probability × Impact × Detectability. R1 1..15, R2 16..35, R3 36..75, R4 76..125.

| Risk | Description | P | I | D | Score | Class | Prevention | Recovery |
|---|---|---:|---:|---:|---:|---|---|---|
| R-001 | Cross-workspace overview or action leak | 3 | 5 | 4 | 60 | R3 | FORCE RLS, scoped transaction, two-workspace tests | disable v3 routes; revoke runtime role; audit affected requests |
| R-002 | v3 duplicates canonical business source of truth | 3 | 5 | 4 | 60 | R3 | ADR-V3-002, projection-only tables, no direct handler SQL | stop projector; discard/rebuild derived actions |
| R-003 | AI or replay causes unauthorized effect | 3 | 5 | 4 | 60 | R3 | human-only decision, single-use consume, idempotency | revoke control and adapter capability; audit effect intent |
| R-004 | migration 0020 blocks startup or weakens RLS | 2 | 5 | 3 | 30 | R2 | transactional migration, PG16 CI, privilege assertions | restore pre-migration backup or forward-fix privileges |
| R-005 | stale action projection hides urgent work | 4 | 4 | 3 | 48 | R3 | source versions, outbox lag health, reconciliation job | full projection rebuild from canonical records |
| R-006 | finance summary misstates cash or margin | 3 | 5 | 3 | 45 | R3 | reuse finance services, integer money, invariant fixtures | suppress summary, open remediation action, reconcile ledger |
| R-007 | release/pilot reports false READY | 3 | 5 | 4 | 60 | R3 | fail-closed validation matrix and immutable commit | change run to BLOCKED/FAILED; invalidate manifest |
| R-008 | v3 changes break v2 clients | 3 | 4 | 2 | 24 | R2 | frozen v2 contract suite on every PR | unregister v3; revert additive registration |
| R-009 | prompt-injection evidence reaches AI | 3 | 5 | 4 | 60 | R3 | quarantine gate and allow-listed evidence | quarantine proposal/evidence; rotate compromised connector credential if exposed |
| R-010 | Golden Flow scope expands into ERP/accounting rewrite | 4 | 4 | 2 | 32 | R2 | explicit out-of-scope and PR budgets | reject scope-changing diff; create separate plan |

## R3 failure modes

| Risk | Trigger | Failure | Detection | Recovery gate |
|---|---|---|---|---|
| R-001 | request context and DB workspace differ | data from another workspace appears | two-workspace test, audit anomaly | zero leaked rows in replay and security-owner review |
| R-002 | v3 writes duplicate account/finance state | sources disagree | reconciliation mismatch | derived-only schema restored and canonical counts unchanged |
| R-003 | non-human/replayed control consumption | duplicate or unauthorized intent | actor/replay tests, audit chain | no unapproved adapter effect; control revoked |
| R-005 | outbox lag or projector failure | action list omits source change | source-version watermark and lag alert | rebuild matches canonical source count/hash |
| R-006 | incorrect link, rounding, or partial settlement | wrong receivable/payable/margin | invariant tests and count/sum report | summary hidden until exact reconciliation PASS |
| R-007 | missing gate treated as success | release candidate appears ready | NOT_RUN/BLOCKED state test | manifest invalidated; all gates rerun on exact commit |
| R-009 | malicious provider text enters evidence | unsafe model proposal | quarantine and evidence lineage test | evidence removed, proposal rejected, connector reviewed |

No R4 risk is accepted. Discovery that a planned change requires autonomous payment/sending, destructive cutover, or unbounded multi-tenant exposure raises the plan to XL and stops implementation.
