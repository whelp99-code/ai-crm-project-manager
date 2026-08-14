import { describe, expect, it } from "vitest";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
} from "@ai-crm/governance";
import { runWorkerTick } from "../src/tick.js";

const registry = new ActionRegistry({
  updateCustomer: "INTERNAL_REVERSIBLE_UPDATE",
});

function service() {
  return new GovernanceAuthorizationService(registry);
}

const authorizeRequest = {
  command: "updateCustomer",
  workspaceId: "ws-1",
  resourceId: "customer-1",
  resourceVersion: 1,
  payload: { note: "worker-tick" },
  requesterPrincipalId: "worker-test",
};

describe("runWorkerTick (GOV-U-06 style lease recover)", () => {
  it("recovers expired leases and keeps leaseEpoch monotonic", () => {
    const governance = service();
    const result = governance.authorize(authorizeRequest);
    const intentId = result.intent!.id;

    const firstLease = governance.leaseIntent(
      intentId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
    );
    expect(firstLease.status).toBe("LEASED");
    expect(firstLease.leaseEpoch).toBe(1);
    const staleToken = firstLease.leaseToken!;

    const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const tick = runWorkerTick({
      governance,
      nowIso: "2026-01-01T00:01:00.000Z",
      log: (message, data) => {
        logs.push({ message, ...(data !== undefined ? { data } : {}) });
      },
    });

    expect(tick.recoveredLeases).toHaveLength(1);
    expect(tick.recoveredLeases[0]?.id).toBe(intentId);
    expect(tick.recoveredLeases[0]?.status).toBe("QUEUED");
    expect(tick.recoveredLeases[0]?.leaseToken).toBeUndefined();
    expect(tick.recoveredLeases[0]?.leaseDeadline).toBeUndefined();
    // Epoch is not decremented on recover (GOV-U-06).
    expect(tick.recoveredLeases[0]?.leaseEpoch).toBe(1);
    expect(logs.some((l) => l.message === "worker.lease_recovered")).toBe(true);

    const secondLease = governance.leaseIntent(
      intentId,
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:03:00.000Z",
    );
    expect(secondLease.leaseEpoch).toBe(2);
    expect(secondLease.leaseToken).not.toBe(staleToken);

    expect(() =>
      governance.startDispatch(intentId, staleToken, "2026-01-01T00:02:30.000Z"),
    ).toThrowError(/fenced|STALE_LEASE_TOKEN|lease/i);

    expect(
      governance.startDispatch(intentId, secondLease.leaseToken!, "2026-01-01T00:02:30.000Z").status,
    ).toBe("DISPATCHING");
  });

  it("does not recover non-expired leases", () => {
    const governance = service();
    const intentId = governance.authorize(authorizeRequest).intent!.id;
    governance.leaseIntent(intentId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z");

    const tick = runWorkerTick({
      governance,
      nowIso: "2026-01-01T00:05:00.000Z",
      log: () => undefined,
    });

    expect(tick.recoveredLeases).toHaveLength(0);
    expect(tick.stuckIntents).toHaveLength(0);
    expect(governance.getIntent("ws-1", intentId).status).toBe("LEASED");
  });

  it("logs stuck DISPATCHING intents past deadline without remote dispatch", () => {
    const governance = service();
    const intentId = governance.authorize(authorizeRequest).intent!.id;
    const lease = governance.leaseIntent(
      intentId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
    );
    governance.startDispatch(intentId, lease.leaseToken!, "2026-01-01T00:00:30.000Z");

    const logs: string[] = [];
    const tick = runWorkerTick({
      governance,
      nowIso: "2026-01-01T00:02:00.000Z",
      log: (message) => {
        logs.push(message);
      },
    });

    // recoverExpiredLeases only touches LEASED; DISPATCHING remains and is reported stuck.
    expect(tick.recoveredLeases).toHaveLength(0);
    expect(tick.stuckIntents).toEqual([
      expect.objectContaining({
        id: intentId,
        status: "DISPATCHING",
        workspaceId: "ws-1",
      }),
    ]);
    expect(logs).toContain("worker.stuck_intents");
    // Still DISPATCHING — no automatic UNKNOWN/redispatch in this tick.
    expect(governance.getIntent("ws-1", intentId).status).toBe("DISPATCHING");
  });

  it("returns empty result when governance has no intents", () => {
    const governance = service();
    const tick = runWorkerTick({
      governance,
      nowIso: "2026-01-01T00:00:00.000Z",
      log: () => undefined,
    });
    expect(tick.recoveredLeases).toEqual([]);
    expect(tick.stuckIntents).toEqual([]);
  });
});
