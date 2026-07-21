import { describe, expect, it } from "vitest";
import {
  DeliveryDomainError,
  DeliveryService,
  baselinePayloadHash,
  classifyBaselineMutation,
  type AuthorizationReceipt,
  type BaselinePatch,
} from "../src/delivery.js";

function created() {
  const service = new DeliveryService();
  const project = service.createProject({
    id: "project-1",
    workspaceId: "ws-1",
    customerId: "customer-1",
    name: "Delivery",
    contractId: "contract-1",
    contractScope: "Build approved scope",
    scheduleStart: "2026-01-01",
    scheduleEnd: "2026-03-31",
    deliverables: [{ id: "deliverable-1", title: "Final", required: true, status: "pending", requirementIds: ["req-1"] }],
    completionRule: "all_required_deliverables_approved",
    riskThreshold: 0.4,
    requirementIds: ["req-1"],
  });
  return { service, project };
}

function receipt(version: number, actionType: AuthorizationReceipt["actionType"], patch: BaselinePatch): AuthorizationReceipt {
  return {
    workspaceId: "ws-1",
    resourceId: "project-1",
    resourceVersion: version,
    actionType,
    payloadHash: baselinePayloadHash(actionType, patch),
    policyVersion: 1,
    status: "CONSUMED",
  };
}

describe("DeliveryService", () => {
  it("persists the five project configuration dimensions", () => {
    const { project } = created();
    expect(project).toMatchObject({
      contractScope: "Build approved scope",
      scheduleStart: "2026-01-01",
      scheduleEnd: "2026-03-31",
      completionRule: "all_required_deliverables_approved",
      riskThreshold: 0.4,
    });
    expect(project.deliverables).toHaveLength(1);
  });

  it.each([
    [{ contractScope: "new" }, "SCOPE_CHANGE"],
    [{ scheduleEnd: "2026-04-30" }, "SCHEDULE_CHANGE"],
    [{ contractId: "contract-2" }, "CONTRACT_CHANGE"],
    [{ riskThreshold: 0.5 }, "INTERNAL_REVERSIBLE_UPDATE"],
  ] as const)("classifies %j as %s", (patch, expected) => {
    expect(classifyBaselineMutation(patch)).toBe(expected);
  });

  it("requires a current action-bound receipt for protected baseline changes", () => {
    const { service, project } = created();
    expect(() => service.changeBaseline("ws-1", project.id, 1, { contractScope: "new" })).toThrowError(
      /requires consumed authorization/,
    );
    expect(() =>
      service.changeBaseline("ws-1", project.id, 1, { contractScope: "new" }, receipt(1, "SCHEDULE_CHANGE", { contractScope: "new" })),
    ).toThrowError(/not bound/);
    expect(
      service.changeBaseline("ws-1", project.id, 1, { contractScope: "new" }, receipt(1, "SCOPE_CHANGE", { contractScope: "new" }))
        .version,
    ).toBe(2);
    expect(() =>
      service.changeBaseline("ws-1", project.id, 2, { scheduleEnd: "2026-04-30" }, receipt(1, "SCHEDULE_CHANGE", { scheduleEnd: "2026-04-30" })),
    ).toThrowError(/not bound/);
  });

  it("traces tasks to known requirements and deliverables", () => {
    const { service, project } = created();
    const updated = service.addTask("ws-1", project.id, 1, {
      id: "task-1",
      title: "Produce final",
      status: "done",
      requirementIds: ["req-1"],
      deliverableId: "deliverable-1",
    });
    expect(updated.tasks[0]).toMatchObject({ requirementIds: ["req-1"], deliverableId: "deliverable-1" });
    expect(() =>
      service.addTask("ws-1", project.id, 2, { id: "task-2", title: "Bad", status: "todo", requirementIds: ["missing"] }),
    ).toThrowError(/unknown requirement/);
  });

  it("raises deterministic risk threshold evidence", () => {
    const { service, project } = created();
    const result = service.recordRisk("ws-1", project.id, 1, {
      id: "risk-1",
      title: "Delay",
      probability: 0.8,
      impact: 0.6,
      status: "open",
    });
    expect(result.score).toBeCloseTo(0.48);
    expect(result.thresholdExceeded).toBe(true);
  });

  it("requires approved deliverables and completed tasks before proposing completion", () => {
    const { service, project } = created();
    expect(() => service.proposeCompletion("ws-1", project.id, 1)).toThrowError(DeliveryDomainError);
    let updated = service.addTask("ws-1", project.id, 1, {
      id: "task-1",
      title: "Produce final",
      status: "done",
      requirementIds: ["req-1"],
      deliverableId: "deliverable-1",
    });
    updated = service.updateDeliverableStatus("ws-1", project.id, updated.version, "deliverable-1", "approved");
    expect(service.proposeCompletion("ws-1", project.id, updated.version).status).toBe("awaiting_user_approval");
  });

  it("rejects cross-workspace and stale mutations", () => {
    const { service, project } = created();
    expect(() => service.getProject("ws-2", project.id)).toThrowError(/another workspace/);
    expect(() => service.addTask("ws-1", project.id, 9, { id: "x", title: "x", status: "todo", requirementIds: [] }))
      .toThrowError(/stale/);
  });
});
