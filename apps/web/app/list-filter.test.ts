import { describe, expect, it } from "vitest";
import { filterByQuery } from "./list-filter";

describe("filterByQuery", () => {
  const names = ["GS건설", "DRB동일", "gsitm"];

  it("returns every index when the query is blank", () => {
    expect(filterByQuery(names, "  ")).toEqual([0, 1, 2]);
  });

  it("matches a case-insensitive substring and keeps source order", () => {
    expect(filterByQuery(names, "gs")).toEqual([0, 2]);
    expect(filterByQuery(names, "동일")).toEqual([1]);
  });

  it("returns nothing when no name contains the query", () => {
    expect(filterByQuery(names, "없는이름")).toEqual([]);
  });
});
