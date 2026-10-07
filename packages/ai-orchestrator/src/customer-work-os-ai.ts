export class CustomerWorkOsAiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerWorkOsAiError";
  }
}

export type CustomerWorkOsAgentRole =
  | "capture_understand"
  | "deal_architect"
  | "meeting_copilot"
  | "proposal_architect"
  | "delivery_guardian"
  | "procurement_asset_guardian"
  | "finance_guardian"
  | "relationship_renewal"
  | "executive_analyst"
  | "independent_reviewer";

export type SuggestionKind =
  | "account_link"
  | "engagement_link"
  | "activity_extract"
  | "knowledge_item"
  | "commitment"
  | "deal_score"
  | "meeting_brief"
  | "quote_draft"
  | "proposal_draft"
  | "change_request"
  | "purchase_risk"
  | "finance_risk"
  | "renewal_opportunity"
  | "executive_brief";

export interface EvidenceSpan {
  sourceRef: string;
  start?: number;
  end?: number;
  excerptDigest: string;
}

export interface ContextFact {
  id: string;
  statement: string;
  status: "CONFIRMED" | "ASSUMED" | "UNKNOWN";
  evidence: EvidenceSpan[];
}

export interface CustomerContextPack {
  workspaceId: string;
  accountId?: string;
  engagementId?: string;
  facts: ContextFact[];
  openCommitments: Array<{ id: string; description: string; dueAt: string | null; status: string }>;
  recentChanges: string[];
  artifactRefs: string[];
  generatedAt: string;
  contentHash: string;
}

export interface AiBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxRetries: number;
  maxLatencyMs: number;
  maxCostMicros: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  retries: number;
  latencyMs: number;
  costMicros: number;
}

export interface StructuredAnalysisRequest {
  workspaceId: string;
  operationId: string;
  agentRole: CustomerWorkOsAgentRole;
  promptVersion: string;
  modelTier: "L1" | "L2" | "L3" | "L4";
  context: CustomerContextPack;
  inputRef: string;
  outputSchemaVersion: string;
  budget: AiBudget;
  correlationId: string;
}

export interface StructuredAnalysisResult {
  output: Record<string, unknown>;
  usage: AiUsage;
  modelVersion: string;
  responseDigest: string;
}

export interface StructuredAnalyzer {
  analyze(request: StructuredAnalysisRequest): Promise<StructuredAnalysisResult>;
}

export interface AiSuggestion {
  id: string;
  workspaceId: string;
  accountId?: string;
  engagementId?: string;
  agentRole: CustomerWorkOsAgentRole;
  kind: SuggestionKind;
  title: string;
  proposedPayload: Record<string, unknown>;
  evidence: EvidenceSpan[];
  confidence: number;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PROPOSED" | "REVIEWED" | "ACCEPTED" | "REJECTED" | "EXPIRED";
  requiresHumanReview: boolean;
  proposedCommand?: PreparedCommand;
  inputDigest: string;
  responseDigest: string;
  modelVersion: string;
  promptVersion: string;
  usage: AiUsage;
  createdByPrincipalId: string;
  reviewedByPrincipalId?: string;
  reviewReason?: string;
  createdAt: string;
  expiresAt: string;
  version: number;
}

export interface PreparedCommand {
  command: string;
  actionType: string;
  resourceType: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  approvalRequired: boolean;
  externalEffect: boolean;
}

export interface SuggestionProposal {
  id: string;
  accountId?: string;
  engagementId?: string;
  kind: SuggestionKind;
  title: string;
  proposedPayload: Record<string, unknown>;
  evidence: EvidenceSpan[];
  confidence: number;
  risk: AiSuggestion["risk"];
  proposedCommand?: PreparedCommand;
  expiresAt: string;
}

const COMMAND_POLICY: Readonly<Record<string, { externalEffect: boolean; approvalRequired: boolean }>> = {
  "crm.account_link_suggest": { externalEffect: false, approvalRequired: true },
  "crm.engagement_link_suggest": { externalEffect: false, approvalRequired: true },
  "crm.activity_extract": { externalEffect: false, approvalRequired: true },
  "psa.commitment_propose": { externalEffect: false, approvalRequired: true },
  "psa.change_request_propose": { externalEffect: false, approvalRequired: true },
  "finance.risk_assess": { externalEffect: false, approvalRequired: false },
  "finance.forecast_refresh": { externalEffect: false, approvalRequired: false },
  "document.draft_prepare": { externalEffect: false, approvalRequired: true },
  "external.email_send": { externalEffect: true, approvalRequired: true },
  "external.calendar_invite": { externalEffect: true, approvalRequired: true },
  "commercial.quote_approve": { externalEffect: false, approvalRequired: true },
  "commercial.contract_activate": { externalEffect: false, approvalRequired: true },
  "procurement.purchase_order_approve": { externalEffect: false, approvalRequired: true },
  "finance.settlement_record": { externalEffect: false, approvalRequired: true },
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function assertInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isInteger(value) || value < minimum) throw new CustomerWorkOsAiError("INVALID_BUDGET", `${name} must be an integer >= ${minimum}`);
}

