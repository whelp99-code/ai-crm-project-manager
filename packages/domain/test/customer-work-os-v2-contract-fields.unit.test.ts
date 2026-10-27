import { describe, expect, it } from "vitest";
import { compareW05ContractDraft, type W05ContractDraft } from "../src/customer-work-os-v2/index.js";

const draft: W05ContractDraft = {
  source: { kind: "OWNER_INPUT", id: "fixture", version: null, reference: "fixture document",
    terms: { startDate: "2026-01-01", endDate: "2026-12-31", valueKrw: "100000000",
      items: [{ id: "license", description: "License", quantity: 1, unitPriceKrw: "100000000" }],
      conditions: ["Annual maintenance"] } },
  terms: { startDate: "2027-01-01", endDate: "2027-12-31", valueKrw: "110000000",
    items: [{ id: "license", description: "Renewed license", quantity: 2, unitPriceKrw: "100000000" }],
    conditions: ["New maintenance terms"] },
};

describe("source-bound contract field comparison", () => {
  it("finds the four changed categories without modifying either snapshot", () => {
    const before = structuredClone(draft);
    expect(compareW05ContractDraft(draft)).toEqual({
      fields: ["period", "amount", "items", "conditions"].map(key => ({ key, status: "CHANGED" })),
      amountDeltaKrw: "10000000",
    });
    expect(draft).toEqual(before);
  });

  it("does not flag ordering or integer formatting as a changed contract", () => {
    const same = structuredClone(draft);
    same.terms = { ...structuredClone(same.source.terms), valueKrw: "000100000000" };
    same.source.terms.items?.push({ id: "support", description: "Support", quantity: 1, unitPriceKrw: "0" });
    same.terms.items = [...(same.source.terms.items ?? [])].reverse();
    same.source.terms.conditions = ["Annual maintenance", "Support"];
    same.terms.conditions = ["Support", "Annual maintenance"];
    expect(compareW05ContractDraft(same).fields.every(field => field.status === "UNCHANGED")).toBe(true);
  });

  it("keeps unknown originals unknown rather than guessing no change", () => {
    const unknown = structuredClone(draft);
    unknown.source.terms = { startDate: null, endDate: null, valueKrw: null, items: null, conditions: null };
    expect(compareW05ContractDraft(unknown)).toEqual({
      fields: ["period", "amount", "items", "conditions"].map(key => ({ key, status: "UNKNOWN" })),
      amountDeltaKrw: null,
    });
  });

  it("computes large decreases with exact integer KRW", () => {
    const large = structuredClone(draft);
    large.source.terms.valueKrw = "900719925474099312345";
    large.terms.valueKrw = "900719925474099312344";
    expect(compareW05ContractDraft(large).amountDeltaKrw).toBe("-1");
  });
});
