import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "d1111111-1111-4111-8111-111111111111";
const owner: V2Actor = {
  principalId: "w01-test-owner",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};
const w01Payload = {
  engagement: { id: "w01-test-engagement", version: 1 },
  versionLabel: "v1",
  validUntil: "2026-08-31",
  scope: "HCI 4-node delivery",
  lines: [{
    id: "w01-test-line",
    sourceId: "w01-test-source-line",
    productId: "hci-test",
    description: "HCI 4-node",
    quantity: 1,
    unitCostKrw: "60000000",
    unitPriceKrw: "100000000",
    vendorAccountId: "vendor-test",
  }],
  options: ["Customer application changes"],
  templateRef: "베를로 견적서 기본양식 - 20260706.xlsx",
  templateObservation: {
    filename: "베를로 견적서 기본양식 - 20260706.xlsx",
    bytes: 23074,
    sha256: "7fe54a33f4b2ad3179361a892fbabb5dd53588fe52e279fe2441beec49437daa",
    sheetNames: ["참고견적", "베를로 템플릿"],
    mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
    historicalCandidateId: "1ckGSGoiJ5KYi6k2LBuBssnkRV75ipGcL",
  },
  vat: {
    netAmountKrw: "100000000",
    vatAmountKrw: "10000000",
    grossAmountKrw: "110000000",
  },
  po: { customerPoId: "customer-po-test", supplierPoId: "supplier-po-test" },
};

