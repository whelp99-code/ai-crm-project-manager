import { describe, expect, it } from "vitest";
import {
  OrchestrationError,
  OrchestrationService,
  canCancelWorkItem,
  deriveJobStatus,
  type WorkItemStatus,
} from "../src/index.js";

function service() {
  return new OrchestrationService();
}

function createTwoStep(sut: OrchestrationService, workspaceId = "ws-1") {
  return sut.createJob({
    workspaceId,
    createdBy: "principal-1",
    source: "natural_command",
    rawText: "assign and revise",
    steps: [
      { title: "Assign task", suggestedCommand: "pm.task_assign", actionType: "PM_TASK_ASSIGN" },
      { title: "Revise plan", suggestedCommand: "pm.plan_revise", actionType: "PM_PLAN_REVISE" },
    ],
  });
}

describe("ORCH-U-01 happy-path transitions", () => {
  it("queued → running → done and job becomes done", () => {
    const sut = service();
    const { job, workItems } = createTwoStep(sut);
    const [a, b] = workItems;
    expect(a!.status).toBe("queued");
    expect(job.status).toBe("open");

    sut.startWorkItem("ws-1", a!.id);
    expect(sut.getWorkItem("ws-1", a!.id).status).toBe("running");

    sut.markDone("ws-1", a!.id, { intentId: "intent-1", resultRef: { ok: true } });
    expect(sut.getWorkItem("ws-1", a!.id).status).toBe("done");
    expect(sut.getWorkItem("ws-1", a!.id).progress).toBe(100);
    expect(sut.getJob("ws-1", job.id).job.status).toBe("open");

    sut.startWorkItem("ws-1", b!.id);
    sut.markDone("ws-1", b!.id);
    expect(sut.getJob("ws-1", job.id).job.status).toBe("done");
  });

  it("running → waiting_control → running → done", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.startWorkItem("ws-1", item.id);
    const waiting = sut.bindControl("ws-1", item.id, "control-1");
    expect(waiting.status).toBe("waiting_control");
    expect(waiting.controlId).toBe("control-1");
    const resumed = sut.resumeFromControl("ws-1", item.id, "intent-9");
    expect(resumed.status).toBe("running");
    expect(resumed.intentId).toBe("intent-9");
    expect(sut.markDone("ws-1", item.id).status).toBe("done");
  });
});

describe("ORCH-U-02 createJob sequences and idempotency", () => {
  it("assigns sequence in step order starting at 1", () => {
    const sut = service();
    const snap = createTwoStep(sut);
    expect(snap.workItems.map((item) => item.sequence)).toEqual([1, 2]);
    expect(snap.job.workItemIds).toEqual(snap.workItems.map((item) => item.id));
    expect(snap.workItems[0]!.suggestedCommand).toBe("pm.task_assign");
    expect(snap.workItems[0]!.actionType).toBe("PM_TASK_ASSIGN");
  });

  it("returns existing job for workspace+idempotencyKey", () => {
    const sut = service();
    const first = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      idempotencyKey: "idem-1",
      steps: [{ title: "One" }],
    });
    const second = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      idempotencyKey: "idem-1",
      steps: [{ title: "Different" }],
    });
    expect(second.job.id).toBe(first.job.id);
    expect(second.workItems).toHaveLength(1);
    expect(second.workItems[0]!.title).toBe("One");
    expect(sut.findJobByIdempotencyKey("ws-1", "idem-1")?.job.id).toBe(first.job.id);
  });
});

describe("ORCH-U-03 bindControl", () => {
  it("requires controlId and sets waiting_control from queued or running", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const queued = workItems[0]!;
    const running = workItems[1]!;
    sut.startWorkItem("ws-1", running.id);

    expect(() => sut.bindControl("ws-1", queued.id, "  ")).toThrowError(OrchestrationError);
    expect(() => sut.bindControl("ws-1", queued.id, "  ")).toThrowError(/controlId is required/);

    expect(sut.bindControl("ws-1", queued.id, "c-q").status).toBe("waiting_control");
    expect(sut.bindControl("ws-1", running.id, "c-r").controlId).toBe("c-r");
  });

  it("rejects bindControl from terminal statuses", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.startWorkItem("ws-1", item.id);
    sut.markDone("ws-1", item.id);
    expect(() => sut.bindControl("ws-1", item.id, "c-1")).toThrowError(/INVALID_WORK_ITEM_TRANSITION|cannot bindControl/);
  });
});

