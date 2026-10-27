import { describe, expect, it } from "vitest";
import { CustomerWorkOsError } from "../src/customer-work-os.js";
import { createW01QuoteDraftStore, readMountedTemplateMeasurement, renderQuoteDraftPreview, W01QuoteDraftAdapter, type W01QuoteDraftInput } from "../src/index.js";

const input: W01QuoteDraftInput = {
  engagement: { id: "engagement", workspaceId: "workspace-1", version: 1 },
  versionLabel: "v1",
  validUntil: "2026-08-31",
  scope: "HCI 4노드 납품, 마이그레이션, 시험 및 완료보고",
  lines: [{
    id: "quote-line",
    sourceId: "quote-line",
    productId: "hci",
    description: "HCI 4노드",
    quantity: 1,
    unitCostKrw: "60000000",
    unitPriceKrw: "100000000",
    vendorAccountId: "vendor",
  }],
  options: ["고객 애플리케이션 수정"],
  templateRef: "베를로 견적서 기본양식 - 20260706.xlsx",
  templateObservation: readMountedTemplateMeasurement({
    filename: "베를로 견적서 기본양식 - 20260706.xlsx",
    bytes: 23074,
    sha256: "7fe54a33f4b2ad3179361a892fbabb5dd53588fe52e279fe2441beec49437daa",
    sheetNames: ["참고견적", "베를로 템플릿"],
    mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
    historicalCandidateId: "1ckGSGoiJ5KYi6k2LBuBssnkRV75ipGcL",
  }),
  vat: { netAmountKrw: "100000000", vatAmountKrw: "10000000", grossAmountKrw: "110000000" },
  po: { customerPoId: "quote", supplierPoId: "po" },
};

describe("W01 quote draft adapter", () => {
  it("keeps one row when a second adapter uses the same local store", () => {
    const store = createW01QuoteDraftStore();
    const first = new W01QuoteDraftAdapter(store);
    const saved = first.draft(input, "draft-quote");
    const second = new W01QuoteDraftAdapter(store);
    const replay = second.draft(input, "draft-quote");
    expect(second.rowsFor("workspace-1")).toHaveLength(1);
    expect(replay.identity).toBe(saved.identity);
    expect(replay.vat.grossAmountKrw).toBe("110000000");
    expect(replay.templateObservation?.approvalVerified).toBe(false);
    expect(replay.templateObservation?.sameHistoricalDocument).toBe(false);
  });

  it("keeps the mounted measurement distinct from the historical candidate", () => {
    const observation = readMountedTemplateMeasurement({
      filename: "베를로 견적서 기본양식 - 20260706.xlsx",
      bytes: 23074,
      sha256: "7fe54a33f4b2ad3179361a892fbabb5dd53588fe52e279fe2441beec49437daa",
      sheetNames: ["참고견적", "베를로 템플릿"],
      mountedItemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
      historicalCandidateId: "1ckGSGoiJ5KYi6k2LBuBssnkRV75ipGcL",
    });
    expect(observation.sameHistoricalDocument).toBe(false);
    expect(observation.approvalVerified).toBe(false);
    expect(() => readMountedTemplateMeasurement({
      filename: observation.filename,
      bytes: 23074,
      sha256: observation.sha256,
      sheetNames: observation.sheetNames,
      mountedItemId: observation.mountedItemId!,
      historicalCandidateId: observation.mountedItemId!,
    })).toThrow(CustomerWorkOsError);
  });

  it("keeps one draft row and the same VAT and PO identity across idempotent replays", () => {
    const adapter = new W01QuoteDraftAdapter();
    const first = adapter.draft(input, "draft-quote");
    const replay = adapter.draft(input, "draft-quote");
    const again = adapter.draft(input, "draft-quote-again");

    expect(adapter.rowsFor("workspace-1")).toHaveLength(1);
    expect(replay).toEqual(first);
    expect(again.identity).toBe(first.identity);
    expect(again.vat).toEqual(first.vat);
    expect(again.po).toEqual({ customerPoId: "quote", supplierPoId: "po" });
    expect(again.templatePreview).toEqual({ accepted: false, reason: "TEMPLATE_UNVERIFIED" });
    expect(again.templateObservation?.mountedItemId).toBe("1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-");
    expect(again.templateObservation?.mountedItemId).not.toBe("1ckGSGoiJ5KYi6k2LBuBssnkRV75ipGcL");
    expect(again.templateObservation?.sameHistoricalDocument).toBe(false);
    expect(again.templateObservation?.approvalVerified).toBe(false);
    expect(again.templateObservation?.bytes).toBe(23074);
    expect(renderQuoteDraftPreview(again)).toEqual({
      accepted: false,
      versionLabel: "v1",
      engagementVersion: 1,
      sheetNames: ["참고견적", "베를로 템플릿"],
      options: ["고객 애플리케이션 수정"],
      vat: input.vat,
      po: input.po,
      mounted: {
        itemId: "1AsMIy4982-1mlcNuUlitpMdKdGQMqq0-",
        bytes: 23074,
        sameHistoricalDocument: false,
        approvalVerified: false,
      },
    });
    expect(again.quote.versionLabel).toBe("v1");
    expect(again.engagementVersion).toBe(1);
    expect(again.options).toEqual(["고객 애플리케이션 수정"]);
    expect(again.quote.exclusions).toEqual([]);
    expect(again.quote.totalPriceKrw).toBe("100000000");
    expect(again.quote.totalCostKrw).toBe("60000000");

    const drifted: W01QuoteDraftInput = {
      ...input,
      vat: { netAmountKrw: "100000000", vatAmountKrw: "0", grossAmountKrw: "100000000" },
    };
    expect(() => adapter.draft(drifted, "draft-quote")).toThrow(CustomerWorkOsError);
    try {
      adapter.draft(drifted, "draft-quote");
    } catch (error) {
      expect((error as CustomerWorkOsError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
    expect(adapter.rowsFor("workspace-1")).toHaveLength(1);
    expect(adapter.rowsFor("workspace-1")[0]?.vat).toEqual(first.vat);
    expect(adapter.rowsFor("workspace-1")[0]?.po).toEqual(first.po);
  });
});
