import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionType } from "@ai-crm/contracts";
import { ModelGateway, type ModelClient, type StructuredOutputSchema } from "@ai-crm/model-gateway";
import { AiOrchestrator, type ExecutionSubmission } from "../src/index.js";

function submission(overrides: Partial<ExecutionSubmission> = {}): ExecutionSubmission {
  return {
    id: "exec-1",
    workspaceId: "ws-1",
    projectId: "project-1",
    planId: "plan-1",
    taskId: "task-1",
    executorPrincipalId: "ai-executor",
    summary: "Implemented feature",
    evidence: [{ objectKey: "artifacts/build.log", version: "1", digest: "deadbeef" }],
    requirementTraces: [{ requirementId: "req-1", deliverableId: "deliverable-1" }],
    submittedAt: "2026-07-15T10:00:00+09:00",
    ...overrides,
  };
}

describe("AiOrchestrator — execution, evidence and independent review", () => {
  it("blocks submission without an evidence manifest or requirement trace", () => {
    const orch = new AiOrchestrator({ minorThreshold: 2 });
    expect(() => orch.submitExecution(submission({ evidence: [] }))).toThrowError(/evidence manifest/);
    expect(() => orch.submitExecution(submission({ requirementTraces: [] }))).toThrowError(/requirement traceability/);
    expect(() =>
      orch.submitExecution(submission({ evidence: [{ objectKey: "k", version: "", digest: "d" }] })),
    ).toThrowError(/objectKey, version and digest/);
  });

  it("requires an independent reviewer principal (never the executor)", () => {
    const orch = new AiOrchestrator({ minorThreshold: 2 });
    orch.submitExecution(submission());
    expect(() =>
      orch.review({ id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-executor", defects: [], reviewedAt: "2026-07-15T11:00:00+09:00" }),
    ).toThrowError(/independent of the executor/);
  });

  it("passes the quality gate with zero critical and minors within threshold; accepts the execution", () => {
    const orch = new AiOrchestrator({ minorThreshold: 2 });
    orch.submitExecution(submission());
    const { review, execution } = orch.review({
      id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer",
      defects: [{ id: "d1", description: "typo", severity: "minor" }],
      reviewedAt: "2026-07-15T11:00:00+09:00",
    });
    expect(review).toMatchObject({ verdict: "PASS", criticalCount: 0, minorCount: 1, attempt: 1 });
    expect(execution.status).toBe("ACCEPTED");
  });

  it("blocks on any critical defect regardless of minor count", () => {
    const orch = new AiOrchestrator({ minorThreshold: 5 });
    orch.submitExecution(submission());
    const { review, execution } = orch.review({
      id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer",
      defects: [{ id: "d1", description: "data loss", severity: "critical" }],
      reviewedAt: "2026-07-15T11:00:00+09:00",
    });
    expect(review.verdict).toBe("FAIL");
    expect(execution.status).toBe("REWORK_REQUIRED");
  });

  it("fails when minor defects exceed the configured threshold (boundary)", () => {
    const orch = new AiOrchestrator({ minorThreshold: 1 });
    orch.submitExecution(submission());
    const { review } = orch.review({
      id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer",
      defects: [
        { id: "d1", description: "a", severity: "minor" },
        { id: "d2", description: "b", severity: "minor" },
      ],
      reviewedAt: "2026-07-15T11:00:00+09:00",
    });
    expect(review).toMatchObject({ verdict: "FAIL", minorCount: 2 });
  });

  it("supports retry/restart: rework then a fresh accepted attempt", () => {
    const orch = new AiOrchestrator({ minorThreshold: 0 });
    orch.submitExecution(submission());
    orch.review({
      id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer",
      defects: [{ id: "d1", description: "bug", severity: "critical" }],
      reviewedAt: "2026-07-15T11:00:00+09:00",
    });
    const retried = orch.resubmitExecution("ws-1", "exec-1", {
      summary: "Fixed the bug",
      evidence: [{ objectKey: "artifacts/build2.log", version: "2", digest: "cafef00d" }],
      requirementTraces: [{ requirementId: "req-1", deliverableId: "deliverable-1" }],
      submittedAt: "2026-07-15T12:00:00+09:00",
      executorPrincipalId: "ai-executor",
    });
    expect(retried).toMatchObject({ attempt: 2, status: "SUBMITTED" });
    const { review, execution } = orch.review({
      id: "rev-2", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer",
      defects: [], reviewedAt: "2026-07-15T13:00:00+09:00",
    });
    expect(review).toMatchObject({ verdict: "PASS", attempt: 2 });
    expect(execution.status).toBe("ACCEPTED");
    expect(orch.reviewsFor("ws-1", "exec-1").map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("cannot review an already-accepted execution and denies cross-workspace access", () => {
    const orch = new AiOrchestrator({ minorThreshold: 0 });
    orch.submitExecution(submission());
    orch.review({ id: "rev-1", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer", defects: [], reviewedAt: "2026-07-15T11:00:00+09:00" });
    expect(() =>
      orch.review({ id: "rev-2", workspaceId: "ws-1", executionId: "exec-1", reviewerPrincipalId: "ai-reviewer", defects: [], reviewedAt: "2026-07-15T12:00:00+09:00" }),
    ).toThrowError(/not reviewable/);
    expect(() => orch.getExecution("ws-2", "exec-1")).toThrowError(/another workspace/);
  });

  it("performs structured analysis only through the model gateway", async () => {
    const orch = new AiOrchestrator({ minorThreshold: 0 });
    const outputSchema: StructuredOutputSchema = {
      schemaVersion: "plan.v1",
      root: { kind: "object", fields: { nextStep: { kind: "string" } } },
    };
    const modelClient: ModelClient = {
      async invoke() {
        return { structuredOutput: { nextStep: "run integration tests" }, modelVersion: "m", retentionHonored: true };
      },
    };
    const gateway = new ModelGateway(modelClient, {
      servicePrincipalId: "principal-model-gateway",
      resolveOperation: (): ActionType => "MODEL_INVOKE",
    });
    const result = await orch.analyze<{ nextStep: string }>(gateway, {
      workspaceId: "ws-1", operationId: "op.model.plan", principalId: "principal-model-gateway",
      promptVersion: "p.v1", modelVersion: "m", prompt: "what next", outputSchema, correlationId: "corr-9",
    });
    expect(result.structuredOutput.nextStep).toBe("run integration tests");
    expect(result.invocation.retentionMode).toBe("zero-retention");
  });

  it("does not import a model SDK or any effect capability", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    const importSpecifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    // Inference only via the model-gateway contract; no SDK, network, connector or effect package.
    for (const forbidden of ["node:http", "node:https", "undici", "axios", "@ai-crm/connectors", "@ai-crm/governance"]) {
      expect(importSpecifiers).not.toContain(forbidden);
    }
    // The only model access is the gateway's typed contract.
    expect(importSpecifiers).toContain("@ai-crm/model-gateway");
    const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@ai-crm/contracts", "@ai-crm/model-gateway"]);
  });
});
