import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { describe, expect, it } from "vitest";
import { CustomerWorkOsV2Error, type V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";
import { v2Hash, type CwosV2StateStore, type V2RuntimeEnvelope } from "../src/customer-work-os-v2-runtime-core.js";

const workspaceId = "w04-cas-synthetic";
const actor: V2Actor = { workspaceId, principalId: "w04-owner", kind: "human", stepUpVerified: true };
const now = () => "2026-10-07T00:00:00.000Z";
const content = "Synthetic W04 revision; authoritative acceptance remains unknown.";
const payload = {
  orderId: "w04-order", workItemId: "w04-work", sourceEventId: "w04-source", quoteRevision: "v1",
  revisionId: "w04-submitted", decision: "SUBMITTED",
  quantities: [{ lineId: "w04-line", ordered: 4, delivered: 4, accepted: 0 }],
  content, contentHash: createHash("sha256").update(content).digest("hex"),
  citationRefs: ["evidence://synthetic/w04-cas"],
};

describe("W04 deterministic two-manager InMemory store CAS (not PostgreSQL)", () => {
  it("lets both managers read the same snapshot and reach store CAS with exactly one winner", async () => {
    const store = new InMemoryCwosV2StateStore();
    const bootstrap = new CustomerWorkOsV2RuntimeManager(store, now);
    await bootstrap.command({
      workspaceId, actor, expectedVersion: 0, idempotencyKey: "w04-principal", command: "identity.registerPrincipal",
      payload: { id: actor.principalId, kind: "human", displayName: "Synthetic owner", active: true },
    });
    await bootstrap.command({
      workspaceId, actor, expectedVersion: 1, idempotencyKey: "w04-membership", command: "identity.addMembership",
      payload: { id: "w04-membership", principalId: actor.principalId },
    });
    await bootstrap.command({ workspaceId, actor, expectedVersion: 2, idempotencyKey: "w04-submitted", command: "delivery.recordRevision", payload });
    const before = await bootstrap.read(workspaceId);
    const beforeAudit = store.auditLog(workspaceId);
    const loaded: Array<V2RuntimeEnvelope | undefined> = [];
    const attempts: Array<{ expectedVersion: number; idempotencyKey: string }> = [];
    const storeOutcomes: Array<{ idempotencyKey: string; status: "committed" | "rejected"; error?: unknown }> = [];
    // Register both event subscriptions before either command starts; no clock-based synchronization.
    const events = new EventEmitter();
    const bothLoaded = once(events, "both-loaded");
    const releaseLoads = once(events, "release-loads");
    let barrierActive = true;
    const delegated: CwosV2StateStore = {
      async load(scope) {
        const snapshot = await store.load(scope);
        if (barrierActive) {
          loaded.push(structuredClone(snapshot));
          if (loaded.length === 2) events.emit("both-loaded");
          await releaseLoads;
        }
        return snapshot;
      },
      async compareAndSwap(scope, expectedVersion, next, audit) {
        attempts.push({ expectedVersion, idempotencyKey: audit.idempotencyKey });
        try {
          const committed = await store.compareAndSwap(scope, expectedVersion, next, audit);
          storeOutcomes.push({ idempotencyKey: audit.idempotencyKey, status: "committed" });
          return committed;
        } catch (error) {
          storeOutcomes.push({ idempotencyKey: audit.idempotencyKey, status: "rejected", error });
          throw error;
        }
      },
    };
    const requests = [0, 1].map(index => ({
      workspaceId, actor, expectedVersion: before.version, idempotencyKey: `w04-racer-${index}`,
      command: "delivery.recordRevision", payload: {
        ...payload, revisionId: `w04-partial-${index}`, decision: "PARTIAL_ACCEPTED",
        quantities: [{ lineId: "w04-line", ordered: 4, delivered: 4, accepted: index + 1 }],
      },
    }));
    const settled = Promise.allSettled(requests.map(request => new CustomerWorkOsV2RuntimeManager(delegated, now).command(request)));
    await bothLoaded;
    try {
      expect(loaded).toEqual([before, before]);
      expect(attempts).toHaveLength(0);
      expect(await store.load(workspaceId)).toEqual(before);
      expect(store.auditLog(workspaceId)).toEqual(beforeAudit);
    } finally {
      barrierActive = false;
      events.emit("release-loads");
    }
    const results = await settled;
    expect(attempts).toHaveLength(2);
    expect(attempts.map(attempt => attempt.expectedVersion)).toEqual([before.version, before.version]);
    expect(attempts.map(attempt => attempt.idempotencyKey).sort()).toEqual(requests.map(request => request.idempotencyKey).sort());
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(storeOutcomes.filter(outcome => outcome.status === "committed")).toHaveLength(1);
    const rejected = storeOutcomes.filter(outcome => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.error).toBeInstanceOf(CustomerWorkOsV2Error);
    expect(rejected[0]?.error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    const loser = results.find(result => result.status === "rejected");
    if (!loser || loser.status !== "rejected") throw new Error("one rejected contender required");
    expect(loser.reason).toBe(rejected[0]?.error);
    const winnerIndex = results.findIndex(result => result.status === "fulfilled");
    const winner = requests[winnerIndex];
    if (!winner) throw new Error("one winning request required");
    const after = await new CustomerWorkOsV2RuntimeManager(store, now).read(workspaceId);
    expect(after.version).toBe(before.version + 1);
    const beforeOrder = before.state.delivery?.orders[0];
    expect(beforeOrder).toBeDefined();
    expect(after.state.delivery?.orders).toEqual([{
      ...beforeOrder,
      revisions: [
        ...(beforeOrder?.revisions ?? []),
        {
          revisionId: winner.payload.revisionId, version: 2, decision: winner.payload.decision,
          quantities: winner.payload.quantities, content: payload.content, contentHash: payload.contentHash,
          citationRefs: payload.citationRefs, reason: null, recordedByPrincipalId: actor.principalId,
        },
      ],
      version: (beforeOrder?.version ?? 0) + 1,
    }]);
    expect(after.state.delivery?.orders[0]).toMatchObject({ authoritativeAcceptance: "UNKNOWN", paymentEligibility: "UNKNOWN" });
    expect(after.idempotency.slice(0, -1)).toEqual(before.idempotency);
    expect(after.idempotency.at(-1)?.key).toBe(winner.idempotencyKey);
    expect(after.idempotency.at(-1)?.requestHash).toBe(v2Hash({ command: winner.command, payload: winner.payload, actor }));
    expect(after.idempotency.at(-1)?.result).toEqual(after.state.delivery?.orders[0]);
    expect(after.idempotency.some(receipt => receipt.key === rejected[0]?.idempotencyKey)).toBe(false);
    const audit = store.auditLog(workspaceId);
    expect(audit).toHaveLength(beforeAudit.length + 1);
    expect(audit.slice(0, -1)).toEqual(beforeAudit);
    const appended = audit.at(-1);
    if (!appended) throw new Error("committed audit required");
    expect(appended).toMatchObject({
      sequence: beforeAudit.length + 1, previousEventHash: beforeAudit.at(-1)?.eventHash,
      idempotencyKey: winner.idempotencyKey, beforeStateHash: before.stateHash, afterStateHash: after.stateHash,
      requestHash: v2Hash({ command: winner.command, payload: winner.payload, actor }),
      resultHash: v2Hash(after.state.delivery?.orders[0]),
    });
    const { eventHash, ...core } = appended;
    expect(eventHash).toBe(v2Hash(core));
  });
});
