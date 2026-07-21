import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GOVERNANCE_COMMANDS } from "../src/app.js";
import { IMPORT_ACTION_TYPES } from "@ai-crm/imports";
import { ACTION_TYPES } from "@ai-crm/contracts";

/**
 * These tests never mock the registry: they assert the durable governance
 * doc (`docs/governance/action-registry.md`) textually names every command,
 * every ActionType and every import/model/connector surface actually
 * registered in code, so the doc cannot silently drift from the registry.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const actionRegistryDoc = readFileSync(
  join(currentDir, "../../../docs/governance/action-registry.md"),
  "utf8",
);

describe("governance docs consistency: action registry", () => {
  it("names every GOVERNANCE_COMMANDS key and value", () => {
    for (const [command, actionType] of Object.entries(GOVERNANCE_COMMANDS)) {
      expect(actionRegistryDoc, `missing command "${command}"`).toContain(command);
      expect(actionRegistryDoc, `missing ActionType "${actionType}" for command "${command}"`).toContain(actionType);
    }
  });

  it("names every IMPORT_ACTION_TYPES value", () => {
    for (const actionType of Object.values(IMPORT_ACTION_TYPES)) {
      expect(actionRegistryDoc, `missing import ActionType "${actionType}"`).toContain(actionType);
    }
  });

  it("names MODEL_INVOKE", () => {
    expect(actionRegistryDoc).toContain("MODEL_INVOKE");
  });

  it("names every registered ActionType from @ai-crm/contracts", () => {
    for (const actionType of ACTION_TYPES) {
      expect(actionRegistryDoc, `missing ActionType "${actionType}"`).toContain(actionType);
    }
  });

  it("states the disabled-connector confinement explicitly", () => {
    const connectorSectionMatch = actionRegistryDoc.match(
      /## 4\. Disabled connector boundary[\s\S]*?(?=\n## |$)/,
    );
    expect(connectorSectionMatch, "expected a disabled-connector section in the doc").not.toBeNull();
    const connectorSection = connectorSectionMatch![0];
    expect(connectorSection).toMatch(/connector/i);
    expect(connectorSection).toMatch(/disabled/i);
  });
});
