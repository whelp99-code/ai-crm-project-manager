import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { customerWorkOsPayloadHash, type ApprovalReceipt } from "@ai-crm/domain/customer-work-os";
import { registerDurableCustomerWorkOsRoutes } from "../src/customer-work-os-routes-durable.js";
import { InMemoryCustomerWorkOsSnapshotStore, type GovernanceApprovalResolver } from "../src/customer-work-os-runtime.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "owner-1";

function headers(idempotency?: string) {
  return {
    "x-workspace-id": WORKSPACE,
    "x-principal-id": PRINCIPAL,
    ...(idempotency ? { "idempotency-key": idempotency } : {}),
  };
}

class FakeApprovals implements GovernanceApprovalResolver {
  readonly calls: Array<Parameters<GovernanceApprovalResolver["resolve"]>[0]> = [];
  async resolve(input: Parameters<GovernanceApprovalResolver["resolve"]>[0]): Promise<ApprovalReceipt> {
    this.calls.push(structuredClone(input));
    if (!input.approvalId.startsWith("approved:")) throw new Error("approval denied");
    return {
      id: input.approvalId,
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      action: input.action,
      payloadHash: input.payloadHash,
      status: "CONSUMED",
      approvedByPrincipalId: "approver-1",
    };
  }
}

async function createApp(store: InMemoryCustomerWorkOsSnapshotStore, approvals?: GovernanceApprovalResolver) {
  const app = Fastify();
  await registerDurableCustomerWorkOsRoutes(app, {
    store,
    ...(approvals ? { approvals } : {}),
    now: () => "2026-08-14T00:00:00.000Z",
  });
  await app.ready();
  return app;
}

async function seed(app: Awaited<ReturnType<typeof createApp>>) {
  await app.inject({ method: "POST", url: "/api/cwos/accounts", headers: headers("account-customer"), payload: { id: "customer", name: "고객", kinds: ["customer"], status: "active" } });
  await app.inject({ method: "POST", url: "/api/cwos/accounts", headers: headers("account-vendor"), payload: { id: "vendor", name: "벤더", kinds: ["vendor"], status: "active" } });
  await app.inject({ method: "POST", url: "/api/cwos/engagements", headers: headers("engagement"), payload: { id: "engagement", projectKey: "PRJ-1", name: "고객 프로젝트", type: "opportunity", stage: "DISCOVERY", health: "normal" } });
  await app.inject({ method: "POST", url: "/api/cwos/commitments", headers: headers("commitment"), payload: { id: "next", engagementId: "engagement", description: "견적 검토", dueAt: "2026-08-20", status: "OPEN", priority: 90, financialImpact: true, approvalRequired: false } });
  await app.inject({ method: "POST", url: "/api/cwos/products", headers: headers("product"), payload: { id: "product", sku: "SKU", name: "장비", kind: "hardware", defaultCostKrw: "100", defaultPriceKrw: "200", active: true } });
}

