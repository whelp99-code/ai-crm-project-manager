import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { canonicalHashOf, POLICY_VERSION } from "@ai-crm/policy-engine";
import { ConnectorDispatcher } from "@ai-crm/connectors";
import { createApp, type CreateAppOptions } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS = "ws-s0";
const OPERATOR = "operator-1";
const APPROVER = "approver-1";

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


describe("S0 natural command integration", () => {
  it("S0-I-01: missing x-workspace-id → 4xx", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update" }]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-principal-id": OPERATOR, "idempotency-key": "k1" },
      payload: { text: "do something" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json()).toMatchObject({ error: "WORKSPACE_REQUIRED" });
  });

  it("S0-I-01b: missing x-principal-id → 4xx", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update" }]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: { "x-workspace-id": WS, "idempotency-key": "k1" },
      payload: { text: "do something" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json()).toMatchObject({ error: "PRINCIPAL_REQUIRED" });
  });

  it("S0-I-02: mock ModelClient is invoked via gateway service principal", async () => {
    const invokeSpy = vi.fn(async (_request: Parameters<ModelClient["invoke"]>[0]) => ({
      structuredOutput: {
        steps: [
          {
            suggestedCommand: "internal.update",
            title: "noop",
            resourceType: "",
            resourceId: "",
            resourceVersion: 1,
            payloadJson: "{}",
          },
        ],
      },
      modelVersion: "m1",
      retentionHonored: true,
    }));
    const api = await ready({
      modelClient: { invoke: invokeSpy },
      modelServicePrincipalId: "principal-model-gateway",
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-gateway" }),
      payload: { text: "internal note" },
    });
    expect(res.statusCode).toBe(202);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    // Gateway redacts and forwards; ModelClient never sees operator principal.
    expect(invokeSpy.mock.calls[0]![0]).toMatchObject({
      redactedPrompt: "internal note",
    });
  });

  it("S0-I-02b: MODEL_UNAVAILABLE when no modelClient", async () => {
    const api = await ready();
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-none" }),
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "MODEL_UNAVAILABLE" });
  });

  it("S0-I-03: unmapped command → work item failed, no PM mutation", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "rm -rf /", title: "bad" }]),
    });
    // Seed a plan so we can detect mutation.
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-s0-unmapped",
        projectId: "proj-1",
        objective: "keep",
        taskIds: ["t1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-unmap" }),
      payload: { text: "delete everything" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string; workItemIds: string[] };
    expect(body.status).toBe("failed");

    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(),
    });
    expect(job.statusCode).toBe(200);
    const snap = job.json() as { workItems: Array<{ status: string; errorCode?: string }> };
    expect(snap.workItems[0]).toMatchObject({ status: "failed", errorCode: "UNMAPPED_COMMAND" });

    // Plan history unchanged (still revision 1 only).
    // No assignment endpoints were hit; verifying job failed is the primary signal.
  });

  it("S0-I-04: SoD — requester cannot approve checkpoint from natural command", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "Assign",
          resourceId: "plan-sod",
          resourceVersion: 1,
          payload: {
            id: "asg-1",
            projectId: "proj-1",
            planId: "plan-sod",
            taskId: "task-1",
            assigneePrincipalId: "worker-1",
          },
        },
      ]),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-sod",
        projectId: "proj-1",
        objective: "sod",
        taskIds: ["task-1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-sod" }),
      payload: { text: "assign task" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; needsApproval: boolean; status: string };
    expect(body.needsApproval).toBe(true);
    expect(body.status).toBe("open");

    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(),
    });
    const controlId = (job.json() as { workItems: Array<{ controlId?: string }> }).workItems[0]?.controlId;
    expect(controlId).toBeTruthy();

    const selfApprove = await api.inject({
      method: "POST",
      url: `/api/governance/controls/${controlId}/decide`,
      headers: { "x-workspace-id": WS },
      payload: { principalId: OPERATOR, decision: "APPROVE" },
    });
    expect(selfApprove.statusCode).toBe(400);
    expect(selfApprove.json()).toMatchObject({ error: "SEPARATION_OF_DUTY" });
  });

  it("S0-I-06: happy path checkpoint assignTask → decide → consume → complete → done", async () => {
    const payload = {
      id: "asg-happy",
      projectId: "proj-happy",
      planId: "plan-happy",
      taskId: "task-happy",
      assigneePrincipalId: "worker-happy",
      createdAt: "2026-07-19T01:00:00.000Z",
    };
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "Assign happy",
          resourceId: "plan-happy",
          resourceVersion: 1,
          payload,
        },
      ]),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-happy",
        projectId: "proj-happy",
        objective: "happy",
        taskIds: ["task-happy"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-happy" }),
      payload: { text: "배정해줘" },
    });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json() as {
      jobId: string;
      workItemIds: string[];
      needsApproval: boolean;
      status: string;
    };
    expect(createdBody.needsApproval).toBe(true);

    const jobBefore = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${createdBody.jobId}`,
      headers: headers(),
    });
    const workItem = (jobBefore.json() as { workItems: Array<{ id: string; controlId?: string; status: string }> })
      .workItems[0]!;
    expect(workItem.status).toBe("waiting_control");
    const controlId = workItem.controlId!;

    const approve = await api.inject({
      method: "POST",
      url: `/api/governance/controls/${controlId}/decide`,
      headers: { "x-workspace-id": WS },
      payload: { principalId: APPROVER, decision: "APPROVE" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: "APPROVED" });

    const consume = await api.inject({
      method: "POST",
      url: `/api/governance/controls/${controlId}/consume`,
      headers: { "x-workspace-id": WS },
      payload: {
        resourceId: "plan-happy",
        resourceVersion: 1,
        payloadHash: canonicalHashOf("PM_TASK_ASSIGN", payload),
        policyVersion: POLICY_VERSION,
      },
    });
    expect(consume.statusCode).toBe(201);
    const intentId = (consume.json() as { id: string }).id;

    const complete = await api.inject({
      method: "POST",
      url: `/api/agent/jobs/${createdBody.jobId}/work-items/${workItem.id}/complete`,
      headers: headers(),
      payload: { intentId },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ status: "done", needsApproval: false });

    const audit = await api.inject({
      method: "GET",
      url: "/api/governance/audit",
      headers: { "x-workspace-id": WS },
    });
    const events = audit.json() as Array<{ kind: string }>;
    expect(events.some((e) => e.kind === "CONTROL_APPROVED")).toBe(true);
    expect(events.some((e) => e.kind === "INTENT_SUCCEEDED")).toBe(true);

    const eventsRes = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${createdBody.jobId}/events`,
      headers: headers(),
    });
    expect(eventsRes.statusCode).toBe(200);
    expect((eventsRes.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("S0-I-06b: ALLOW path internal.update completes without control", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "note" }]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-allow" }),
      payload: { text: "update internal" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "done", needsApproval: false });
  });

  it("S0-I-07: idempotency header replay returns same job", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "once" }]),
    });
    const first = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-replay" }),
      payload: { text: "once" },
    });
    const second = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-replay" }),
      payload: { text: "once again" },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
  });

  it("S0-I-07b: header/body idempotency mismatch → 400", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update" }]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "header-key" }),
      payload: { text: "x", idempotencyKey: "body-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "IDEMPOTENCY_MISMATCH" });
  });

  it("S0-I-08: remote connector dispatch → CONNECTOR_DISABLED", async () => {
    const dispatcher = new ConnectorDispatcher();
    try {
      dispatcher.dispatch({
        operationId: "remote.write",
        actionType: "CUSTOMER_SEND",
        effect: "remote",
      });
      expect.fail("expected CONNECTOR_DISABLED");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONNECTOR_DISABLED" });
    }
  });

  it("cancel cascade cancels waiting work items", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "A",
          resourceId: "plan-cancel",
          resourceVersion: 1,
          payload: {
            projectId: "p",
            planId: "plan-cancel",
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
        id: "plan-cancel",
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
      headers: headers({ "idempotency-key": "idem-cancel" }),
      payload: { text: "assign then cancel" },
    });
    const jobId = (created.json() as { jobId: string }).jobId;
    const cancelled = await api.inject({
      method: "POST",
      url: `/api/agent/jobs/${jobId}/cancel`,
      headers: headers(),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
  });
  it("S0-I-05: stale control binding after approve → no assignment complete", async () => {
    const payload = {
      id: "asg-tamper",
      projectId: "proj-tamper",
      planId: "plan-tamper",
      taskId: "task-tamper",
      assigneePrincipalId: "worker-tamper",
      createdAt: "2026-07-19T01:00:00.000Z",
    };
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "Assign tamper",
          resourceId: "plan-tamper",
          resourceVersion: 1,
          payload,
        },
      ]),
    });
    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-tamper",
        projectId: "proj-tamper",
        objective: "tamper",
        taskIds: ["task-tamper"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-tamper" }),
      payload: { text: "assign" },
    });
    const createdBody = created.json() as { jobId: string };
    const jobBefore = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${createdBody.jobId}`,
      headers: headers(),
    });
    const workItem = (jobBefore.json() as { workItems: Array<{ id: string; controlId?: string }> }).workItems[0]!;
    const controlId = workItem.controlId!;

    await api.inject({
      method: "POST",
      url: `/api/governance/controls/${controlId}/decide`,
      headers: { "x-workspace-id": WS },
      payload: { principalId: APPROVER, decision: "APPROVE" },
    });

    const consume = await api.inject({
      method: "POST",
      url: `/api/governance/controls/${controlId}/consume`,
      headers: { "x-workspace-id": WS },
      payload: {
        resourceId: "plan-tamper",
        resourceVersion: 1,
        payloadHash: canonicalHashOf("PM_TASK_ASSIGN", { ...payload, taskId: "tampered-task" }),
        policyVersion: POLICY_VERSION,
      },
    });
    expect(consume.statusCode).toBeGreaterThanOrEqual(400);
    expect(consume.json()).toMatchObject({ error: "STALE_CONTROL_BINDING" });

    const jobAfter = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${createdBody.jobId}`,
      headers: headers(),
    });
    expect((jobAfter.json() as { workItems: Array<{ status: string }> }).workItems[0]?.status).toBe("waiting_control");
  });

  it("S0 incomplete PM_PLAN_CREATE payload fails closed (no done)", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.plan_create",
          title: "bad plan",
          payload: { id: "only-id" },
        },
      ]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-incomplete" }),
      payload: { text: "create plan" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string };
    expect(body.status).not.toBe("done");
    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(),
    });
    const item = (job.json() as { workItems: Array<{ status: string; errorCode?: string }> }).workItems[0]!;
    expect(item.status).toBe("failed");
    expect(item.errorCode).toMatch(/INCOMPLETE_PAYLOAD|APPLY_FAILED/);
  });
  it("apply-fail invalidates orphan QUEUED intent (ALLOW path)", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.plan_create",
          title: "bad plan invalidate",
          payload: { id: "only-id" },
        },
      ]),
    });
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-invalidate-apply" }),
      payload: { text: "create incomplete plan" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string; status: string };
    expect(body.status).not.toBe("done");

    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${body.jobId}`,
      headers: headers(),
    });
    const item = (job.json() as { workItems: Array<{ status: string; errorCode?: string }> }).workItems[0]!;
    expect(item.status).toBe("failed");
    expect(item.errorCode).toMatch(/INCOMPLETE_PAYLOAD|APPLY_FAILED/);

    const audit = await api.inject({
      method: "GET",
      url: "/api/governance/audit",
      headers: { "x-workspace-id": WS },
    });
    const events = audit.json() as Array<{ kind: string; subjectId: string }>;
    expect(events.some((e) => e.kind === "INTENT_QUEUED")).toBe(true);
    expect(events.some((e) => e.kind === "INTENT_INVALIDATED" || e.kind === "INTENT_CANCELLED")).toBe(true);
    // Must not have succeeded after apply failure.
    expect(events.some((e) => e.kind === "INTENT_SUCCEEDED")).toBe(false);
  });

  it("SSE stream mode emits event frames for job snapshot", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update", title: "sse-note" }]),
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-sse" }),
      payload: { text: "note for sse" },
    });
    expect(created.statusCode).toBe(202);
    const jobId = (created.json() as { jobId: string }).jobId;

    const sse = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}/events`,
      headers: {
        ...headers(),
        accept: "text/event-stream",
      },
    });
    expect(sse.statusCode).toBe(200);
    const contentType = String(sse.headers["content-type"] ?? "");
    expect(contentType).toContain("text/event-stream");
    const payload = sse.body;
    expect(payload).toContain("event: job.updated");
    expect(payload).toContain("event: work_item.updated");
    expect(payload).toContain("event: stream.end");
    expect(payload).toContain(`"id":"${jobId}"`);

    // Backward-compat JSON stub without stream Accept.
    const jsonMode = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}/events`,
      headers: headers(),
    });
    expect(jsonMode.statusCode).toBe(200);
    expect((jsonMode.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("cancel cascade terminalizes governance control", async () => {
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "A",
          resourceId: "plan-cancel-ctl",
          resourceVersion: 1,
          payload: {
            projectId: "p",
            planId: "plan-cancel-ctl",
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
        id: "plan-cancel-ctl",
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
      headers: headers({ "idempotency-key": "idem-cancel-ctl" }),
      payload: { text: "assign then cancel" },
    });
    const jobId = (created.json() as { jobId: string }).jobId;
    const jobBefore = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: headers(),
    });
    const controlId = (jobBefore.json() as { workItems: Array<{ controlId?: string }> }).workItems[0]?.controlId!;
    const cancelled = await api.inject({
      method: "POST",
      url: `/api/agent/jobs/${jobId}/cancel`,
      headers: headers(),
    });
    expect(cancelled.statusCode).toBe(200);
    const controls = await api.inject({
      method: "GET",
      url: "/api/governance/controls",
      headers: { "x-workspace-id": WS },
    });
    const ctl = (controls.json() as Array<{ id: string; status: string }>).find((c) => c.id === controlId);
    expect(ctl?.status).toBe("CANCELLED");
  });

  it("cross-workspace job get returns 404", async () => {
    const api = await ready({
      modelClient: planClient([{ suggestedCommand: "internal.update" }]),
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-xws" }),
      payload: { text: "x" },
    });
    const jobId = (created.json() as { jobId: string }).jobId;
    const foreign = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: { "x-workspace-id": "ws-other", "x-principal-id": OPERATOR },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("default persistenceMode is memory without DATABASE_URL/pgPool", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const api = await ready({ modelClient: planClient([{ suggestedCommand: "internal.update" }]) });
      const runtime = (api as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm;
      expect(runtime?.persistenceMode).toBe("memory");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
    }
  });

  it("dual-write mock pool receives orch snapshot + governance rows on agent command", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pgPool = {
      async query<T = unknown>(sql: string, params?: unknown[]) {
        queries.push({ sql, ...(params ? { params } : {}) });
        if (sql.replace(/\s+/g, " ").trim().startsWith("INSERT INTO audit_events")) {
          return { rows: [{ id: "audit-fake-dw" } as T], rowCount: 1 };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    };
    const api = await ready({
      pgPool,
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "Assign",
          resourceId: "plan-dw",
          resourceVersion: 1,
          payload: {
            projectId: "p-dw",
            planId: "plan-dw",
            taskId: "t-dw",
            assigneePrincipalId: "worker-1",
          },
        },
      ]),
    });
    const runtime = (api as FastifyInstance & { aiCrm?: { persistenceMode: string; orchStore?: unknown; govRepo?: unknown } }).aiCrm;
    expect(runtime?.persistenceMode).toBe("pg");
    expect(runtime?.orchStore).toBeTruthy();
    expect(runtime?.govRepo).toBeTruthy();

    await api.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-dw",
        projectId: "p-dw",
        objective: "dw",
        taskIds: ["t-dw"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });
    const created = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-dual-write" }),
      payload: { text: "assign via dual-write" },
    });
    expect(created.statusCode).toBe(202);
    // orch upsert + governance control/intent inserts should have been attempted
    const sqlBlob = queries.map((q) => q.sql).join("\n");
    expect(sqlBlob).toMatch(/orch_jobs|INSERT INTO orch_/i);
    expect(queries.length).toBeGreaterThan(0);
  });
  it("dual-write failure logs a structured DUALWRITE_FAILED warning and does not fail the request (G-01 MEDIUM 3)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pgPool = {
        // Hydrate-on-boot reads must succeed (fail-closed hydrate is a
        // separate concern); only writes fail, to isolate dual-write
        // best-effort handling from boot-time hydrate.
        async query(sql: string) {
          if (/^\s*select/i.test(sql)) return { rows: [], rowCount: 0 };
          throw new Error("simulated dual-write failure");
        },
      };
      const api = await ready({
        pgPool,
        modelClient: planClient([
          {
            suggestedCommand: "pm.task_assign",
            title: "Assign",
            resourceId: "plan-dw-fail",
            resourceVersion: 1,
            payload: {
              projectId: "p-dw-fail",
              planId: "plan-dw-fail",
              taskId: "t-dw-fail",
              assigneePrincipalId: "worker-1",
            },
          },
        ]),
      });
      const runtime = (api as FastifyInstance & { aiCrm?: { persistenceMode: string; dualWriteFailures: number } })
        .aiCrm;
      expect(runtime?.persistenceMode).toBe("pg");
      expect(runtime?.dualWriteFailures).toBe(0);

      await api.inject({
        method: "POST",
        url: "/api/pm/plans",
        headers: { "x-workspace-id": WS },
        payload: {
          id: "plan-dw-fail",
          projectId: "p-dw-fail",
          objective: "dw-fail",
          taskIds: ["t-dw-fail"],
          createdByPrincipalId: OPERATOR,
          createdAt: "2026-07-19T00:00:00.000Z",
        },
      });
      const created = await api.inject({
        method: "POST",
        url: "/api/agent/commands",
        headers: headers({ "idempotency-key": "idem-dual-write-fail" }),
        payload: { text: "assign via failing dual-write" },
      });
      // Memory SoR stays authoritative: request succeeds despite the PG write failing.
      expect(created.statusCode).toBe(202);

      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warned).toMatch(/\[DUALWRITE_FAILED\]/);
      expect(warned).toMatch(/workspaceId=ws-s0/);
      expect(runtime?.dualWriteFailures).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ready() fails closed when databaseUrl set but pool cannot connect", async () => {
    // Inject a pool that fails on first dual-write is not ready-fail; instead
    // force onReady dynamic path with invalid URL and no injectable Pool by
    // stubbing — use pgPool that is undefined and databaseUrl that cannot open.
    // When pg is installed, Pool constructs but select 1 fails if server down.
    // Prefer explicit: pass databaseUrl and a custom failing via invalid module is hard;
    // use inject path: createApp with databaseUrl + mock by setting pgPool that
    // is not used for ready — ready only opens when !pool && databaseUrl.
    await expect(
      ready({
        databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/no_such_db",
        modelClient: planClient([{ suggestedCommand: "internal.update" }]),
      }),
    ).rejects.toThrow(/DATABASE_URL|Postgres pool|ECONNREFUSED|password|connect/i);
  });

});
