import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WS = "ws-s2";
const headers = { "x-workspace-id": WS };

function start(options: CreateAppOptions = {}): FastifyInstance {
  const instance = createApp(options);
  app = instance;
  return instance;
}

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = start(options);
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

function reportSnapshot() {
  return {
    goalVsResult: { goal: "Deliver", result: "Delivered", met: true },
    deliverables: [{ deliverableId: "d1", title: "Final", state: "approved", accepted: true }],
    scheduleVariance: { planned: 30, actual: 32, variance: 2 },
    scopeVariance: { planned: 10, actual: 10, variance: 0 },
    costVariance: { planned: 1000, actual: 1100, variance: 100 },
    riskVariance: { materializedRiskIds: ["risk-1"], figure: { planned: 1, actual: 2, variance: 1 } },
    financialImpact: {
      revenueKrw: "1000000",
      costKrw: "600000",
      profitabilityKrw: "400000",
      asOf: "2026-06-30",
    },
    aiActionHistory: [
      { at: "2026-07-15T09:00:00+09:00", principalId: "ai-pm", kind: "plan", summary: "planned" },
      { at: "2026-07-15T10:00:00+09:00", principalId: "ai-executor", kind: "execute", summary: "built" },
    ],
    exceptions: [{ id: "fx-1", title: "variance", severity: "medium", status: "resolved" }],
    evidenceLinks: [{ claim: "revenue", objectKey: "obj/rev", version: "1", digest: "deadbeef" }],
  };
}

