import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type ApprovalReceipt,
} from "../src/customer-work-os.js";

const WORKSPACE = "workspace-hardening";

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsError);
    expect((error as CustomerWorkOsError).code).toBe(code);
  }
}

function receipt(input: Omit<ApprovalReceipt, "workspaceId" | "status" | "approvedByPrincipalId">): ApprovalReceipt {
  return { ...input, workspaceId: WORKSPACE, status: "CONSUMED", approvedByPrincipalId: "owner" };
}

function deliveryFixture(): { service: CustomerWorkOsService; projectVersion: number; engagementVersion: number } {
  const service = new CustomerWorkOsService();
  service.createAccount({ id: "customer", workspaceId: WORKSPACE, name: "고객", kinds: ["customer"], status: "active" });
  service.createAccount({ id: "vendor", workspaceId: WORKSPACE, name: "벤더", kinds: ["vendor"], status: "active" });
  service.createEngagement({ id: "eng", workspaceId: WORKSPACE, projectKey: "PRJ-HARD", name: "하드닝", type: "opportunity", stage: "DISCOVERY", health: "normal", ownerPrincipalId: "owner" });
  service.addCommitment({ id: "next", workspaceId: WORKSPACE, engagementId: "eng", ownerPrincipalId: "owner", description: "완료 후 수금 확인", dueAt: "2026-10-31", status: "OPEN", priority: 90, financialImpact: true, approvalRequired: false });
  service.recordActivity({ id: "activity", workspaceId: WORKSPACE, engagementId: "eng", type: "meeting", occurredAt: "2026-08-14T00:00:00Z", summary: "요구사항 확인", evidenceRef: "meeting://1", humanReviewed: true });
  service.addKnowledgeItem({ id: "req", workspaceId: WORKSPACE, engagementId: "eng", kind: "requirement", statement: "서비스 중단 없음", status: "CONFIRMED", evidenceRef: "meeting://1#req", sourceActivityId: "activity" });
  service.addProduct({ id: "product", workspaceId: WORKSPACE, sku: "SKU", name: "장비", kind: "hardware", defaultCostKrw: "100", defaultPriceKrw: "200", active: true });
  const quote = service.createQuote({ id: "quote", workspaceId: WORKSPACE, engagementId: "eng", versionLabel: "v1", status: "DRAFT", validUntil: "2026-09-01", bomLines: [{ id: "line", productId: "product", description: "장비", quantity: 1, unitCostKrw: "100", unitPriceKrw: "200", vendorAccountId: "vendor" }], scope: "납품", exclusions: [] });
  const quotePayload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
  const approved = service.approveQuote(WORKSPACE, quote.id, quote.version, receipt({ id: "quote-approval", resourceType: "quote", resourceId: quote.id, resourceVersion: quote.version, action: "QUOTE_APPROVE", payloadHash: customerWorkOsPayloadHash(quotePayload) }), 1000);
  service.acceptQuoteAsContract({ id: "contract", workspaceId: WORKSPACE, engagementId: "eng", quoteId: "quote", title: "계약", scope: "납품", exclusions: [], contractValueKrw: "200", effectiveFrom: "2026-08-15", billingMilestones: [{ id: "bill", name: "잔금", amountKrw: "200", trigger: "검수" }] }, approved.version);
  const project = service.handoverToDelivery({ id: "project", workspaceId: WORKSPACE, engagementId: "eng", contractId: "contract", projectKey: "PRJ-HARD", scopeBaseline: "납품", scheduleStart: "2026-08-20", scheduleEnd: "2026-09-30", requirementIds: ["req"], deliverables: [{ id: "deliverable", title: "완료보고", required: true, requirementIds: ["req"], status: "PENDING" }] });
  const withWork = service.addDeliveryWorkItem(WORKSPACE, project.id, project.version, { id: "work", title: "구축", status: "TODO", requirementIds: ["req"], deliverableId: "deliverable", estimatedHours: 8 });
  return { service, projectVersion: withWork.version, engagementVersion: service.getEngagementSnapshot(WORKSPACE, "eng").engagement.version };
}

