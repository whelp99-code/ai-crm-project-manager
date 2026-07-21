import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient, ModelClientResponse } from "@ai-crm/model-gateway";
import { createAzureOpenAiClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * D7 live-model gap closer: a REAL Azure OpenAI (or OpenAI-compatible)
 * network call, exercised through the full effect path — not a mock.
 *
 * Gated by LIVE_MODEL_TEST=1 so the normal offline/CI suite (every other
 * test file in this repo) stays green and network-free; every other test
 * injects a deterministic ModelClient exactly as before. This file is the
 * ONLY place @ai-crm/model-gateway's AzureOpenAiClient is ever constructed
 * in apps/api's test suite.
 *
 * Deliberately ONE network call total: the single POST /api/agent/commands
 * below drives the one live model invocation; we capture and assert on its
 * raw ModelClientResponse (via a thin pass-through wrapper) as well as on
 * the persisted ModelInvocationRecord surfaced by GET /api/model/invocations.
 *
 * Run: LIVE_MODEL_TEST=1 pnpm --filter @ai-crm/api exec vitest run test/live-model.integration.test.ts
 * Requires (see docs/ops/live-model.md): AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
 * AZURE_OPENAI_AUTH_MODE, optionally AZURE_OPENAI_DEPLOYMENT.
 */

const LIVE = process.env.LIVE_MODEL_TEST === "1";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS = "ws-live-model";
const OPERATOR = "operator-live-model";
const GATEWAY_PRINCIPAL = "principal-model-gateway";

function headers(extra: Record<string, string> = {}) {
  return {
    "x-workspace-id": WS,
    "x-principal-id": OPERATOR,
    ...extra,
  };
}

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)("D7 live model: real Azure OpenAI call drives the full agent-command effect path", () => {
  it(
    "POST /api/agent/commands with a real Azure OpenAI plan response produces a real job (not a mock)",
    async () => {
      const real = createAzureOpenAiClient();
      let captured: ModelClientResponse | undefined;
      // Thin pass-through so we can assert on the exact raw response the
      // live provider returned, without making a second network call.
      const capturingClient: ModelClient = {
        async invoke(request) {
          const response = await real.invoke(request);
          captured = response;
          return response;
        },
      };

      const api = await ready({
        modelClient: capturingClient,
        modelServicePrincipalId: GATEWAY_PRINCIPAL,
      });

      const res = await api.inject({
        method: "POST",
        url: "/api/agent/commands",
        headers: headers({ "idempotency-key": "live-model-1" }),
        payload: { text: "post an internal update noting the pilot rollout is on track" },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json() as { jobId: string; status: string; workItemIds: string[] };

      // The live model response is the ONLY thing that could have produced a
      // real job here — nothing in this test hardcodes suggestedCommand.
      expect(captured).toBeDefined();
      expect(typeof captured!.modelVersion).toBe("string");
      expect(captured!.modelVersion.length).toBeGreaterThan(0);
      expect(typeof captured!.retentionHonored).toBe("boolean");
      const structured = captured!.structuredOutput as { steps?: unknown };
      expect(Array.isArray(structured.steps)).toBe(true);
      expect((structured.steps as unknown[]).length).toBeGreaterThan(0);

      // The job either completed (mapped command) or failed closed
      // (UNMAPPED_COMMAND) — both are legitimate real outcomes of a live
      // model call; either way it proves a real invocation drove the effect
      // path end to end, not a canned mock.
      expect(["done", "failed"]).toContain(body.status);

      const job = await api.inject({
        method: "GET",
        url: `/api/agent/jobs/${body.jobId}`,
        headers: headers(),
      });
      expect(job.statusCode).toBe(200);
      const jobBody = job.json() as {
        workItems: Array<{ status: string; errorCode?: string; suggestedCommand?: string }>;
      };
      expect(jobBody.workItems).toHaveLength(1);
      // suggestedCommand on the work item is whatever the live model chose —
      // real provider output, not a fixture.
      expect(typeof jobBody.workItems[0]!.suggestedCommand).toBe("string");

      // The persisted model-invocation audit record confirms the invocation
      // ran under the dedicated gateway service principal / MODEL_INVOKE,
      // and carries the real provider's modelVersion + retention outcome.
      const invocations = await api.inject({
        method: "GET",
        url: "/api/model/invocations",
        headers: headers(),
      });
      expect(invocations.statusCode).toBe(200);
      const records = invocations.json() as Array<{
        principalId: string;
        actionType: string;
        modelVersion: string;
        retentionMode: "zero-retention" | "retain";
        correlationId: string;
      }>;
      const record = records.find((r) => r.correlationId === `nc:${WS}:live-model-1`);
      expect(record).toBeDefined();
      expect(record!.principalId).toBe(GATEWAY_PRINCIPAL);
      expect(record!.actionType).toBe("MODEL_INVOKE");
      expect(record!.modelVersion).toBe(captured!.modelVersion);
      expect(["zero-retention", "retain"]).toContain(record!.retentionMode);
    },
    30_000,
  );
});
