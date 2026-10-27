import {
  CustomerWorkOsAiError,
  CustomerWorkOsAiService,
  type AiSuggestion,
} from "./customer-work-os-ai.js";

export * from "./customer-work-os-ai.js";

const STATUSES = new Set<AiSuggestion["status"]>(["PROPOSED", "REVIEWED", "ACCEPTED", "REJECTED", "EXPIRED"]);
const RISKS = new Set<AiSuggestion["risk"]>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

type AiServiceInternals = {
  suggestions: Map<string, AiSuggestion>;
  inputCache: Map<string, string>;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function required(value: string, field: string): void {
  if (!value.trim()) throw new CustomerWorkOsAiError("INVALID_STATE", `${field} is required`);
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new CustomerWorkOsAiError("INVALID_STATE", `${field} must be a non-negative integer`);
}

function validateSuggestion(item: AiSuggestion): void {
  required(item.id, "suggestion.id");
  required(item.workspaceId, "suggestion.workspaceId");
  required(item.title, "suggestion.title");
  required(item.inputDigest, "suggestion.inputDigest");
  required(item.responseDigest, "suggestion.responseDigest");
  required(item.modelVersion, "suggestion.modelVersion");
  required(item.promptVersion, "suggestion.promptVersion");
  required(item.createdByPrincipalId, "suggestion.createdByPrincipalId");
  if (!STATUSES.has(item.status)) throw new CustomerWorkOsAiError("INVALID_STATE", `unsupported suggestion status ${String(item.status)}`);
  if (!RISKS.has(item.risk)) throw new CustomerWorkOsAiError("INVALID_STATE", `unsupported suggestion risk ${String(item.risk)}`);
  if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    throw new CustomerWorkOsAiError("INVALID_STATE", "suggestion confidence must be 0..1");
  }
  if (!Number.isInteger(item.version) || item.version < 1) throw new CustomerWorkOsAiError("INVALID_STATE", "suggestion version must be >= 1");
  const createdAt = new Date(item.createdAt).getTime();
  const expiresAt = new Date(item.expiresAt).getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new CustomerWorkOsAiError("INVALID_STATE", "suggestion timestamps are invalid");
  }
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    throw new CustomerWorkOsAiError("INVALID_STATE", "suggestion evidence is required");
  }
  for (const evidence of item.evidence) {
    required(evidence.sourceRef, "evidence.sourceRef");
    required(evidence.excerptDigest, "evidence.excerptDigest");
  }
  nonNegativeInteger(item.usage.inputTokens, "usage.inputTokens");
  nonNegativeInteger(item.usage.outputTokens, "usage.outputTokens");
  nonNegativeInteger(item.usage.toolCalls, "usage.toolCalls");
  nonNegativeInteger(item.usage.retries, "usage.retries");
  nonNegativeInteger(item.usage.latencyMs, "usage.latencyMs");
  nonNegativeInteger(item.usage.costMicros, "usage.costMicros");
  if (["ACCEPTED", "REJECTED"].includes(item.status)) {
    if (!item.reviewedByPrincipalId?.trim() || !item.reviewReason?.trim()) {
      throw new CustomerWorkOsAiError("INVALID_STATE", "reviewed suggestion requires reviewer and reason");
    }
  }
  if (item.reviewedByPrincipalId && item.reviewedByPrincipalId === item.createdByPrincipalId) {
    throw new CustomerWorkOsAiError("INVALID_STATE", "persisted suggestion contains a creator self-review");
  }
}

function internals(service: CustomerWorkOsAiService): AiServiceInternals {
  return service as unknown as AiServiceInternals;
}

declare module "./customer-work-os-ai.js" {
  interface CustomerWorkOsAiService {
    hydrate(suggestions: readonly AiSuggestion[]): void;
    exportState(): AiSuggestion[];
  }
}

CustomerWorkOsAiService.prototype.hydrate = function hydrate(suggestions: readonly AiSuggestion[]): void {
  if (!Array.isArray(suggestions)) throw new CustomerWorkOsAiError("INVALID_STATE", "suggestions must be an array");
  const candidate = new Map<string, AiSuggestion>();
  for (const raw of suggestions) {
    const item = copy(raw);
    validateSuggestion(item);
    if (candidate.has(item.id)) throw new CustomerWorkOsAiError("INVALID_STATE", `duplicate suggestion id ${item.id}`);
    candidate.set(item.id, item);
  }
  const state = internals(this);
  state.suggestions.clear();
  for (const [id, item] of candidate) state.suggestions.set(id, copy(item));
  state.inputCache.clear();
};

CustomerWorkOsAiService.prototype.exportState = function exportState(): AiSuggestion[] {
  return [...internals(this).suggestions.values()]
    .map((item) => copy(item))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
};
