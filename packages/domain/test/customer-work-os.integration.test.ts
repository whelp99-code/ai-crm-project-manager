import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type ApprovalReceipt,
  type FinancialItem,
} from "../src/customer-work-os.js";

const WORKSPACE = "workspace-1";

function receipt(input: Omit<ApprovalReceipt, "workspaceId" | "status" | "approvedByPrincipalId">): ApprovalReceipt {
  return {
    ...input,
    workspaceId: WORKSPACE,
    status: "CONSUMED",
    approvedByPrincipalId: "owner-1",
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsError);
    expect((error as CustomerWorkOsError).code).toBe(code);
  }
}

function seedCore(service: CustomerWorkOsService): void {
  service.createAccount({
    id: "account-customer",
    workspaceId: WORKSPACE,
    name: "선진엔지니어링",
    kinds: ["customer"],
    status: "active",
  });
  service.createAccount({
    id: "account-vendor",
    workspaceId: WORKSPACE,
    name: "총판 A",
    kinds: ["vendor", "partner"],
    status: "active",
  });
  service.createAccount({
    id: "account-maker",
    workspaceId: WORKSPACE,
    name: "HCI 제조사",
    kinds: ["manufacturer"],
    status: "active",
  });
  service.addContact({
    id: "contact-1",
    workspaceId: WORKSPACE,
    accountId: "account-customer",
    name: "홍길동",
    title: "IT 팀장",
    email: "hong@example.com",
    stakeholderRole: "decision_maker",
  });
  service.createEngagement({
    id: "engagement-1",
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
  service.assignParty({
    id: "party-customer",
    workspaceId: WORKSPACE,
    engagementId: "engagement-1",
    accountId: "account-customer",
    role: "customer",
    primary: true,
    commercialResponsibility: true,
    deliveryResponsibility: false,
  });
  service.assignParty({
    id: "party-vendor",
    workspaceId: WORKSPACE,
    engagementId: "engagement-1",
    accountId: "account-vendor",
    role: "vendor",
    primary: true,
    commercialResponsibility: true,
    deliveryResponsibility: true,
  });
  service.recordActivity({
    id: "activity-1",
    workspaceId: WORKSPACE,
    engagementId: "engagement-1",
    accountId: "account-customer",
    type: "meeting",
    occurredAt: "2026-08-14T01:00:00.000Z",
    summary: "HCI 교체와 10월 검수 요구 확인",
    evidenceRef: "meeting://2026-08-14/1",
    humanReviewed: true,
  });
  service.addKnowledgeItem({
    id: "req-1",
    workspaceId: WORKSPACE,
    engagementId: "engagement-1",
    kind: "requirement",
    statement: "기존 서비스 중단 없이 HCI를 교체한다.",
    status: "CONFIRMED",
    evidenceRef: "meeting://2026-08-14/1#requirement-1",
    sourceActivityId: "activity-1",
  });
  service.addCommitment({
    id: "commitment-1",
    workspaceId: WORKSPACE,
    engagementId: "engagement-1",
    sourceActivityId: "activity-1",
    ownerPrincipalId: "owner-1",
    counterpartyAccountId: "account-customer",
    description: "수정 견적서를 전달한다.",
    dueAt: "2026-08-18",
    status: "OPEN",
    priority: 90,
    financialImpact: true,
    approvalRequired: true,
  });
  service.addProduct({
    id: "product-hci",
    workspaceId: WORKSPACE,
    sku: "HCI-4NODE",
    name: "4노드 HCI",
    kind: "hardware",
    manufacturerAccountId: "account-maker",
    defaultCostKrw: "60000000",
    defaultPriceKrw: "100000000",
    active: true,
  });
}

describe("CustomerWorkOsService integrated CRM/CPQ/PSA/ERP flow", () => {
  it("connects opportunity, quote, contract, delivery, procurement, asset and project finance by one project key", () => {
    const service = new CustomerWorkOsService();
    seedCore(service);

    const draft = service.createQuote({
      id: "quote-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      versionLabel: "v1",
      status: "DRAFT",
      validUntil: "2026-08-31",
      scope: "HCI 4노드 납품, 마이그레이션, 시험 및 완료보고",
      exclusions: ["고객 애플리케이션 수정"],
      bomLines: [
        {
          id: "bom-1",
          productId: "product-hci",
          description: "HCI 4노드",
          quantity: 1,
          unitCostKrw: "60000000",
          unitPriceKrw: "100000000",
          vendorAccountId: "account-vendor",
        },
      ],
    });
    expect(draft.totalCostKrw).toBe("60000000");
    expect(draft.totalPriceKrw).toBe("100000000");
    expect(draft.marginBps).toBe(4000);

    const quotePayload = {
      totalCostKrw: draft.totalCostKrw,
      totalPriceKrw: draft.totalPriceKrw,
      marginBps: draft.marginBps,
      scope: draft.scope,
    };
    const approvedQuote = service.approveQuote(
      WORKSPACE,
      draft.id,
      draft.version,
      receipt({
        id: "approval-quote-1",
        resourceType: "quote",
        resourceId: draft.id,
        resourceVersion: draft.version,
        action: "QUOTE_APPROVE",
        payloadHash: customerWorkOsPayloadHash(quotePayload),
      }),
      2000,
    );
    expect(approvedQuote.status).toBe("APPROVED");

    const accepted = service.acceptQuoteAsContract(
      {
        id: "contract-1",
        workspaceId: WORKSPACE,
        engagementId: "engagement-1",
        quoteId: "quote-1",
        title: "HCI 구축 계약",
        scope: draft.scope,
        exclusions: draft.exclusions,
        contractValueKrw: "100000000",
        effectiveFrom: "2026-08-20",
        effectiveTo: "2026-10-31",
        billingMilestones: [
          { id: "billing-1", name: "계약금", amountKrw: "30000000", trigger: "계약", expectedDate: "2026-08-25" },
          { id: "billing-2", name: "잔금", amountKrw: "70000000", trigger: "검수", expectedDate: "2026-10-31" },
        ],
      },
      approvedQuote.version,
    );
    expect(accepted.engagement.stage).toBe("CONTRACTED");

    const delivery = service.handoverToDelivery({
      id: "delivery-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      contractId: "contract-1",
      projectKey: "PRJ-2026-001",
      scopeBaseline: draft.scope,
      scheduleStart: "2026-08-25",
      scheduleEnd: "2026-10-31",
      requirementIds: ["req-1"],
      deliverables: [
        {
          id: "deliverable-1",
          title: "완료보고서",
          required: true,
          requirementIds: ["req-1"],
          status: "PENDING",
        },
      ],
    });
    expect(delivery.projectKey).toBe("PRJ-2026-001");

    const change = service.proposeChangeRequest({
      id: "change-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      deliveryProjectId: "delivery-1",
      sourceActivityId: "activity-1",
      description: "지사 장비 로그 연동 추가",
      scopeImpact: "지사 로그 연동과 시험을 범위에 추가",
      scheduleImpactDays: 3,
      costImpactKrw: "2000000",
      priceImpactKrw: "4000000",
    });
    const changePayload = {
      disposition: "ADDITIONAL_QUOTE",
      scopeImpact: change.scopeImpact,
      scheduleImpactDays: change.scheduleImpactDays,
      costImpactKrw: change.costImpactKrw,
      priceImpactKrw: change.priceImpactKrw,
    };
    const approvedChange = service.approveChangeRequest(
      WORKSPACE,
      change.id,
      change.version,
      "ADDITIONAL_QUOTE",
      receipt({
        id: "approval-change-1",
        resourceType: "change_request",
        resourceId: change.id,
        resourceVersion: change.version,
        action: "CHANGE_REQUEST_APPROVE",
        payloadHash: customerWorkOsPayloadHash(changePayload),
      }),
    );
    expect(approvedChange.status).toBe("APPROVED");
    const applied = service.applyChangeRequest(WORKSPACE, change.id, approvedChange.version);
    expect(applied.project.scheduleEnd).toBe("2026-11-03");

    const order = service.createPurchaseOrder({
      id: "po-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      vendorAccountId: "account-vendor",
      expectedDate: "2026-09-10",
      lines: [
        {
          id: "po-line-1",
          productId: "product-hci",
          description: "HCI 4노드",
          quantity: 1,
          unitCostKrw: "60000000",
          receivedQuantity: 0,
        },
      ],
    });
    const poPayload = {
      vendorAccountId: order.vendorAccountId,
      totalCostKrw: "60000000",
      lines: order.lines,
    };
    const approvedOrder = service.approvePurchaseOrder(
      WORKSPACE,
      order.id,
      order.version,
      receipt({
        id: "approval-po-1",
        resourceType: "purchase_order",
        resourceId: order.id,
        resourceVersion: order.version,
        action: "PURCHASE_ORDER_APPROVE",
        payloadHash: customerWorkOsPayloadHash(poPayload),
      }),
    );
    const ordered = service.markPurchaseOrderOrdered(WORKSPACE, order.id, approvedOrder.version);
    const received = service.receivePurchaseOrderLine(WORKSPACE, order.id, ordered.version, "po-line-1", 1);
    expect(received.status).toBe("RECEIVED");

    const asset = service.registerAsset({
      id: "asset-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      customerAccountId: "account-customer",
      productId: "product-hci",
      purchaseOrderId: "po-1",
      serialOrLicenseKey: "HCI-SERIAL-0001",
      status: "DELIVERED",
      deliveredAt: "2026-09-10",
      warrantyEnd: "2029-09-09",
      renewalDate: "2029-08-10",
    });
    expect(asset.status).toBe("DELIVERED");

    const receivable: FinancialItem = {
      id: "fin-in-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      accountId: "account-customer",
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
    service.addFinancialItem(receivable);
    service.addFinancialItem({
      id: "fin-out-1",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      accountId: "account-vendor",
      direction: "OUT",
      category: "hardware_cost",
      lifecycle: "INCURRED",
      netAmountKrw: "60000000",
      vatAmountKrw: "6000000",
      grossAmountKrw: "66000000",
      expectedDate: "2026-09-30",
      contractualDueDate: "2026-09-30",
      sourcePurchaseOrderId: "po-1",
      revision: 1,
    });

    const partial = service.recordSettlement({
      id: "settlement-in-1",
      workspaceId: WORKSPACE,
      financialItemId: "fin-in-1",
      direction: "IN",
      amountKrw: "50000000",
      settledAt: "2026-10-31",
      accountOrCard: "법인통장",
      evidenceRef: "bank://2026-10-31/1",
    });
    expect(partial.financialItem.lifecycle).toBe("PARTIAL");
    service.recordSettlement({
      id: "settlement-in-2",
      workspaceId: WORKSPACE,
      financialItemId: "fin-in-1",
      direction: "IN",
      amountKrw: "60000000",
      settledAt: "2026-11-15",
      accountOrCard: "법인통장",
      evidenceRef: "bank://2026-11-15/1",
    });
    service.recordSettlement({
      id: "settlement-out-1",
      workspaceId: WORKSPACE,
      financialItemId: "fin-out-1",
      direction: "OUT",
      amountKrw: "66000000",
      settledAt: "2026-09-30",
      accountOrCard: "법인통장",
      evidenceRef: "bank://2026-09-30/1",
    });

    const finance = service.financeSummary(WORKSPACE, "engagement-1");
    expect(finance.expectedRevenueKrw).toBe("100000000");
    expect(finance.estimateAtCompletionKrw).toBe("60000000");
    expect(finance.forecastProfitKrw).toBe("40000000");
    expect(finance.forecastMarginBps).toBe(4000);
    expect(finance.receivableKrw).toBe("0");
    expect(finance.payableKrw).toBe("0");
    expect(finance.cashPositionKrw).toBe("44000000");

    const snapshot = service.getEngagementSnapshot(WORKSPACE, "engagement-1");
    expect(snapshot.engagement.projectKey).toBe("PRJ-2026-001");
    expect(snapshot.parties).toHaveLength(2);
    expect(snapshot.assets).toHaveLength(1);
    expect(snapshot.changeRequests[0]?.status).toBe("APPLIED");
  });

  it("keeps account roles engagement-specific rather than permanently classifying a company", () => {
    const service = new CustomerWorkOsService();
    service.createAccount({ id: "account-a", workspaceId: WORKSPACE, name: "복합 관계사", kinds: ["customer", "partner"], status: "active" });
    service.createEngagement({ id: "eng-a", workspaceId: WORKSPACE, projectKey: "PRJ-A", name: "A 사업", type: "opportunity", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    service.createEngagement({ id: "eng-b", workspaceId: WORKSPACE, projectKey: "PRJ-B", name: "B 사업", type: "opportunity", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    service.assignParty({ id: "party-a", workspaceId: WORKSPACE, engagementId: "eng-a", accountId: "account-a", role: "customer", primary: true, commercialResponsibility: true, deliveryResponsibility: false });
    service.assignParty({ id: "party-b", workspaceId: WORKSPACE, engagementId: "eng-b", accountId: "account-a", role: "partner", primary: true, commercialResponsibility: false, deliveryResponsibility: true });
    expect(service.getEngagementSnapshot(WORKSPACE, "eng-a").parties[0]?.role).toBe("customer");
    expect(service.getEngagementSnapshot(WORKSPACE, "eng-b").parties[0]?.role).toBe("partner");
  });

  it("fails closed on no next action, low margin, stale approval and approval replay", () => {
    const service = new CustomerWorkOsService();
    seedCore(service);

    const withoutAction = new CustomerWorkOsService();
    withoutAction.createEngagement({ id: "eng", workspaceId: WORKSPACE, projectKey: "PRJ-X", name: "X", type: "inquiry", stage: "INQUIRY", health: "normal", ownerPrincipalId: "owner" });
    expectCode(() => withoutAction.transitionEngagement(WORKSPACE, "eng", 1, "DISCOVERY"), "NEXT_ACTION_REQUIRED");

    const quote = service.createQuote({
      id: "quote-low",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      versionLabel: "v1",
      status: "DRAFT",
      validUntil: "2026-08-31",
      scope: "저마진 제안",
      exclusions: [],
      bomLines: [{ id: "line", productId: "product-hci", description: "HCI", quantity: 1, unitCostKrw: "60000000", unitPriceKrw: "65000000", vendorAccountId: "account-vendor" }],
    });
    const quotePayload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
    const approval = receipt({ id: "approval-low", resourceType: "quote", resourceId: quote.id, resourceVersion: quote.version, action: "QUOTE_APPROVE", payloadHash: customerWorkOsPayloadHash(quotePayload) });
    expectCode(() => service.approveQuote(WORKSPACE, quote.id, quote.version, approval, 1000), "MARGIN_BELOW_FLOOR");

    const allowed = service.approveQuote(WORKSPACE, quote.id, quote.version, approval, 700);
    expect(allowed.status).toBe("APPROVED");
    expectCode(() => service.approveQuote(WORKSPACE, quote.id, allowed.version, approval, 700), "INVALID_STATE");

    const other = service.createQuote({
      id: "quote-other",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      versionLabel: "v2",
      status: "DRAFT",
      validUntil: "2026-09-30",
      scope: "다른 제안",
      exclusions: [],
      bomLines: [{ id: "line2", productId: "product-hci", description: "HCI", quantity: 1, unitCostKrw: "60000000", unitPriceKrw: "100000000", vendorAccountId: "account-vendor" }],
    });
    expectCode(() => service.approveQuote(WORKSPACE, other.id, other.version, approval, 1000), "REPLAYED_APPROVAL");
  });

  it("rejects over-receipt, malformed VAT, unbound project cost and over-settlement", () => {
    const service = new CustomerWorkOsService();
    seedCore(service);

    const order = service.createPurchaseOrder({
      id: "po",
      workspaceId: WORKSPACE,
      engagementId: "engagement-1",
      vendorAccountId: "account-vendor",
      lines: [{ id: "line", productId: "product-hci", description: "HCI", quantity: 1, unitCostKrw: "60000000", receivedQuantity: 0 }],
    });
    const poPayload = { vendorAccountId: order.vendorAccountId, totalCostKrw: "60000000", lines: order.lines };
    const approved = service.approvePurchaseOrder(WORKSPACE, order.id, order.version, receipt({ id: "approve-po", resourceType: "purchase_order", resourceId: order.id, resourceVersion: order.version, action: "PURCHASE_ORDER_APPROVE", payloadHash: customerWorkOsPayloadHash(poPayload) }));
    const ordered = service.markPurchaseOrderOrdered(WORKSPACE, order.id, approved.version);
    expectCode(() => service.receivePurchaseOrderLine(WORKSPACE, order.id, ordered.version, "line", 2), "OVER_RECEIPT");

    expectCode(
      () => service.addFinancialItem({ id: "bad-vat", workspaceId: WORKSPACE, engagementId: "engagement-1", accountId: "account-customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "109", expectedDate: "2026-09-01", revision: 1 }),
      "VAT_MISMATCH",
    );
    expectCode(
      () => service.addFinancialItem({ id: "orphan", workspaceId: WORKSPACE, accountId: "account-vendor", direction: "OUT", category: "hardware_cost", lifecycle: "PLANNED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "110", expectedDate: "2026-09-01", revision: 1 }),
      "PROJECT_BINDING_REQUIRED",
    );

    service.addFinancialItem({ id: "receivable", workspaceId: WORKSPACE, engagementId: "engagement-1", accountId: "account-customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "110", expectedDate: "2026-09-01", revision: 1 });
    expectCode(
      () => service.recordSettlement({ id: "too-much", workspaceId: WORKSPACE, financialItemId: "receivable", direction: "IN", amountKrw: "111", settledAt: "2026-09-01", accountOrCard: "bank", evidenceRef: "bank://1" }),
      "OVER_SETTLEMENT",
    );
  });

  it("does not allow confirmed knowledge without evidence or cross-workspace access", () => {
    const service = new CustomerWorkOsService();
    seedCore(service);
    expectCode(
      () => service.addKnowledgeItem({ id: "fact-no-evidence", workspaceId: WORKSPACE, engagementId: "engagement-1", kind: "confirmed_fact", statement: "장비 버전은 1.0이다.", status: "CONFIRMED" }),
      "EVIDENCE_REQUIRED",
    );
    expectCode(() => service.financeSummary("workspace-2", "engagement-1"), "CROSS_WORKSPACE");
  });
});
