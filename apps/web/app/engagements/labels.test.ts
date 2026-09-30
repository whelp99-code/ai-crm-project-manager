import { describe, expect, it } from "vitest";
import { stageLabel } from "./labels";

describe("engagement stage label mapping", () => {
  it("uses the Korean label only when the import map is unique", () => {
    expect(stageLabel("PROPOSAL")).toBe("제안/견적");
    expect(stageLabel("CONTRACTED")).toBe("고객발주");
    expect(stageLabel("BILLING")).toBe("청구/수금");
    expect(stageLabel("CLOSED")).toBe("완료");
    expect(stageLabel("ON_HOLD")).toBe("보류");
    expect(stageLabel("LOST")).toBe("실패");
  });

  it("leaves ambiguous and unknown stages as stored", () => {
    expect(stageLabel("DELIVERY")).toBe("DELIVERY");
    expect(stageLabel("ACCEPTANCE")).toBe("ACCEPTANCE");
    expect(stageLabel("수행/검수")).toBe("수행/검수");
  });
});
