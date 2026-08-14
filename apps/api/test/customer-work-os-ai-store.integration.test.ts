import { describe, expect, it } from "vitest";
import { CustomerWorkOsAiError } from "@ai-crm/ai-orchestrator/customer-work-os-ai";
import {
  CustomerWorkOsAiRuntime,
  InMemoryAiSuggestionStore,
} from "../src/customer-work-os-ai-store.js";

const WORKSPACE = "workspace-ai-store";

function proposal(id = "suggestion") {
  return {
    id,
    workspaceId: WORKSPACE,
    engagementId: "engagement",
    agentRole: "finance_guardian" as const,
    kind: "finance_risk" as const,
    title: "30일 현금 부족 위험",
    proposedPayload: { expectedIncomingKrw: "100", expectedOutgoingKrw: "200" },
    evidence: [{ sourceRef: "finance://summary", excerptDigest: "sha256:evidence" }],
    confidence: 0.98,
    risk: "HIGH" as const,
    proposedCommand: {
      command: "finance.risk_assess",
      actionType: "INTERNAL_REVERSIBLE_UPDATE",
      resourceType: "finance_risk",
      resourceId: "engagement",
      payload: { risk: "negative_cash" },
      approvalRequired: false,
      externalEffect: false,
    },
    inputDigest: "sha256:input",
    responseDigest: "sha256:response",
    modelVersion: "model-v1",
    promptVersion: "finance-v1",
    usage: { inputTokens: 100, outputTokens: 50, toolCalls: 0, retries: 0, latencyMs: 500, costMicros: 1000 },
    createdByPrincipalId: "ai-finance",
    createdAt: "2026-08-14T00:00:00Z",
    expiresAt: "2026-08-15T00:00:00Z",
  };
}

describe("CustomerWorkOsAiRuntime", () => {
  it("persists a proposal and reviews it after runtime restart", async () => {
    const store = new InMemoryAiSuggestionStore();
    const created = await new CustomerWorkOsAiRuntime(store).propose(proposal());
    expect(created.status).toBe("PROPOSED");

    const restarted = new CustomerWorkOsAiRuntime(store);
    const accepted = await restarted.review({
      workspaceId: WORKSPACE,
      suggestionId: created.id,
      expectedVersion: created.version,
      reviewerPrincipalId: "human-owner",
      reviewerKind: "HUMAN",
      decision: "ACCEPT",
      reason: "재무 원장과 근거를 확인함",
      now: "2026-08-14T01:00:00Z",
    });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.version).toBe(2);
    expect((await restarted.preparedCommand(WORKSPACE, created.id)).command).toBe("finance.risk_assess");
  });

  it("rejects AI review and creator self review", async () => {
    const store = new InMemoryAiSuggestionStore();
    const runtime = new CustomerWorkOsAiRuntime(store);
    const created = await runtime.propose(proposal());
    await expect(runtime.review({ workspaceId: WORKSPACE, suggestionId: created.id, expectedVersion: 1, reviewerPrincipalId: "other-ai", reviewerKind: "AI", decision: "ACCEPT", reason: "AI approves", now: "2026-08-14T01:00:00Z" })).rejects.toMatchObject({ code: "HUMAN_REVIEW_REQUIRED" });
    await expect(runtime.review({ workspaceId: WORKSPACE, suggestionId: created.id, expectedVersion: 1, reviewerPrincipalId: "ai-finance", reviewerKind: "HUMAN", decision: "ACCEPT", reason: "self", now: "2026-08-14T01:00:00Z" })).rejects.toMatchObject({ code: "INDEPENDENT_REVIEW_REQUIRED" });
  });

  it("rejects concurrent double decisions", async () => {
    const store = new InMemoryAiSuggestionStore();
    const first = new CustomerWorkOsAiRuntime(store);
    const second = new CustomerWorkOsAiRuntime(store);
    const created = await first.propose(proposal());
    const accepted = await first.review({ workspaceId: WORKSPACE, suggestionId: created.id, expectedVersion: 1, reviewerPrincipalId: "human-owner", reviewerKind: "HUMAN", decision: "ACCEPT", reason: "ok", now: "2026-08-14T01:00:00Z" });
    expect(accepted.status).toBe("ACCEPTED");
    await expect(second.review({ workspaceId: WORKSPACE, suggestionId: created.id, expectedVersion: 1, reviewerPrincipalId: "human-reviewer", reviewerKind: "HUMAN", decision: "REJECT", reason: "late", now: "2026-08-14T01:01:00Z" })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("expires stale proposals and never exposes a command", async () => {
    const store = new InMemoryAiSuggestionStore();
    const runtime = new CustomerWorkOsAiRuntime(store);
    const created = await runtime.propose(proposal());
    const expired = await runtime.review({ workspaceId: WORKSPACE, suggestionId: created.id, expectedVersion: 1, reviewerPrincipalId: "human-owner", reviewerKind: "HUMAN", decision: "ACCEPT", reason: "too late", now: "2026-08-16T00:00:00Z" });
    expect(expired.status).toBe("EXPIRED");
    await expect(runtime.preparedCommand(WORKSPACE, created.id)).rejects.toMatchObject({ code: "HUMAN_REVIEW_REQUIRED" });
  });

  it("keeps workspace isolation", async () => {
    const runtime = new CustomerWorkOsAiRuntime(new InMemoryAiSuggestionStore());
    await runtime.propose(proposal());
    expect(await runtime.get("another-workspace", "suggestion")).toBeUndefined();
    expect(await runtime.list("another-workspace")).toEqual([]);
  });

  it("rejects duplicate proposal ids", async () => {
    const runtime = new CustomerWorkOsAiRuntime(new InMemoryAiSuggestionStore());
    await runtime.propose(proposal());
    await expect(runtime.propose(proposal())).rejects.toBeInstanceOf(CustomerWorkOsAiError);
  });
});