function assertBudget(budget: AiBudget): void {
  assertInteger(budget.maxInputTokens, "maxInputTokens", 1);
  assertInteger(budget.maxOutputTokens, "maxOutputTokens", 1);
  assertInteger(budget.maxToolCalls, "maxToolCalls");
  assertInteger(budget.maxRetries, "maxRetries");
  assertInteger(budget.maxLatencyMs, "maxLatencyMs", 1);
  assertInteger(budget.maxCostMicros, "maxCostMicros");
}

function assertUsageWithinBudget(usage: AiUsage, budget: AiBudget): void {
  if (usage.inputTokens > budget.maxInputTokens) throw new CustomerWorkOsAiError("BUDGET_EXHAUSTED", "input token budget exceeded");
  if (usage.outputTokens > budget.maxOutputTokens) throw new CustomerWorkOsAiError("BUDGET_EXHAUSTED", "output token budget exceeded");
  if (usage.toolCalls > budget.maxToolCalls) throw new CustomerWorkOsAiError("BUDGET_EXHAUSTED", "tool-call budget exceeded");
  if (usage.retries > budget.maxRetries) throw new CustomerWorkOsAiError("BUDGET_EXHAUSTED", "retry budget exceeded");
  if (usage.latencyMs > budget.maxLatencyMs) throw new CustomerWorkOsAiError("TIMEOUT", "latency budget exceeded");
  if (usage.costMicros > budget.maxCostMicros) throw new CustomerWorkOsAiError("BUDGET_EXHAUSTED", "cost budget exceeded");
}

function validateEvidence(evidence: EvidenceSpan[]): void {
  if (evidence.length === 0) throw new CustomerWorkOsAiError("EVIDENCE_REQUIRED", "AI suggestion requires evidence");
  for (const span of evidence) {
    if (!span.sourceRef.trim() || !span.excerptDigest.trim()) throw new CustomerWorkOsAiError("INVALID_EVIDENCE", "evidence requires sourceRef and excerptDigest");
    if (span.start !== undefined && (!Number.isInteger(span.start) || span.start < 0)) throw new CustomerWorkOsAiError("INVALID_EVIDENCE", "evidence start must be non-negative integer");
    if (span.end !== undefined && (!Number.isInteger(span.end) || span.end < 0 || (span.start !== undefined && span.end < span.start))) {
      throw new CustomerWorkOsAiError("INVALID_EVIDENCE", "evidence end is invalid");
    }
  }
}

function validatePreparedCommand(command: PreparedCommand): PreparedCommand {
  const policy = COMMAND_POLICY[command.command];
  if (!policy) throw new CustomerWorkOsAiError("COMMAND_NOT_ALLOWLISTED", `command is not allowlisted: ${command.command}`);
  if (!command.actionType.trim() || !command.resourceType.trim()) throw new CustomerWorkOsAiError("INVALID_COMMAND", "prepared command requires actionType and resourceType");
  if (command.externalEffect !== policy.externalEffect || command.approvalRequired !== policy.approvalRequired) {
    throw new CustomerWorkOsAiError("COMMAND_POLICY_MISMATCH", "prepared command policy flags do not match the registry");
  }
  return copy(command);
}

export class CustomerWorkOsAiService {
  private readonly suggestions = new Map<string, AiSuggestion>();
  private readonly inputCache = new Map<string, string>();

  async analyzeAndPropose(
    analyzer: StructuredAnalyzer,
    request: StructuredAnalysisRequest,
    proposalFromOutput: (result: StructuredAnalysisResult) => SuggestionProposal,
    principalId: string,
    now: string,
  ): Promise<AiSuggestion> {
    assertBudget(request.budget);
    if (!principalId.trim()) throw new CustomerWorkOsAiError("INVALID_PRINCIPAL", "principalId is required");
    if (!request.context.contentHash.trim()) throw new CustomerWorkOsAiError("INVALID_CONTEXT", "context contentHash is required");
    const cacheKey = `${request.workspaceId}\u0000${request.operationId}\u0000${request.context.contentHash}\u0000${request.inputRef}\u0000${request.promptVersion}`;
    const existingId = this.inputCache.get(cacheKey);
    if (existingId) return this.get(request.workspaceId, existingId);

    const result = await analyzer.analyze(copy(request));
    assertUsageWithinBudget(result.usage, request.budget);
    const proposal = proposalFromOutput(result);
    const suggestion = this.propose(
      {
        ...proposal,
        workspaceId: request.workspaceId,
        agentRole: request.agentRole,
        inputDigest: request.context.contentHash,
        responseDigest: result.responseDigest,
        modelVersion: result.modelVersion,
        promptVersion: request.promptVersion,
        usage: result.usage,
        createdByPrincipalId: principalId,
        createdAt: now,
      },
    );
    this.inputCache.set(cacheKey, suggestion.id);
    return suggestion;
  }