describe("ORCH-U-04 reject / markFailed", () => {
  it("marks failed with errorCode REJECTED from waiting_control", () => {
    const sut = service();
    const { job, workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.bindControl("ws-1", item.id, "control-1");
    const failed = sut.markFailed("ws-1", item.id, "REJECTED");
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("REJECTED");
    // sibling still open → job open
    expect(sut.getJob("ws-1", job.id).job.status).toBe("open");
  });
});

describe("ORCH-U-05 cancel truth table", () => {
  it("allows cancel from queued", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    expect(canCancelWorkItem(item)).toBe(true);
    expect(sut.cancelWorkItem("ws-1", item.id).status).toBe("cancelled");
  });

  it("allows cancel from running without controlId", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.startWorkItem("ws-1", item.id);
    expect(canCancelWorkItem(sut.getWorkItem("ws-1", item.id))).toBe(true);
    expect(sut.cancelWorkItem("ws-1", item.id).status).toBe("cancelled");
  });

  it("allows cancel from waiting_control and clears controlId", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.bindControl("ws-1", item.id, "control-77");
    const cancelled = sut.cancelWorkItem("ws-1", item.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.controlId).toBeUndefined();
    const event = sut
      .listEvents("ws-1", item.jobId)
      .filter((entry) => entry.kind === "work_item.cancelled")
      .at(-1);
    expect(event?.payload.clearedControlId).toBe("control-77");
  });

  it("throws INVALID_WORK_ITEM_TRANSITION for done|failed|cancelled", () => {
    const sut = service();
    const snap = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      steps: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });
    const [doneItem, failedItem, cancelledItem] = snap.workItems;
    sut.startWorkItem("ws-1", doneItem!.id);
    sut.markDone("ws-1", doneItem!.id);
    sut.markFailed("ws-1", failedItem!.id, "UNMAPPED");
    sut.cancelWorkItem("ws-1", cancelledItem!.id);

    for (const item of [doneItem!, failedItem!, cancelledItem!]) {
      expect(() => sut.cancelWorkItem("ws-1", item.id)).toThrowError(OrchestrationError);
      try {
        sut.cancelWorkItem("ws-1", item.id);
      } catch (error) {
        expect(error).toBeInstanceOf(OrchestrationError);
        expect((error as OrchestrationError).code).toBe("INVALID_WORK_ITEM_TRANSITION");
      }
    }
  });
});

describe("ORCH-U-06 cancel cascade multi-step", () => {
  it("cancels all non-terminal items in one cancelJob call", () => {
    const sut = service();
    const snap = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      steps: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });
    const [a, b, c] = snap.workItems;
    sut.startWorkItem("ws-1", a!.id);
    sut.markDone("ws-1", a!.id);
    sut.startWorkItem("ws-1", b!.id);
    sut.bindControl("ws-1", c!.id, "control-c");

    const after = sut.cancelJob("ws-1", snap.job.id);
    expect(after.workItems.find((item) => item.id === a!.id)?.status).toBe("done");
    expect(after.workItems.find((item) => item.id === b!.id)?.status).toBe("cancelled");
    expect(after.workItems.find((item) => item.id === c!.id)?.status).toBe("cancelled");
    expect(after.workItems.find((item) => item.id === c!.id)?.controlId).toBeUndefined();
    expect(after.job.status).toBe("partial");
  });

  it("no-ops when all work items are already terminal", () => {
    const sut = service();
    const snap = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      steps: [{ title: "A" }],
    });
    sut.startWorkItem("ws-1", snap.workItems[0]!.id);
    sut.markDone("ws-1", snap.workItems[0]!.id);
    const after = sut.cancelJob("ws-1", snap.job.id);
    expect(after.job.status).toBe("done");
    expect(after.workItems[0]!.status).toBe("done");
  });
});

