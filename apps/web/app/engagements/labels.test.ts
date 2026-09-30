import { describe, expect, it } from "vitest";
import { stageLabel } from "./labels";

describe("engagement stage label mapping", () => {
  it("uses the owner Notion stage name for unique codes", () => {
    expect(stageLabel("PROPOSAL")).toBe("제안/견적");
    expect(stageLabel("CONTRACTED")).toBe("고객발주");
    expect(stageLabel("BILLING")).toBe("청구/수금");
    expect(stageLabel("CLOSED")).toBe("완료");
    expect(stageLabel("ON_HOLD")).toBe("보류");
    expect(stageLabel("LOST")).toBe("실패");
  });

  it("shows the stored Notion stage instead of the code", () => {
    expect(stageLabel("DELIVERY", "매입발주")).toBe("매입발주");
    expect(stageLabel("DELIVERY", "수행/검수")).toBe("수행/검수");
    expect(stageLabel("PROPOSAL", "제안/견적")).toBe("제안/견적");
  });

  it("does not guess DELIVERY when the original stage is missing", () => {
    expect(stageLabel("DELIVERY")).toBe("수행 중");
    expect(stageLabel("DELIVERY", "  ")).toBe("수행 중");
    expect(stageLabel("ACCEPTANCE")).toBe("ACCEPTANCE");
  });
});
