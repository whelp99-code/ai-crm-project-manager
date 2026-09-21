# AI-CRM+PM completion plan

## Remaining work

1. Fix `npm test` (vitest/vite failed rc 1; see evidence).
2. Keep `npm run typecheck` green.
3. Local commit only after test+typecheck pass. No push.

## Done definition

- `npm run typecheck` rc 0
- `npm test` rc 0

## Evidence 2026-09-21

typecheck rc=0
/worker typecheck$ tsc -b --noEmit
apps/worker typecheck: Done
apps/api typecheck: Done
apps/web typecheck$ tsc --noEmit
apps/web typecheck: Done
npm notice run ai-crm-project-manager@2.0.0 typecheck
npm notice run pnpm -r --if-present run typecheck

