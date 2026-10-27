# 14 — PR Roadmap

Detailed scopes and copy-ready dispatch prompts live in `prs/PR-001` through `prs/PR-008`.

| PR | Title | Risk | Type | Predecessor | Direct files | New files | Migration |
|---|---|---|---|---|---:|---:|---:|
| PR-001 | Restore inherited green baseline | R2 | SEQUENTIAL | none | 3 | 0 | 0 |
| PR-002 | v3 contracts and PostgreSQL operations | R3 | SEQUENTIAL | PR-001 | 2 | 4 | 1 |
| PR-003 | Golden Flow walking skeleton | R3 | SEQUENTIAL | PR-002 | 6 | 5 | 0 |
| PR-004 | Finance and settlement visibility | R3 | SEQUENTIAL | PR-003 | 9 | 4 | 0 |
| PR-005 | Owner Action Hub | R2 | SEQUENTIAL | PR-004 | 1 | 3 | 0 |
| PR-006 | AI proposal and human approval | R3 | SEQUENTIAL | PR-005 | 3 | 2 | 0 |
| PR-007 | Cutover reconciliation and pilot operations | R3 | SEQUENTIAL | PR-006 | 4 | 3 | 0 |
| PR-008 | Release gate and v3 candidate | R3 | EXCLUSIVE | PR-007 | 2 | 2 | 0 |

Every PR stays within the default budget of 12 modified files, 8 new files, 500 logical lines, and 1 migration. If implementation exceeds a budget, the author stops and proposes a numbered split before editing more files.

## Vertical-slice rationale

- PR-002 establishes contracts and durable storage required by every flow.
- PR-003 is the thinnest end-to-end path: canonical source → action projection → overview API → integration test.
- PR-004/005/006 add finance, browser, and AI/approval outcomes in contract order without reopening canonical schema.
- PR-007 proves real transition and reconciliation behavior.
- PR-008 verifies the assembled surface on one commit.

## Rolling wave

- PR-001: decomposed through DETAIL files.
- PR-002: decomposed through SUB files; DETAIL decomposition occurs after PR-001 reports actual dependency and TypeScript state.
- PR-003..PR-008: `DECOMPOSITION: PENDING` appears in each README with a predecessor-based reason.
