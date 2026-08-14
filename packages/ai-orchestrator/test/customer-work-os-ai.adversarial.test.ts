import { describe, expect, it } from "vitest";
import {
  CustomerWorkOsAiError,
  CustomerWorkOsAiService,
  type StructuredAnalysisRequest,
  type StructuredAnalyzer,
} from "../src/customer-work-os-ai.js";

const WORKSPACE = "workspace-ai";

function request(overrides: Partial<StructuredAnalysisRequest> = {}): StructuredAnalysisRequest {
  return {
    workspaceId: WORKSPACE,
    operationId: "capture.activity",
    agentRole: "capture_understand",
    promptVersion: "capture-v1",
    modelTier: "L1",
    context: {
      workspaceId: WORKSPACE,
      engagementId: "engagement",
      facts: [{ id: "fact", statement: "고객은 HCI 교체를 요청했다.", status: "CONFIRMED", evidence: [{ sourceRef: "mail://1", excerptDigest: "sha256:a" }] }],
      openCommitments: [],
      recentChanges: [],
      artifactRefs: [],
      generatedAt: "2026-08-14T00:00:00Z",
      contentHash: "sha256:context",
    },
    inputRef: "mail://1",
    outputSchemaVersion: "activity-extract-v1",
    budget: { maxInputTokens: 1000, maxOutputTokens: 500, maxToolCalls: 2, maxRetries: 1, maxLatencyMs: 5000, maxCostMicros: 10000 },
    correlationId: "correlation-1",
    ...overrides,
  };
}

function analyzer(usage = { inputTokens: 100, outputTokens: 50, toolCalls: 0, retries: 0, latencyMs: 500, costMicros: 1000 }): StructuredAnalyzer {
  return {
    async analyze() {
      return { output: { summary: "HCI 교체 요청" }, usage, modelVersion: "small-model-v1", responseDigest: "sha256:response" };
    },
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkOsAiError);
    expect((error as CustomerWorkOsAiError).code).toBe(code);
  }
}

