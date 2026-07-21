import { describe, expect, it } from "vitest";
import { CrmDomainError, CrmService } from "../src/crm.js";

function seeded() {
  const service = new CrmService();
  service.createCustomer({
    id: "customer-1",
    workspaceId: "ws-1",
    name: "Acme",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  return service;
}

describe("CrmService", () => {
  it("rejects duplicates, cross-workspace references and stale versions", () => {
    const service = seeded();
    expect(() =>
      service.createCustomer({
        id: "customer-1",
        workspaceId: "ws-1",
        name: "Duplicate",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrowError(CrmDomainError);
    expect(() =>
      service.addContract({
        id: "contract-1",
        workspaceId: "ws-2",
        customerId: "customer-1",
        title: "Wrong",
        scope: "x",
        effectiveFrom: "2026-01-01",
      }),
    ).toThrowError(/another workspace/);
    expect(() => service.updateCustomer("ws-1", "customer-1", 2, { status: "at_risk" }, "2026-02-01T00:00:00Z"))
      .toThrowError(/expected customer version/);
  });

  it("returns exception-first deterministic overview with explicit pending finance", () => {
    const service = seeded();
    service.addException({
      id: "low",
      workspaceId: "ws-1",
      customerId: "customer-1",
      title: "Low",
      severity: "low",
      priority: 1,
      occurredAt: "2026-01-02T00:00:00Z",
      status: "open",
    });
    service.addException({
      id: "high",
      workspaceId: "ws-1",
      customerId: "customer-1",
      title: "High",
      severity: "high",
      priority: 9,
      occurredAt: "2026-01-03T00:00:00Z",
      status: "open",
    });
    service.addNextAction({
      id: "later",
      workspaceId: "ws-1",
      customerId: "customer-1",
      title: "Later",
      priority: 3,
      dueAt: "2026-01-10T00:00:00Z",
      status: "open",
    });
    service.addNextAction({
      id: "first",
      workspaceId: "ws-1",
      customerId: "customer-1",
      title: "First",
      priority: 8,
      dueAt: "2026-01-20T00:00:00Z",
      status: "open",
    });
    const overview = service.overview("ws-1", "customer-1", []);
    expect(overview.sectionOrder).toEqual([
      "exceptions",
      "nextActions",
      "status",
      "contracts",
      "projects",
      "communications",
      "finance",
    ]);
    expect(overview.exceptions.map((item) => item.id)).toEqual(["high", "low"]);
    expect(overview.nextActions.map((item) => item.id)).toEqual(["first", "later"]);
    expect(overview.finance).toEqual({ status: "pending" });
  });

  it("resolves exceptions and preserves communication history", () => {
    const service = seeded();
    service.addException({
      id: "exception-1",
      workspaceId: "ws-1",
      customerId: "customer-1",
      title: "Risk",
      severity: "medium",
      priority: 4,
      occurredAt: "2026-01-02T00:00:00Z",
      status: "open",
    });
    service.recordCommunication({
      id: "message-1",
      workspaceId: "ws-1",
      customerId: "customer-1",
      channel: "email",
      summary: "First",
      occurredAt: "2026-01-02T00:00:00Z",
    });
    service.recordCommunication({
      id: "message-2",
      workspaceId: "ws-1",
      customerId: "customer-1",
      channel: "meeting",
      summary: "Second",
      occurredAt: "2026-01-03T00:00:00Z",
    });
    service.resolveException("ws-1", "exception-1", "2026-01-04T00:00:00Z");
    const overview = service.overview("ws-1", "customer-1", []);
    expect(overview.exceptions).toEqual([]);
    expect(overview.communications.map((item) => item.summary)).toEqual(["Second", "First"]);
    expect(() => service.resolveException("ws-1", "exception-1", "2026-01-05T00:00:00Z")).toThrowError(
      /already resolved/,
    );
  });

  it("rejects project summaries from another workspace", () => {
    const service = seeded();
    expect(() =>
      service.overview("ws-1", "customer-1", [
        { id: "project-1", workspaceId: "ws-2", customerId: "customer-1", name: "Wrong", status: "active", progress: 0 },
      ]),
    ).toThrowError(/not bound/);
  });
});
