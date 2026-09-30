import { describe, expect, it } from "vitest";
import { stageLabel } from "./labels";

describe("engagement stage label mapping", () => {
  it("uses the owner Notion stage name for codes present in the project list", () => {
    expect(stageLabel("PROPOSAL")).toBe("제안/견적");
    expect(stageLabel("CONTRACTED")).toBe("고객발주");
    expect(stageLabel("BILLING")).toBe("청구/수금");
    expect(stageLabel("CLOSED")).toBe("완료");
    expect(stageLabel("ON_HOLD")).toBe("보류");
    expect(stageLabel("LOST")).toBe("실패");
  });

  it("labels DELIVERY with the owner Notion stage that the code stands for", () => {
    expect(stageLabel("DELIVERY")).toBe("수행/검수");
  });

  it("leaves unknown stages as stored", () => {
    expect(stageLabel("ACCEPTANCE")).toBe("ACCEPTANCE");
    expect(stageLabel("NOT_A_STAGE")).toBe("NOT_A_STAGE");
  });
});
