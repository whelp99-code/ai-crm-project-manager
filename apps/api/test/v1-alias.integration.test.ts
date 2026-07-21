import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * N-10 (D8) SECURITY-CRITICAL: `/v1/agent/*` must alias `/api/agent/*` with
 * exact auth/header parity — never a bypass of the fail-closed API-key gate.
 * isApiPath/isAgentPath in app.ts were generalized to recognize `/v1` as a
 * versioned alias of `/api`; this file proves that generalization actually
 * gates `/v1` the same way it gates `/api`, not just that the routes exist.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.AUTH_API_KEY;
  delete process.env.API_AUTH_TOKEN;
});

const WS = "ws-v1-alias";
const OPERATOR = "operator-v1-alias";
const KEY = "test-api-key-v1-alias";

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
        modelVersion: "v1-alias-test",
        retentionHonored: true,
      };
    },
  };
}

describe("N-10: /v1/agent/* routes resolve identically to /api/agent/*", () => {
  it("POST /v1/agent/commands is registered and behaves like the /api alias (202, same job shape)", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "v1-alias-1" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(typeof body.jobId).toBe("string");
  });

  it("GET /v1/agent/jobs/:id reads back a job created via /api/agent/commands", async () => {
    const api = await ready({ modelClient: planClient() });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "v1-alias-2" },
      payload: { text: "do work" },
    });
    expect(created.statusCode).toBe(202);
    const jobId = created.json().jobId as string;

    const viaV1 = await api.inject({
      method: "GET",
      url: `/v1/agent/jobs/${jobId}`,
      headers: { "x-workspace-id": WS },
    });
    expect(viaV1.statusCode).toBe(200);
    expect(viaV1.json().job.id).toBe(jobId);
  });

  it("POST /v1/agent/jobs/:id/cancel and .../work-items/:id/complete are registered (not 404 route-not-found)", async () => {
    const api = await ready({});
    const cancel = await api.inject({
      method: "POST",
      url: "/v1/agent/jobs/missing-job/cancel",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
    });
    // domain 404 (JOB_NOT_FOUND) is fine — the route is registered and
    // reached the handler; only the literal fastify "Not Found" envelope
    // would mean the alias wasn't actually registered.
    expect(cancel.json()).not.toMatchObject({ error: "Not Found" });

    const complete = await api.inject({
      method: "POST",
      url: "/v1/agent/jobs/missing-job/work-items/missing-item/complete",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
      payload: { intentId: "missing-intent" },
    });
    expect(complete.json()).not.toMatchObject({ error: "Not Found" });
  });

  it("GET /v1/agent/jobs/:id/events is registered", async () => {
    const api = await ready({});
    const res = await api.inject({
      method: "GET",
      url: "/v1/agent/jobs/missing-job/events",
      headers: { "x-workspace-id": WS },
    });
    expect(res.json()).not.toMatchObject({ error: "Not Found" });
  });
});

describe("N-10 SECURITY-CRITICAL: /v1 auth parity — no bypass of the API-key gate", () => {
  it("NEGATIVE: with authApiKey set, POST /v1/agent/commands with NO x-api-key → 401 UNAUTHENTICATED (same as /api)", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "v1-parity-1" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("NEGATIVE: with authApiKey set, POST /v1/agent/commands with WRONG x-api-key → 401 UNAUTHENTICATED", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "idempotency-key": "v1-parity-2",
        "x-api-key": "wrong-key",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("NEGATIVE: with authApiKey set, GET /v1/agent/jobs/:id with no key also 401s (GET is not exempt on the agent surface)", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "GET",
      url: "/v1/agent/jobs/some-job",
      headers: { "x-workspace-id": WS },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("POSITIVE: with authApiKey set, correct x-api-key + required headers → 202 (not 401) on /v1", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "x-api-key": KEY,
        "idempotency-key": "v1-parity-3",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(202);
  });

  it("proves /api and /v1 401 IDENTICALLY for the same missing-key request (true parity, not coincidental equal codes)", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const headers = { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "v1-parity-4" };
    const viaApi = await api.inject({ method: "POST", url: "/api/agent/commands", headers, payload: { text: "x" } });
    const viaV1 = await api.inject({ method: "POST", url: "/v1/agent/commands", headers, payload: { text: "x" } });
    expect(viaApi.statusCode).toBe(401);
    expect(viaV1.statusCode).toBe(401);
    expect(viaApi.json()).toEqual(viaV1.json());
  });
});

describe("N-10: /v1/agent required-header parity with /api/agent", () => {
  it("missing x-workspace-id on /v1/agent/commands → 400 WORKSPACE_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-principal-id": OPERATOR, "idempotency-key": "v1-header-1" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "WORKSPACE_REQUIRED" });
  });

  it("missing x-principal-id on /v1/agent/commands → 400 PRINCIPAL_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "idempotency-key": "v1-header-2" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "PRINCIPAL_REQUIRED" });
  });

  it("missing Idempotency-Key on /v1/agent/commands → 400 IDEMPOTENCY_REQUIRED", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "IDEMPOTENCY_REQUIRED" });
  });
});

describe("N-10: rate-limit + Idempotency-Key echo headers on agent command responses", () => {
  it("echoes Idempotency-Key and includes X-RateLimit-* headers on /api/agent/commands", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "rl-header-1" },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers["idempotency-key"]).toBe("rl-header-1");
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(Number(res.headers["x-ratelimit-remaining"])).toBeLessThan(Number(res.headers["x-ratelimit-limit"]));
  });

  it("also echoes headers on the /v1/agent/commands alias, and decrements remaining across calls for the same workspace", async () => {
    const api = await ready({ modelClient: planClient() });
    const first = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "rl-header-2" },
      payload: { text: "do work" },
    });
    const second = await api.inject({
      method: "POST",
      url: "/v1/agent/commands",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR, "idempotency-key": "rl-header-3" },
      payload: { text: "do work" },
    });
    expect(first.headers["idempotency-key"]).toBe("rl-header-2");
    expect(second.headers["idempotency-key"]).toBe("rl-header-3");
    expect(Number(second.headers["x-ratelimit-remaining"])).toBeLessThan(
      Number(first.headers["x-ratelimit-remaining"]),
    );
  });
});
