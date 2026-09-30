import { describe, expect, it } from "vitest";
import {
  archivedPredicate,
  engagementsSql,
  financeItemsSql,
  financeTotalsSql,
  rollupFinanceTotals,
} from "../src/readonly-lists.js";

describe("readonly finance totals query", () => {
  it("sums net, vat, and gross by direction and excludes archived rows only when the sync column exists", () => {
    expect(archivedPredicate(false, "f")).toBe("TRUE");
    expect(archivedPredicate(true, "f")).toBe("f.archived_at IS NULL");
    const sql = financeTotalsSql(true);
    expect(sql).toContain("SUM(f.net_amount_krw)");
    expect(sql).toContain("SUM(f.vat_amount_krw)");
    expect(sql).toContain("SUM(f.gross_amount_krw)");
    expect(sql).toContain("GROUP BY f.direction");
    expect(sql).toContain("f.archived_at IS NULL");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(financeTotalsSql(false)).not.toContain("archived_at");
    expect(engagementsSql(true)).toContain("e.archived_at IS NULL");
    expect(financeItemsSql(true)).toContain("f.archived_at IS NULL");
    expect(engagementsSql(false)).not.toContain("archived_at");
  });

  it("rolls query rows into IN and OUT without inventing a missing direction", () => {
    expect(rollupFinanceTotals([
      { direction: "IN", net: "9714000", vat: "971400", gross: "10685400" },
      { direction: "OUT", net: "87760000", vat: "8776000", gross: "96536000" },
    ])).toEqual({
      IN: { net: "9714000", vat: "971400", gross: "10685400" },
      OUT: { net: "87760000", vat: "8776000", gross: "96536000" },
    });
    expect(rollupFinanceTotals([])).toEqual({
      IN: { net: "0", vat: "0", gross: "0" },
      OUT: { net: "0", vat: "0", gross: "0" },
    });
  });
});
