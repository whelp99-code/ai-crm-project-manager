import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCustomerWorkOsV25Routes } from "../src/customer-work-os-v25-routes.js";
import { InMemoryV25StateStore } from "../src/customer-work-os-v25-runtime.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const headers = (key: string) => ({
  "x-workspace-id": workspaceId,
  "x-principal-id": "owner-1",
  "x-principal-kind": "human",
  "x-step-up": "true",
  "idempotency-key": key,
});

describe("Customer Work OS v2.5 API", () => {
  let app = Fastify();

  beforeEach(async () => {
    app = Fastify();
    registerCustomerWorkOsV25Routes(app, { store: new InMemoryV25StateStore(), now: () => "2026-08-29T00:00:00.000Z" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("accepts one-shot capture and exposes the review queue", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/cwos/v2.5/capture",
      headers: headers("capture-1"),
      payload: {
        expectedVersion: 0,
        capture: {
          id: "capture-1",
          workspaceId,
          kind: "TEXT",
          title: "선진 HCI",
          content: "선진 HCI PRJ-2026-001 검수일 2026-10-15, 총판 4천만원은 2026-09-30 지급. 다음 주까지 일정 회신.",
          occurredAt: "2026-08-29T00:00:00.000Z",
          sender: "owner-1",
          sourceRef: "manual://1",
          providerEventId: null,
          attachments: [],
          language: "ko"
        },
        context: {
          accountAliases: [{ id: "account-sunjin", aliases: ["선진"] }],
          engagementAliases: [{ id: "engagement-hci", aliases: ["선진 HCI"], projectKey: "PRJ-2026-001" }],
          defaultTimezone: "Asia/Seoul"
        }
      }
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.runtimeVersion).toBe(1);
    expect(body.result.mutations.some((item: { category: string }) => item.category === "FINANCIAL_ITEM")).toBe(true);

    const review = await app.inject({
      method: "GET",
      url: "/api/cwos/v2.5/review",
      headers: {
        "x-workspace-id": workspaceId,
        "x-principal-id": "owner-1",
        "x-principal-kind": "human"
      }
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().review.capturePlans).toHaveLength(1);
  });

  it("replays identical idempotent capture and rejects conflicting reuse", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/cwos/v2.5/capture",
      headers: headers("same-key"),
      payload: {
        expectedVersion: 0,
        capture: {
          id: "capture-1",
          workspaceId,
          kind: "TEXT",
          title: null,
          content: "단순 메모",
          occurredAt: "2026-08-29T00:00:00.000Z",
          sender: "owner-1",
          sourceRef: "manual://1",
          providerEventId: null,
          attachments: [],
          language: "ko"
        },
        context: { accountAliases: [], engagementAliases: [], defaultTimezone: "Asia/Seoul" }
      }
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await app.inject({
      ...request,
      payload: {
        ...request.payload,
        capture: { ...request.payload.capture, content: "다른 내용" }
      }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("runs the AI manager and returns a briefing", async () => {
    const manager = await app.inject({
      method: "POST",
      url: "/api/cwos/v2.5/manager/run",
      headers: headers("manager-1"),
      payload: {
        expectedVersion: 0,
        snapshot: {
          workspaceId,
          asOf: "2026-08-29T00:00:00.000Z",
          engagements: [{ id: "eng-1", name: "HCI 구축", stage: "DELIVERY", health: "warning", lastActivityAt: "2026-08-10T00:00:00.000Z", nextActionCount: 0, forecastRevenueKrw: "100000000", estimateAtCompletionKrw: "92000000", forecastMarginBps: 800 }],
          commitments: [],
          financialItems: [],
          changeRequests: [],
          assets: [],
          clarifications: []
        }
      }
    });
    expect(manager.statusCode).toBe(201);
    expect(manager.json().result.criticalFindingIds.length).toBeGreaterThan(0);

    const briefing = await app.inject({
      method: "GET",
      url: "/api/cwos/v2.5/briefing",
      headers: {
        "x-workspace-id": workspaceId,
        "x-principal-id": "owner-1",
        "x-principal-kind": "human"
      }
    });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.json().briefing).not.toBeNull();
  });
});
