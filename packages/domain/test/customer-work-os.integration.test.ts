import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type ApprovalReceipt,
  type FinancialItem,
} from "../src/customer-work-os.js";

const WORKSPACE = "workspace-1";

function approval(input: Omit<ApprovalReceipt, "workspaceId" | "status" | "approvedByPrincipalId">): ApprovalReceipt {
  return { ...input, workspaceId: WORKSPACE, status: "CONSUMED", approvedByPrincipalId: "owner-1" };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsError);
    expect((error as CustomerWorkOsError).code).toBe(code);
  }
}

function seed(service: CustomerWorkOsService): void {
  service.createAccount({ id: "customer", workspaceId: WORKSPACE, name: "선진엔지니어링", kinds: ["customer"], status: "active" });
  service.createAccount({ id: "vendor", workspaceId: WORKSPACE, name: "총판 A", kinds: ["vendor", "partner"], status: "active" });
  service.createAccount({ id: "maker", workspaceId: WORKSPACE, name: "HCI 제조사", kinds: ["manufacturer"], status: "active" });
  service.addContact({ id: "contact", workspaceId: WORKSPACE, accountId: "customer", name: "홍길동", email: "hong@example.com", stakeholderRole: "decision_maker" });
  service.createEngagement({
    id: "engagement",
    workspaceId: WORKSPACE,
    projectKey: "PRJ-2026-001",
    name: "선진엔지니어링 HCI 구축",
    type: "opportunity",
    stage: "DISCOVERY",
    health: "normal",
    ownerPrincipalId: "owner-1",
    startDate: "2026-08-14",
    targetDate: "2026-10-31",
  });
  service.assignParty({ id: "party-customer", workspaceId: WORKSPACE, engagementId: "engagement", accountId: "customer", role: "customer", primary: true, commercialResponsibility: true, deliveryResponsibility: false });
  service.assignParty({ id: "party-vendor", workspaceId: WORKSPACE, engagementId: "engagement", accountId: "vendor", role: "vendor", primary: true, commercialResponsibility: true, deliveryResponsibility: true });
  service.recordActivity({
    id: "activity",
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    accountId: "customer",
    type: "meeting",
    occurredAt: "2026-08-14T01:00:00.000Z",
    summary: "HCI 교체와 10월 검수 요구 확인",
    evidenceRef: "meeting://2026-08-14/1",
    humanReviewed: true,
  });
  service.addKnowledgeItem({
    id: "requirement",
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    kind: "requirement",
    statement: "기존 서비스 중단 없이 HCI를 교체한다.",
    status: "CONFIRMED",
    evidenceRef: "meeting://2026-08-14/1#requirement",
    sourceActivityId: "activity",
  });
  service.addCommitment({
    id: "commitment",
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    sourceActivityId: "activity",
    ownerPrincipalId: "owner-1",
    counterpartyAccountId: "customer",
    description: "수정 견적서를 전달한다.",
    dueAt: "2026-08-18",
    status: "OPEN",
    priority: 90,
    financialImpact: true,
    approvalRequired: true,
  });
  service.addProduct({
    id: "hci",
    workspaceId: WORKSPACE,
    sku: "HCI-4NODE",
    name: "4노드 HCI",
    kind: "hardware",
    manufacturerAccountId: "maker",
    defaultCostKrw: "60000000",
    defaultPriceKrw: "100000000",
    active: true,
  });
}

function createQuote(service: CustomerWorkOsService, id = "quote", cost = "60000000", price = "100000000") {
  return service.createQuote({
    id,
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    versionLabel: "v1",
    status: "DRAFT",
    validUntil: "2026-08-31",
    scope: "HCI 4노드 납품, 마이그레이션, 시험 및 완료보고",
    exclusions: ["고객 애플리케이션 수정"],
    bomLines: [{ id: `${id}-line`, productId: "hci", description: "HCI 4노드", quantity: 1, unitCostKrw: cost, unitPriceKrw: price, vendorAccountId: "vendor" }],
  });
}

