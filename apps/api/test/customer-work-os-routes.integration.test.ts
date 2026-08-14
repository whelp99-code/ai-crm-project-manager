import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCustomerWorkOsRoutes } from "../src/customer-work-os-routes.js";

const headers = (key: string, workspace = "11111111-1111-4111-8111-111111111111") => ({
  "x-workspace-id": workspace,
  "x-principal-id": "owner-1",
  "idempotency-key": key,
});

describe("Customer Work OS API plugin", () => {
  let app = Fastify();

  beforeEach(async () => {
    app = Fastify();
    await registerCustomerWorkOsRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("creates and reads an engagement through the API", async () => {
    const account = await app.inject({
      method: "POST",
      url: "/api/cwos/accounts",
      headers: headers("account-1"),
      payload: { id: "customer", name: "선진엔지니어링", kinds: ["customer"], status: "active" },
    });
    expect(account.statusCode).toBe(201);

    const engagement = await app.inject({
      method: "POST",
      url: "/api/cwos/engagements",
      headers: headers("engagement-1"),
      payload: { id: "engagement", projectKey: "PRJ-2026-001", name: "HCI 구축", type: "opportunity", stage: "INQUIRY", health: "normal" },
    });
    expect(engagement.statusCode).toBe(201);

    const party = await app.inject({
      method: "POST",
      url: "/api/cwos/parties",
      headers: headers("party-1"),
      payload: { id: "party", engagementId: "engagement", accountId: "customer", role: "customer", primary: true, commercialResponsibility: true, deliveryResponsibility: false },
    });
    expect(party.statusCode).toBe(201);

    const commitment = await app.inject({
      method: "POST",
      url: "/api/cwos/commitments",
      headers: headers("commitment-1"),
      payload: { id: "next-action", engagementId: "engagement", description: "고객 요구사항을 확인한다.", dueAt: "2026-08-20", status: "OPEN", priority: 90, financialImpact: false, approvalRequired: false },
    });
    expect(commitment.statusCode).toBe(201);

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/cwos/engagements/engagement",
      headers: { "x-workspace-id": "11111111-1111-4111-8111-111111111111", "x-principal-id": "owner-1" },
    });
    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json();
    expect(body.engagement.projectKey).toBe("PRJ-2026-001");
    expect(body.parties).toHaveLength(1);
    expect(body.commitments[0].description).toContain("요구사항");
  });

  it("replays the same idempotent request and rejects changed payload reuse", async () => {
    const request = {
      method: "POST" as const,
      url: "/api/cwos/accounts",
      headers: headers("same-key"),
      payload: { id: "customer", name: "A 고객", kinds: ["customer"], status: "active" },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await app.inject({
      ...request,
      payload: { id: "other", name: "다른 고객", kinds: ["customer"], status: "active" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("requires workspace, principal and idempotency headers", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/cwos/accounts",
      payload: { id: "customer", name: "A", kinds: ["customer"], status: "active" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("HEADER_REQUIRED");
  });

  it("isolates workspaces", async () => {
    await app.inject({
      method: "POST",
      url: "/api/cwos/engagements",
      headers: headers("create-engagement"),
      payload: { id: "engagement", projectKey: "PRJ-1", name: "A", type: "opportunity", stage: "INQUIRY", health: "normal" },
    });

    const crossWorkspace = await app.inject({
      method: "GET",
      url: "/api/cwos/engagements/engagement",
      headers: { "x-workspace-id": "22222222-2222-4222-8222-222222222222", "x-principal-id": "owner-2" },
    });
    expect(crossWorkspace.statusCode).toBe(403);
    expect(crossWorkspace.json().error).toBe("CROSS_WORKSPACE");
  });

  it("records partial settlement and exposes project finance", async () => {
    await app.inject({ method: "POST", url: "/api/cwos/accounts", headers: headers("account"), payload: { id: "customer", name: "고객", kinds: ["customer"], status: "active" } });
    await app.inject({ method: "POST", url: "/api/cwos/engagements", headers: headers("engagement"), payload: { id: "engagement", projectKey: "PRJ-1", name: "프로젝트", type: "delivery", stage: "BILLING", health: "normal" } });

    const item = await app.inject({
      method: "POST",
      url: "/api/cwos/financial-items",
      headers: headers("financial-item"),
      payload: {
        id: "receivable",
        engagementId: "engagement",
        accountId: "customer",
        direction: "IN",
        category: "contract_revenue",
        lifecycle: "BILLED",
        netAmountKrw: "1000000",
        vatAmountKrw: "100000",
        grossAmountKrw: "1100000",
        expectedDate: "2026-08-31",
        revision: 1,
      },
    });
    expect(item.statusCode).toBe(201);

    const settlement = await app.inject({
      method: "POST",
      url: "/api/cwos/settlements",
      headers: headers("settlement"),
      payload: { id: "settlement", financialItemId: "receivable", direction: "IN", amountKrw: "500000", settledAt: "2026-08-31", accountOrCard: "법인통장", evidenceRef: "bank://1" },
    });
    expect(settlement.statusCode).toBe(201);
    expect(settlement.json().financialItem.lifecycle).toBe("PARTIAL");

    const finance = await app.inject({
      method: "GET",
      url: "/api/cwos/engagements/engagement/finance",
      headers: { "x-workspace-id": "11111111-1111-4111-8111-111111111111", "x-principal-id": "owner-1" },
    });
    expect(finance.statusCode).toBe(200);
    expect(finance.json().receivableKrw).toBe("600000");
    expect(finance.json().cashPositionKrw).toBe("500000");
  });
});
