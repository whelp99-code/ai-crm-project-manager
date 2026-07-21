import { describe, expect, it } from "vitest";
import { ACTION_TYPES } from "@ai-crm/contracts";
import { COMMAND_MAP, mapCommand, mapCommandKey, normalizeCommand } from "../src/command-map.js";

describe("MAP-U command map", () => {
  it("MAP-U-01: every map value is a registered ActionType", () => {
    const allowed = new Set<string>(ACTION_TYPES);
    for (const [command, actionType] of Object.entries(COMMAND_MAP)) {
      expect(allowed.has(actionType), `${command} → ${actionType}`).toBe(true);
    }
  });

  it("MAP-U-02: unknown strings return null", () => {
    expect(mapCommand("rm -rf /")).toBeNull();
    expect(mapCommand("finance.payment_execute")).toBeNull();
    expect(mapCommand("")).toBeNull();
    expect(mapCommand("   ")).toBeNull();
    expect(mapCommandKey("totally.unknown")).toBeNull();
  });

  it("MAP-U-03: normalize trims, lowercases, collapses whitespace", () => {
    expect(normalizeCommand("  PM.Task_Assign  ")).toBe("pm.task_assign");
    expect(normalizeCommand("pm.plan_create")).toBe("pm.plan_create");
    expect(normalizeCommand("internal.   update")).toBe("internal. update");
    expect(mapCommand("  PM.Task_Assign ")).toBe("PM_TASK_ASSIGN");
    expect(mapCommand("Pm.Plan_Revise")).toBe("PM_PLAN_REVISE");
    expect(mapCommand("pm.target_set")).toBe("PM_TARGET_SET");
    expect(mapCommand("pm.plan_create")).toBe("PM_PLAN_CREATE");
    expect(mapCommand("INTERNAL.UPDATE")).toBe("INTERNAL_REVERSIBLE_UPDATE");
  });

  it("exposes exactly the S0 five-key whitelist", () => {
    expect(Object.keys(COMMAND_MAP).sort()).toEqual(
      ["internal.update", "pm.plan_create", "pm.plan_revise", "pm.target_set", "pm.task_assign"].sort(),
    );
  });
});