describe("CustomerWorkOsService", () => {
  it("keeps the prior renewal quote revision after a correction", () => {
    const service = new CustomerWorkOsService();
    seed(service);
    service.createEngagement({
      id: "renewal-engagement",
      workspaceId: WORKSPACE,
      projectKey: "PRJ-2026-001-R",
      name: "선진엔지니어링 HCI 갱신",
      type: "renewal",
      stage: "PROPOSAL",
      health: "normal",
      ownerPrincipalId: "owner-1",
    });
    const quote = service.createQuote({
      id: "renewal-quote",
      workspaceId: WORKSPACE,
      engagementId: "renewal-engagement",
      versionLabel: "v1",
      status: "DRAFT",
      validUntil: "2026-08-31",
      scope: "기존 유지보수",
      exclusions: ["신규 하드웨어"],
      bomLines: [{ id: "renewal-line", productId: "hci", description: "HCI 4노드", quantity: 1, unitCostKrw: "60000000", unitPriceKrw: "100000000", vendorAccountId: "vendor" }],
    });
    const corrected = service.correctRenewalQuote(WORKSPACE, quote.id, quote.version, {
      versionLabel: "v2",
      validUntil: "2026-09-30",
      scope: "기존 유지보수, 검수 일정 수정",
      exclusions: ["신규 하드웨어", "교체 작업"],
    });
    expect(corrected.versionLabel).toBe("v2");
    expect(corrected.validUntil).toBe("2026-09-30");
    expect(service.renewalQuoteHistory(WORKSPACE, quote.id)).toEqual([
      { versionLabel: "v1", validUntil: "2026-08-31", scope: "기존 유지보수", exclusions: ["신규 하드웨어"], version: 1 },
    ]);
  });

  it("runs a CRM → CPQ → contract → PSA → procurement → asset → finance vertical slice", () => {
    const service = new CustomerWorkOsService();
    seed(service);

    const quote = createQuote(service);
    expect(quote.totalCostKrw).toBe("60000000");
    expect(quote.totalPriceKrw).toBe("100000000");
    expect(quote.grossProfitKrw).toBe("40000000");
    expect(quote.marginBps).toBe(4000);

    const quotePayload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
    const approvedQuote = service.approveQuote(
      WORKSPACE,
      quote.id,
      quote.version,
      approval({ id: "approve-quote", resourceType: "quote", resourceId: quote.id, resourceVersion: quote.version, action: "QUOTE_APPROVE", payloadHash: customerWorkOsPayloadHash(quotePayload) }),
      2000,
    );

    const accepted = service.acceptQuoteAsContract(
      {
        id: "contract",
        workspaceId: WORKSPACE,
        engagementId: "engagement",
        quoteId: quote.id,
        title: "HCI 구축 계약",
        scope: quote.scope,
        exclusions: quote.exclusions,
        contractValueKrw: "100000000",
        effectiveFrom: "2026-08-20",
        effectiveTo: "2026-10-31",
        billingMilestones: [
          { id: "deposit", name: "계약금", amountKrw: "30000000", trigger: "계약", expectedDate: "2026-08-25" },
          { id: "balance", name: "잔금", amountKrw: "70000000", trigger: "검수", expectedDate: "2026-10-31" },
        ],
      },
      approvedQuote.version,
    );
    expect(accepted.engagement.stage).toBe("CONTRACTED");

    const delivery = service.handoverToDelivery({
      id: "delivery",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      contractId: "contract",
      projectKey: "PRJ-2026-001",
      scopeBaseline: quote.scope,
      scheduleStart: "2026-08-25",
      scheduleEnd: "2026-10-31",
      requirementIds: ["requirement"],
      deliverables: [{ id: "completion-report", title: "완료보고서", required: true, requirementIds: ["requirement"], status: "PENDING" }],
    });
    expect(delivery.projectKey).toBe("PRJ-2026-001");

    const change = service.proposeChangeRequest({
      id: "change",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      deliveryProjectId: "delivery",
      sourceActivityId: "activity",
      description: "지사 장비 로그 연동 추가",
      scopeImpact: "지사 로그 연동과 시험을 범위에 추가",
      scheduleImpactDays: 3,
      costImpactKrw: "2000000",
      priceImpactKrw: "4000000",
    });
    const changePayload = { disposition: "ADDITIONAL_QUOTE", scopeImpact: change.scopeImpact, scheduleImpactDays: 3, costImpactKrw: "2000000", priceImpactKrw: "4000000" };
    const approvedChange = service.approveChangeRequest(
      WORKSPACE,
      change.id,
      change.version,
      "ADDITIONAL_QUOTE",
      approval({ id: "approve-change", resourceType: "change_request", resourceId: change.id, resourceVersion: change.version, action: "CHANGE_REQUEST_APPROVE", payloadHash: customerWorkOsPayloadHash(changePayload) }),
    );
    const appliedChange = service.applyChangeRequest(WORKSPACE, change.id, approvedChange.version);
    expect(appliedChange.project.scheduleEnd).toBe("2026-11-03");

    const order = service.createPurchaseOrder({
      id: "po",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      vendorAccountId: "vendor",
      expectedDate: "2026-09-10",
      lines: [{ id: "po-line", productId: "hci", description: "HCI 4노드", quantity: 1, unitCostKrw: "60000000", receivedQuantity: 0 }],
    });
    const poPayload = { vendorAccountId: "vendor", totalCostKrw: "60000000", lines: order.lines };
    const approvedOrder = service.approvePurchaseOrder(
      WORKSPACE,
      order.id,
      order.version,
      approval({ id: "approve-po", resourceType: "purchase_order", resourceId: order.id, resourceVersion: order.version, action: "PURCHASE_ORDER_APPROVE", payloadHash: customerWorkOsPayloadHash(poPayload) }),
    );
    const ordered = service.markPurchaseOrderOrdered(WORKSPACE, order.id, approvedOrder.version);
    const received = service.receivePurchaseOrderLine(WORKSPACE, order.id, ordered.version, "po-line", 1);
    expect(received.status).toBe("RECEIVED");

    service.registerAsset({
      id: "asset",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      customerAccountId: "customer",
      productId: "hci",
      purchaseOrderId: "po",
      serialOrLicenseKey: "HCI-SERIAL-0001",
      status: "DELIVERED",
      deliveredAt: "2026-09-10",
      warrantyEnd: "2029-09-09",
      renewalDate: "2029-08-10",
    });

    const incoming: FinancialItem = {
      id: "incoming",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      accountId: "customer",
      direction: "IN",
      category: "contract_revenue",
      lifecycle: "BILLED",
      netAmountKrw: "100000000",
      vatAmountKrw: "10000000",
      grossAmountKrw: "110000000",
      expectedDate: "2026-10-31",
      contractualDueDate: "2026-11-30",
      revision: 1,
    };
    service.addFinancialItem(incoming);
    service.addFinancialItem({
      id: "outgoing",
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      accountId: "vendor",
      direction: "OUT",
      category: "hardware_cost",
      lifecycle: "INCURRED",
      netAmountKrw: "60000000",
      vatAmountKrw: "6000000",
      grossAmountKrw: "66000000",
      expectedDate: "2026-09-30",
      contractualDueDate: "2026-09-30",
      sourcePurchaseOrderId: "po",
      revision: 1,
    });

    const partial = service.recordSettlement({ id: "in-1", workspaceId: WORKSPACE, financialItemId: "incoming", direction: "IN", amountKrw: "50000000", settledAt: "2026-10-31", accountOrCard: "법인통장", evidenceRef: "bank://in-1" });
    expect(partial.financialItem.lifecycle).toBe("PARTIAL");
    service.recordSettlement({ id: "in-2", workspaceId: WORKSPACE, financialItemId: "incoming", direction: "IN", amountKrw: "60000000", settledAt: "2026-11-15", accountOrCard: "법인통장", evidenceRef: "bank://in-2" });
    service.recordSettlement({ id: "out-1", workspaceId: WORKSPACE, financialItemId: "outgoing", direction: "OUT", amountKrw: "66000000", settledAt: "2026-09-30", accountOrCard: "법인통장", evidenceRef: "bank://out-1" });

    const finance = service.financeSummary(WORKSPACE, "engagement");
    expect(finance.expectedRevenueKrw).toBe("100000000");
    expect(finance.estimateAtCompletionKrw).toBe("60000000");
    expect(finance.forecastProfitKrw).toBe("40000000");
    expect(finance.forecastMarginBps).toBe(4000);
    expect(finance.receivableKrw).toBe("0");
    expect(finance.payableKrw).toBe("0");
    expect(finance.cashPositionKrw).toBe("44000000");

    const snapshot = service.getEngagementSnapshot(WORKSPACE, "engagement");
    expect(snapshot.parties).toHaveLength(2);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.changes[0]?.status).toBe("APPLIED");
    expect(snapshot.engagement.projectKey).toBe("PRJ-2026-001");
  });

  it("keeps the same company in different roles for different engagements", () => {
    const service = new CustomerWorkOsService();
    service.createAccount({ id: "mixed", workspaceId: WORKSPACE, name: "복합 관계사", kinds: ["customer", "partner"], status: "active" });
    service.createEngagement({ id: "a", workspaceId: WORKSPACE, projectKey: "PRJ-A", name: "A", type: "opportunity", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    service.createEngagement({ id: "b", workspaceId: WORKSPACE, projectKey: "PRJ-B", name: "B", type: "opportunity", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    service.assignParty({ id: "pa", workspaceId: WORKSPACE, engagementId: "a", accountId: "mixed", role: "customer", primary: true, commercialResponsibility: true, deliveryResponsibility: false });
    service.assignParty({ id: "pb", workspaceId: WORKSPACE, engagementId: "b", accountId: "mixed", role: "partner", primary: true, commercialResponsibility: false, deliveryResponsibility: true });
    expect(service.getEngagementSnapshot(WORKSPACE, "a").parties[0]?.role).toBe("customer");
    expect(service.getEngagementSnapshot(WORKSPACE, "b").parties[0]?.role).toBe("partner");
  });

  it("fails closed on missing next action, low margin, stale binding and receipt replay", () => {
    const service = new CustomerWorkOsService();
    seed(service);

    const noAction = new CustomerWorkOsService();
    noAction.createEngagement({ id: "eng", workspaceId: WORKSPACE, projectKey: "PRJ-X", name: "X", type: "inquiry", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    expectCode(() => noAction.transitionEngagement(WORKSPACE, "eng", 1, "DISCOVERY"), "NEXT_ACTION_REQUIRED");

    const quote = createQuote(service, "low", "60000000", "65000000");
    const payload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
    const bound = approval({ id: "approve-low", resourceType: "quote", resourceId: quote.id, resourceVersion: quote.version, action: "QUOTE_APPROVE", payloadHash: customerWorkOsPayloadHash(payload) });
    expectCode(() => service.approveQuote(WORKSPACE, quote.id, quote.version, bound, 1000), "MARGIN_BELOW_FLOOR");
    const approved = service.approveQuote(WORKSPACE, quote.id, quote.version, bound, 700);
    expect(approved.status).toBe("APPROVED");

    const other = createQuote(service, "other");
    expectCode(() => service.approveQuote(WORKSPACE, other.id, other.version, bound, 1000), "REPLAYED_APPROVAL");
  });

  it("blocks over-receipt, bad VAT, orphan cost, over-settlement and duplicate reversal", () => {
    const service = new CustomerWorkOsService();
    seed(service);

    const order = service.createPurchaseOrder({ id: "po", workspaceId: WORKSPACE, engagementId: "engagement", vendorAccountId: "vendor", lines: [{ id: "line", productId: "hci", description: "HCI", quantity: 1, unitCostKrw: "60000000", receivedQuantity: 0 }] });
    const poPayload = { vendorAccountId: "vendor", totalCostKrw: "60000000", lines: order.lines };
    const approved = service.approvePurchaseOrder(WORKSPACE, order.id, order.version, approval({ id: "approve-po", resourceType: "purchase_order", resourceId: order.id, resourceVersion: order.version, action: "PURCHASE_ORDER_APPROVE", payloadHash: customerWorkOsPayloadHash(poPayload) }));
    const ordered = service.markPurchaseOrderOrdered(WORKSPACE, order.id, approved.version);
    expectCode(() => service.receivePurchaseOrderLine(WORKSPACE, order.id, ordered.version, "line", 2), "OVER_RECEIPT");

    expectCode(
      () => service.addFinancialItem({ id: "bad-vat", workspaceId: WORKSPACE, engagementId: "engagement", accountId: "customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "109", expectedDate: "2026-09-01", revision: 1 }),
      "VAT_MISMATCH",
    );
    expectCode(
      () => service.addFinancialItem({ id: "orphan", workspaceId: WORKSPACE, engagementId: null, accountId: "vendor", direction: "OUT", category: "hardware_cost", lifecycle: "PLANNED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "110", expectedDate: "2026-09-01", revision: 1 }),
      "PROJECT_BINDING_REQUIRED",
    );

    service.addFinancialItem({ id: "receivable", workspaceId: WORKSPACE, engagementId: "engagement", accountId: "customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "110", expectedDate: "2026-09-01", revision: 1 });
    expectCode(() => service.recordSettlement({ id: "too-much", workspaceId: WORKSPACE, financialItemId: "receivable", direction: "IN", amountKrw: "111", settledAt: "2026-09-01", accountOrCard: "bank", evidenceRef: "bank://too-much" }), "OVER_SETTLEMENT");

    service.recordSettlement({ id: "paid", workspaceId: WORKSPACE, financialItemId: "receivable", direction: "IN", amountKrw: "50", settledAt: "2026-09-01", accountOrCard: "bank", evidenceRef: "bank://paid" });
    service.recordSettlement({ id: "reverse", workspaceId: WORKSPACE, financialItemId: "receivable", direction: "IN", amountKrw: "50", settledAt: "2026-09-02", accountOrCard: "bank", evidenceRef: "bank://reverse", reversalOfSettlementId: "paid" });
    expectCode(() => service.recordSettlement({ id: "reverse-again", workspaceId: WORKSPACE, financialItemId: "receivable", direction: "IN", amountKrw: "50", settledAt: "2026-09-03", accountOrCard: "bank", evidenceRef: "bank://reverse-again", reversalOfSettlementId: "paid" }), "DUPLICATE_REVERSAL");
  });

  it("requires evidence for confirmed facts and isolates workspaces", () => {
    const service = new CustomerWorkOsService();
    seed(service);
    expectCode(() => service.addKnowledgeItem({ id: "fact", workspaceId: WORKSPACE, engagementId: "engagement", kind: "confirmed_fact", statement: "장비 버전은 1.0이다.", status: "CONFIRMED" }), "EVIDENCE_REQUIRED");
    expectCode(() => service.financeSummary("other-workspace", "engagement"), "CROSS_WORKSPACE");
  });
});