describe("ORCH-U-07 deriveJobStatus matrix", () => {
  it.each([
    { name: "any non-terminal → open", statuses: ["done", "queued"] as WorkItemStatus[], expected: "open" },
    { name: "running keeps open", statuses: ["running"] as WorkItemStatus[], expected: "open" },
    { name: "waiting_control keeps open", statuses: ["waiting_control", "done"] as WorkItemStatus[], expected: "open" },
    { name: "all done → done", statuses: ["done", "done"] as WorkItemStatus[], expected: "done" },
    { name: "all cancelled → cancelled", statuses: ["cancelled"] as WorkItemStatus[], expected: "cancelled" },
    { name: "all failed → failed", statuses: ["failed", "failed"] as WorkItemStatus[], expected: "failed" },
    { name: "mix terminal → partial", statuses: ["done", "failed"] as WorkItemStatus[], expected: "partial" },
    { name: "done+cancelled → partial", statuses: ["done", "cancelled"] as WorkItemStatus[], expected: "partial" },
    { name: "failed+cancelled → partial", statuses: ["failed", "cancelled"] as WorkItemStatus[], expected: "partial" },
    { name: "empty → done", statuses: [] as WorkItemStatus[], expected: "done" },
  ])("$name", ({ statuses, expected }) => {
    expect(deriveJobStatus(statuses)).toBe(expected);
  });
});

describe("ORCH-U-08 workspace isolation", () => {
  it("refuses cross-workspace get/cancel and keeps idempotency per workspace", () => {
    const sut = service();
    const a = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "p1",
      idempotencyKey: "same",
      steps: [{ title: "A" }],
    });
    const b = sut.createJob({
      workspaceId: "ws-2",
      createdBy: "p2",
      idempotencyKey: "same",
      steps: [{ title: "B" }],
    });
    expect(a.job.id).not.toBe(b.job.id);

    expect(() => sut.getJob("ws-2", a.job.id)).toThrowError(/another workspace/);
    expect(() => sut.cancelWorkItem("ws-2", a.workItems[0]!.id)).toThrowError(/another workspace/);
    expect(sut.listJobs("ws-1")).toHaveLength(1);
    expect(sut.listJobs("ws-2")).toHaveLength(1);
  });
});

