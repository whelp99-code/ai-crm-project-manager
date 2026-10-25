import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createStandaloneCustomerWorkOsV2App,
  type CustomerWorkOsV2ActorBinding,
} from "../src/customer-work-os-v2-routes.js";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { CustomerWorkOsV2Error } from "@ai-crm/domain/customer-work-os-v2";
import {
  validateAuditInput,
  validateEnvelope,
  v2Hash,
  type CwosV2StateStore,
  type V2AuditEvent,
  type V2RuntimeEnvelope,
} from "../src/customer-work-os-v2-runtime-core.js";

const workspaceId = "e1111111-1111-4111-8111-111111111111";
const actorBinding: CustomerWorkOsV2ActorBinding = {
  workspaceId,
  principalId: "w04-local-owner",
  kind: "human",
  stepUpVerified: true,
};
const actor: V2Actor = { ...actorBinding };
const content = "C06 local fixture: delivery status remains unconfirmed.";
const contentHash = createHash("sha256").update(content).digest("hex");
const citationRefs = ["evidence://mail-c06-001/delivery-status"];

function revision(input: {
  revisionId: string;
  kind: "SUBMITTED" | "PARTIAL_ACCEPTED" | "ACCEPTED" | "REJECTED";
  deliveredQuantity: number;
  acceptedQuantity: number;
  reason?: string;
}) {
  return {
    orderId: "work-c06-001",
    workItemId: "work-c06-001",
    sourceEventId: "mail-c06-001",
    quoteRevision: "v1",
    revisionId: input.revisionId,
    decision: input.kind,
    quantities: [{
      lineId: "quote-line",
      ordered: 4,
      delivered: input.deliveredQuantity,
      accepted: input.acceptedQuantity,
    }],
    content,
    contentHash,
    citationRefs,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

const headers = {
  "x-workspace-id": workspaceId,
  "x-principal-id": actorBinding.principalId,
  "x-principal-kind": "human",
};

async function postCommand(
  app: ReturnType<typeof createStandaloneCustomerWorkOsV2App>,
  input: { command: string; expectedVersion: number; idempotencyKey: string; payload: unknown },
) {
  return app.inject({
    method: "POST",
    url: "/api/cwos/v2/commands",
    headers: { ...headers, "idempotency-key": input.idempotencyKey },
    payload: {
      command: input.command,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    },
  });
}

describe("Customer Work OS v2 delivery fixture", () => {
  it("persists submission and partial/rejected acceptance revisions through authenticated POST and GET state", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({
      store,
      profile: "test",
      actorBinding,
      now: () => "2026-10-06T00:00:00.000Z",
    });
    await app.ready();
    try {
      const principal = await postCommand(app, {
        command: "identity.registerPrincipal",
        expectedVersion: 0,
        idempotencyKey: "w04-c06-principal",
        payload: {
          id: actorBinding.principalId,
          kind: "human",
          displayName: "W04 Local Owner",
          active: true,
        },
      });
      expect(principal.statusCode).toBe(200);
      const membership = await postCommand(app, {
        command: "identity.addMembership",
        expectedVersion: 1,
        idempotencyKey: "w04-c06-membership",
        payload: { id: "w04-c06-membership", principalId: actorBinding.principalId },
      });
      expect(membership.statusCode).toBe(200);

      const submitted = await postCommand(app, {
        command: "delivery.recordRevision",
        expectedVersion: 2,
        idempotencyKey: "w04-c06-submit",
        payload: revision({ revisionId: "w04-c06-revision-1", kind: "SUBMITTED", deliveredQuantity: 4, acceptedQuantity: 0 }),
      });
      expect(submitted.statusCode).toBe(200);
      const partial = await postCommand(app, {
        command: "delivery.recordRevision",
        expectedVersion: 3,
        idempotencyKey: "w04-c06-partial",
        payload: revision({ revisionId: "w04-c06-revision-2", kind: "PARTIAL_ACCEPTED", deliveredQuantity: 4, acceptedQuantity: 1 }),
      });
      expect(partial.statusCode).toBe(200);
      const rejected = await postCommand(app, {
        command: "delivery.recordRevision",
        expectedVersion: 4,
        idempotencyKey: "w04-c06-reject",
        payload: revision({ revisionId: "w04-c06-revision-3", kind: "REJECTED", deliveredQuantity: 4, acceptedQuantity: 0, reason: "Local fixture rejection" }),
      });
      expect(rejected.statusCode).toBe(200);

      const state = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      expect(state.statusCode).toBe(200);
      const order = state.json().state.delivery.orders[0];
      expect(order.revisions.map((item: { decision: string; quantities: Array<{ accepted: number }> }) => [
        item.decision,
        item.quantities[0]?.accepted,
      ])).toEqual([
        ["SUBMITTED", 0],
        ["PARTIAL_ACCEPTED", 1],
        ["REJECTED", 0],
      ]);
      expect(order.revisions.every((item: { content: string; contentHash: string; citationRefs: string[] }) =>
        item.content === content && item.contentHash === contentHash && item.citationRefs.includes("evidence://mail-c06-001/delivery-status"),
      )).toBe(true);
      expect(order).toMatchObject({
        authoritativeAcceptance: "UNKNOWN",
        paymentEligibility: "UNKNOWN",
      });
      expect(order.revisions[0]?.quantities[0]?.ordered).toBe(4);

      const secondApp = createStandaloneCustomerWorkOsV2App({
        store,
        profile: "test",
        actorBinding,
        now: () => "2026-10-06T00:00:00.000Z",
      });
      await secondApp.ready();
      let afterRace: { version: number; state: { delivery: { orders: Array<{ revisions: unknown[] }> } } };
      try {
        const reopened = await secondApp.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
        expect(reopened.statusCode).toBe(200);
        expect(reopened.json().state.delivery.orders[0].revisions).toHaveLength(3);
        const expectedVersion = reopened.json().version;
        const contenders = await Promise.all([
          postCommand(app, {
            command: "delivery.recordRevision",
            expectedVersion,
            idempotencyKey: "w04-c06-two-manager-a",
            payload: revision({ revisionId: "w04-c06-race-a", kind: "PARTIAL_ACCEPTED", deliveredQuantity: 4, acceptedQuantity: 2 }),
          }),
          postCommand(secondApp, {
            command: "delivery.recordRevision",
            expectedVersion,
            idempotencyKey: "w04-c06-two-manager-b",
            payload: revision({ revisionId: "w04-c06-race-b", kind: "REJECTED", deliveredQuantity: 4, acceptedQuantity: 0, reason: "Concurrent local fixture rejection" }),
          }),
        ]);
        expect(contenders.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        afterRace = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers }).then((response) => response.json());
        expect(afterRace.state.delivery.orders[0]?.revisions).toHaveLength(4);
      } finally {
        await secondApp.close();
      }

      const snapshotBeforeInvalid = await store.load(workspaceId);
      const auditBeforeInvalid = store.auditLog(workspaceId);
      const invalidQuantity = await postCommand(app, {
        command: "delivery.recordRevision",
        expectedVersion: afterRace.version,
        idempotencyKey: "w04-c06-invalid-quantity",
        payload: revision({
          revisionId: "w04-c06-invalid-quantity",
          kind: "PARTIAL_ACCEPTED",
          deliveredQuantity: 4,
          acceptedQuantity: 5,
        }),
      });
      expect(invalidQuantity.statusCode).toBe(400);
      expect(invalidQuantity.json()).toMatchObject({ error: "INVALID_DELIVERY_QUANTITY" });
      const snapshotAfterInvalid = await store.load(workspaceId);
      expect(snapshotAfterInvalid?.version).toBe(snapshotBeforeInvalid?.version);
      expect(store.auditLog(workspaceId)).toHaveLength(auditBeforeInvalid.length);
      expect(snapshotAfterInvalid?.idempotency.some((item) => item.key === "w04-c06-invalid-quantity")).toBe(false);

      const unstepUpApp = createStandaloneCustomerWorkOsV2App({
        store,
        profile: "test",
        actorBinding: { ...actorBinding, stepUpVerified: false },
        now: () => "2026-10-06T00:00:00.000Z",
      });
      await unstepUpApp.ready();
      try {
        const denied = await unstepUpApp.inject({
          method: "POST",
          url: "/api/cwos/v2/commands",
          headers: { ...headers, "idempotency-key": "w04-c06-no-step-up" },
          payload: {
            command: "delivery.recordRevision",
            expectedVersion: afterRace.version,
            payload: revision({ revisionId: "w04-c06-denied", kind: "REJECTED", deliveredQuantity: 4, acceptedQuantity: 0, reason: "Denied" }),
          },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ error: "STEP_UP_REQUIRED" });
      } finally {
        await unstepUpApp.close();
      }
    } finally {
      await app.close();
    }
  });

  it("semantically replays a revision after the v2 transport idempotency window rolls past 501 keys", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId,
      actor,
      expectedVersion: 0,
      idempotencyKey: "w04-window-principal",
      command: "identity.registerPrincipal",
      payload: { id: actor.principalId, kind: "human", displayName: "W04 Local Owner", active: true },
    });
    await runtime.command({
      workspaceId,
      actor,
      expectedVersion: 1,
      idempotencyKey: "w04-window-membership",
      command: "identity.addMembership",
      payload: { id: "w04-window-membership", principalId: actor.principalId },
    });
    const firstPayload = revision({
      revisionId: "w04-window-original-revision",
      kind: "SUBMITTED",
      deliveredQuantity: 4,
      acceptedQuantity: 0,
    });
    const first = await runtime.command({
      workspaceId,
      actor,
      expectedVersion: 2,
      idempotencyKey: "w04-window-original-transport-key",
      command: "delivery.recordRevision",
      payload: firstPayload,
    });
    let version = first.envelope.version;
    for (let index = 0; index < 501; index += 1) {
      const next = await runtime.command({
        workspaceId,
        actor,
        expectedVersion: version,
        idempotencyKey: `w04-window-transport-${index}`,
        command: "delivery.recordRevision",
        payload: revision({
          revisionId: `w04-window-revision-${index}`,
          kind: "SUBMITTED",
          deliveredQuantity: 4,
          acceptedQuantity: 0,
        }),
      });
      version = next.envelope.version;
    }
    const beforeReplay = await runtime.read(workspaceId);
    const beforeOrder = beforeReplay.state.delivery?.orders.find((item) => item.id === "work-c06-001");
    expect(beforeReplay.idempotency.some((item) => item.key === "w04-window-original-transport-key")).toBe(false);
    const serialized = JSON.stringify({ envelope: beforeReplay, audit: store.auditLog(workspaceId) });
    const restored = JSON.parse(serialized) as { envelope: V2RuntimeEnvelope; audit: V2AuditEvent[] };
    validateEnvelope(restored.envelope);
    const restoredStore: CwosV2StateStore = {
      async load(scope) {
        return scope === restored.envelope.workspaceId ? structuredClone(restored.envelope) : undefined;
      },
      async compareAndSwap(scope, expectedVersion, next, audit) {
        validateAuditInput(scope, audit);
        if (scope !== restored.envelope.workspaceId) {
          throw new CustomerWorkOsV2Error("CROSS_WORKSPACE_STATE", "fixture workspace differs");
        }
        if (restored.envelope.version !== expectedVersion) {
          throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "fixture version changed");
        }
        const prospective = { ...structuredClone(next), version: expectedVersion + 1 };
        validateEnvelope(prospective);
        if (audit.beforeStateHash !== restored.envelope.stateHash || audit.afterStateHash !== prospective.stateHash) {
          throw new CustomerWorkOsV2Error("AUDIT_CHAIN_MISMATCH", "fixture audit state binding failed");
        }
        const previous = restored.audit.at(-1);
        const core = {
          ...structuredClone(audit), sequence: (previous?.sequence ?? 0) + 1,
          previousEventHash: previous?.eventHash ?? null,
        };
        const event = { ...core, eventHash: v2Hash(core) };
        restored.envelope = prospective;
        restored.audit.push(event);
        return structuredClone(prospective);
      },
    };
    const reopened = new CustomerWorkOsV2RuntimeManager(restoredStore, () => "2026-10-07T00:00:00.000Z");
    const afterRestore = await reopened.read(workspaceId);
    expect(afterRestore).toEqual(beforeReplay);
    expect(afterRestore.idempotency).toHaveLength(500);
    expect(afterRestore.idempotency.some((item) => item.key === "w04-window-original-transport-key")).toBe(false);
    expect(restored.audit).toEqual(store.auditLog(workspaceId));
    const replay = await reopened.command({
      workspaceId,
      actor,
      expectedVersion: beforeReplay.version,
      idempotencyKey: "w04-window-original-transport-key",
      command: "delivery.recordRevision",
      payload: firstPayload,
    });
    const afterOrder = replay.envelope.state.delivery?.orders.find((item) => item.id === "work-c06-001");
    expect(afterOrder?.revisions).toHaveLength(beforeOrder?.revisions.length ?? 0);
    expect(afterOrder?.version).toBe(beforeOrder?.version);
    expect(beforeOrder).toBeDefined();
    expect(afterOrder).toEqual(beforeOrder);
    expect(replay.result).toEqual(beforeOrder);
    expect(afterOrder?.revisions[0]).toEqual(first.envelope.state.delivery?.orders[0]?.revisions[0]);
    expect(afterOrder).toMatchObject({ authoritativeAcceptance: "UNKNOWN", paymentEligibility: "UNKNOWN" });
    expect(replay.envelope.state).toEqual(beforeReplay.state);
    expect(replay.envelope.stateHash).toBe(beforeReplay.stateHash);
    expect(replay.envelope.version).toBe(beforeReplay.version + 1);
    expect(replay.envelope.updatedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(replay.envelope.idempotency).toHaveLength(500);
    expect(replay.envelope.idempotency.at(-1)).toMatchObject({
      key: "w04-window-original-transport-key", createdAt: "2026-10-07T00:00:00.000Z", result: beforeOrder,
    });
    const previousAudit = store.auditLog(workspaceId);
    expect(restored.audit.slice(0, -1)).toEqual(previousAudit);
    expect(restored.audit).toHaveLength(previousAudit.length + 1);
    const appended = restored.audit.at(-1);
    if (!appended) throw new Error("replay audit required");
    const { eventHash, ...auditCore } = appended;
    expect(eventHash).toBe(v2Hash(auditCore));
    expect(appended).toMatchObject({
      previousEventHash: previousAudit.at(-1)?.eventHash,
      sequence: previousAudit.length + 1,
      beforeStateHash: beforeReplay.stateHash, afterStateHash: replay.envelope.stateHash,
      resultHash: v2Hash(replay.result), createdAt: "2026-10-07T00:00:00.000Z",
    });
    const committed = JSON.stringify(restored);
    await expect(restoredStore.compareAndSwap(workspaceId, beforeReplay.version, replay.envelope, auditCore))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(JSON.stringify(restored)).toBe(committed);
    expect(await runtime.read(workspaceId)).toEqual(beforeReplay);
  });
});
