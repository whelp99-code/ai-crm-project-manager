/**
 * Boots a REAL @ai-crm/api Fastify app (createApp() from apps/api/src) on an
 * ephemeral-but-fixed loopback port for the pilot-wizard LIVE-LOOP e2e
 * (D1/D9). This is the exact production route table (agent commands,
 * governance decide/consume, agent job complete) — not a mock server.
 *
 * The injected `modelClient` is a deterministic stub (no network, same shape
 * as apps/api/test/s0-natural-command.integration.test.ts `planClient`), so
 * the loop is fully reproducible offline. SoR stays in-memory (no
 * DATABASE_URL passed) — this harness proves the wizard's HTTP contract, not
 * PG persistence (that is M1/M2's live-PG scope).
 *
 * Run directly via tsx (see playwright.live.config.ts webServer[0].command):
 *   node <pnpm-store>/tsx@…/node_modules/tsx/dist/cli.mjs e2e/live-server.ts
 */
import type { FastifyInstance } from "fastify";
import { createApp } from "@ai-crm/api";
import {
  PILOT_LIVE_API_PORT,
  PILOT_LIVE_ASSIGNMENT_PAYLOAD,
  PILOT_LIVE_OPERATOR_ID,
  PILOT_LIVE_PLAN_ID,
  PILOT_LIVE_PROJECT_ID,
  PILOT_LIVE_TASK_ID,
  PILOT_LIVE_WEB_BASE_URL,
  PILOT_LIVE_WORKSPACE_ID,
} from "./live-loop-env.js";

function deterministicPmTaskAssignModelClient() {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand: "pm.task_assign",
              title: "파일럿 라이브 루프 배정",
              resourceType: "PM_PLAN",
              resourceId: PILOT_LIVE_PLAN_ID,
              resourceVersion: 1,
              payloadJson: JSON.stringify(PILOT_LIVE_ASSIGNMENT_PAYLOAD),
            },
          ],
        },
        modelVersion: "pilot-live-loop-deterministic-1",
        retentionHonored: true,
      };
    },
  };
}

async function main(): Promise<void> {
  const app: FastifyInstance = createApp({
    modelClient: deterministicPmTaskAssignModelClient(),
    modelServicePrincipalId: "principal-model-gateway-pilot-live",
  });

  // Test-harness-only CORS: the wizard's client component fetches this API
  // cross-origin from the Next dev server's own origin (browser fetch, not
  // a Next server-side proxy). Production apps/api has no CORS layer — this
  // hook lives only in this e2e harness, not in apps/api/src/app.ts.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", PILOT_LIVE_WEB_BASE_URL);
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,x-workspace-id,x-principal-id,idempotency-key");
    if (request.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });

  await app.ready();

  // Seed the PM plan/task the deterministic plan step resolves against, via
  // the real POST /api/pm/plans route (no direct store poking).
  const seeded = await app.inject({
    method: "POST",
    url: "/api/pm/plans",
    headers: { "x-workspace-id": PILOT_LIVE_WORKSPACE_ID },
    payload: {
      id: PILOT_LIVE_PLAN_ID,
      projectId: PILOT_LIVE_PROJECT_ID,
      objective: "pilot live-loop e2e seed (D1/D9)",
      taskIds: [PILOT_LIVE_TASK_ID],
      createdByPrincipalId: PILOT_LIVE_OPERATOR_ID,
      createdAt: "2026-07-19T01:00:00.000Z",
    },
  });
  if (seeded.statusCode !== 201) {
    throw new Error(`pilot-live-loop: seed PM plan failed (${seeded.statusCode}): ${seeded.body}`);
  }

  await app.listen({ port: PILOT_LIVE_API_PORT, host: "127.0.0.1" });
  // eslint-disable-next-line no-console
  console.log(`pilot-live-loop: AI-CRM API listening on 127.0.0.1:${PILOT_LIVE_API_PORT}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error) => {
  console.error("pilot-live-loop: live-server failed to start", error);
  process.exit(1);
});
