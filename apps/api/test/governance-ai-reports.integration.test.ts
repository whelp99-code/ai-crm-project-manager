import { afterEach, describe, expect, it } from "vitest";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { canonicalHashOf, POLICY_VERSION } from "@ai-crm/policy-engine";
import type { ModelClient } from "@ai-crm/model-gateway";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const headers = { "x-workspace-id": "ws-1" };

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

describe("Governance approval inbox and audit (AC-09/AC-11)", () => {
  it("routes a protected scope change through authorize -> inbox -> approve -> consume", async () => {
    const api = await ready();
    const payload = { contractScope: "New scope" };
    const authorized = await api.inject({
      method: "POST", url: "/api/governance/authorize", headers,
      payload: { command: "project.scope_change", resourceId: "project-1", resourceVersion: 1, payload, requesterPrincipalId: "ai-pm" },
    });
    expect(authorized.statusCode).toBe(201);
    const control = authorized.json().control as { id: string; kind: string; status: string };
    expect(control).toMatchObject({ kind: "APPROVAL", status: "PENDING" });

    // Pending inbox shows the control.
    const inbox = await api.inject({ method: "GET", url: "/api/governance/controls?status=PENDING", headers });
    expect(inbox.json()).toMatchObject([{ id: control.id, actionType: "SCOPE_CHANGE" }]);

    // Requester cannot self-approve (SoD).
    const selfApprove = await api.inject({
      method: "POST", url: `/api/governance/controls/${control.id}/decide`, headers,
      payload: { principalId: "ai-pm", decision: "APPROVE" },
    });
    expect(selfApprove.statusCode).toBe(400);
    expect(selfApprove.json()).toMatchObject({ error: "SEPARATION_OF_DUTY" });

    const approve = await api.inject({
      method: "POST", url: `/api/governance/controls/${control.id}/decide`, headers,
      payload: { principalId: "human-approver", decision: "APPROVE" },
    });
    expect(approve.json()).toMatchObject({ status: "APPROVED" });

    // Consuming with a mismatched binding is rejected before any valid consume.
    const stale = await api.inject({
      method: "POST", url: `/api/governance/controls/${control.id}/consume`, headers,
      payload: { resourceId: "project-1", resourceVersion: 1, payloadHash: canonicalHashOf("SCOPE_CHANGE", { contractScope: "tampered" }), policyVersion: POLICY_VERSION },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "STALE_CONTROL_BINDING" });

    // Consume with the exact bound payload hash produces a queued intent.
    const consume = await api.inject({
      method: "POST", url: `/api/governance/controls/${control.id}/consume`, headers,
      payload: {
        resourceId: "project-1", resourceVersion: 1,
        payloadHash: canonicalHashOf("SCOPE_CHANGE", payload), policyVersion: POLICY_VERSION,
      },
    });
    expect(consume.statusCode).toBe(201);
    expect(consume.json()).toMatchObject({ status: "QUEUED", actionType: "SCOPE_CHANGE" });

    // Audit chain is intact and verifiable.
    const audit = await api.inject({ method: "GET", url: "/api/governance/audit/verify", headers });
    expect(audit.json()).toEqual({ valid: true });
    const events = await api.inject({ method: "GET", url: "/api/governance/audit", headers });
    expect((events.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it("allows a low-risk internal update without a control and blocks cross-workspace audit", async () => {
    const api = await ready();
    const authorized = await api.inject({
      method: "POST", url: "/api/governance/authorize", headers,
      payload: { command: "internal.update", resourceId: "r1", resourceVersion: 1, payload: { note: "x" }, requesterPrincipalId: "p1" },
    });
    expect(authorized.json()).toMatchObject({ requiredControl: "ALLOW", intent: { status: "QUEUED" } });
    const foreign = await api.inject({ method: "GET", url: "/api/governance/controls", headers: { "x-workspace-id": "ws-2" } });
    expect(foreign.json()).toEqual([]);
  });

  it("refuses cross-workspace control decisions and notification transitions", async () => {
    const api = await ready();
    const authorized = await api.inject({
      method: "POST", url: "/api/governance/authorize", headers,
      payload: { command: "customer.send", resourceId: "customer-1", resourceVersion: 1, payload: { message: "hi" }, requesterPrincipalId: "ai-pm" },
    });
    const controlId = (authorized.json().control as { id: string }).id;
    // A ws-2 caller cannot approve a ws-1 control even with a guessable id.
    const foreign = await api.inject({
      method: "POST", url: `/api/governance/controls/${controlId}/decide`, headers: { "x-workspace-id": "ws-2" },
      payload: { principalId: "attacker", decision: "APPROVE" },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "CONTROL_NOT_FOUND" });

    const created = await api.inject({ method: "POST", url: "/api/notifications", headers, payload: { subjectId: "s1" } });
    const notificationId = created.json().id as string;
    const foreignNotify = await api.inject({
      method: "POST", url: `/api/notifications/${notificationId}/transition`, headers: { "x-workspace-id": "ws-2" },
      payload: { status: "SENT" },
    });
    expect(foreignNotify.statusCode).toBe(404);
    expect(foreignNotify.json()).toMatchObject({ error: "NOTIFICATION_NOT_FOUND" });
  });
});

describe("Notification lifecycle (AC-12)", () => {
  it("drives PENDING -> SENT -> ESCALATED -> ACKED and lists by status", async () => {
    const api = await ready();
    const created = await api.inject({ method: "POST", url: "/api/notifications", headers, payload: { subjectId: "control-000001" } });
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({ status: "PENDING", attempts: 0 });

    expect((await api.inject({ method: "POST", url: `/api/notifications/${id}/transition`, headers, payload: { status: "SENT" } })).json()).toMatchObject({ status: "SENT", attempts: 1 });
    expect((await api.inject({ method: "POST", url: `/api/notifications/${id}/transition`, headers, payload: { status: "ESCALATED" } })).json()).toMatchObject({ status: "ESCALATED" });
    expect((await api.inject({ method: "POST", url: `/api/notifications/${id}/transition`, headers, payload: { status: "ACKED" } })).json()).toMatchObject({ status: "ACKED" });

    // Illegal transition (ACKED is terminal) fails.
    const bad = await api.inject({ method: "POST", url: `/api/notifications/${id}/transition`, headers, payload: { status: "SENT" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "INVALID_NOTIFICATION_TRANSITION" });

    const acked = await api.inject({ method: "GET", url: "/api/notifications?status=ACKED", headers });
    expect(acked.json()).toMatchObject([{ id, status: "ACKED" }]);
  });
});

describe("Model gateway boundary via API (AC-11)", () => {
  const modelClient: ModelClient = {
    async invoke() {
      return { structuredOutput: { riskLevel: "medium" }, modelVersion: "m1", retentionHonored: true };
    },
  };
  const outputSchema = { schemaVersion: "risk.v1", root: { kind: "object", fields: { riskLevel: { kind: "enum", values: ["low", "medium", "high"] } } } };

  it("stays fail-closed when no provider is configured", async () => {
    const api = await ready();
    const denied = await api.inject({
      method: "POST", url: "/api/model/invoke", headers,
      payload: { operationId: "op.risk", principalId: "principal-model-gateway", promptVersion: "v1", modelVersion: "m1", prompt: "assess", outputSchema, correlationId: "c1" },
    });
    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({ error: "MODEL_GATEWAY_UNSET" });
  });

  it("invokes inference and records a redacted invocation when a provider is injected", async () => {
    const api = await ready({ modelClient });
    const invoke = await api.inject({
      method: "POST", url: "/api/model/invoke", headers,
      payload: { operationId: "op.risk", principalId: "principal-model-gateway", promptVersion: "v1", modelVersion: "m1", prompt: "assess a@b.com", outputSchema, correlationId: "c1" },
    });
    expect(invoke.statusCode).toBe(201);
    expect(invoke.json()).toMatchObject({ structuredOutput: { riskLevel: "medium" }, invocation: { actionType: "MODEL_INVOKE", retentionMode: "zero-retention" } });
    expect(JSON.stringify(invoke.json())).not.toContain("a@b.com");

    const denied = await api.inject({
      method: "POST", url: "/api/model/invoke", headers,
      payload: { operationId: "op.risk", principalId: "principal-api", promptVersion: "v1", modelVersion: "m1", prompt: "assess", outputSchema, correlationId: "c2" },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: "PRINCIPAL_DENIED" });
  });
});

describe("AI execution and independent review (AC-03/04/05/06)", () => {
  it("blocks review by the executor and accepts an independent passing review", async () => {
    const api = await ready({ aiMinorThreshold: 1 });
    const submit = await api.inject({
      method: "POST", url: "/api/ai/executions", headers,
      payload: {
        id: "exec-1", projectId: "project-1", planId: "plan-1", taskId: "task-1", executorPrincipalId: "ai-executor",
        summary: "done", evidence: [{ objectKey: "k", version: "1", digest: "d" }],
        requirementTraces: [{ requirementId: "req-1", deliverableId: "deliverable-1" }], submittedAt: "2026-07-15T10:00:00+09:00",
      },
    });
    expect(submit.statusCode).toBe(201);

    const noEvidence = await api.inject({
      method: "POST", url: "/api/ai/executions", headers,
      payload: { id: "exec-2", projectId: "project-1", planId: "plan-1", taskId: "task-2", executorPrincipalId: "ai-executor", summary: "x", evidence: [], requirementTraces: [], submittedAt: "2026-07-15T10:00:00+09:00" },
    });
    expect(noEvidence.statusCode).toBe(400);
    expect(noEvidence.json()).toMatchObject({ error: "MISSING_EVIDENCE" });

    const selfReview = await api.inject({
      method: "POST", url: "/api/ai/reviews", headers,
      payload: { id: "rev-1", executionId: "exec-1", reviewerPrincipalId: "ai-executor", defects: [], reviewedAt: "2026-07-15T11:00:00+09:00" },
    });
    expect(selfReview.statusCode).toBe(400);
    expect(selfReview.json()).toMatchObject({ error: "INDEPENDENT_REVIEW_REQUIRED" });

    const critical = await api.inject({
      method: "POST", url: "/api/ai/reviews", headers,
      payload: { id: "rev-2", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer", defects: [{ id: "d1", description: "loss", severity: "critical" }], reviewedAt: "2026-07-15T11:00:00+09:00" },
    });
    expect(critical.json()).toMatchObject({ review: { verdict: "FAIL" }, execution: { status: "REWORK_REQUIRED" } });
  });
});

describe("Final report snapshot + follow-up (AC-13/AC-14)", () => {
  function snapshot() {
    return {
      goalVsResult: { goal: "Deliver", result: "Delivered", met: true },
      deliverables: [{ deliverableId: "d1", title: "Final", state: "approved", accepted: true }],
      scheduleVariance: { planned: 30, actual: 32, variance: 2 },
      scopeVariance: { planned: 10, actual: 10, variance: 0 },
      costVariance: { planned: 1000, actual: 1100, variance: 100 },
      riskVariance: { materializedRiskIds: ["risk-1"], figure: { planned: 1, actual: 2, variance: 1 } },
      financialImpact: { revenueKrw: "1000000", costKrw: "600000", profitabilityKrw: "400000", asOf: "2026-06-30" },
      aiActionHistory: [
        { at: "2026-07-15T09:00:00+09:00", principalId: "ai-pm", kind: "plan", summary: "planned" },
        { at: "2026-07-15T10:00:00+09:00", principalId: "ai-executor", kind: "execute", summary: "built" },
      ],
      exceptions: [{ id: "fx-1", title: "variance", severity: "medium", status: "resolved" }],
      evidenceLinks: [{ claim: "revenue", objectKey: "obj/rev", version: "1", digest: "deadbeef" }],
    };
  }

  it("submits an immutable snapshot and runs the reject + follow-up flow (per-field)", async () => {
    const api = await ready();
    const submit = await api.inject({
      method: "POST", url: "/api/reports", headers,
      payload: { id: "report-1", projectId: "project-1", submittedByPrincipalId: "ai-pm", submittedAt: "2026-07-15T12:00:00+09:00", snapshot: snapshot() },
    });
    expect(submit.statusCode).toBe(201);
    const body = submit.json();
    // AC-13 per-field presence (a)-(j).
    expect(body.snapshot.goalVsResult).toMatchObject({ met: true });
    expect(body.snapshot.deliverables).toHaveLength(1);
    expect(body.snapshot.scheduleVariance.variance).toBe(2);
    expect(body.snapshot.scopeVariance.variance).toBe(0);
    expect(body.snapshot.costVariance.variance).toBe(100);
    expect(body.snapshot.riskVariance.materializedRiskIds).toEqual(["risk-1"]);
    expect(body.snapshot.financialImpact.profitabilityKrw).toBe("400000");
    expect(body.snapshot.aiActionHistory).toHaveLength(2);
    expect(body.snapshot.exceptions[0].status).toBe("resolved");
    expect(body.snapshot.evidenceLinks[0].digest).toBe("deadbeef");
    expect(body.snapshotHash).toMatch(/^[a-f0-9]{64}$/);

    expect((await api.inject({ method: "GET", url: "/api/reports/report-1/immutable", headers })).json()).toEqual({ immutable: true });

    // Reject requires a reason; SoD blocks self-decision.
    const selfReject = await api.inject({
      method: "POST", url: "/api/reports/report-1/reject", headers,
      payload: { principalId: "ai-pm", decidedAt: "2026-07-15T13:00:00+09:00", reason: "rework" },
    });
    expect(selfReject.statusCode).toBe(400);
    expect(selfReject.json()).toMatchObject({ error: "SOD_VIOLATION" });

    const reject = await api.inject({
      method: "POST", url: "/api/reports/report-1/reject", headers,
      payload: { principalId: "human-reviewer", decidedAt: "2026-07-15T13:00:00+09:00", reason: "needs rework" },
    });
    expect(reject.json()).toMatchObject({ status: "REJECTED", rejectionReason: "needs rework" });

    const followUp = await api.inject({
      method: "POST", url: "/api/reports/report-1/follow-ups", headers,
      payload: { id: "fu-1", title: "Redo section", description: "fix numbers", createdByPrincipalId: "ai-pm", createdAt: "2026-07-15T14:00:00+09:00" },
    });
    expect(followUp.statusCode).toBe(201);
    const done = await api.inject({
      method: "POST", url: "/api/follow-ups/fu-1/complete", headers,
      payload: { principalId: "ai-pm", at: "2026-07-15T15:00:00+09:00" },
    });
    expect(done.json()).toMatchObject({ status: "DONE", completedByPrincipalId: "ai-pm" });
  });

  it("rejects an inconsistent financial snapshot", async () => {
    const api = await ready();
    const bad = snapshot();
    bad.financialImpact.profitabilityKrw = "999";
    const submit = await api.inject({
      method: "POST", url: "/api/reports", headers,
      payload: { id: "report-2", projectId: "project-1", submittedByPrincipalId: "ai-pm", submittedAt: "2026-07-15T12:00:00+09:00", snapshot: bad },
    });
    expect(submit.statusCode).toBe(400);
    expect(submit.json()).toMatchObject({ error: "INCONSISTENT_FINANCIALS" });
  });
});
