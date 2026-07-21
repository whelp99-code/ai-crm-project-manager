import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * G-04 contract test: asserts docs/api/agent-openapi.md does not drift from
 * the implementation in apps/api/src/app.ts. Every documented route must be
 * registered, and every documented required-header/error-code pair must be
 * enforced by the running app — not just described in prose.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.AUTH_API_KEY;
  delete process.env.API_AUTH_TOKEN;
});

const WS = "ws-agent-contract";
const OPERATOR = "operator-agent-contract";
const KEY = "test-api-key-agent-contract";

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

function planClient(): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand: "internal.update",
              title: "note",
              resourceType: "",
              resourceId: "",
              resourceVersion: 1,
              payloadJson: "{}",
            },
          ],
        },
        modelVersion: "agent-contract-test",
        retentionHonored: true,
      };
    },
  };
}

/** A Fastify "route not found" response has this exact envelope shape:
 * `{ statusCode: 404, error: "Not Found", message: "Route GET:/x not found" }`.
 * Domain 404s (JOB_NOT_FOUND, etc.) use `{ error: "<CODE>", message }` where
 * `error` is a domain code, never the literal "Not Found". */
function isRouteNotFound(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const rec = body as Record<string, unknown>;
  return rec.error === "Not Found";
}
describe("agent-openapi contract: documented routes are registered", () => {
  it("POST /api/agent/commands is registered (not a 404 route-not-found)", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "contract-1" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).not.toBe(404);
    expect(res.statusCode).toBe(202);
  });

  it("GET /api/agent/jobs/:id is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "GET",
      url: "/api/agent/jobs/missing-job",
      headers: { "x-workspace-id": WS },
    });
    expect(res.statusCode).toBe(404);
    expect(isRouteNotFound(res.json())).toBe(false);
    expect(res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("GET /api/agent/jobs/:id/events is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "GET",
      url: "/api/agent/jobs/missing-job/events",
      headers: { "x-workspace-id": WS },
    });
    expect(res.statusCode).toBe(404);
    expect(isRouteNotFound(res.json())).toBe(false);
    expect(res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("POST /api/agent/jobs/:id/cancel is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/jobs/missing-job/cancel",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
    });
    expect(res.statusCode).toBe(404);
    expect(isRouteNotFound(res.json())).toBe(false);
    expect(res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("POST /api/agent/jobs/:id/work-items/:workItemId/complete is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/jobs/missing-job/work-items/missing-item/complete",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
      payload: { intentId: "missing-intent" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(isRouteNotFound(res.json())).toBe(false);
  });

  it("GET /api/governance/controls is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "GET",
      url: "/api/governance/controls",
      headers: { "x-workspace-id": WS },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("governance authorize + audit + audit/verify routes are registered", async () => {
    const api = await ready({});
    const authorize = await api.inject({
      method: "POST",
      url: "/api/governance/authorize",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
      payload: {},
    });
    expect(isRouteNotFound(authorize.json())).toBe(false);
    const audit = await api.inject({
      method: "GET",
      url: "/api/governance/audit",
      headers: { "x-workspace-id": WS },
    });
    expect(audit.statusCode).toBe(200);
    const verify = await api.inject({
      method: "GET",
      url: "/api/governance/audit/verify",
      headers: { "x-workspace-id": WS },
    });
    expect(verify.statusCode).toBe(200);
    expect(isRouteNotFound(verify.json())).toBe(false);
  });

  it("GET /metrics, /health, /ready are registered", async () => {
    const api = await ready({});
    const metrics = await api.inject({ method: "GET", url: "/metrics" });
    const health = await api.inject({ method: "GET", url: "/health" });
    const readyRes = await api.inject({ method: "GET", url: "/ready" });
    expect(metrics.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect([200, 503]).toContain(readyRes.statusCode);
  });
});

describe("agent-openapi contract: required headers on POST /api/agent/commands", () => {
  it("missing x-workspace-id → 400 WORKSPACE_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-principal-id": OPERATOR, "idempotency-key": "contract-2" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "WORKSPACE_REQUIRED" });
  });

  it("missing x-principal-id → 400 PRINCIPAL_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "idempotency-key": "contract-3" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "PRINCIPAL_REQUIRED" });
  });

  it("missing any Idempotency-Key (header or body) → 400 IDEMPOTENCY_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "IDEMPOTENCY_REQUIRED" });
  });

  it("header vs body idempotency key mismatch → 400 IDEMPOTENCY_MISMATCH", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "header-key" },
      payload: { text: "do work", idempotencyKey: "body-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "IDEMPOTENCY_MISMATCH" });
  });
});

describe("agent-openapi contract: AUTH_API_KEY fail-closed", () => {
  it("with authApiKey set, POST /api/agent/commands without x-api-key → 401 UNAUTHENTICATED", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "contract-4" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("with authApiKey set, correct x-api-key + required headers → not 401", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "x-api-key": KEY,
        "idempotency-key": "contract-5",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(202);
  });

  it("with authApiKey set, GET /metrics does not require the api key", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("with authApiKey set, GET /health does not require the api key", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("with authApiKey set, GET /ready does not require the api key", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({ method: "GET", url: "/ready" });
    expect([200, 503]).toContain(res.statusCode);
  });
});