describe("CustomerWorkOsAiService", () => {
  it("creates an evidence-backed suggestion and requires review before command preparation", async () => {
    const service = new CustomerWorkOsAiService();
    const suggestion = await service.analyzeAndPropose(
      analyzer(),
      request(),
      () => ({
        id: "suggestion-1",
        engagementId: "engagement",
        kind: "activity_extract",
        title: "고객 이메일을 활동으로 등록",
        proposedPayload: { summary: "HCI 교체 요청" },
        evidence: [{ sourceRef: "mail://1", start: 0, end: 10, excerptDigest: "sha256:excerpt" }],
        confidence: 0.96,
        risk: "LOW",
        proposedCommand: {
          command: "crm.activity_extract",
          actionType: "INTERNAL_REVERSIBLE_UPDATE",
          resourceType: "activity",
          payload: { summary: "HCI 교체 요청" },
          approvalRequired: true,
          externalEffect: false,
        },
        expiresAt: "2026-08-15T00:00:00Z",
      }),
      "ai-capture",
      "2026-08-14T00:00:00Z",
    );
    expect(suggestion.status).toBe("PROPOSED");
    expect(suggestion.requiresHumanReview).toBe(true);
    expectCode(() => service.preparedCommand(WORKSPACE, suggestion.id), "HUMAN_REVIEW_REQUIRED");

    const accepted = service.review(WORKSPACE, suggestion.id, suggestion.version, "owner", "ACCEPT", "메일 원문과 일치함", "2026-08-14T01:00:00Z");
    expect(accepted.status).toBe("ACCEPTED");
    expect(service.preparedCommand(WORKSPACE, suggestion.id).command).toBe("crm.activity_extract");
  });

  it("deduplicates identical context and input analysis", async () => {
    const service = new CustomerWorkOsAiService();
    let calls = 0;
    const counting: StructuredAnalyzer = {
      async analyze() {
        calls += 1;
        return analyzer().analyze(request());
      },
    };
    const proposal = () => ({
      id: "suggestion-cache",
      engagementId: "engagement",
      kind: "finance_risk" as const,
      title: "현금 위험",
      proposedPayload: { risk: false },
      evidence: [{ sourceRef: "finance://summary", excerptDigest: "sha256:finance" }],
      confidence: 0.99,
      risk: "LOW" as const,
      expiresAt: "2026-08-15T00:00:00Z",
    });
    const first = await service.analyzeAndPropose(counting, request(), proposal, "ai-finance", "2026-08-14T00:00:00Z");
    const second = await service.analyzeAndPropose(counting, request(), proposal, "ai-finance", "2026-08-14T00:00:01Z");
    expect(second.id).toBe(first.id);
    expect(calls).toBe(1);
  });

  it("fails closed when evidence is absent or a command is not allowlisted", () => {
    const service = new CustomerWorkOsAiService();
    expectCode(
      () => service.propose({
        id: "no-evidence",
        workspaceId: WORKSPACE,
        agentRole: "deal_architect",
        kind: "deal_score",
        title: "수주 점수",
        proposedPayload: {},
        evidence: [],
        confidence: 0.9,
        risk: "LOW",
        inputDigest: "sha256:input",
        responseDigest: "sha256:response",
        modelVersion: "model",
        promptVersion: "prompt",
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 1 },
        createdByPrincipalId: "ai",
        createdAt: "2026-08-14T00:00:00Z",
        expiresAt: "2026-08-15T00:00:00Z",
      }),
      "EVIDENCE_REQUIRED",
    );
    expectCode(
      () => service.propose({
        id: "malicious-command",
        workspaceId: WORKSPACE,
        agentRole: "capture_understand",
        kind: "activity_extract",
        title: "임의 명령",
        proposedPayload: {},
        evidence: [{ sourceRef: "mail://1", excerptDigest: "sha256:e" }],
        confidence: 0.99,
        risk: "LOW",
        proposedCommand: { command: "shell.exec", actionType: "EXECUTE", resourceType: "shell", payload: { command: "rm -rf /" }, approvalRequired: false, externalEffect: true },
        inputDigest: "sha256:input",
        responseDigest: "sha256:response",
        modelVersion: "model",
        promptVersion: "prompt",
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 1 },
        createdByPrincipalId: "ai",
        createdAt: "2026-08-14T00:00:00Z",
        expiresAt: "2026-08-15T00:00:00Z",
      }),
      "COMMAND_NOT_ALLOWLISTED",
    );
  });

  it("stops when token, tool, latency or cost budgets are exceeded", async () => {
    const cases = [
      { inputTokens: 1001, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 1, code: "BUDGET_EXHAUSTED" },
      { inputTokens: 1, outputTokens: 501, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 1, code: "BUDGET_EXHAUSTED" },
      { inputTokens: 1, outputTokens: 1, toolCalls: 3, retries: 0, latencyMs: 1, costMicros: 1, code: "BUDGET_EXHAUSTED" },
      { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 2, latencyMs: 1, costMicros: 1, code: "BUDGET_EXHAUSTED" },
      { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 5001, costMicros: 1, code: "TIMEOUT" },
      { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 10001, code: "BUDGET_EXHAUSTED" },
    ];
    for (const [index, item] of cases.entries()) {
      const service = new CustomerWorkOsAiService();
      await expect(
        service.analyzeAndPropose(
          analyzer(item),
          request(),
          () => ({ id: `budget-${index}`, kind: "executive_brief", title: "브리핑", proposedPayload: {}, evidence: [{ sourceRef: "data://1", excerptDigest: "sha256:e" }], confidence: 0.9, risk: "LOW", expiresAt: "2026-08-15T00:00:00Z" }),
          "ai",
          "2026-08-14T00:00:00Z",
        ),
      ).rejects.toMatchObject({ code: item.code });
    }
  });

  it("expires stale suggestions and never silently executes external effects", () => {
    const service = new CustomerWorkOsAiService();
    const suggestion = service.propose({
      id: "email",
      workspaceId: WORKSPACE,
      agentRole: "relationship_renewal",
      kind: "renewal_opportunity",
      title: "갱신 안내 메일",
      proposedPayload: {},
      evidence: [{ sourceRef: "contract://1", excerptDigest: "sha256:c" }],
      confidence: 0.99,
      risk: "MEDIUM",
      proposedCommand: { command: "external.email_send", actionType: "EMAIL_SEND", resourceType: "email", payload: { subject: "갱신 안내" }, approvalRequired: true, externalEffect: true },
      inputDigest: "sha256:input",
      responseDigest: "sha256:response",
      modelVersion: "model",
      promptVersion: "prompt",
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0, retries: 0, latencyMs: 1, costMicros: 1 },
      createdByPrincipalId: "ai",
      createdAt: "2026-08-14T00:00:00Z",
      expiresAt: "2026-08-14T01:00:00Z",
    });
    const expired = service.review(WORKSPACE, suggestion.id, suggestion.version, "owner", "ACCEPT", "확인", "2026-08-14T02:00:00Z");
    expect(expired.status).toBe("EXPIRED");
    expectCode(() => service.preparedCommand(WORKSPACE, suggestion.id), "HUMAN_REVIEW_REQUIRED");
  });
});
