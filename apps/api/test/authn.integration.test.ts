import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.AUTH_API_KEY;
  delete process.env.API_AUTH_TOKEN;
});

const WS = "ws-authn";
const OPERATOR = "operator-authn";
const KEY = "test-api-key-t017";

const customer = {
  id: "customer-authn-1",
  name: "Authn Co",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
};

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
        modelVersion: "authn-test",
        retentionHonored: true,
      };
    },
  };
}

async function ready(options: Parameters<typeof createApp>[0] = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

describe("T-017 authn fail-closed", () => {
  it("when AUTH_API_KEY set, mutating /api/* without key → 401", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS },
      payload: customer,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("when AUTH_API_KEY set, wrong x-api-key → 401", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, "x-api-key": "wrong-key" },
      payload: customer,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("when AUTH_API_KEY set, correct x-api-key allows mutate", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, "x-api-key": KEY },
      payload: customer,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: customer.id });
  });

  it("when AUTH_API_KEY set, Authorization Bearer match allows mutate", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, authorization: `Bearer ${KEY}` },
      payload: customer,
    });
    expect(res.statusCode).toBe(201);
  });

  it("when AUTH_API_KEY set, agent route without key → 401 even with principal", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "idempotency-key": "authn-no-key",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("when AUTH_API_KEY set, agent GET without key → 401", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "GET",
      url: "/api/agent/jobs/job-missing",
      headers: { "x-workspace-id": WS, "x-principal-id": OPERATOR },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("when AUTH_API_KEY set, agent with key but without principal still fails", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-api-key": KEY,
        "idempotency-key": "authn-no-principal",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).not.toBe(401);
    expect(res.json()).toMatchObject({ error: "PRINCIPAL_REQUIRED" });
  });

  it("when AUTH_API_KEY set, agent with key + principal succeeds", async () => {
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "x-api-key": KEY,
        "idempotency-key": "authn-ok",
      },
      payload: { text: "internal note" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("reads AUTH_API_KEY from env when options.authApiKey omitted", async () => {
    process.env.AUTH_API_KEY = KEY;
    const api = await ready();
    const denied = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS },
      payload: customer,
    });
    expect(denied.statusCode).toBe(401);
    const ok = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, "x-api-key": KEY },
      payload: { ...customer, id: "customer-authn-env" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("reads API_AUTH_TOKEN alias when AUTH_API_KEY unset", async () => {
    process.env.API_AUTH_TOKEN = KEY;
    const api = await ready();
    const denied = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS },
      payload: customer,
    });
    expect(denied.statusCode).toBe(401);
    const ok = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, authorization: `Bearer ${KEY}` },
      payload: { ...customer, id: "customer-authn-alias" },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("when API key unset, dev principal mode still works (no 401)", async () => {
    delete process.env.AUTH_API_KEY;
    delete process.env.API_AUTH_TOKEN;
    const api = await ready({ modelClient: planClient() });
    const mutate = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS },
      payload: customer,
    });
    expect(mutate.statusCode).toBe(201);

    const agent = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "idempotency-key": "authn-dev",
      },
      payload: { text: "dev mode" },
    });
    expect(agent.statusCode).toBe(202);
  });

  it("non-mutating non-agent GET without key is allowed when key mode on", async () => {
    const api = await ready({ authApiKey: KEY });
    // Seed via authorized mutate
    await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { "x-workspace-id": WS, "x-api-key": KEY },
      payload: customer,
    });
    const overview = await api.inject({
      method: "GET",
      url: `/api/customers/${customer.id}/overview`,
      headers: { "x-workspace-id": WS },
    });
    expect(overview.statusCode).toBe(200);
  });

  it("/health never requires API key", async () => {
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });
});
