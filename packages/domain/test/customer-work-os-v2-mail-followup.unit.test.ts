import { describe, expect, it } from "vitest";
import { CustomerWorkOsV2Platform, type V2Actor } from "../src/customer-work-os-v2/index.js";

const actor: V2Actor = { principalId: "human-1", workspaceId: "ws-1", kind: "human", stepUpVerified: true };

describe("CWOS v2 mail/work and follow-up boundaries", () => {
  it("deduplicates inbox receipts and scopes work links by provider mailbox locator", () => {
    const platform = new CustomerWorkOsV2Platform("ws-1");
    const first = platform.inbox.receiveMail({ id: "receipt-1", workspaceId: "ws-1", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/t1", providerEventId: "m1", receivedAt: "2026-09-22T00:00:00.000Z" }, "2026-09-22T00:00:00.000Z");
    const duplicate = platform.inbox.receiveMail({ ...first }, "2026-09-22T00:00:01.000Z");
    expect(duplicate).toEqual(first);
    const link = platform.inbox.mapWork({ id: "link-1", workspaceId: "ws-1", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/t1", sourceEventId: "event-1", workItemId: "work-1" }, actor, "2026-09-22T00:00:00.000Z");
    const repeated = platform.inbox.mapWork({ id: "link-duplicate", workspaceId: "ws-1", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/t1", sourceEventId: "event-1", workItemId: "work-1" }, actor, "2026-09-22T00:00:01.000Z");
    expect(link.workItemId).toBe("work-1");
    expect(repeated.id).toBe("link-1");
    expect(platform.inbox.exportState().mailOutbox).toHaveLength(2);
  });

  it("keeps mail handling and customer work closure separate", () => {
    const platform = new CustomerWorkOsV2Platform("ws-1");
    expect(() => platform.followUps.upsert({ id: "f1", workspaceId: "ws-1", sourceEventId: "e1", workItemId: "w1", mailHandling: "DRAFTED", customerWork: "CLOSED", nextOwner: "human-2", dueAt: null, evidenceRefs: ["ev-1"] }, actor)).toThrowError(/cannot close/);
    const item = platform.followUps.upsert({ id: "f1", workspaceId: "ws-1", sourceEventId: "e1", workItemId: "w1", mailHandling: "DELIVERY_UNKNOWN", customerWork: "CLOSED", nextOwner: "human-2", dueAt: null, evidenceRefs: ["ev-1"] }, actor);
    expect(item.mailHandling).toBe("DELIVERY_UNKNOWN");
    expect(item.customerWork).toBe("CLOSED");
  });
});