describe("W01 v2 authorized draft persistence", () => {
  it("rejects unsafe raw JSON quantities through app.inject with unchanged state and audit", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 0, idempotencyKey: "http-quantity-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "Fixture Owner", active: true },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 1, idempotencyKey: "http-quantity-membership",
      command: "identity.addMembership", payload: { id: "http-quantity-membership", principalId: owner.principalId },
    });
    const app = createStandaloneCustomerWorkOsV2App({ store, profile: "test", actorBinding: owner });
    const headers = {
      "content-type": "application/json", "x-principal-kind": owner.kind,
      "x-principal-id": owner.principalId, "x-workspace-id": workspaceId,
    };
    const before = await runtime.read(workspaceId);
    const auditBefore = structuredClone(store.auditLog(workspaceId));
    try {
      for (const [index, rawQuantity] of ["9007199254740992", "9007199254740993", "1.5", "0", "-1"].entries()) {
        const parsedQuantity = JSON.parse(rawQuantity) as number;
        const payload = {
          ...w01Payload,
          lines: w01Payload.lines.map(line => ({ ...line, quantity: parsedQuantity, unitCostKrw: "1", unitPriceKrw: "1" })),
          vat: { netAmountKrw: String(parsedQuantity), vatAmountKrw: "0", grossAmountKrw: String(parsedQuantity) },
        };
        const response = await app.inject({
          method: "POST", url: "/api/cwos/v2/commands",
          headers: { ...headers, "idempotency-key": `http-quantity-${index}` },
          payload: JSON.stringify({ expectedVersion: 2, command: "w01.quoteDraft", payload })
            .replace(`"quantity":${parsedQuantity}`, `"quantity":${rawQuantity}`),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "INVALID_QUANTITY" });
        expect(await runtime.read(workspaceId)).toEqual(before);
        expect(store.auditLog(workspaceId)).toEqual(auditBefore);
      }
      const quantity = Number.MAX_SAFE_INTEGER;
      const net = (BigInt(quantity) * 3n).toString();
      const request = {
        method: "POST" as const, url: "/api/cwos/v2/commands",
        headers: { ...headers, "idempotency-key": "http-quantity-safe" },
        payload: {
          expectedVersion: 2, command: "w01.quoteDraft",
          payload: {
            ...w01Payload,
            lines: w01Payload.lines.map(line => ({ ...line, quantity, unitCostKrw: "2", unitPriceKrw: "3" })),
            vat: { netAmountKrw: net, vatAmountKrw: "0", grossAmountKrw: net },
          },
        },
      };
      const accepted = await app.inject(request);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json().result.quote.totalPriceKrw).toBe(net);
      expect(accepted.json().result.quote.totalCostKrw).toBe((BigInt(quantity) * 2n).toString());
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(accepted.json());
      expect(store.auditLog(workspaceId)).toHaveLength(auditBefore.length + 1);
    } finally {
      await app.close();
    }
  });

  it.each(["9007199254740992", "9007199254740993"])("rejects JSON quantity %s through the generic native command without state changes", async (rawQuantity) => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 0, idempotencyKey: "quantity-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "Fixture Owner", active: true },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 1, idempotencyKey: "quantity-membership",
      command: "identity.addMembership", payload: { id: "quantity-membership", principalId: owner.principalId },
    });
    const before = await runtime.read(workspaceId);
    const quantity = JSON.parse(rawQuantity) as number;
    expect(quantity).toBe(9007199254740992);
    await expect(runtime.command({
      workspaceId, actor: owner, expectedVersion: 2, idempotencyKey: "quantity-rejected",
      command: "w01.quoteDraft",
      payload: {
        ...w01Payload,
        lines: w01Payload.lines.map(line => ({ ...line, quantity, unitCostKrw: "1", unitPriceKrw: "1" })),
        vat: { netAmountKrw: String(quantity), vatAmountKrw: "0", grossAmountKrw: String(quantity) },
      },
    })).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    expect(await runtime.read(workspaceId)).toEqual(before);
  });

  it("persists the measured unapproved draft as the authorized command idempotency result", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "w01-test-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "W01 Test Owner", active: true },
    });
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 1,
      idempotencyKey: "w01-test-membership",
      command: "identity.addMembership",
      payload: { id: "w01-test-membership", principalId: owner.principalId },
    });

    const first = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "w01-test-draft",
      command: "w01.quoteDraft",
      payload: w01Payload,
    });
    const reopenedRuntime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    const replay = await reopenedRuntime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "w01-test-draft",
      command: "w01.quoteDraft",
      payload: w01Payload,
    });

    expect(first.result).toMatchObject({
      quote: { versionLabel: "v1" },
      engagementVersion: 1,
      vat: w01Payload.vat,
      po: w01Payload.po,
      templateObservation: {
        mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
        sameHistoricalDocument: false,
        approvalVerified: false,
      },
    });
    expect(replay.result).toEqual(first.result);
    expect(replay.envelope.state.quoteDrafts).toEqual([first.result]);
    expect(replay.envelope.version).toBe(first.envelope.version);
    expect(replay.envelope.idempotency.filter((item) => item.key === "w01-test-draft")).toHaveLength(1);
  });

  it("keeps a quote draft after snapshot reconstruction and a new transport key", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 0, idempotencyKey: "persist-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "Fixture Owner", active: true },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 1, idempotencyKey: "persist-membership",
      command: "identity.addMembership", payload: { id: "persist-membership", principalId: owner.principalId },
    });
    const first = await runtime.command({
      workspaceId, actor: owner, expectedVersion: 2, idempotencyKey: "persist-draft",
      command: "w01.quoteDraft", payload: w01Payload,
    });
    const reopened = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
    const replay = await reopened.command({
      workspaceId, actor: owner, expectedVersion: first.envelope.version, idempotencyKey: "new-transport-key",
      command: "w01.quoteDraft", payload: w01Payload,
    });
    expect(replay.envelope.state.quoteDrafts).toEqual([first.result]);
    await expect(reopened.command({
      workspaceId, actor: owner, expectedVersion: replay.envelope.version, idempotencyKey: "conflicting-cost",
      command: "w01.quoteDraft",
      payload: { ...w01Payload, lines: w01Payload.lines.map(line => ({ ...line, unitCostKrw: "1" })) },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await reopened.read(workspaceId)).state.quoteDrafts).toEqual([first.result]);
  });

  it("rejects missing step-up and changed-payload idempotency replay", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "w01-edge-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "W01 Test Owner", active: true },
    });
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 1,
      idempotencyKey: "w01-edge-membership",
      command: "identity.addMembership",
      payload: { id: "w01-edge-membership", principalId: owner.principalId },
    });
    const created = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "w01-edge-draft",
      command: "w01.quoteDraft",
      payload: w01Payload,
    });

    await expect(runtime.command({
      workspaceId,
      actor: { ...owner, stepUpVerified: false },
      expectedVersion: created.envelope.version,
      idempotencyKey: "w01-no-step-up",
      command: "w01.quoteDraft",
      payload: w01Payload,
    })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });

    await expect(runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: created.envelope.version,
      idempotencyKey: "w01-edge-draft",
      command: "w01.quoteDraft",
      payload: { ...w01Payload, options: ["Changed option"] },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
