# Pilot wizard LIVE-LOOP e2e (D1/D9)

Closes the "wizard live loop operator-manual" gap: `/pilot` previously only
had a fail-closed e2e (`apps/web/e2e/pilot-wizard.spec.ts`) proving the
4-step wizard renders and navigates client-side without a live API. This
adds a second, REAL browser-driven proof that a pilot operator can walk the
full S0 loop — submit a natural-language command, have a *different*
principal (SoD) approve the resulting governance checkpoint, and see the
job reach a terminal state — against a real `@ai-crm/api` Fastify app, not a
mock.

## What's real vs. deterministic

- **Real**: the exact production Fastify route table (`createApp()` from
  `apps/api/src/app.ts`), the exact `/pilot` Next.js page/wizard component,
  a real headless Chromium browser driven by Playwright, real HTTP calls
  over the loopback network.
- **Deterministic (no network)**: the injected `modelClient` — same stub
  pattern as `apps/api/test/s0-natural-command.integration.test.ts`
  (`planClient`). No Azure/OpenAI call is made; that live model-gateway
  proof is a separate deliverable (D7).
- **In-memory SoR**: no `DATABASE_URL` is passed, so this proves the
  wizard's HTTP/governance contract, not PG persistence (that's the
  M1/M2 live-PG scope — see `docs/ops/*` for those drills).

## Files

- `apps/web/e2e/live-loop-env.ts` — single source of truth for ports,
  workspace/principal ids, and the exact deterministic PM_TASK_ASSIGN
  payload, shared by the config, the server harness, and the spec so they
  can never drift apart.
- `apps/web/e2e/live-server.ts` — boots the real API (`createApp()`) on
  `127.0.0.1:$PILOT_LIVE_API_PORT` (default `4391`), seeds one PM plan/task
  via the real `POST /api/pm/plans` route, and adds a **test-harness-only**
  CORS hook (apps/api itself has no CORS layer; production doesn't need one
  because the wizard is normally same-origin-proxied — here the browser
  talks directly to a second dev port, so the harness adds the header
  itself, not `apps/api/src/app.ts`).
- `apps/web/playwright.live.config.ts` — second Playwright project with
  **two** `webServer`s: the live API (via `tsx`, resolved from the pnpm
  store — no new `tsx` dependency was installed, it's already vendored
  transitively) and `next dev` pointed at that live API through
  `API_BASE_URL`/`WORKSPACE_ID`/`OPERATOR_PRINCIPAL_ID`/
  `APPROVER_PRINCIPAL_ID` envs.
- `apps/web/e2e/pilot-live-loop.spec.ts` — the spec itself.
- `apps/web/playwright.config.ts` — unchanged default project now has
  `testIgnore: /pilot-live-loop\.spec\.ts/` so the default fail-closed run
  never tries to boot two extra servers.

## What the spec proves, step by step

1. **Step 2 (submit)** — fills the operator principal + command text in the
   real `/pilot` UI and clicks 명령 전송 (submit). This is a real
   `POST /api/agent/commands` call from the browser. Asserts the wizard
   auto-advances to step 3 and a `jobId`/status is tracked.
2. **Step 3 (approve)** — asserts a `Control ID` was populated from the
   live job, fills a **different** approver principal (separation of
   duty), and clicks 승인 (approve) — a real
   `POST /api/governance/controls/:id/decide` call. Asserts the UI shows
   `APPROVE → APPROVED`.
3. **Completing the loop** — turning an `APPROVED` checkpoint into a
   `done` work item still requires the governance `consume` + agent
   work-item `complete` calls; there is no shortcut in the API (see
   `apps/api/test/s0-natural-command.integration.test.ts` S0-I-06, the
   canonical happy path this spec mirrors byte-for-byte, including the
   `canonicalHashOf("PM_TASK_ASSIGN", payload)` binding). Those two calls
   are made directly against the same live API via Playwright's `request`
   fixture — not a domain PATCH, not a second UI surface.
4. **Step 4 (completion)** — clicks the wizard's own 새로고침 (refresh)
   button and asserts the wizard's own confirmation text
   `파일럿 루프 완료 · pilot loop complete` renders, with `done` status and
   the tracked `jobId` visible. Takes a full-page screenshot at
   `apps/web/test-results/pilot-live-loop-complete.png`.

No domain PATCH endpoint is ever called by this spec.

## Running it

```bash
cd apps/web
pnpm exec playwright install chromium   # first run only
pnpm test:e2e:live
```

Must be run with `cwd` = `apps/web` (the config resolves the pnpm store's
`tsx` binary relative to `process.cwd()/../../node_modules/.pnpm`).

Override ports/ids if needed:

```bash
PILOT_LIVE_API_PORT=5391 PILOT_LIVE_WEB_PORT=5392 pnpm test:e2e:live
```

The existing fail-closed suite (`pnpm test:e2e`) is untouched and does not
pick up `pilot-live-loop.spec.ts`.

## Last verified run

- `cd apps/web && pnpm exec tsc --noEmit` — clean.
- `pnpm --filter @ai-crm/web test:e2e:live` — 1 passed
  (`pilot-live-loop.spec.ts`: submit → approve (SoD) → consume/complete →
  pilot loop complete).
- `pnpm --filter @ai-crm/web test:e2e` — 4 passed (existing fail-closed
  specs: `monitor-fail-closed`, `pilot-wizard` ×2, `work-fail-closed`).
- Screenshot: `apps/web/test-results/pilot-live-loop-complete.png` (job
  `job-000001`, status `done`, wizard renders
  "파일럿 루프 완료 · pilot loop complete").
