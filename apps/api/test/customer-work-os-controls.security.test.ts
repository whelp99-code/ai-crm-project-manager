import { describe, expect, it } from "vitest";
import {
  InMemoryCustomerWorkOsControlService,
  buildCustomerWorkOsControlRequestHash,
  type ControlRequester,
  type PrincipalIdentity,
} from "../src/customer-work-os-controls.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function principals(): Map<string, PrincipalIdentity> {
  return new Map([
    ["requester", { id: "requester", workspaceId: WORKSPACE, kind: "HUMAN", role: "operator", active: true }],
    ["owner", { id: "owner", workspaceId: WORKSPACE, kind: "HUMAN", role: "owner", active: true }],
    ["viewer", { id: "viewer", workspaceId: WORKSPACE, kind: "HUMAN", role: "viewer", active: true }],
    ["ai", { id: "ai", workspaceId: WORKSPACE, kind: "AI", role: "owner", active: true }],
  ]);
}

function requestInput(overrides: Partial<Omit<ControlRequester, "requestHash">> = {}): ControlRequester {
  const base: Omit<ControlRequester, "requestHash"> = {
    workspaceId: WORKSPACE,
    requesterPrincipalId: "requester",
    idempotencyKey: "request-1",
    action: "QUOTE_APPROVE",
    resourceType: "quote",
    resourceId: "quote-1",
    resourceVersion: 1,
    payloadHash: "sha256:payload",
    reason: "목표 마진과 범위를 검토함",
    ...overrides,
  };
  return { ...base, requestHash: buildCustomerWorkOsControlRequestHash(base) };
}

describe("Customer Work OS approval controls", () => {
  it("creates an idempotent request, records an independent decision and resolves a consumed receipt", async () => {
    let now = "2026-08-14T00:00:00Z";
    const service = new InMemoryCustomerWorkOsControlService(principals(), () => now);
    const first = await service.request(requestInput());
    const replay = await service.request(requestInput());
    expect(replay).toEqual(first);
    expect(first.status).toBe("REQUESTED");

    now = "2026-08-14T00:10:00Z";
    const approved = await service.decide({ workspaceId: WORKSPACE, controlId: first.id, approverPrincipalId: "owner", idempotencyKey: "decision-1", decision: "APPROVE", reason: "견적 원가와 마진 확인" });
    expect(approved.status).toBe("CONSUMED");
    expect(approved.decidedByPrincipalId).toBe("owner");

    const receipt = await service.resolve({ workspaceId: WORKSPACE, approvalId: first.id, resourceType: "quote", resourceId: "quote-1", resourceVersion: 1, action: "QUOTE_APPROVE", payloadHash: "sha256:payload" });
    expect(receipt.status).toBe("CONSUMED");
    expect(receipt.approvedByPrincipalId).toBe("owner");
  });

  it("rejects request hash tampering and idempotency payload conflicts", async () => {
    const service = new InMemoryCustomerWorkOsControlService(principals(), () => "2026-08-14T00:00:00Z");
    await expect(service.request({ ...requestInput(), requestHash: "tampered" })).rejects.toMatchObject({ code: "REQUEST_HASH_MISMATCH" });
    await service.request(requestInput());
    await expect(service.request(requestInput({ payloadHash: "sha256:other" }))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("forbids self approval, AI approval and unauthorized roles", async () => {
    const service = new InMemoryCustomerWorkOsControlService(principals(), () => "2026-08-14T00:10:00Z");
    const self = await service.request(requestInput({ idempotencyKey: "self" }));
    await expect(service.decide({ workspaceId: WORKSPACE, controlId: self.id, approverPrincipalId: "requester", idempotencyKey: "self-decision", decision: "APPROVE", reason: "self" })).rejects.toMatchObject({ code: "SELF_APPROVAL_FORBIDDEN" });

    const ai = await service.request(requestInput({ idempotencyKey: "ai-request" }));
    await expect(service.decide({ workspaceId: WORKSPACE, controlId: ai.id, approverPrincipalId: "ai", idempotencyKey: "ai-decision", decision: "APPROVE", reason: "AI" })).rejects.toMatchObject({ code: "HUMAN_APPROVER_REQUIRED" });

    const viewer = await service.request(requestInput({ idempotencyKey: "viewer-request" }));
    await expect(service.decide({ workspaceId: WORKSPACE, controlId: viewer.id, approverPrincipalId: "viewer", idempotencyKey: "viewer-decision", decision: "APPROVE", reason: "viewer" })).rejects.toMatchObject({ code: "APPROVER_ROLE_FORBIDDEN" });
  });

  it("expires stale approvals and never resolves rejected or expired controls", async () => {
    let now = "2026-08-14T00:00:00Z";
    const service = new InMemoryCustomerWorkOsControlService(principals(), () => now);
    const control = await service.request(requestInput({ idempotencyKey: "expiry" }));
    now = "2026-08-14T02:00:00Z";
    const expired = await service.decide({ workspaceId: WORKSPACE, controlId: control.id, approverPrincipalId: "owner", idempotencyKey: "expiry-decision", decision: "APPROVE", reason: "late" });
    expect(expired.status).toBe("EXPIRED");
    await expect(service.resolve({ workspaceId: WORKSPACE, approvalId: control.id, resourceType: "quote", resourceId: "quote-1", resourceVersion: 1, action: "QUOTE_APPROVE", payloadHash: "sha256:payload" })).rejects.toMatchObject({ code: "STALE_APPROVAL" });
  });

  it("rejects a receipt lookup for a changed version or payload", async () => {
    let now = "2026-08-14T00:00:00Z";
    const service = new InMemoryCustomerWorkOsControlService(principals(), () => now);
    const control = await service.request(requestInput());
    now = "2026-08-14T00:01:00Z";
    await service.decide({ workspaceId: WORKSPACE, controlId: control.id, approverPrincipalId: "owner", idempotencyKey: "decision", decision: "APPROVE", reason: "ok" });
    await expect(service.resolve({ workspaceId: WORKSPACE, approvalId: control.id, resourceType: "quote", resourceId: "quote-1", resourceVersion: 2, action: "QUOTE_APPROVE", payloadHash: "sha256:payload" })).rejects.toMatchObject({ code: "STALE_APPROVAL" });
    await expect(service.resolve({ workspaceId: WORKSPACE, approvalId: control.id, resourceType: "quote", resourceId: "quote-1", resourceVersion: 1, action: "QUOTE_APPROVE", payloadHash: "sha256:changed" })).rejects.toMatchObject({ code: "STALE_APPROVAL" });
  });
});