  propose(
    input: Omit<AiSuggestion, "status" | "requiresHumanReview" | "version" | "reviewedByPrincipalId" | "reviewReason">,
  ): AiSuggestion {
    if (this.suggestions.has(input.id)) throw new CustomerWorkOsAiError("DUPLICATE_ID", `suggestion exists: ${input.id}`);
    if (!input.title.trim()) throw new CustomerWorkOsAiError("INVALID_INPUT", "suggestion title is required");
    if (input.confidence < 0 || input.confidence > 1) throw new CustomerWorkOsAiError("INVALID_CONFIDENCE", "confidence must be 0..1");
    validateEvidence(input.evidence);
    if (new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()) throw new CustomerWorkOsAiError("INVALID_EXPIRY", "expiresAt must be after createdAt");
    const proposedCommand = input.proposedCommand ? validatePreparedCommand(input.proposedCommand) : undefined;
    const requiresHumanReview = input.confidence < 0.9 || input.risk !== "LOW" || Boolean(proposedCommand?.approvalRequired);
    const suggestion: AiSuggestion = {
      ...copy(input),
      ...(proposedCommand ? { proposedCommand } : {}),
      status: "PROPOSED",
      requiresHumanReview,
      version: 1,
    };
    this.suggestions.set(suggestion.id, suggestion);
    return copy(suggestion);
  }

  review(
    workspaceId: string,
    suggestionId: string,
    expectedVersion: number,
    reviewerPrincipalId: string,
    decision: "ACCEPT" | "REJECT",
    reason: string,
    now: string,
  ): AiSuggestion {
    const suggestion = this.requireVersion(workspaceId, suggestionId, expectedVersion);
    if (suggestion.status !== "PROPOSED" && suggestion.status !== "REVIEWED") {
      throw new CustomerWorkOsAiError("INVALID_STATE", `suggestion is ${suggestion.status}`);
    }
    if (!reviewerPrincipalId.trim()) throw new CustomerWorkOsAiError("INVALID_PRINCIPAL", "reviewer principal is required");
    if (!reason.trim()) throw new CustomerWorkOsAiError("REVIEW_REASON_REQUIRED", "review reason is required");
    if (new Date(now).getTime() >= new Date(suggestion.expiresAt).getTime()) {
      suggestion.status = "EXPIRED";
      suggestion.version += 1;
      return copy(suggestion);
    }
    suggestion.reviewedByPrincipalId = reviewerPrincipalId;
    suggestion.reviewReason = reason.trim();
    suggestion.status = decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    suggestion.version += 1;
    return copy(suggestion);
  }

  preparedCommand(workspaceId: string, suggestionId: string): PreparedCommand {
    const suggestion = this.require(workspaceId, suggestionId);
    if (suggestion.status !== "ACCEPTED") throw new CustomerWorkOsAiError("HUMAN_REVIEW_REQUIRED", "suggestion must be accepted before command preparation");
    if (!suggestion.proposedCommand) throw new CustomerWorkOsAiError("NO_COMMAND", "suggestion does not contain a command");
    return copy(suggestion.proposedCommand);
  }

  get(workspaceId: string, suggestionId: string): AiSuggestion {
    return copy(this.require(workspaceId, suggestionId));
  }

  list(workspaceId: string, status?: AiSuggestion["status"]): AiSuggestion[] {
    return [...this.suggestions.values()]
      .filter((item) => item.workspaceId === workspaceId && (status === undefined || item.status === status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => copy(item));
  }

  private require(workspaceId: string, suggestionId: string): AiSuggestion {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion) throw new CustomerWorkOsAiError("NOT_FOUND", `suggestion not found: ${suggestionId}`);
    if (suggestion.workspaceId !== workspaceId) throw new CustomerWorkOsAiError("CROSS_WORKSPACE", "suggestion belongs to another workspace");
    return suggestion;
  }

  private requireVersion(workspaceId: string, suggestionId: string, expectedVersion: number): AiSuggestion {
    const suggestion = this.require(workspaceId, suggestionId);
    if (suggestion.version !== expectedVersion) throw new CustomerWorkOsAiError("STALE_VERSION", `expected suggestion version ${expectedVersion}, found ${suggestion.version}`);
    return suggestion;
  }
}
