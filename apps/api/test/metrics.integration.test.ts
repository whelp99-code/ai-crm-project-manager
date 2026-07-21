import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS = "ws-metrics";
const OPERATOR = "operator-metrics";

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

function planClient(suggestedCommand: string): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand,
              title: "step",
              resourceType: "",
              resourceId: "",
              resourceVersion: 1,
              payloadJson: "{}",
            },
          ],
        },
        modelVersion: "metrics-test",
        retentionHonored: true,
      };
    },
  };
}
function assignPlanClient(): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand: "pm.task_assign",
              title: "Assign metrics",
              resourceType: "",
              resourceId: "plan-metrics",
              resourceVersion: 1,
              payloadJson: JSON.stringify({
                id: "asg-metrics",
                projectId: "proj-metrics",
                planId: "plan-metrics",
                taskId: "task-metrics",
                assigneePrincipalId: "worker-metrics",
              }),
            },
          ],
        },
        modelVersion: "metrics-test",
        retentionHonored: true,
      };
    },
  };
}

interface MetricsBody {
  status: string;
  agent: { jobsTotal: number; jobsByStatus: Record<string, number> };
  governance: {
    controlsTotal: number;
    controlsByStatus: Record<string, number>;
    intentsTotal: number;
    intentsByStatus: Record<string, number>;
  };
  dualWriteFailures: number;
  sse: { activeJobSubscriptions: number };
}

