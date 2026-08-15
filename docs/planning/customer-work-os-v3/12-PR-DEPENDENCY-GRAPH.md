# 12 — PR Dependency Graph

```text
PR-001 Baseline Green
  -> PR-002 Contracts + PostgreSQL Operations
      -> PR-003 Golden Flow Walking Skeleton
          -> PR-004 Finance + Settlement Visibility
              -> PR-005 Action Hub UI
                  -> PR-006 AI Proposal + Human Approval
                      -> PR-007 Cutover + Pilot Operations
                          -> PR-008 Release Gate + Acceptance
```

PR-004 through PR-008 are sequential because route registration, OpenAPI assertions, browser contracts, and pilot evidence build on the previous response shape. This removes same-file parallel ownership. PR-008 uses one immutable candidate commit.

Cycle check: PASS. Every edge points from a lower PR number to a higher number. No reverse dependency exists.

## Gates between PRs

- G0 after PR-001: `pnpm check` exit 0.
- G1 after PR-002: migration + RLS + repository tests PASS on PostgreSQL 16.
- G2 after PR-003: overview and action-item integration tests PASS; v2 contract PASS.
- G3a after PR-004: finance invariants and write-free overview PASS.
- G3b after PR-005: browser Action Hub PASS.
- G3c after PR-006: AI/approval security PASS.
- G4 after PR-007: reconciliation fixture and controlled pilot E2E PASS.
- G5 after PR-008: full release matrix PASS on the exact commit; MANUAL approvals still separate.
