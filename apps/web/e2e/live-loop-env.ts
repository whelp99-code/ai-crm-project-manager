/**
 * Shared config for the pilot-wizard LIVE-LOOP e2e (D1/D9).
 *
 * Single source of truth consumed by three processes that must agree on the
 * same ports / ids / seed payload:
 *  - playwright.live.config.ts (spawns both webServers with matching env)
 *  - live-server.ts            (boots the real @ai-crm/api Fastify app)
 *  - pilot-live-loop.spec.ts   (drives the browser + calls governance
 *                                consume/complete directly, mirroring
 *                                apps/api/test/s0-natural-command.integration.test.ts
 *                                S0-I-06 happy path)
 *
 * No network calls, no fabricated data: the model plan below is a
 * deterministic stub (same pattern as apps/api tests' `planClient`), and the
 * PM plan/task are seeded via the real POST /api/pm/plans route before the
 * API starts listening.
 */

export const PILOT_LIVE_API_PORT = Number(process.env.PILOT_LIVE_API_PORT ?? 4391);
export const PILOT_LIVE_WEB_PORT = Number(process.env.PILOT_LIVE_WEB_PORT ?? 4392);

export const PILOT_LIVE_API_BASE_URL = `http://127.0.0.1:${PILOT_LIVE_API_PORT}`;
export const PILOT_LIVE_WEB_BASE_URL = `http://127.0.0.1:${PILOT_LIVE_WEB_PORT}`;

export const PILOT_LIVE_WORKSPACE_ID = process.env.PILOT_LIVE_WORKSPACE_ID ?? "ws-pilot-live";
export const PILOT_LIVE_OPERATOR_ID = process.env.PILOT_LIVE_OPERATOR_ID ?? "pilot-live-operator";
export const PILOT_LIVE_APPROVER_ID = process.env.PILOT_LIVE_APPROVER_ID ?? "pilot-live-approver";

export const PILOT_LIVE_PLAN_ID = "plan-pilot-live";
export const PILOT_LIVE_PROJECT_ID = "project-pilot-live";
export const PILOT_LIVE_TASK_ID = "task-pilot-live";

/** Exact suggestedCommand payload the deterministic modelClient returns for
 * the PM_TASK_ASSIGN plan step. Kept as one literal so live-server.ts (model
 * step) and pilot-live-loop.spec.ts (governance consume payloadHash) can
 * never drift apart. */
export const PILOT_LIVE_ASSIGNMENT_PAYLOAD = {
  id: "asg-pilot-live",
  projectId: PILOT_LIVE_PROJECT_ID,
  planId: PILOT_LIVE_PLAN_ID,
  taskId: PILOT_LIVE_TASK_ID,
  assigneePrincipalId: "worker-pilot-live",
  createdAt: "2026-07-19T02:00:00.000Z",
} as const;

export const PILOT_LIVE_COMMAND_TEXT = "이 작업을 배정해 주세요 (pilot live loop)";