describe("GET /metrics", () => {
  it("requires no auth, mirroring /health", async () => {
    const api = await ready({ authApiKey: "some-key" });
    const res = await api.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("starts at zero job counts on a fresh app", async () => {
    const api = await ready();
    const res = await api.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MetricsBody;
    expect(body.status).toBe("ok");
    expect(body.agent.jobsTotal).toBe(0);
    expect(body.dualWriteFailures).toBe(0);
    expect(body.sse.activeJobSubscriptions).toBe(0);
  });

  it("reflects real job-status counts after a command runs to completion", async () => {
    const api = await ready({ modelClient: planClient("internal.update") });

    const before = await api.inject({ method: "GET", url: "/metrics" });
    expect((before.json() as MetricsBody).agent.jobsTotal).toBe(0);

    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-metrics-1" }),
      payload: { text: "internal note" },
    });
    expect(created.statusCode).toBe(202);
    const body = created.json() as { jobId: string; status: string };
    // internal.update is auto-authorized (minorThreshold 0 by default here) so
    // the job either completes immediately or fails; either way it is counted.

    const after = await api.inject({ method: "GET", url: "/metrics" });
    const afterBody = after.json() as MetricsBody;
    expect(afterBody.agent.jobsTotal).toBe(1);
    expect(afterBody.agent.jobsByStatus[body.status]).toBe(1);
  });

  it("counts an active SSE subscriber while a live stream is open", async () => {
    const api = await ready({ modelClient: planClient("internal.update") });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-metrics-sse" }),
      payload: { text: "internal note" },
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;

    // Directly exercise the same EventHub instance the route reads from.
    const hub = (api as unknown as { eventHub: { subscribe: (ws: string, id: string, cb: () => void) => () => void } })
      .eventHub;
    const stop = hub.subscribe(WS, jobId, () => {});
    try {
      const res = await api.inject({ method: "GET", url: "/metrics" });
      const metricsBody = res.json() as MetricsBody;
      expect(metricsBody.sse.activeJobSubscriptions).toBe(1);
    } finally {
      stop();
    }

    const after = await api.inject({ method: "GET", url: "/metrics" });
    expect((after.json() as MetricsBody).sse.activeJobSubscriptions).toBe(0);
  });

  it("surfaces governance control/intent counters after a checkpoint is created", async () => {
    const api = await ready({
      modelClient: assignPlanClient(),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-metrics",
        projectId: "proj-metrics",
        objective: "metrics",
        taskIds: ["task-metrics"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-metrics-gov" }),
      payload: { text: "assign task" },
    });
    expect(created.statusCode).toBe(202);
    expect((created.json() as { needsApproval: boolean }).needsApproval).toBe(true);

    const res = await api.inject({ method: "GET", url: "/metrics" });
    const body = res.json() as MetricsBody;
    expect(body.governance.controlsTotal).toBeGreaterThanOrEqual(1);
    // Concrete (non-tautological) status assertion: the assign command created
    // a PENDING checkpoint control.
    expect(body.governance.controlsByStatus.PENDING ?? 0).toBeGreaterThanOrEqual(1);

    // Drive an ALLOW-tier internal.update through a second app so a real
    // SUCCEEDED intent exists, then assert intentsByStatus concretely.
    const allowApi = createApp({ modelClient: planClient("internal.update") });
    try {
      await allowApi.ready();
      const done = await allowApi.inject({
        method: "POST",
        url: "/api/agent/commands",
        headers: headers({ "idempotency-key": "idem-metrics-intent" }),
        payload: { text: "reversible internal update" },
      });
      expect(done.statusCode).toBe(202);
      const allowMetrics = (await allowApi.inject({ method: "GET", url: "/metrics" })).json() as MetricsBody;
      expect(allowMetrics.governance.intentsTotal).toBeGreaterThanOrEqual(1);
      expect(allowMetrics.governance.intentsByStatus.SUCCEEDED ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      await allowApi.close();
    }
  });

  it("N15-01: serves a valid Prometheus text exposition via Accept: text/plain, keeping JSON as the default", async () => {
    const api = await ready({ modelClient: planClient("internal.update") });

    // JSON remains the default with no Accept header.
    const jsonDefault = await api.inject({ method: "GET", url: "/metrics" });
    expect(jsonDefault.headers["content-type"]).toMatch(/application\/json/);
    expect(() => jsonDefault.json()).not.toThrow();

    // Drive a real job so a known counter line is non-zero.
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-metrics-prom" }),
      payload: { text: "internal note" },
    });
    expect(created.statusCode).toBe(202);
    const status = (created.json() as { status: string }).status;

    const viaAccept = await api.inject({
      method: "GET",
      url: "/metrics",
      headers: { accept: "text/plain" },
    });
    expect(viaAccept.statusCode).toBe(200);
    expect(viaAccept.headers["content-type"]).toMatch(/text\/plain/);
    const bodyAccept = viaAccept.body;

    const viaQuery = await api.inject({ method: "GET", url: "/metrics?format=prometheus" });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.headers["content-type"]).toMatch(/text\/plain/);

    const viaSiblingRoute = await api.inject({ method: "GET", url: "/metrics/prometheus" });
    expect(viaSiblingRoute.statusCode).toBe(200);
    expect(viaSiblingRoute.headers["content-type"]).toMatch(/text\/plain/);
    expect(viaSiblingRoute.body).toBe(bodyAccept);

    // Valid Prometheus/OpenMetrics exposition: every metric line is preceded
    // by matching # HELP and # TYPE ... gauge comment lines.
    const lines = bodyAccept.split("\n").filter((l) => l.length > 0);
    const metricNames = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("# HELP ")) {
        const name = line.slice("# HELP ".length).split(" ")[0]!;
        expect(lines[i + 1]).toBe(`# TYPE ${name} gauge`);
        metricNames.add(name);
      } else if (!line.startsWith("#")) {
        const metricPart = line.split(/[{ ]/)[0]!;
        expect(metricNames.has(metricPart)).toBe(true);
        expect(line).toMatch(/ -?\d+(\.\d+)?$/);
      }
    }
    expect(metricNames).toEqual(
      new Set([
        "ai_crm_agent_jobs_total",
        "ai_crm_agent_jobs_by_status",
        "ai_crm_governance_controls_total",
        "ai_crm_governance_controls_by_status",
        "ai_crm_governance_intents_total",
        "ai_crm_governance_intents_by_status",
        "ai_crm_dual_write_failures",
        "ai_crm_sse_active_job_subscriptions",
      ]),
    );

    // Known counter line reflecting the real job we just drove through, and
    // the dual-write-failure gauge cross-checked against the JSON value
    // (best-effort dual write may be non-zero when running against a real
    // pg pool with non-uuid test workspace ids; this assertion is mode-agnostic).
    expect(bodyAccept).toContain(`ai_crm_agent_jobs_by_status{status="${status}"} 1`);
    expect(bodyAccept).toContain("ai_crm_agent_jobs_total 1");
    const jsonAfter = (await api.inject({ method: "GET", url: "/metrics" })).json() as MetricsBody;
    expect(bodyAccept).toContain(`ai_crm_dual_write_failures ${jsonAfter.dualWriteFailures}`);
  });
});
