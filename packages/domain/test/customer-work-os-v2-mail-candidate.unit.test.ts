import { describe, expect, it } from "vitest";
import { CustomerWorkOsV2Error, UnifiedInboxService, type InboxState, type V2Actor } from "../src/customer-work-os-v2/index.js";

const service: V2Actor = { principalId: "worker-1", workspaceId: "ws-1", kind: "service", stepUpVerified: false };
const human: V2Actor = { principalId: "human-1", workspaceId: "ws-1", kind: "human", stepUpVerified: true };
const candidate = { id: "candidate-1", workspaceId: "ws-1", provider: "GMAIL" as const, mailbox: "ops@example.test", sourceLocator: "thread/t1", providerEventId: "message-1", subject: "Question", bodyDigest: "sha256:digest" };

describe("CWOS v2 mail candidates", () => {
  it("is service-only, workspace-scoped, immutable, and isolated from inbox effects", () => {
    const inbox = new UnifiedInboxService();
    expect(() => inbox.createMailCandidate(candidate, human, "2026-10-08T00:00:00.000Z")).toThrowError(CustomerWorkOsV2Error);
    expect(() => inbox.createMailCandidate(candidate, { ...service, workspaceId: "ws-2" }, "2026-10-08T00:00:00.000Z")).toThrowError(CustomerWorkOsV2Error);

    const created = inbox.createMailCandidate(candidate, service, "2026-10-08T00:00:00.000Z");
    expect(inbox.createMailCandidate({ ...candidate }, service, "2026-10-09T00:00:00.000Z")).toEqual(created);
    expect(created).toMatchObject({ status: "CANDIDATE", confirmed: false, freshness: "producer_unverified", createdByPrincipalId: service.principalId, createdAt: "2026-10-08T00:00:00.000Z", version: 1 });
    expect(() => inbox.createMailCandidate({ ...candidate, subject: "Changed" }, service, "2026-10-09T00:00:00.000Z")).toThrowError(expect.objectContaining({ code: "CANDIDATE_CONFLICT" }));
    expect(() => inbox.createMailCandidate({ ...candidate, id: "candidate-1", providerEventId: "message-2" }, service, "2026-10-09T00:00:00.000Z")).toThrowError(expect.objectContaining({ code: "CANDIDATE_CONFLICT" }));

    const state = inbox.exportState();
    expect(state.mailCandidates).toEqual([created]);
    expect(state.events).toEqual([]);
    expect(state.mailInboxReceipts).toEqual([]);
    expect(state.mailWorkLinks).toEqual([]);
    expect(state.mailOutbox).toEqual([]);
  });

  it("appends a different source without modifying a previous candidate", () => {
    const inbox = new UnifiedInboxService();
    const first = inbox.createMailCandidate(candidate, service, "2026-10-08T00:00:00.000Z");
    const second = inbox.createMailCandidate({ ...candidate, id: "candidate-2", providerEventId: "message-2" },
      service, "2026-10-09T00:00:00.000Z");
    expect(inbox.exportState().mailCandidates).toEqual([first, second]);
  });

  it("round-trips candidates and hydrates legacy snapshots without them", () => {
    const inbox = new UnifiedInboxService();
    const created = inbox.createMailCandidate(candidate, service, "2026-10-08T00:00:00.000Z");
    const restored = new UnifiedInboxService();
    restored.hydrateState(inbox.exportState());
    expect(restored.exportState().mailCandidates).toEqual([created]);

    const legacy: InboxState = { ...inbox.exportState() };
    delete legacy.mailCandidates;
    const legacyRestored = new UnifiedInboxService();
    legacyRestored.hydrateState(legacy);
    expect(legacyRestored.exportState().mailCandidates).toEqual([]);
  });
});
