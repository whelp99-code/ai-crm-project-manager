import { describe, expect, it } from "vitest";
import { directionLabel, formatKrw } from "./labels";

describe("finance label and amount formatting", () => {
  it("maps import directions and leaves unknown values as stored", () => {
    expect(directionLabel("IN")).toBe("매출");
    expect(directionLabel("OUT")).toBe("매입");
    expect(directionLabel("OTHER")).toBe("OTHER");
  });

  it("formats integer won with grouping and does not invent a number for non-integers", () => {
    expect(formatKrw("9714000")).toBe("9,714,000");
    expect(formatKrw("971400")).toBe("971,400");
    expect(formatKrw("10685400")).toBe("10,685,400");
    expect(formatKrw("87760000")).toBe("87,760,000");
    expect(formatKrw("96536000")).toBe("96,536,000");
    expect(formatKrw("0")).toBe("0");
    expect(formatKrw("12.5")).toBe("12.5");
  });
});
