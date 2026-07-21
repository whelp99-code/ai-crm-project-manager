import { describe, expect, it } from "vitest";
import { PM_COMMAND_ACTIONS, PmDomainError, PmService, type PmCheckpointReceipt } from "../src/pm.js";

function receipt(version: number, actionType: PmCheckpointReceipt["actionType"]): PmCheckpointReceipt {
  return { workspaceId: "ws-1", resourceId: "plan-1", resourceVersion: version, actionType, status: "CONSUMED" };
}

function created() {
  const service = new PmService();
  const plan = service.createPlan({
    id: "plan-1",
    workspaceId: "ws-1",
    projectId: "project-1",
    revision: 1,
    objective: "Deliver approved scope",
    taskIds: ["task-1"],
    createdByPrincipalId: "ai-pm",
    createdAt: "2026-01-01T00:00:00Z",
  });
  return { service, plan };
}

describe("PmService", () => {
  it("owns every PM command with an explicit action type", () => {
    expect(PM_COMMAND_ACTIONS).toEqual({
      createPlan: "PM_PLAN_CREATE",
      revisePlan: "PM_PLAN_REVISE",
      assignTask: "PM_TASK_ASSIGN",
      setTarget: "PM_TARGET_SET",
    });
  });

  it("persists create, revision, assignment, target and variance evidence", () => {
    const { service } = created();
    const revised = service.revisePlan(
      "ws-1",
      "plan-1",
      1,
      {
        objective: "Deliver accepted scope",
        taskIds: ["task-1", "task-2"],
        createdByPrincipalId: "ai-pm",
        createdAt: "2026-01-02T00:00:00Z",
      },
      receipt(1, "PM_PLAN_REVISE"),
    );
    expect(revised.revisions.map((item) => item.revision)).toEqual([1, 2]);
    const assignment = service.assignTask(
      {
        id: "assignment-1",
        workspaceId: "ws-1",
        projectId: "project-1",
        planId: "plan-1",
        taskId: "task-2",
        assigneePrincipalId: "ai-executor",
        assignedByPrincipalId: "ai-pm",
        status: "active",
        createdAt: "2026-01-02T01:00:00Z",
      },
      2,
      receipt(2, "PM_TASK_ASSIGN"),
    );
    expect(assignment.assigneePrincipalId).toBe("ai-executor");
    const target = service.setTarget(
      {
        id: "target-1",
        workspaceId: "ws-1",
        projectId: "project-1",
        metric: "schedule",
        target: 10,
        tolerance: 1,
        direction: "max",
      },
      "plan-1",
      2,
      receipt(2, "PM_TARGET_SET"),
    );
    expect(target.version).toBe(1);
    const observation = service.observe({
      id: "observation-1",
      workspaceId: "ws-1",
      projectId: "project-1",
      targetId: "target-1",
      actual: 16,
      observedAt: "2026-01-10T00:00:00Z",
      evidenceRef: "evidence://schedule/1",
    });
    expect(observation.exception).toMatchObject({ severity: "critical", evidenceRef: "evidence://schedule/1" });
    expect(service.listExceptions("ws-1", "project-1")).toHaveLength(1);
  });

  it("rejects missing, wrong and stale checkpoints", () => {
    const { service } = created();
    expect(() =>
      service.revisePlan("ws-1", "plan-1", 1, {
        objective: "x",
        taskIds: ["task-1"],
        createdByPrincipalId: "ai-pm",
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ).toThrowError(/requires a consumed checkpoint/);
    expect(() =>
      service.revisePlan(
        "ws-1",
        "plan-1",
        1,
        { objective: "x", taskIds: ["task-1"], createdByPrincipalId: "ai-pm", createdAt: "2026-01-02T00:00:00Z" },
        receipt(1, "PM_TASK_ASSIGN"),
      ),
    ).toThrowError(/stale or mismatched/);
    expect(() =>
      service.revisePlan(
        "ws-1",
        "plan-1",
        2,
        { objective: "x", taskIds: ["task-1"], createdByPrincipalId: "ai-pm", createdAt: "2026-01-02T00:00:00Z" },
        receipt(2, "PM_PLAN_REVISE"),
      ),
    ).toThrowError(PmDomainError);
  });

  it("keeps revision history immutable from returned copies", () => {
    const { service, plan } = created();
    plan.revisions[0]!.objective = "tampered";
    expect(service.planHistory("ws-1", "plan-1")[0]!.objective).toBe("Deliver approved scope");
  });

  it("rejects duplicate active assignment and missing observation evidence", () => {
    const { service } = created();
    const base = {
      workspaceId: "ws-1",
      projectId: "project-1",
      planId: "plan-1",
      taskId: "task-1",
      assigneePrincipalId: "ai-executor",
      assignedByPrincipalId: "ai-pm",
      status: "active" as const,
      createdAt: "2026-01-02T00:00:00Z",
    };
    service.assignTask({ id: "assignment-1", ...base }, 1, receipt(1, "PM_TASK_ASSIGN"));
    expect(() => service.assignTask({ id: "assignment-2", ...base }, 1, receipt(1, "PM_TASK_ASSIGN"))).toThrowError(
      /already has active assignment/,
    );
    service.setTarget(
      { id: "target-1", workspaceId: "ws-1", projectId: "project-1", metric: "risk", target: 0.4, tolerance: 0, direction: "max" },
      "plan-1",
      1,
      receipt(1, "PM_TARGET_SET"),
    );
    expect(() =>
      service.observe({
        id: "observation-1",
        workspaceId: "ws-1",
        projectId: "project-1",
        targetId: "target-1",
        actual: 0.8,
        observedAt: "2026-01-03T00:00:00Z",
        evidenceRef: "",
      }),
    ).toThrowError(/requires evidence/);
  });
});
