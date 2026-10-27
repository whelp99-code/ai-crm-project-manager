import { describe, expect, it } from "vitest";
import { NOTION_CWOS_WORKSPACE_NAMESPACE, resolveNotionWorkspaceId } from "../src/notion-cwos.js";

const NAME = "jm-business-crm";
const VECTOR = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";

describe("resolveNotionWorkspaceId", () => {
  it("matches the dry-run UUIDv5 vector byte for byte", () => {
    expect(NOTION_CWOS_WORKSPACE_NAMESPACE).toBe("6ba7b811-9dad-11d1-80b4-00c04fd430c8");
    const resolved = resolveNotionWorkspaceId(NAME);
    expect(resolved).toEqual({ workspaceId: VECTOR, rewritten: true });
    expect(resolveNotionWorkspaceId(`  ${NAME}  `).workspaceId).toBe(VECTOR);
  });

  it("is deterministic and name-sensitive", () => {
    expect(resolveNotionWorkspaceId(NAME).workspaceId).toBe(resolveNotionWorkspaceId(NAME).workspaceId);
    expect(resolveNotionWorkspaceId("other-workspace").workspaceId).not.toBe(VECTOR);
  });

  it("passes an existing UUID through without rehashing", () => {
    const existing = "11111111-1111-4111-8111-111111111111";
    expect(resolveNotionWorkspaceId(existing)).toEqual({ workspaceId: existing, rewritten: false });
    expect(existing).not.toBe(VECTOR);
  });
});
