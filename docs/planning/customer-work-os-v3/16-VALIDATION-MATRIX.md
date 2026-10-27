# 16 — Validation Matrix

| Gate | Evidence | Command/surface | Success | Failure state |
|---|---|---|---|---|
| V0 Baseline | command log | `pnpm check` | exit 0 | FAIL |
| V1 Compatibility | v2 contract report | API/domain package tests | all v2 cases pass | FAIL |
| V2 Migration | SQL/test log | PG16 apply + persistence tests | all migrations and RLS checks pass | FAIL |
| V3 Golden Flow API | integration report | API v3 integration test | happy and failure paths pass | FAIL |
| V4 Finance | invariant report | finance/API tests | exact fixture amounts | FAIL |
| V5 Security | security report | security suites | workspace/approval/injection cases pass | FAIL |
| V6 Web build | build log | web production build | exit 0 | FAIL |
| V7 Browser | Playwright report | v3 E2E | owner flow and fail-closed state pass | FAIL |
| V8 Restore | dump/restore report | PG dump→restore→verify | counts/hash and v3 read equal | FAIL |
| V9 CI | GitHub run link | v3 release workflow | all required jobs success with non-zero security/integration test counts | NOT_RUN or FAIL |
| V10 Pilot acceptance | signed evidence | completion over gateResults V0..V9 | derived pilot state PASSED and owner accepts metrics/findings=0 | BLOCKED until MANUAL |
| V11 Production | explicit approval | deployment checklist after V10 | separate owner approval | BLOCKED until MANUAL |

Rules:

- Missing evidence is `NOT_RUN` or `BLOCKED`, never PASS.
- A successful local run does not satisfy V9.
- V10 uses non-sensitive identifiers in committed evidence; customer-private artifacts stay outside Git.
- V11 is not part of autonomous implementation.
- `cwos_v3_pilot_runs.gate_results` contains only V0..V9. V10 is the acceptance transition; V11 is never a pilot prerequisite.
