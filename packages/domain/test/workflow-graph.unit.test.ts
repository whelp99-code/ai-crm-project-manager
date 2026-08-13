import { describe, expect, it } from "vitest";
import {
  WorkflowGraphError,
  WorkflowGraphRuntime,
  type WorkflowGraphSpec,
} from "../src/workflow-graph.js";

interface State extends Record<string, unknown> {
  attempts: number;
  approved?: boolean;
  verified?: boolean;
}

function graph(): WorkflowGraphSpec {
  return {
    id: "proposal-loop",
    version: "1.0.0",
    entryNodeId: "build",
    defaultMaxNodeVisits: 10,
    maxTransitions: 30,
    maxCostUnits: 20,
    maxDurationMs: 60_000,
    nodes: [
      { id: "build", kind: "ACTION", title: "Build", requirementIds: ["REQ-1"] },
      { id: "verify", kind: "VERIFY", title: "Verify", requirementIds: ["REQ-1"] },
      { id: "approve", kind: "APPROVAL", title: "Approve", requirementIds: ["REQ-2"], approvalActionType: "QUOTE_APPROVE" },
      { id: "done", kind: "TERMINAL", title: "Done", requirementIds: [], terminalResult: "SUCCESS" },
    ],
    edges: [
      { id: "b-v", from: "build", to: "verify", outcome: "built", loopId: "quality" },
      { id: "v-b", from: "verify", to: "build", outcome: "retry", loopId: "quality" },
      { id: "v-a", from: "verify", to: "approve", outcome: "pass" },
      { id: "a-d", from: "approve", to: "done", outcome: "approved" },
    ],
    loops: [{ id: "quality", nodeIds: ["build", "verify"], maxIterations: 5, maxNoProgress: 2, maxSameFailure: 1, minProgressDelta: 1 }],
  };
}

describe("WorkflowGraphRuntime", () => {
  it("runs a bounded retry loop, waits for immutable approval and completes", async () => {
    const runtime = new WorkflowGraphRuntime<State>(graph(), {
      build: ({ run }) => ({
        outcome: "built",
        statePatch: { attempts: run.state.attempts + 1 },
        progressScore: run.progressScore + 10,
        costUnits: 1,
        evidence: [{ id: `build-${run.state.attempts + 1}`, kind: "artifact", ref: `artifact://${run.state.attempts + 1}` }],
      }),
      verify: ({ run }) => run.state.attempts < 2
        ? { outcome: "retry", progressScore: run.progressScore + 1, failureSignature: "quality:missing-section" }
        : { outcome: "pass", progressScore: run.progressScore + 20, statePatch: { verified: true } },
      approve: ({ approvalReceipt }) => approvalReceipt
        ? { outcome: "approved", statePatch: { approved: true }, progressScore: 100 }
        : {
            outcome: "wait",
            approvalBinding: {
              actionType: "QUOTE_APPROVE",
              resourceId: "quote-1",
              resourceVersion: 3,
              payloadHash: "abc",
            },
          },
    });

    let run = runtime.createRun({
      id: "run-1",
      workspaceId: "ws-1",
      resourceType: "quote",
      resourceId: "quote-1",
      resourceVersion: 3,
      initialState: { attempts: 0 },
      now: "2026-08-14T00:00:00.000Z",
    });
    run = await runtime.run(run, { now: () => "2026-08-14T00:00:01.000Z" });
    expect(run.status).toBe("WAITING_APPROVAL");
    expect(run.state.attempts).toBe(2);
    expect(run.waitingApproval).toEqual({ actionType: "QUOTE_APPROVE", resourceId: "quote-1", resourceVersion: 3, payloadHash: "abc" });

    run = await runtime.run(run, {
      now: () => "2026-08-14T00:00:02.000Z",
      approvalReceipt: {
        id: "approval-1",
        actionType: "QUOTE_APPROVE",
        resourceId: "quote-1",
        resourceVersion: 3,
        payloadHash: "abc",
        approvedBy: "owner-1",
        approvedAt: "2026-08-14T00:00:01.500Z",
        expiresAt: "2026-08-14T01:00:00.000Z",
        status: "APPROVED",
      },
    });
    expect(run.status).toBe("COMPLETED");
    expect(run.state).toMatchObject({ attempts: 2, approved: true, verified: true });
    expect(run.evidence).toHaveLength(2);
  });

  it("opens a circuit breaker when the same failure repeats", async () => {
    const spec = graph();
    spec.loops[0]!.maxSameFailure = 0;
    const runtime = new WorkflowGraphRuntime<State>(spec, {
      build: ({ run }) => ({ outcome: "built", statePatch: { attempts: run.state.attempts + 1 }, progressScore: run.progressScore + 10 }),
      verify: ({ run }) => ({ outcome: "retry", progressScore: run.progressScore + 1, failureSignature: "same" }),
      approve: () => ({ outcome: "wait", approvalBinding: { actionType: "QUOTE_APPROVE", resourceId: "quote-1", resourceVersion: 1, payloadHash: "x" } }),
    });
    const run = await runtime.run(runtime.createRun({
      id: "run-2",
      workspaceId: "ws-1",
      resourceType: "quote",
      resourceId: "quote-1",
      resourceVersion: 1,
      initialState: { attempts: 0 },
      now: "2026-08-14T00:00:00.000Z",
    }), { now: () => "2026-08-14T00:00:01.000Z" });
    expect(run.status).toBe("FAILED");
    expect(run.failureCode).toBe("LOOP_CIRCUIT_BREAKER:quality");
  });

  it("rejects stale approval receipts", async () => {
    const runtime = new WorkflowGraphRuntime<State>(graph(), {
      build: () => ({ outcome: "built", progressScore: 10 }),
      verify: () => ({ outcome: "pass", progressScore: 20 }),
      approve: ({ approvalReceipt }) => approvalReceipt
        ? { outcome: "approved", progressScore: 100 }
        : { outcome: "wait", approvalBinding: { actionType: "QUOTE_APPROVE", resourceId: "quote-1", resourceVersion: 3, payloadHash: "abc" } },
    });
    const run = await runtime.run(runtime.createRun({
      id: "run-3",
      workspaceId: "ws-1",
      resourceType: "quote",
      resourceId: "quote-1",
      resourceVersion: 3,
      initialState: { attempts: 0 },
      now: "2026-08-14T00:00:00.000Z",
    }), { now: () => "2026-08-14T00:00:01.000Z" });
    await expect(runtime.step(run, {
      now: "2026-08-14T00:00:02.000Z",
      approvalReceipt: {
        id: "bad",
        actionType: "QUOTE_APPROVE",
        resourceId: "quote-1",
        resourceVersion: 2,
        payloadHash: "abc",
        approvedBy: "owner",
        approvedAt: "2026-08-14T00:00:01.500Z",
        expiresAt: "2026-08-14T01:00:00.000Z",
        status: "APPROVED",
      },
    })).rejects.toMatchObject<Partial<WorkflowGraphError>>({ code: "STALE_APPROVAL" });
  });
});
