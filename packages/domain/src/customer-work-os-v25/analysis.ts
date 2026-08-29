import type { MutationCategory } from "./capture.js";
import {
  CustomerWorkOsV25Error,
  clampConfidence,
  copy,
  required,
  uniqueStrings,
  type RiskLevel,
} from "./shared.js";

export interface AiEntityCandidate {
  id: string;
  confidence: number;
  evidenceRefs: string[];
  rationale: string;
}

export interface AiMutationCandidate {
  category: MutationCategory;
  operation: "CREATE" | "UPDATE" | "LINK";
  targetId: string | null;
  field: string | null;
  value: unknown;
  confidence: number;
  risk: RiskLevel;
  evidenceRefs: string[];
  rationale: string;
}

export interface AiClarificationCandidate {
  prompt: string;
  field: string;
  mutationIndex: number | null;
  options: Array<{ id: string; label: string; value: unknown }>;
  evidenceRefs: string[];
}

export interface AiCaptureAnalysis {
  schemaVersion: 1;
  accountCandidates: AiEntityCandidate[];
  engagementCandidates: AiEntityCandidate[];
  mutations: AiMutationCandidate[];
  clarifications: AiClarificationCandidate[];
  modelVersion: string;
  promptVersion: string;
  invocationRef: string;
}

export interface CaptureAnalysisRequest {
  workspaceId: string;
  sourceId: string;
  kind: string;
  content: string;
  occurredAt: string;
  sourceRef: string;
  knownAccounts: Array<{ id: string; aliases: string[] }>;
  knownEngagements: Array<{ id: string; aliases: string[]; projectKey?: string }>;
  maxQuestions: number;
}

export interface CaptureAnalysisProvider {
  analyze(request: CaptureAnalysisRequest): Promise<AiCaptureAnalysis>;
}

const CATEGORIES = new Set<MutationCategory>([
  "ACTIVITY",
  "ACCOUNT_LINK",
  "ENGAGEMENT_LINK",
  "ENGAGEMENT_FIELD",
  "REQUIREMENT",
  "UNKNOWN",
  "COMMITMENT",
  "CHANGE_REQUEST",
  "FINANCIAL_ITEM",
  "SETTLEMENT",
  "DOCUMENT",
]);
const OPERATIONS = new Set(["CREATE", "UPDATE", "LINK"] as const);
const RISKS = new Set<RiskLevel>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export function validateAiCaptureAnalysis(input: AiCaptureAnalysis): AiCaptureAnalysis {
  if (input.schemaVersion !== 1) {
    throw new CustomerWorkOsV25Error("AI_ANALYSIS_SCHEMA", "unsupported AI capture analysis schema");
  }
  const accountCandidates = input.accountCandidates.map((candidate) => ({
    id: required(candidate.id, "accountCandidate.id"),
    confidence: clampConfidence(candidate.confidence),
    evidenceRefs: uniqueStrings(candidate.evidenceRefs, "accountCandidate.evidenceRef", false),
    rationale: required(candidate.rationale, "accountCandidate.rationale"),
  }));
  const engagementCandidates = input.engagementCandidates.map((candidate) => ({
    id: required(candidate.id, "engagementCandidate.id"),
    confidence: clampConfidence(candidate.confidence),
    evidenceRefs: uniqueStrings(candidate.evidenceRefs, "engagementCandidate.evidenceRef", false),
    rationale: required(candidate.rationale, "engagementCandidate.rationale"),
  }));
  const mutations = input.mutations.map((candidate) => {
    if (!CATEGORIES.has(candidate.category)) {
      throw new CustomerWorkOsV25Error("AI_ANALYSIS_SCHEMA", `unsupported AI mutation category: ${String(candidate.category)}`);
    }
    if (!OPERATIONS.has(candidate.operation)) {
      throw new CustomerWorkOsV25Error("AI_ANALYSIS_SCHEMA", `unsupported AI mutation operation: ${String(candidate.operation)}`);
    }
    if (!RISKS.has(candidate.risk)) {
      throw new CustomerWorkOsV25Error("AI_ANALYSIS_SCHEMA", `unsupported AI mutation risk: ${String(candidate.risk)}`);
    }
    return {
      ...copy(candidate),
      confidence: clampConfidence(candidate.confidence),
      evidenceRefs: uniqueStrings(candidate.evidenceRefs, "aiMutation.evidenceRef", false),
      rationale: required(candidate.rationale, "aiMutation.rationale"),
    };
  });
  const clarifications = input.clarifications.map((candidate) => ({
    prompt: required(candidate.prompt, "aiClarification.prompt"),
    field: required(candidate.field, "aiClarification.field"),
    mutationIndex: candidate.mutationIndex,
    options: candidate.options.map((option) => ({
      id: required(option.id, "aiClarification.option.id"),
      label: required(option.label, "aiClarification.option.label"),
      value: copy(option.value),
    })),
    evidenceRefs: uniqueStrings(candidate.evidenceRefs, "aiClarification.evidenceRef", false),
  }));
  for (const clarification of clarifications) {
    if (clarification.mutationIndex !== null && (
      !Number.isSafeInteger(clarification.mutationIndex) ||
      clarification.mutationIndex < 0 ||
      clarification.mutationIndex >= mutations.length
    )) {
      throw new CustomerWorkOsV25Error("AI_ANALYSIS_SCHEMA", "clarification mutationIndex is out of range");
    }
  }
  return {
    schemaVersion: 1,
    accountCandidates,
    engagementCandidates,
    mutations,
    clarifications,
    modelVersion: required(input.modelVersion, "modelVersion"),
    promptVersion: required(input.promptVersion, "promptVersion"),
    invocationRef: required(input.invocationRef, "invocationRef"),
  };
}