describe("durable Customer Work OS routes", () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("persists workspace state and idempotency across application restart", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const first = await createApp(store); apps.push(first);
    const request = { method: "POST" as const, url: "/api/cwos/accounts", headers: headers("account-1"), payload: { id: "customer", name: "고객 A", kinds: ["customer"], status: "active" } };
    const created = await first.inject(request);
    expect(created.statusCode).toBe(201);
    await first.close(); apps.splice(apps.indexOf(first), 1);

    const restarted = await createApp(store); apps.push(restarted);
    const replay = await restarted.inject(request);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.json()).toEqual(created.json());
  });

  it("uses a consumed governance approval before approving a quote", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const approvals = new FakeApprovals();
    const app = await createApp(store, approvals); apps.push(app);
    await seed(app);

    const draftResponse = await app.inject({
      method: "POST",
      url: "/api/cwos/quotes",
      headers: headers("quote-create"),
      payload: {
        id: "quote",
        engagementId: "engagement",
        versionLabel: "v1",
        status: "DRAFT",
        validUntil: "2026-08-31",
        scope: "장비 납품",
        exclusions: [],
        bomLines: [{ id: "line", productId: "product", description: "장비", quantity: 1, unitCostKrw: "100", unitPriceKrw: "200", vendorAccountId: "vendor" }],
      },
    });
    expect(draftResponse.statusCode).toBe(201);
    const draft = draftResponse.json();

    const approved = await app.inject({
      method: "POST",
      url: "/api/cwos/quotes/quote/approve",
      headers: headers("quote-approve"),
      payload: { engagementId: "engagement", expectedVersion: draft.version, minimumMarginBps: 1000, approvalId: "approved:quote" },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json().status).toBe("APPROVED");
    expect(approvals.calls).toHaveLength(1);
    expect(approvals.calls[0]).toMatchObject({ action: "QUOTE_APPROVE", resourceId: "quote", resourceVersion: 1 });
  });

  it("does not accept raw receipt JSON when approval infrastructure is unavailable", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const app = await createApp(store); apps.push(app);
    await seed(app);
    await app.inject({
      method: "POST",
      url: "/api/cwos/quotes",
      headers: headers("quote-create"),
      payload: { id: "quote", engagementId: "engagement", versionLabel: "v1", status: "DRAFT", validUntil: "2026-08-31", scope: "장비", exclusions: [], bomLines: [{ id: "line", productId: "product", description: "장비", quantity: 1, unitCostKrw: "100", unitPriceKrw: "200", vendorAccountId: "vendor" }] },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/cwos/quotes/quote/approve",
      headers: headers("quote-approve"),
      payload: {
        engagementId: "engagement",
        expectedVersion: 1,
        minimumMarginBps: 1000,
        approvalId: "fake",
        receipt: { status: "CONSUMED", approvedByPrincipalId: "attacker" },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("APPROVAL_INFRASTRUCTURE_REQUIRED");
  });

  it("requires governance approval for non-planned finance and settlements", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const approvals = new FakeApprovals();
    const app = await createApp(store, approvals); apps.push(app);
    await app.inject({ method: "POST", url: "/api/cwos/accounts", headers: headers("customer"), payload: { id: "customer", name: "고객", kinds: ["customer"], status: "active" } });
    await app.inject({ method: "POST", url: "/api/cwos/engagements", headers: headers("engagement"), payload: { id: "engagement", projectKey: "PRJ", name: "프로젝트", type: "delivery", stage: "BILLING", health: "normal" } });

    const financialPayload = {
      id: "receivable",
      engagementId: "engagement",
      accountId: "customer",
      direction: "IN",
      category: "contract_revenue",
      lifecycle: "BILLED",
      netAmountKrw: "100",
      vatAmountKrw: "10",
      grossAmountKrw: "110",
      expectedDate: "2026-08-31",
      revision: 1,
      approvalId: "approved:financial",
    };
    const created = await app.inject({ method: "POST", url: "/api/cwos/financial-items", headers: headers("financial"), payload: financialPayload });
    expect(created.statusCode).toBe(201);
    expect(approvals.calls[0]?.action).toBe("FINANCIAL_ITEM_CREATE");

    const settlementPayload = { id: "settlement", engagementId: "engagement", financialItemId: "receivable", direction: "IN", amountKrw: "110", settledAt: "2026-08-31", accountOrCard: "bank", evidenceRef: "bank://1", approvalId: "approved:settlement" };
    const settled = await app.inject({ method: "POST", url: "/api/cwos/settlements", headers: headers("settlement"), payload: settlementPayload });
    expect(settled.statusCode).toBe(201);
    expect(approvals.calls[1]?.action).toBe("FINANCE_SETTLEMENT_RECORD");
    expect(settled.json().financialItem.lifecycle).toBe("SETTLED");
  });

  it("binds approval lookup to the deterministic domain payload hash", async () => {
    const store = new InMemoryCustomerWorkOsSnapshotStore();
    const approvals = new FakeApprovals();
    const app = await createApp(store, approvals); apps.push(app);
    await seed(app);
    const draft = (await app.inject({ method: "POST", url: "/api/cwos/quotes", headers: headers("q"), payload: { id: "quote", engagementId: "engagement", versionLabel: "v1", status: "DRAFT", validUntil: "2026-08-31", scope: "장비", exclusions: [], bomLines: [{ id: "line", productId: "product", description: "장비", quantity: 1, unitCostKrw: "100", unitPriceKrw: "200", vendorAccountId: "vendor" }] } })).json();
    await app.inject({ method: "POST", url: "/api/cwos/quotes/quote/approve", headers: headers("qa"), payload: { engagementId: "engagement", expectedVersion: 1, minimumMarginBps: 1000, approvalId: "approved:q" } });
    expect(approvals.calls[0]?.payloadHash).toBe(customerWorkOsPayloadHash({ totalCostKrw: draft.totalCostKrw, totalPriceKrw: draft.totalPriceKrw, marginBps: draft.marginBps, scope: draft.scope }));
  });
});