describe("ORCH-U-09 progress and events", () => {
  it("accepts progress 0..100 and rejects out of range", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const id = workItems[0]!.id;
    expect(sut.setProgress("ws-1", id, 0).progress).toBe(0);
    expect(sut.setProgress("ws-1", id, 50).progress).toBe(50);
    expect(sut.setProgress("ws-1", id, 100).progress).toBe(100);
    expect(() => sut.setProgress("ws-1", id, 101)).toThrowError(/progress/);
    expect(() => sut.setProgress("ws-1", id, -1)).toThrowError(/progress/);
  });

  it("appends job events and does not rewrite history", () => {
    const sut = service();
    const { job, workItems } = createTwoStep(sut);
    const before = sut.listEvents("ws-1", job.id);
    expect(before.some((event) => event.kind === "job.created")).toBe(true);
    expect(before.filter((event) => event.kind === "work_item.created")).toHaveLength(2);

    sut.startWorkItem("ws-1", workItems[0]!.id);
    sut.markDone("ws-1", workItems[0]!.id);
    const after = sut.listEvents("ws-1", job.id);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("ORCH-U-10 input validation", () => {
  it("rejects missing workspaceId and createdBy", () => {
    const sut = service();
    expect(() =>
      sut.createJob({ workspaceId: "", createdBy: "p", steps: [{ title: "A" }] }),
    ).toThrowError(/workspaceId/);
    expect(() =>
      sut.createJob({ workspaceId: "ws-1", createdBy: " ", steps: [{ title: "A" }] }),
    ).toThrowError(/createdBy/);
    expect(() =>
      sut.createJob({ workspaceId: "ws-1", createdBy: "p", steps: [{ title: "" }] }),
    ).toThrowError(/title/);
  });
});

describe("ORCH-U-11 illegal transitions throw", () => {
  it("cannot markDone from queued or start from running", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const id = workItems[0]!.id;
    expect(() => sut.markDone("ws-1", id)).toThrowError(OrchestrationError);
    sut.startWorkItem("ws-1", id);
    expect(() => sut.startWorkItem("ws-1", id)).toThrowError(/INVALID_WORK_ITEM_TRANSITION|cannot start/);
  });
});

describe("ORCH-U-12 reopenFromRework", () => {
  it("reopens done → queued, clears resultRef, emits event", () => {
    const sut = service();
    const { job, workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.startWorkItem("ws-1", item.id);
    sut.markDone("ws-1", item.id, { resultRef: { ok: true }, intentId: "intent-1" });
    expect(sut.getWorkItem("ws-1", item.id).status).toBe("done");

    const reopened = sut.reopenFromRework("ws-1", item.id);
    expect(reopened.status).toBe("queued");
    expect(reopened.progress).toBe(0);
    expect(reopened.resultRef).toBeUndefined();
    expect(reopened.errorCode).toBeUndefined();
    // intentId retained so callers can correlate prior authorization if needed
    expect(reopened.intentId).toBe("intent-1");
    expect(sut.getJob("ws-1", job.id).job.status).toBe("open");

    const events = sut.listEvents("ws-1", job.id);
    const reopenEvent = events.filter((event) => event.kind === "work_item.reopened_for_rework").at(-1);
    expect(reopenEvent?.payload).toMatchObject({
      workItemId: item.id,
      previousStatus: "done",
      reason: "REWORK_REQUIRED",
    });
  });

  it("reopens failed → queued and clears errorCode", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    sut.markFailed("ws-1", item.id, "APPLY_FAILED");
    const reopened = sut.reopenFromRework("ws-1", item.id);
    expect(reopened.status).toBe("queued");
    expect(reopened.errorCode).toBeUndefined();
  });

  it("rejects reopenFromRework from non-done/failed statuses", () => {
    const sut = service();
    const { workItems } = createTwoStep(sut);
    const item = workItems[0]!;
    expect(() => sut.reopenFromRework("ws-1", item.id)).toThrowError(/INVALID_WORK_ITEM_TRANSITION|cannot reopenFromRework/);
    sut.startWorkItem("ws-1", item.id);
    expect(() => sut.reopenFromRework("ws-1", item.id)).toThrowError(/INVALID_WORK_ITEM_TRANSITION|cannot reopenFromRework/);
  });
});

describe("ORCH-U-HYDRATE hydrate-on-boot restart consistency", () => {
  it("rebuilds jobs/workItems/events/idempotency from persisted snapshots", () => {
    const sut = service();
    const created = createTwoStep(sut);
    sut.startWorkItem("ws-1", created.workItems[0]!.id);

    const snapshot = sut.getJob("ws-1", created.job.id);

    const fresh = new OrchestrationService();
    fresh.hydrate([snapshot]);

    const reloaded = fresh.getJob("ws-1", created.job.id);
    expect(reloaded.job.id).toBe(created.job.id);
    expect(reloaded.workItems).toHaveLength(2);
    expect(reloaded.workItems[0]?.status).toBe("running");
    expect(reloaded.events.length).toBeGreaterThan(0);
  });

  it("preserves idempotency lookups after hydrate", () => {
    const sut = service();
    const created = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      idempotencyKey: "idem-hydrate",
      steps: [{ title: "One" }],
    });
    const snapshot = sut.getJob("ws-1", created.job.id);

    const fresh = new OrchestrationService();
    fresh.hydrate([snapshot]);

    const found = fresh.findJobByIdempotencyKey("ws-1", "idem-hydrate");
    expect(found?.job.id).toBe(created.job.id);
  });

  it("advances id counters past hydrated ids so new ids never collide", () => {
    const sut = service();
    const created = createTwoStep(sut);
    const snapshot = sut.getJob("ws-1", created.job.id);

    const fresh = new OrchestrationService();
    fresh.hydrate([snapshot]);

    const next = fresh.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      steps: [{ title: "New after hydrate" }],
    });
    expect(next.job.id).not.toBe(created.job.id);
    const [, hydratedSuffix] = created.job.id.split("-");
    const [, nextSuffix] = next.job.id.split("-");
    expect(Number(nextSuffix)).toBeGreaterThan(Number(hydratedSuffix));
  });

  it("replaces prior state wholesale (does not merge with pre-hydrate jobs)", () => {
    const sut = service();
    const staleJob = sut.createJob({
      workspaceId: "ws-1",
      createdBy: "principal-1",
      steps: [{ title: "Stale" }],
    });
    sut.hydrate([]);
    expect(() => sut.getJob("ws-1", staleJob.job.id)).toThrowError(/job not found/);
  });
});
