# 05 — Acceptance Criteria

Every MUST has a normal and failure-path criterion.

| Acceptance ID | REQ | Given | When | Then |
|---|---|---|---|---|
| ACCEPT-BASE-001A | REQ-BASE-001 | clean install at the v3 branch | `pnpm check` runs | exit 0; typecheck and Vitest complete |
| ACCEPT-BASE-001B | REQ-BASE-001 | strict TypeScript remains enabled | a `pg` import and v2 core compile | no ambient-any or unused-import error; no skip/ignore added |
| ACCEPT-COMPAT-001A | REQ-COMPAT-001 | frozen v2 contract fixtures | v2 state/readiness/command tests run | all prior status/header/body expectations pass |
| ACCEPT-COMPAT-001B | REQ-COMPAT-001 | v3 files are present | an unauthorized v2 request runs | the same pre-v3 401/403 response is returned |
| ACCEPT-ACT-001A | REQ-ACT-001 | workspace A source record | the projector receives the same event twice | one OPEN row exists and version is stable on replay |
| ACCEPT-ACT-001B | REQ-ACT-001 | workspace A actor and workspace B source | an upsert/read is attempted | exact 404 `NOT_FOUND` with the same safe body as an absent ID; no row or cross-workspace audit data |
| ACCEPT-ACT-001C | REQ-ACT-001 | OPEN action, owner actor, current version, reason and evidence | dismiss is requested with a new idempotency key | status becomes DISMISSED once and audit/outbox are appended |
| ACCEPT-ACT-001D | REQ-ACT-001 | assigned team member, stale version, missing reason, or replay with different body | dismiss is attempted | 403/409/422; status remains OPEN and no duplicate event exists |
| ACCEPT-GOLD-001A | REQ-GOLD-001 | canonical Golden Flow fixture | `GET /api/cwos/v3/overview` runs | ordered stages, blockers, finance, approvals, and evidence are returned |
| ACCEPT-GOLD-001B | REQ-GOLD-001 | database/API unavailable | `/v3` loads | explicit unavailable state; no READY or zero-value fabrication |
| ACCEPT-GOLD-002A | REQ-GOLD-002 | ACTIVE engagement with an OPEN due action | transition is requested with current version | transition succeeds and audit/outbox are appended |
| ACCEPT-GOLD-002B | REQ-GOLD-002 | ACTIVE engagement without an OPEN action | transition is requested | 409 `NEXT_ACTION_REQUIRED`; engagement is unchanged |
| ACCEPT-GOLD-003A | REQ-GOLD-003 | a new inquiry fixture and owner controls | the E2E drives inquiry→engagement→commitment→quote approval→contract→delivery→purchase→financial item→partial settlement→renewal | every transition is exercised, audit-linked, and visible in the final v3 overview with exact money |
| ACCEPT-GOLD-003B | REQ-GOLD-003 | quote, purchase, or settlement lacks the required human control or project link | the E2E attempts the transition | 403/409; canonical stage and balances remain unchanged and a blocker/remediation action is visible |
| ACCEPT-FIN-001A | REQ-FIN-001 | invoices, partial receipts, purchases, and payments | finance summary loads | receivable, payable, margin, and cash risk match fixture totals exactly |
| ACCEPT-FIN-001B | REQ-FIN-001 | a canonical financial item with `engagementId=null`, valid account ID, and OUT direction | producer mutation commits, then the live worker projector runs twice | outbox partition is `account:{accountId}`, one PAYABLE remediation action is OPEN with `engagementId=null`, no duplicate exists, overview GET remains write-free, and ambiguous money is excluded |
| ACCEPT-AI-001A | REQ-AI-001 | allow-listed evidence and budget | proposal generation succeeds | PROPOSED contains evidence refs, confidence, model, prompt version, and cost |
| ACCEPT-AI-001B | REQ-AI-001 | quarantined prompt-injection evidence or empty refs | generation is requested | 422/403; no proposal and no external effect |
| ACCEPT-APP-001A | REQ-APP-001 | pending control and human owner | owner approves and consumes once | one CONSUMED event and one effect intent exist |
| ACCEPT-APP-001B | REQ-APP-001 | AI actor, expired control, or replay | consume is attempted | 403/409; no effect intent is created |
| ACCEPT-CUT-001A | REQ-CUT-001 | PLANNED import plan and exact source/target counts, sums, required fields, and hash | validate then owner-controlled apply runs with one idempotency key per mutation | reconciliation report row is append-only, plan becomes APPROVED then APPLIED, and apply verifies the stored report hash |
| ACCEPT-CUT-001B | REQ-CUT-001 | count, money, hash, required-field, version, or control mismatch | validate/apply is attempted | plan remains PLANNED or APPROVED; exact 409/422 is returned and no canonical apply event exists |
| ACCEPT-OPS-001A | REQ-OPS-001 | exact commit, V0..V9 each PASS, completed pilot evidence, zero high findings | completion is requested | pilot becomes PASSED; V10 is recorded by this acceptance and production V11 remains BLOCKED |
| ACCEPT-OPS-001B | REQ-OPS-001 | any V0..V9 gate is FAIL/BLOCKED/NOT_RUN or missing | completion is requested | pilot becomes FAILED for any FAIL, otherwise BLOCKED; PASSED and production approval are false |
