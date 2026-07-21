import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { EventHub } from "../src/event-hub.js";

/**
 * G-03: live SSE hub beyond the initial snapshot burst.
 *
 * Covers:
 *  1. Initial-burst ordering (job.updated before work_item.updated;
 *     control.updated present when a control exists) — once-mode, via `inject()`.
 *  2. A genuine live follow-up event over a real listening HTTP server:
 *     open `?live=1`, trigger a mutation on another connection, assert the
 *     already-open stream receives a second frame for that job.
 *  3. Failure injection: client disconnects mid-stream → server unsubscribes
 *     cleanly (no crash, no lingering `EventHub` subscriber).
 *  4. No-events/empty: a job with no further mutation still closes cleanly
 *     in once-mode (burst-then-close contract preserved).
 */

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS = "ws-sse-eventing";
const OPERATOR = "operator-sse";

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
        modelVersion: "test-plan",
        retentionHonored: true,
      };
    },
  };
}

function hubOf(instance: FastifyInstance): EventHub {
  return (instance as unknown as { eventHub: EventHub }).eventHub;
}

async function listen(instance: FastifyInstance): Promise<number> {
  await instance.listen({ port: 0, host: "127.0.0.1" });
  const address = instance.server.address() as AddressInfo;
  return address.port;
}

interface SsePump {
  waitFor(predicate: (buf: string) => boolean, timeoutMs?: number): Promise<string>;
  buffer(): string;
  close(): void;
}

function openSse(port: number, path: string): SsePump {
  let buffer = "";
  const waiters: Array<{ predicate: (buf: string) => boolean; resolve: (buf: string) => void }> = [];

  const req = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "GET",
    headers: headers({ accept: "text/event-stream" }),
  });
  req.end();

  req.on("response", (res) => {
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.predicate(buffer)) {
          const [w] = waiters.splice(i, 1);
          w!.resolve(buffer);
        }
      }
    });
  });
  // Intentional aborts (disconnect test) surface as ECONNRESET/socket errors; swallow them.
  req.on("error", () => {});

  return {
    buffer: () => buffer,
    waitFor(predicate, timeoutMs = 4000) {
      if (predicate(buffer)) return Promise.resolve(buffer);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.predicate === predicate);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`timed out waiting for SSE predicate; buffer so far:\n${buffer}`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (buf) => {
            clearTimeout(timer);
            resolve(buf);
          },
        });
      });
    },
    close() {
      req.destroy();
    },
  };
}

