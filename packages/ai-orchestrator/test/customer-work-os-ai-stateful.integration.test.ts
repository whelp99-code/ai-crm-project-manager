import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsAiError,
  CustomerWorkOsAiService,
  type AiSuggestion,
} from "../src/customer-work-os-ai-stateful.js";

function suggestion(overrides: Partial<AiSuggestion> = {}): AiSuggestion {
  return {
    id: "suggestion-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    agentRole: "capture_understand",
    kind: "knowledge_item",
    title: "요구사항 후보",
    proposedPayload: { statement: "무중단 전환" },
    evidence: [{ sourceRef: "mail://1", excerptDigest: "sha256:evidence" }],
    confidence: 0.8,
    risk: "MEDIUM",
    status: "PROPOSED",
    requiresHumanReview: true,
    inputDigest: "sha256:input",
    responseDigest: "sha256:response",
    modelVersion: "model-v1",
    promptVersion: "prompt-v1",
    usage: { inputTokens: 10, outputTokens: 5, toolCalls: 0, retries: 0, latencyMs: 25, costMicros: 100 },
    createdByPrincipalId: "ai-1",
    createdAt: "2026-08-14T00:00:00.000Z",
    expiresAt: "2026-08-14T01:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("Customer Work OS AI state hydration", () => {
  it("restores persisted suggestions and exports detached state", () => {
    const service = new CustomerWorkOsAiService();
    service.hydrate([suggestion()]);
    const exported = service.exportState();
    exported[0]!.title = "변조";

    expect(service.get("11111111-1111-4111-8111-111111111111", "suggestion-1").title).toBe("요구사항 후보");
  });

  it("validates all candidates before replacing current state", () => {
    const service = new CustomerWorkOsAiService();
    service.hydrate([suggestion()]);
    const duplicate = suggestion({ title: "중복" });

    expect(() => service.hydrate([suggestion(), duplicate])).toThrowError(CustomerWorkOsAiError);
    expect(service.exportState()).toHaveLength(1);
    expect(service.exportState()[0]?.title).toBe("요구사항 후보");
  });

  it("rejects a persisted creator self-review", () => {
    const service = new CustomerWorkOsAiService();
    expect(() => service.hydrate([suggestion({
      status: "ACCEPTED",
      reviewedByPrincipalId: "ai-1",
      reviewReason: "self",
      version: 2,
    })])).toMatchObject({ code: "INVALID_STATE" });
  });
});
