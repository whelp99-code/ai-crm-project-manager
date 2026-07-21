import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS_A = "ws-s1-a";
const WS_B = "ws-s1-b";
const OPERATOR = "operator-s1";

function headers(workspaceId: string, extra: Record<string, string> = {}) {
  return {
    "x-workspace-id": workspaceId,
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

function planClient(steps: Array<Record<string, unknown>>): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: steps.map((step) => {
            const {
              suggestedCommand,
              title = "step",
              resourceType = "",
              resourceId = "",
              resourceVersion = 1,
              payload = {},
            } = step;
            return {
              suggestedCommand,
              title,
              resourceType,
              resourceId,
              resourceVersion,
              payloadJson: JSON.stringify(payload ?? {}),
            };
          }),
        },
        modelVersion: "test-plan-s1",
        retentionHonored: true,
      };
    },
  };
}

describe("S1 Customer 360 resource binding", () => {
  it("S1-I-01: 360 overview + agent job coexist with ADR-012 resource pair", async () => {
    const customerId = "cust-s1-a";
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "internal.update",
          title: "Customer follow-up",
          resourceType: "customer",
          resourceId: customerId,
          payload: { note: "s1 follow-up" },
        },
      ]),
    });

    const created = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: headers(WS_A),
      payload: {
        id: customerId,
        name: "S1 Customer A",
        status: "active",
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    expect(created.statusCode).toBe(201);

    const overview = await api.inject({
      method: "GET",
      url: `/api/customers/${customerId}/overview`,
      headers: headers(WS_A),
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      customer: { id: customerId, name: "S1 Customer A" },
      finance: { status: "pending" },
    });
    const finance = (overview.json() as { finance: Record<string, unknown> }).finance;
    expect(finance).not.toHaveProperty("cashKrw");
    expect(finance).not.toHaveProperty("receivableKrw");

    const command = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers(WS_A, { "idempotency-key": "s1-i-01-bind" }),
      payload: {
        text: "이 고객으로 내부 일감 생성",
        resourceBinding: { resourceType: "customer", resourceId: customerId },
      },
    });
    expect(command.statusCode).toBe(202);
    const body = command.json() as { jobId: string; status: string };
    expect(body.jobId).toBeTruthy();

    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(WS_A),
    });
    expect(job.statusCode).toBe(200);
    const snap = job.json() as {
      job: { workspaceId: string };
      workItems: Array<{ resourceType?: string; resourceId?: string; status: string }>;
    };
    expect(snap.job.workspaceId).toBe(WS_A);
    expect(snap.workItems.length).toBeGreaterThan(0);
    expect(snap.workItems[0]).toMatchObject({
      resourceType: "customer",
      resourceId: customerId,
    });

    // Same workspace 360 still works after job creation.
    const overviewAfter = await api.inject({
      method: "GET",
      url: `/api/customers/${customerId}/overview`,
      headers: headers(WS_A),
    });
    expect(overviewAfter.statusCode).toBe(200);
    expect(overviewAfter.json()).toMatchObject({
      customer: { id: customerId },
      finance: { status: "pending" },
    });

    // Cross-workspace isolation: workspace B cannot read workspace A job.
    const cross = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(WS_B),
    });
    expect(cross.statusCode).toBe(404);
  });

  it("S1-I-01b: bare resourceId-only does not land as unpaired work-item binding", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "internal.update",
          title: "half bind",
          resourceId: "cust-only",
          payload: {},
        },
      ]),
    });

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers(WS_A, { "idempotency-key": "s1-i-01-half" }),
      payload: { text: "half binding should not store unpaired resourceId" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = (res.json() as { jobId: string }).jobId;
    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: headers(WS_A),
    });
    const item = (job.json() as { workItems: Array<{ resourceType?: string; resourceId?: string }> })
      .workItems[0]!;
    // ADR-012: work items never store resourceId without resourceType.
    expect(item.resourceType).toBeUndefined();
    expect(item.resourceId).toBeUndefined();
  });

  it("S1-I-01b2: resourceType-only plan step is rejected", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "internal.update",
          title: "type only",
          resourceType: "customer",
          payload: {},
        },
      ]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers(WS_A, { "idempotency-key": "s1-i-01-type-only" }),
      payload: { text: "type only must fail closed" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json()).toMatchObject({ error: "INVALID_RESOURCE_BINDING" });
  });

  it("S1-I-01c: request resourceBinding half-pair is rejected", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "noop" }]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers(WS_A, { "idempotency-key": "s1-i-01-half-body" }),
      payload: {
        text: "binding half pair",
        resourceBinding: { resourceId: "cust-x" },
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json()).toMatchObject({ error: "INVALID_RESOURCE_BINDING" });
  });

  it("S1-I-01d: body resourceBinding fills missing plan step pair", async () => {
    const customerId = "cust-s1-fill";
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "internal.update",
          title: "fill from body",
          // no resourceType/resourceId on plan step
          payload: { note: "fill" },
        },
      ]),
    });

    await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: headers(WS_A),
      payload: {
        id: customerId,
        name: "Fill Customer",
        status: "active",
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const command = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers(WS_A, { "idempotency-key": "s1-i-01-fill" }),
      payload: {
        text: "create work for customer",
        resourceBinding: { resourceType: "customer", resourceId: customerId },
      },
    });
    expect(command.statusCode).toBe(202);
    const jobId = (command.json() as { jobId: string }).jobId;
    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: headers(WS_A),
    });
    const item = (job.json() as { workItems: Array<{ resourceType?: string; resourceId?: string }> })
      .workItems[0];
    expect(item).toMatchObject({ resourceType: "customer", resourceId: customerId });
  });
});
