import { afterAll, describe, expect, it } from "vitest";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";

const workspaceId = "workspace-c05-c06";
const headers = (principalId: string) => ({
  "x-workspace-id": workspaceId,
  "x-principal-id": principalId,
  "x-principal-kind": "human",
  "x-step-up": "true",
});

describe("CWOS v2 C05/C06 command surface", () => {
  const app = createStandaloneCustomerWorkOsV2App({ profile: "test" });

  afterAll(async () => {
    await app.close();
  });

  it("denies a registered principal without active workspace membership from mapping work", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner"), "idempotency-key": "c05-register-owner" },
      payload: { command: "identity.registerPrincipal", expectedVersion: 0, payload: { id: "owner", kind: "human", displayName: "Owner", active: true } },
    });
    expect(register.statusCode).toBe(200);
    const membership = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner"), "idempotency-key": "c05-membership-owner" },
      payload: { command: "identity.addMembership", expectedVersion: 1, payload: { id: "membership-owner", principalId: "owner" } },
    });
    expect(membership.statusCode).toBe(200);
    const secondPrincipal = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner"), "idempotency-key": "c05-register-unmembered" },
      payload: { command: "identity.registerPrincipal", expectedVersion: 2, payload: { id: "unmembered", kind: "human", displayName: "Unmembered", active: true } },
    });
    expect(secondPrincipal.statusCode).toBe(200);
    const denied = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("unmembered"), "idempotency-key": "c05-denied-map" },
      payload: { command: "mail.mapWork", expectedVersion: 3, payload: { id: "link-denied", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/t1", sourceEventId: "event-1", workItemId: "work-1" } },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "MEMBERSHIP_REQUIRED" });
  });

  it("exposes correction and terminal delivery-unknown closure through the API", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner"), "idempotency-key": "c06-register" },
      payload: { command: "identity.registerPrincipal", expectedVersion: 3, payload: { id: "owner-2", kind: "human", displayName: "Owner 2", active: true } },
    });
    expect(register.statusCode).toBe(200);
    const membership = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner"), "idempotency-key": "c06-membership" },
      payload: { command: "identity.addMembership", expectedVersion: 4, payload: { id: "membership-owner-2", principalId: "owner-2" } },
    });
    expect(membership.statusCode).toBe(200);
    const first = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner-2"), "idempotency-key": "c06-first-link" },
      payload: { command: "mail.mapWork", expectedVersion: 5, payload: { id: "link-c06", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/c06", sourceEventId: "event-c06", workItemId: "work-old" } },
    });
    expect(first.statusCode).toBe(200);
    const correction = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner-2"), "idempotency-key": "c06-correction" },
      payload: { command: "mail.mapWork", expectedVersion: 6, payload: { id: "link-c06-new", provider: "gmail", mailbox: "ops@example.test", sourceLocator: "thread/c06", sourceEventId: "event-c06", workItemId: "work-new", correctionReason: "triage correction" } },
    });
    expect(correction.statusCode).toBe(200);
    const followUp = await app.inject({
      method: "POST",
      url: "/api/cwos/v2/commands",
      headers: { ...headers("owner-2"), "idempotency-key": "c06-follow-up" },
      payload: { command: "work.followUp", expectedVersion: 7, payload: { id: "follow-c06", sourceEventId: "event-c06", workItemId: "work-new", mailHandling: "DELIVERY_UNKNOWN", customerWork: "CLOSED", nextOwner: "owner-2", dueAt: null, evidenceRefs: ["audit:c06-correction"] } },
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().result).toMatchObject({ mailHandling: "DELIVERY_UNKNOWN", customerWork: "CLOSED", correctionReason: null });
  });
});