describe("Customer Work OS hardening", () => {
  it("requires approved evidence and completed work before delivery completion", () => {
    const { service, projectVersion } = deliveryFixture();
    expectCode(() => service.proposeDeliveryCompletion(WORKSPACE, "project", projectVersion), "COMPLETION_RULE_FAILED");

    const deliverable = service.updateDeliverableStatus(WORKSPACE, "project", projectVersion, "deliverable", "APPROVED", "evidence://completion");
    expectCode(() => service.proposeDeliveryCompletion(WORKSPACE, "project", deliverable.version), "COMPLETION_RULE_FAILED");

    const work = service.updateDeliveryWorkItemStatus(WORKSPACE, "project", deliverable.version, "work", "DONE", 10);
    const proposed = service.proposeDeliveryCompletion(WORKSPACE, "project", work.version);
    expect(proposed.status).toBe("AWAITING_APPROVAL");

    const payload = { projectId: proposed.id, version: proposed.version, deliverables: proposed.deliverables, workItems: proposed.workItems };
    const completed = service.completeDelivery(
      WORKSPACE,
      proposed.id,
      proposed.version,
      receipt({ id: "complete-approval", resourceType: "delivery_project", resourceId: proposed.id, resourceVersion: proposed.version, action: "DELIVERY_COMPLETE", payloadHash: customerWorkOsPayloadHash(payload) }),
    );
    expect(completed.status).toBe("COMPLETE");
    expect(service.getEngagementSnapshot(WORKSPACE, "eng").engagement.stage).toBe("BILLING");
  });

  it("does not register more serialized assets than received quantity", () => {
    const { service } = deliveryFixture();
    const po = service.createPurchaseOrder({ id: "po", workspaceId: WORKSPACE, engagementId: "eng", vendorAccountId: "vendor", lines: [{ id: "line", productId: "product", description: "장비", quantity: 1, unitCostKrw: "100", receivedQuantity: 0 }] });
    const poPayload = { vendorAccountId: "vendor", totalCostKrw: "100", lines: po.lines };
    const approved = service.approvePurchaseOrder(WORKSPACE, po.id, po.version, receipt({ id: "po-approval", resourceType: "purchase_order", resourceId: po.id, resourceVersion: po.version, action: "PURCHASE_ORDER_APPROVE", payloadHash: customerWorkOsPayloadHash(poPayload) }));
    const ordered = service.markPurchaseOrderOrdered(WORKSPACE, po.id, approved.version);
    service.receivePurchaseOrderLine(WORKSPACE, po.id, ordered.version, "line", 1);
    service.registerAsset({ id: "asset-1", workspaceId: WORKSPACE, engagementId: "eng", customerAccountId: "customer", productId: "product", purchaseOrderId: "po", serialOrLicenseKey: "SERIAL-1", status: "DELIVERED" });
    expectCode(() => service.registerAsset({ id: "asset-2", workspaceId: WORKSPACE, engagementId: "eng", customerAccountId: "customer", productId: "product", purchaseOrderId: "po", serialOrLicenseKey: "SERIAL-2", status: "DELIVERED" }), "ASSET_QUANTITY_EXCEEDED");
  });

  it("returns a financial item to its base lifecycle after a full reversal", () => {
    const { service } = deliveryFixture();
    service.addFinancialItem({ id: "item", workspaceId: WORKSPACE, engagementId: "eng", accountId: "customer", direction: "IN", category: "contract_revenue", lifecycle: "BILLED", netAmountKrw: "100", vatAmountKrw: "10", grossAmountKrw: "110", expectedDate: "2026-09-30", revision: 1 });
    service.recordSettlement({ id: "settlement", workspaceId: WORKSPACE, financialItemId: "item", direction: "IN", amountKrw: "110", settledAt: "2026-09-30", accountOrCard: "bank", evidenceRef: "bank://settlement" });
    const reversed = service.recordSettlement({ id: "reversal", workspaceId: WORKSPACE, financialItemId: "item", direction: "IN", amountKrw: "110", settledAt: "2026-10-01", accountOrCard: "bank", evidenceRef: "bank://reversal", reversalOfSettlementId: "settlement" });
    expect(reversed.financialItem.lifecycle).toBe("BILLED");
    expect(service.financeSummary(WORKSPACE, "eng").collectedKrw).toBe("0");
  });

  it("blocks closing while commitments or finance remain open", () => {
    const { service } = deliveryFixture();
    const snapshot = service.getEngagementSnapshot(WORKSPACE, "eng");
    expectCode(() => service.closeEngagement(WORKSPACE, "eng", snapshot.engagement.version, receipt({ id: "close", resourceType: "engagement", resourceId: "eng", resourceVersion: snapshot.engagement.version, action: "ENGAGEMENT_CLOSE", payloadHash: "wrong" })), "INVALID_STAGE");
  });
});