function httpPost(port: number, path: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...headers({ "content-type": "application/json" }),
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("SSE eventing (G-03)", () => {
  it("initial burst orders job.updated before work_item.updated, control.updated present", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "A",
          resourceId: "plan-sse-order",
          resourceVersion: 1,
          payload: {
            projectId: "p",
            planId: "plan-sse-order",
            taskId: "t1",
            assigneePrincipalId: "w",
          },
        },
      ]),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-sse-order",
        projectId: "p",
        objective: "c",
        taskIds: ["t1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-sse-order" }),
      payload: { text: "assign for ordering" },
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;

    const sse = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}/events`,
      headers: headers({ accept: "text/event-stream" }),
    });
    expect(sse.statusCode).toBe(200);

    const jobIdx = sse.body.indexOf("event: job.updated");
    const workItemIdx = sse.body.indexOf("event: work_item.updated");
    const controlIdx = sse.body.indexOf("event: control.updated");
    expect(jobIdx).toBeGreaterThanOrEqual(0);
    expect(workItemIdx).toBeGreaterThan(jobIdx);
    expect(controlIdx).toBeGreaterThan(workItemIdx);
    expect(sse.body).toContain("event: stream.end");
  });

  it("no-events/empty job still closes cleanly in once-mode (burst-then-close preserved)", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "quiet" }]),
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-sse-quiet" }),
      payload: { text: "note, no follow-up mutation" },
    });
    const jobId = (created.json() as { jobId: string }).jobId;

    const sse = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}/events`,
      headers: headers({ accept: "text/event-stream" }),
    });
    expect(sse.statusCode).toBe(200);
    expect(sse.body).toContain("event: job.updated");
    expect(sse.body).toContain("event: stream.end");
    // Once-mode never subscribes — no subscriber left behind.
    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(0);
  });

  it("live mode delivers a follow-up event when the job is mutated after the burst", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "A",
          resourceId: "plan-sse-live",
          resourceVersion: 1,
          payload: {
            projectId: "p",
            planId: "plan-sse-live",
            taskId: "t1",
            assigneePrincipalId: "w",
          },
        },
      ]),
      sseLiveTimeoutMs: 5000,
    });
    const port = await listen(api);

    await httpPost(port, "/api/pm/plans", {
      id: "plan-sse-live",
      projectId: "p",
      objective: "c",
      taskIds: ["t1"],
      createdByPrincipalId: OPERATOR,
      createdAt: "2026-07-19T00:00:00.000Z",
    });

    const created = await httpPost(port, "/api/agent/commands", {
      text: "assign for live stream",
      idempotencyKey: "idem-sse-live-1",
    });
    expect(created.status).toBe(202);
    const jobId = (JSON.parse(created.body) as { jobId: string }).jobId;

    const pump = openSse(port, `/api/agent/jobs/${jobId}/events?live=1`);
    await pump.waitFor((buf) => buf.includes("event: stream.end") === false && buf.includes("event: job.updated"));

    // Burst has landed; hub should now show exactly one live subscriber for this job.
    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(1);
    const burstJobUpdatedCount = countOccurrences(pump.buffer(), "event: job.updated");

    const cancelled = await httpPost(port, `/api/agent/jobs/${jobId}/cancel`, {});
    expect(cancelled.status).toBe(200);

    await pump.waitFor((buf) => countOccurrences(buf, "event: job.updated") > burstJobUpdatedCount);
    expect(pump.buffer()).toContain(`"status":"cancelled"`);

    pump.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(0);
  });

  it("client disconnect mid-stream cleans up the subscriber with no crash", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "disconnect-note" }]),
      sseLiveTimeoutMs: 5000,
    });
    const port = await listen(api);

    const created = await httpPost(port, "/api/agent/commands", {
      text: "note for disconnect",
      idempotencyKey: "idem-sse-live-2",
    });
    const jobId = (JSON.parse(created.body) as { jobId: string }).jobId;

    const pump = openSse(port, `/api/agent/jobs/${jobId}/events?live=1`);
    await pump.waitFor((buf) => buf.includes("event: job.updated"));
    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(1);

    pump.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(0);
    expect(hubOf(api).activeJobCount()).toBe(0);

    // Server must still be alive and answer further requests (no crash from the abort).
    const stillUp = await httpPost(port, "/api/agent/commands", {
      text: "server survives disconnect",
      idempotencyKey: "idem-sse-live-3",
    });
    expect(stillUp.status).toBe(202);
  });

  it("live mode auto-closes after the idle timeout and cleans up the subscriber", async () => {
    const api = await ready({
      sseLiveTimeoutMs: 150,
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "A",
          resourceId: "plan-sse-idle",
          resourceVersion: 1,
          payload: { projectId: "p", planId: "plan-sse-idle", taskId: "t1", assigneePrincipalId: "w" },
        },
      ]),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-sse-idle",
        projectId: "p",
        objective: "c",
        taskIds: ["t1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    const port = await listen(api);
    const created = await httpPost(port, "/api/agent/commands", {
      text: "note for idle timeout",
      idempotencyKey: "idem-sse-idle-1",
    });
    const jobId = (JSON.parse(created.body) as { jobId: string }).jobId;

    const pump = openSse(port, `/api/agent/jobs/${jobId}/events?live=1`);
    await pump.waitFor((buf) => buf.includes("event: job.updated"));
    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(1);

    // No further mutation → idle timer fires and the server closes the stream.
    await pump.waitFor((buf) => buf.includes("event: stream.end"), 2000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hubOf(api).subscriberCount(WS, jobId)).toBe(0);
    expect(hubOf(api).activeJobCount()).toBe(0);
    pump.close();
  });
});