describe("S2 AI execution + report delivery loop", () => {
  it("S2-I-01 review SoD + REWORK then independent PASS → ACCEPTED; missing evidence/traces fail closed", async () => {
    const api = await ready({ aiMinorThreshold: 1 });

    const missingEvidence = await api.inject({
      method: "POST",
      url: "/api/ai/executions",
      headers,
      payload: {
        id: "s2-exec-missing-ev",
        projectId: "project-s2",
        planId: "plan-s2",
        taskId: "task-s2-a",
        executorPrincipalId: "ai-executor",
        summary: "no evidence",
        evidence: [],
        requirementTraces: [{ requirementId: "req-1", deliverableId: "d1" }],
        submittedAt: "2026-07-15T10:00:00+09:00",
      },
    });
    expect(missingEvidence.statusCode).toBe(400);
    expect(missingEvidence.json()).toMatchObject({ error: "MISSING_EVIDENCE" });

    const missingTraces = await api.inject({
      method: "POST",
      url: "/api/ai/executions",
      headers,
      payload: {
        id: "s2-exec-missing-tr",
        projectId: "project-s2",
        planId: "plan-s2",
        taskId: "task-s2-b",
        executorPrincipalId: "ai-executor",
        summary: "no traces",
        evidence: [{ objectKey: "k", version: "1", digest: "d" }],
        requirementTraces: [],
        submittedAt: "2026-07-15T10:00:00+09:00",
      },
    });
    expect(missingTraces.statusCode).toBe(400);
    expect(missingTraces.json()).toMatchObject({ error: "MISSING_TRACE" });

    const submit = await api.inject({
      method: "POST",
      url: "/api/ai/executions",
      headers,
      payload: {
        id: "s2-exec-1",
        projectId: "project-s2",
        planId: "plan-s2",
        taskId: "task-s2",
        executorPrincipalId: "ai-executor",
        summary: "first attempt",
        evidence: [{ objectKey: "obj/s2", version: "1", digest: "abc" }],
        requirementTraces: [{ requirementId: "req-1", deliverableId: "d1" }],
        submittedAt: "2026-07-15T10:00:00+09:00",
      },
    });
    expect(submit.statusCode).toBe(201);
    expect(submit.json()).toMatchObject({ id: "s2-exec-1", status: "SUBMITTED", attempt: 1 });

    const selfReview = await api.inject({
      method: "POST",
      url: "/api/ai/reviews",
      headers,
      payload: {
        id: "s2-rev-self",
        executionId: "s2-exec-1",
        reviewerPrincipalId: "ai-executor",
        defects: [],
        reviewedAt: "2026-07-15T11:00:00+09:00",
      },
    });
    expect(selfReview.statusCode).toBe(400);
    expect(selfReview.json()).toMatchObject({ error: "INDEPENDENT_REVIEW_REQUIRED" });

    const critical = await api.inject({
      method: "POST",
      url: "/api/ai/reviews",
      headers,
      payload: {
        id: "s2-rev-critical",
        executionId: "s2-exec-1",
        reviewerPrincipalId: "ai-reviewer",
        defects: [{ id: "d-crit", description: "critical defect", severity: "critical" }],
        reviewedAt: "2026-07-15T11:05:00+09:00",
      },
    });
    expect(critical.statusCode).toBe(201);
    expect(critical.json()).toMatchObject({
      review: { verdict: "FAIL", criticalCount: 1 },
      execution: { status: "REWORK_REQUIRED", attempt: 1 },
    });

    // After REWORK, independent PASS on a fresh resubmit path is exercised via a second execution
    // (API does not expose resubmitExecution; ACCEPTED is verified on a clean independent review).
    const submit2 = await api.inject({
      method: "POST",
      url: "/api/ai/executions",
      headers,
      payload: {
        id: "s2-exec-2",
        projectId: "project-s2",
        planId: "plan-s2",
        taskId: "task-s2-retry",
        executorPrincipalId: "ai-executor",
        summary: "retry attempt",
        evidence: [{ objectKey: "obj/s2", version: "2", digest: "def" }],
        requirementTraces: [{ requirementId: "req-1", deliverableId: "d1" }],
        submittedAt: "2026-07-15T12:00:00+09:00",
      },
    });
    expect(submit2.statusCode).toBe(201);

    const pass = await api.inject({
      method: "POST",
      url: "/api/ai/reviews",
      headers,
      payload: {
        id: "s2-rev-pass",
        executionId: "s2-exec-2",
        reviewerPrincipalId: "ai-reviewer",
        defects: [],
        reviewedAt: "2026-07-15T12:30:00+09:00",
      },
    });
    expect(pass.statusCode).toBe(201);
    expect(pass.json()).toMatchObject({
      review: { verdict: "PASS" },
      execution: { status: "ACCEPTED" },
    });

    const accepted = await api.inject({
      method: "GET",
      url: "/api/ai/executions/s2-exec-2",
      headers,
    });
    expect(accepted.json()).toMatchObject({ status: "ACCEPTED" });
  });

  it("S2-I-02 report immutability: final snapshot frozen; reject/mutate cannot silently rewrite fields", async () => {
    const api = await ready();
    const snapshot = reportSnapshot();

    const submit = await api.inject({
      method: "POST",
      url: "/api/reports",
      headers,
      payload: {
        id: "s2-report-1",
        projectId: "project-s2",
        submittedByPrincipalId: "ai-pm",
        submittedAt: "2026-07-15T12:00:00+09:00",
        snapshot,
      },
    });
    expect(submit.statusCode).toBe(201);
    const created = submit.json() as {
      id: string;
      snapshotHash: string;
      snapshot: { financialImpact: { profitabilityKrw: string }; goalVsResult: { met: boolean } };
      status: string;
    };
    expect(created.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const originalHash = created.snapshotHash;
    const originalProfit = created.snapshot.financialImpact.profitabilityKrw;

    const immutable = await api.inject({
      method: "GET",
      url: "/api/reports/s2-report-1/immutable",
      headers,
    });
    expect(immutable.statusCode).toBe(200);
    expect(immutable.json()).toEqual({ immutable: true });

    // Reject path must not rewrite snapshot fields (status/reason only).
    const reject = await api.inject({
      method: "POST",
      url: "/api/reports/s2-report-1/reject",
      headers,
      payload: {
        principalId: "human-reviewer",
        decidedAt: "2026-07-15T13:00:00+09:00",
        reason: "needs rework",
      },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toMatchObject({
      status: "REJECTED",
      rejectionReason: "needs rework",
      snapshotHash: originalHash,
      snapshot: {
        financialImpact: { profitabilityKrw: originalProfit },
        goalVsResult: { met: true },
      },
    });

    // GET still verifies immutability after reject.
    const afterReject = await api.inject({
      method: "GET",
      url: "/api/reports/s2-report-1",
      headers,
    });
    expect(afterReject.json()).toMatchObject({
      snapshotHash: originalHash,
      snapshot: { financialImpact: { profitabilityKrw: originalProfit } },
    });
    expect(
      (await api.inject({ method: "GET", url: "/api/reports/s2-report-1/immutable", headers })).json(),
    ).toEqual({ immutable: true });

    // Duplicate submit (mutate-by-resubmit) is rejected — no silent rewrite.
    const resubmit = await api.inject({
      method: "POST",
      url: "/api/reports",
      headers,
      payload: {
        id: "s2-report-1",
        projectId: "project-s2",
        submittedByPrincipalId: "ai-pm",
        submittedAt: "2026-07-15T14:00:00+09:00",
        snapshot: {
          ...snapshot,
          financialImpact: {
            ...snapshot.financialImpact,
            profitabilityKrw: "999999",
            revenueKrw: "1599999",
          },
        },
      },
    });
    expect(resubmit.statusCode).toBe(409);
    expect(resubmit.json()).toMatchObject({ error: "DUPLICATE_ID" });

    const still = await api.inject({
      method: "GET",
      url: "/api/reports/s2-report-1",
      headers,
    });
    expect(still.json()).toMatchObject({
      snapshotHash: originalHash,
      snapshot: { financialImpact: { profitabilityKrw: originalProfit } },
    });
  });

  it("S2-I-01b REWORK review with agentJobId+agentWorkItemId reopens done work item", async () => {
    const api = await ready({
      aiMinorThreshold: 0,
      modelClient: planClient([
        {
          suggestedCommand: "internal.update",
          title: "Apply internal update",
          payload: { note: "s2-rework" },
        },
      ]),
    });

    const command = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        ...headers,
        "x-principal-id": "operator-s2",
        "idempotency-key": "s2-rework-bridge",
      },
      payload: { text: "run internal update" },
    });
    expect(command.statusCode).toBe(202);
    const cmdBody = command.json() as {
      jobId: string;
      status: string;
      workItemIds: string[];
    };
    expect(cmdBody.status).toBe("done");
    expect(cmdBody.workItemIds).toHaveLength(1);

    const jobBefore = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${cmdBody.jobId}`,
      headers: { ...headers, "x-principal-id": "operator-s2" },
    });
    const snapBefore = jobBefore.json() as {
      workItems: Array<{ id: string; status: string; resultRef?: unknown; errorCode?: string }>;
    };
    const workItemId = snapBefore.workItems[0]!.id;
    expect(snapBefore.workItems[0]).toMatchObject({ status: "done" });

    const exec = await api.inject({
      method: "POST",
      url: "/api/ai/executions",
      headers,
      payload: {
        id: "s2-exec-bridge",
        projectId: "project-s2",
        planId: "plan-s2",
        taskId: "task-bridge",
        executorPrincipalId: "ai-executor",
        summary: "bridge attempt",
        evidence: [{ objectKey: "obj/bridge", version: "1", digest: "bridge" }],
        requirementTraces: [{ requirementId: "req-bridge", deliverableId: "d-bridge" }],
        submittedAt: "2026-07-15T15:00:00+09:00",
      },
    });
    expect(exec.statusCode).toBe(201);

    const rework = await api.inject({
      method: "POST",
      url: "/api/ai/reviews",
      headers,
      payload: {
        id: "s2-rev-bridge",
        executionId: "s2-exec-bridge",
        reviewerPrincipalId: "ai-reviewer",
        defects: [{ id: "d-bridge", description: "needs rework", severity: "critical" }],
        reviewedAt: "2026-07-15T15:10:00+09:00",
        agentJobId: cmdBody.jobId,
        agentWorkItemId: workItemId,
      },
    });
    expect(rework.statusCode).toBe(201);
    const reworkBody = rework.json() as {
      execution: { status: string };
      reopenedWorkItem?: { id: string; status: string; resultRef?: unknown; errorCode?: string };
    };
    expect(reworkBody.execution.status).toBe("REWORK_REQUIRED");
    expect(reworkBody.reopenedWorkItem).toMatchObject({
      id: workItemId,
      status: "queued",
    });
    expect(reworkBody.reopenedWorkItem?.resultRef).toBeUndefined();
    expect(reworkBody.reopenedWorkItem?.errorCode).toBeUndefined();

    const jobAfter = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${cmdBody.jobId}`,
      headers: { ...headers, "x-principal-id": "operator-s2" },
    });
    const snapAfter = jobAfter.json() as {
      job: { status: string };
      workItems: Array<{ id: string; status: string; resultRef?: unknown; errorCode?: string }>;
    };
    expect(snapAfter.workItems[0]).toMatchObject({ id: workItemId, status: "queued" });
    expect(snapAfter.workItems[0]!.status).not.toBe("done");
    expect(snapAfter.workItems[0]!.resultRef).toBeUndefined();
    expect(snapAfter.job.status).toBe("open");
  });
});
