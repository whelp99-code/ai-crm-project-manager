import { describe, expect, it } from "vitest";
import { kindLabel, parseKinds, statusLabel } from "./labels";

describe("account label mapping", () => {
  it("maps the role values present in the accounts snapshot and leaves unknown values as stored", () => {
    expect(parseKinds('["customer"]').map(kindLabel)).toEqual(["고객"]);
    expect(parseKinds('["partner"]').map(kindLabel)).toEqual(["파트너"]);
    expect(parseKinds('["manufacturer"]').map(kindLabel)).toEqual(["manufacturer"]);
    expect(parseKinds('["customer","partner"]').map(kindLabel)).toEqual(["고객", "파트너"]);
  });

  it("does not invent a label when kinds is not a JSON string array", () => {
    expect(parseKinds("customer").map(kindLabel)).toEqual(["고객"]);
    expect(parseKinds("not-json").map(kindLabel)).toEqual(["not-json"]);
    expect(parseKinds('["customer",1]').map(kindLabel)).toEqual(['["customer",1]']);
  });

  it("maps only the status value present in the snapshot", () => {
    expect(statusLabel("active")).toBe("활성");
    expect(statusLabel("inactive")).toBe("inactive");
    expect(statusLabel("at_risk")).toBe("at_risk");
  });
});
