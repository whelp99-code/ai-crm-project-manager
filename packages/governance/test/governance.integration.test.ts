import { describe, expect, it } from "vitest";
import { ActionRegistry, GovernanceAuthorizationService, GovernanceError, type Binding } from "../src/index.js";

const registry = new ActionRegistry({
  updateCustomer: "INTERNAL_REVERSIBLE_UPDATE",
  sendCustomer: "CUSTOMER_SEND",
  revisePlan: "PM_PLAN_REVISE",
});

function service() {
  return new GovernanceAuthorizationService(registry);
}

const request = {
  command: "sendCustomer",
  workspaceId: "ws-1",
  resourceId: "customer-1",
  resourceVersion: 3,
  payload: { message: "approved text" },
  requesterPrincipalId: "ai-executor",
};

function bindingFrom(control: NonNullable<ReturnType<GovernanceAuthorizationService["authorize"]>["control"]>): Binding {
  const binding: Binding = {
    workspaceId: control.workspaceId,
    resourceId: control.resourceId,
    resourceVersion: control.resourceVersion,
    payloadHash: control.payloadHash,
    policyVersion: control.policyVersion,
  };
  if (control.trustedContextHash !== undefined) binding.trustedContextHash = control.trustedContextHash;
  return binding;
}

describe("GovernanceAuthorizationService", () => {
  it("uses only injected trusted finance context and binds its fingerprint to finance controls", () => {
    const financeRegistry = new ActionRegistry({ verifyFinance: "FINANCE_VERIFY" });
    const trusted = {
      workspaceId: "ws-1", effectiveDate: "2026-01-01", tier: "risk_tiered" as const,
      matrixVersion: 1, packVersion: 1, financePolicyVersion: 1,
      evidenceHash: "a".repeat(64), validUntil: "2026-01-02T00:00:00.000Z",
    };
    const sut = new GovernanceAuthorizationService(financeRegistry, undefined, {
      financePolicyContext: () => trusted,
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });
    const result = sut.authorize({ ...request, command: "verifyFinance" });
    expect(result.requiredControl).toBe("ALLOW");
    expect(result.intent?.trustedContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sut.snapshot().audits[0]?.data).toMatchObject({
      decisionReason: "Active risk-tiered finance policy permits bounded verification without a control.",
      trustedFinanceContext: { tier: "risk_tiered", matrixVersion: "1" },
    });
  });

  it.each([
    ["FINANCE_CONTEXT_ABSENT", undefined],
    ["FINANCE_CONTEXT_WORKSPACE_MISMATCH", { workspaceId: "ws-2" }],
    ["FINANCE_CONTEXT_DATE_MISMATCH", { effectiveDate: "2025-12-31" }],
    ["FINANCE_CONTEXT_MATRIX_MISMATCH", { matrixVersion: 2 }],
    ["FINANCE_CONTEXT_PACK_MISMATCH", { packVersion: 2 }],
    ["FINANCE_CONTEXT_POLICY_MISMATCH", { financePolicyVersion: 2 }],
    ["FINANCE_CONTEXT_EVIDENCE_INVALID", { evidenceHash: "forged" }],
    ["FINANCE_CONTEXT_STALE", { validUntil: "2026-01-01T11:59:59.000Z" }],
  ] as const)("fails closed with auditable %s", (machineReason, override) => {
    const financeRegistry = new ActionRegistry({ verifyFinance: "FINANCE_VERIFY" });
    const base = {
      workspaceId: "ws-1", effectiveDate: "2026-01-01", tier: "risk_tiered" as const,
      matrixVersion: 1, packVersion: 1, financePolicyVersion: 1,
      evidenceHash: "a".repeat(64), validUntil: "2026-01-02T00:00:00.000Z",
    };
    const sut = new GovernanceAuthorizationService(financeRegistry, undefined, {
      financePolicyContext: () => override === undefined ? undefined : { ...base, ...override },
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });
    const result = sut.authorize({ ...request, command: "verifyFinance" });
    expect(result.requiredControl).toBe("REQUIRE_APPROVAL");
    expect(sut.snapshot().audits[0]?.data).toMatchObject({
      policyTier: "conservative",
      trustedFinanceContext: { source: "fallback", machineReason },
    });
  });

  it("rejects an approved finance control when trusted DailyGate context changes", () => {
    const financeRegistry = new ActionRegistry({ verifyFinance: "FINANCE_VERIFY" });
    let trusted = {
      workspaceId: "ws-1", effectiveDate: "2026-01-01", tier: "eligible" as const,
      matrixVersion: 1, packVersion: 1, financePolicyVersion: 1,
      evidenceHash: "a".repeat(64), validUntil: "2026-01-02T00:00:00.000Z",
    };
    const sut = new GovernanceAuthorizationService(financeRegistry, undefined, {
      financePolicyContext: () => trusted,
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    });
    const control = sut.authorize({ ...request, command: "verifyFinance" }).control!;
    sut.decideControl(control.id, "controller-2", "APPROVE", "ws-1");
    trusted = { ...trusted, evidenceHash: "b".repeat(64) };
    try {
      sut.consumeControl(control.id, bindingFrom(control));
      expect.unreachable("stale finance control must be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "STALE_CONTROL_FINANCE_CONTEXT" });
    }
  });
  it("fails closed for an unmapped command without mutating state", () => {
    const sut = service();
    expect(() => sut.authorize({ ...request, command: "notRegistered" })).toThrowError(GovernanceError);
    expect(sut.snapshot().audits).toHaveLength(0);
  });

  it("queues reversible internal work without inventing an approval", () => {
    const sut = service();
    const result = sut.authorize({ ...request, command: "updateCustomer" });
    expect(result.requiredControl).toBe("ALLOW");
    expect(result.intent?.status).toBe("QUEUED");
    expect(result.control).toBeUndefined();
    expect(sut.snapshot().outbox.map((event) => event.kind)).toEqual([
      "POLICY_DECIDED",
      "INTENT_QUEUED",
    ]);
  });

  it("requires a distinct approver and a one-time bound control for protected work", () => {
    const sut = service();
    const control = sut.authorize(request).control!;
    expect(control.kind).toBe("APPROVAL");
    expect(() => sut.decideControl(control.id, request.requesterPrincipalId, "APPROVE", "ws-1")).toThrowError(
      /requester cannot decide/,
    );
    sut.decideControl(control.id, "human-owner", "APPROVE", "ws-1");
    const intent = sut.consumeControl(control.id, bindingFrom(control));
    expect(intent.controlId).toBe(control.id);
    expect(() => sut.consumeControl(control.id, bindingFrom(control))).toThrowError(/cannot be consumed/);
  });

  it("requires and consumes a checkpoint for plan revisions", () => {
    const sut = service();
    const control = sut.authorize({
      ...request,
      command: "revisePlan",
      resourceId: "project-1",
    }).control!;
    expect(control.kind).toBe("CHECKPOINT");
    sut.decideControl(control.id, "ai-reviewer", "APPROVE", "ws-1");
    expect(sut.consumeControl(control.id, bindingFrom(control)).status).toBe("QUEUED");
  });

  it.each([
    ["workspaceId", "ws-2"],
    ["resourceId", "customer-2"],
    ["resourceVersion", 4],
    ["payloadHash", "tampered"],
    ["policyVersion", 999],
  ] as const)("rejects stale control binding for %s", (field, value) => {
    const sut = service();
    const control = sut.authorize(request).control!;
    sut.decideControl(control.id, "human-owner", "APPROVE", "ws-1");
    expect(() => sut.consumeControl(control.id, { ...bindingFrom(control), [field]: value })).toThrowError(
      new RegExp(field),
    );
  });

  it("recovers an expired lease and fences a stale worker token", () => {
    const sut = service();
    const result = sut.authorize({ ...request, command: "updateCustomer" });
    const firstLease = sut.leaseIntent(result.intent!.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z");
    const staleToken = firstLease.leaseToken!;
    expect(sut.recoverExpiredLeases("2026-01-01T00:01:00.000Z")).toHaveLength(1);
    const secondLease = sut.leaseIntent(result.intent!.id, "2026-01-01T00:02:00.000Z", "2026-01-01T00:03:00.000Z");
    expect(secondLease.leaseEpoch).toBe(2);
    expect(() => sut.startDispatch(result.intent!.id, staleToken, "2026-01-01T00:02:30.000Z")).toThrowError(
      /fenced/,
    );
    expect(sut.startDispatch(result.intent!.id, secondLease.leaseToken!, "2026-01-01T00:02:30.000Z").status).toBe(
      "DISPATCHING",
    );
  });

  it("does not allow duplicate leases or stale result writers", () => {
    const sut = service();
    const intent = sut.authorize({ ...request, command: "updateCustomer" }).intent!;
    const lease = sut.leaseIntent(intent.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z");
    expect(() => sut.leaseIntent(intent.id, "2026-01-01T00:00:10.000Z", "2026-01-01T00:02:00.000Z")).toThrowError(
      /cannot lease/,
    );
    sut.startDispatch(intent.id, lease.leaseToken!, "2026-01-01T00:00:30.000Z");
    expect(() => sut.finishIntent(intent.id, "wrong-token", "SUCCEEDED")).toThrowError(/does not own/);
    expect(sut.finishIntent(intent.id, lease.leaseToken!, "UNKNOWN").status).toBe("UNKNOWN");
  });

  it.each(["SUCCEEDED", "FAILED"] as const)("records a fenced %s terminal result", (outcome) => {
    const sut = service();
    const intent = sut.authorize({
      ...request,
      command: "updateCustomer",
      resourceId: `customer-${outcome}`,
    }).intent!;
    const lease = sut.leaseIntent(
      intent.id,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
    );
    sut.startDispatch(intent.id, lease.leaseToken!, "2026-01-01T00:00:30.000Z");
    expect(sut.finishIntent(intent.id, lease.leaseToken!, outcome).status).toBe(outcome);
  });

  it("invalidates queued or leased work but refuses to erase an in-flight effect", () => {
    const sut = service();
    const queued = sut.authorize({ ...request, command: "updateCustomer" }).intent!;
    expect(sut.invalidateIntent(queued.id).status).toBe("INVALIDATED");

    const second = sut.authorize({ ...request, command: "updateCustomer", resourceId: "customer-2" }).intent!;
    const lease = sut.leaseIntent(second.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z");
    sut.startDispatch(second.id, lease.leaseToken!, "2026-01-01T00:00:30.000Z");
    expect(() => sut.invalidateIntent(second.id)).toThrowError(/cannot invalidate DISPATCHING/);
  });

  it("advances notification states and rejects terminal transitions", () => {
    const sut = service();
    const notification = sut.createNotification("ws-1", "exception-1");
    expect(sut.transitionNotification(notification.id, "SENT", "ws-1").attempts).toBe(1);
    expect(sut.transitionNotification(notification.id, "ESCALATED", "ws-1").status).toBe("ESCALATED");
    expect(sut.transitionNotification(notification.id, "ACKED", "ws-1").status).toBe("ACKED");
    expect(() => sut.transitionNotification(notification.id, "DEAD_LETTER", "ws-1")).toThrowError(/ACKED/);
  });

  it("verifies each workspace audit chain independently and detects tampering", () => {
    const sut = service();
    sut.authorize({ ...request, command: "updateCustomer" });
    sut.createNotification("ws-2", "exception-2");
    expect(sut.verifyAuditChain("ws-1")).toBe(true);
    expect(sut.verifyAuditChain("ws-2")).toBe(true);

    const state = sut.snapshot();
    state.audits[0]!.hash = "tampered";
    const tampered = new GovernanceAuthorizationService(registry, state);
    expect(tampered.verifyAuditChain("ws-1")).toBe(false);
  });
});

describe("GOV-U-05 expireControl", () => {
  it("transitions PENDING → EXPIRED and is idempotent once expired", () => {
    const sut = service();
    const control = sut.authorize(request).control!;
    expect(control.status).toBe("PENDING");

    const expired = sut.expireControl(control.id, "ws-1");
    expect(expired.status).toBe("EXPIRED");
    expect(sut.getControl("ws-1", control.id).status).toBe("EXPIRED");

    // Idempotent re-expire
    expect(sut.expireControl(control.id, "ws-1").status).toBe("EXPIRED");

    const kinds = sut.listAuditEvents("ws-1").map((event) => event.kind);
    expect(kinds).toContain("CONTROL_EXPIRED");
  });

  it("refuses to expire non-PENDING controls other than already-EXPIRED", () => {
    const sut = service();
    const control = sut.authorize(request).control!;
    sut.decideControl(control.id, "human-owner", "APPROVE", "ws-1");
    expect(() => sut.expireControl(control.id, "ws-1")).toThrowError(/CONTROL_NOT_PENDING|cannot be expired/);
  });

  it("fails closed on workspace mismatch", () => {
    const sut = service();
    const control = sut.authorize(request).control!;
    expect(() => sut.expireControl(control.id, "ws-other")).toThrowError(/CONTROL_NOT_FOUND|not found/);
  });
});

describe("GOV-U-HYDRATE hydrate-on-boot restart consistency", () => {
  it("rebuilds controls/intents maps from persisted shapes", async () => {
    const { controlToPersisted, intentToPersisted } = await import("../src/index.js");
    const sut = service();
    const control = sut.authorize(request).control!;
    const intent = sut.authorize({
      command: "updateCustomer",
      workspaceId: "ws-1",
      resourceId: "customer-2",
      resourceVersion: 1,
      payload: { name: "x" },
      requesterPrincipalId: "ai-executor",
    }).intent!;

    const fresh = service();
    fresh.hydrate({
      controls: [controlToPersisted(control)],
      intents: [intentToPersisted(intent)],
    });

    expect(fresh.getControl("ws-1", control.id).status).toBe("PENDING");
    expect(fresh.getIntent("ws-1", intent.id).status).toBe("QUEUED");
    expect(fresh.listControls("ws-1")).toHaveLength(1);
  });

  it("advances id counters past hydrated ids so new ids never collide", async () => {
    const { controlToPersisted } = await import("../src/index.js");
    const sut = service();
    const control = sut.authorize(request).control!;

    const fresh = service();
    fresh.hydrate({ controls: [controlToPersisted(control)], intents: [] });

    const next = fresh.authorize(request).control!;
    expect(next.id).not.toBe(control.id);
    const [, hydratedSuffix] = control.id.split("-");
    const [, nextSuffix] = next.id.split("-");
    expect(Number(nextSuffix)).toBeGreaterThan(Number(hydratedSuffix));
  });

  it("replaces prior state wholesale (does not merge with pre-hydrate controls)", () => {
    const sut = service();
    const stale = sut.authorize(request).control!;
    sut.hydrate({ controls: [], intents: [] });
    expect(() => sut.getControl("ws-1", stale.id)).toThrowError(/CONTROL_NOT_FOUND|not found/);
  });
});
