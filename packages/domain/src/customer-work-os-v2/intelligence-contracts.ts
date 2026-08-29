export const CUSTOMER_WORK_OS_INTELLIGENCE_VERSION = "2.5.0" as const;

export type CaptureChannel =
  | "TEXT"
  | "EMAIL"
  | "MEETING"
  | "MESSAGE"
  | "VOICE_TRANSCRIPT"
  | "FILE"
  | "CALENDAR"
  | "NOTION"
  | "FINANCE_IMPORT";

export type IntelligenceRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type IntelligenceCandidateKind =
  | "ACTIVITY"
  | "ACCOUNT_LINK"
  | "ENGAGEMENT_LINK"
  | "REQUIREMENT"
  | "UNKNOWN"
  | "COMMITMENT"
  | "SCHEDULE_CHANGE"
  | "FINANCIAL_ITEM"
  | "CHANGE_REQUEST"
  | "DOCUMENT"
  | "ACCOUNT_UPDATE"
  | "ENGAGEMENT_UPDATE";

export type IntelligenceCandidateStatus =
  | "PROPOSED"
  | "READY_AUTO_APPLY"
  | "NEEDS_CLARIFICATION"
  | "NEEDS_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "APPLIED"
  | "FAILED";

export interface IntelligenceEvidence {
  ref: string;
  excerpt: string;
  location?: string;
}

export interface IntelligenceAccountContext {
  id: string;
  name: string;
  aliases?: string[];
  emails?: string[];
  domains?: string[];
}

export interface IntelligenceEngagementContext {
  id: string;
  projectKey: string;
  name: string;
  aliases?: string[];
  accountIds?: string[];
  stage?: string;
  targetDate?: string;
}

export interface IntelligenceContext {
  accounts: IntelligenceAccountContext[];
  engagements: IntelligenceEngagementContext[];
  defaultOwnerPrincipalId: string;
  now: string;
}

export interface CaptureInput {
  id: string;
  workspaceId: string;
  channel: CaptureChannel;
  sourceRef: string;
  receivedAt: string;
  content: string;
  sender?: string;
  subject?: string;
  attachmentRefs?: string[];
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureRecord {
  id: string;
  workspaceId: string;
  channel: CaptureChannel;
  sourceRef: string;
  receivedAt: string;
  contentHash: string;
  normalizedContent: string;
  sender: string | null;
  subject: string | null;
  attachmentRefs: string[];
  language: string;
  metadata: Record<string, unknown>;
  status: "CAPTURED" | "ANALYZED" | "QUARANTINED";
  promptInjectionSuspected: boolean;
  duplicateOfCaptureId: string | null;
  createdByPrincipalId: string;
  version: number;
}

export interface InterpretedRequirement {
  statement: string;
  confirmed: boolean;
  evidenceRefs: string[];
  confidence: number;
}

export interface InterpretedUnknown {
  statement: string;
  impact?: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface InterpretedCommitment {
  description: string;
  dueAt?: string;
  externalPromise: boolean;
  evidenceRefs: string[];
  confidence: number;
}

export interface InterpretedScheduleChange {
  field: "targetDate" | "acceptanceDate" | "billingDate" | "paymentDate";
  date?: string;
  phrase: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface InterpretedFinancialItem {
  direction: "IN" | "OUT";
  category:
    | "contract_revenue"
    | "change_revenue"
    | "maintenance_revenue"
    | "hardware_cost"
    | "license_cost"
    | "outsourcing_cost"
    | "travel_cost"
    | "cloud_cost"
    | "internal_labor"
    | "overhead"
    | "other";
  netAmountKrw?: string;
  grossAmountKrw?: string;
  vatAmountKrw?: string;
  expectedDate?: string;
  contractualDueDate?: string;
  memo: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface StructuredInterpretation {
  accountId?: string;
  accountConfidence?: number;
  engagementId?: string;
  engagementConfidence?: number;
  activitySummary: string;
  requirements: InterpretedRequirement[];
  unknowns: InterpretedUnknown[];
  commitments: InterpretedCommitment[];
  scheduleChanges: InterpretedScheduleChange[];
  financialItems: InterpretedFinancialItem[];
  changeRequests: Array<{
    description: string;
    scopeImpact: string;
    scheduleImpactDays?: number;
    costImpactKrw?: string;
    priceImpactKrw?: string;
    evidenceRefs: string[];
    confidence: number;
  }>;
  documentRefs: Array<{
    title: string;
    type: string;
    storageUri: string;
    evidenceRefs: string[];
    confidence: number;
  }>;
  warnings: string[];
}

export interface IntelligenceCandidate {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  planId: string;
  kind: IntelligenceCandidateKind;
  targetType: string;
  targetId: string | null;
  field: string;
  value: Record<string, unknown>;
  confidence: number;
  risk: IntelligenceRisk;
  evidence: IntelligenceEvidence[];
  rationale: string;
  status: IntelligenceCandidateStatus;
  payloadHash: string;
  approvalAction: string | null;
  approvedByPrincipalId: string | null;
  appliedReceiptRef: string | null;
  failureCode: string | null;
  version: number;
}

export interface ClarificationOption {
  id: string;
  label: string;
  value: unknown;
}

export interface ClarificationQuestion {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  planId: string;
  candidateIds: string[];
  prompt: string;
  options: ClarificationOption[];
  evidence: IntelligenceEvidence[];
  status: "OPEN" | "ANSWERED" | "DEFERRED" | "DISMISSED";
  answer: unknown;
  answeredByPrincipalId: string | null;
  version: number;
}

export interface UpdatePlan {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  accountId: string | null;
  engagementId: string | null;
  candidates: IntelligenceCandidate[];
  questions: ClarificationQuestion[];
  deferredQuestionCount: number;
  status:
    | "DRAFT"
    | "QUARANTINED"
    | "AWAITING_CLARIFICATION"
    | "AWAITING_APPROVAL"
    | "READY"
    | "PARTIALLY_APPLIED"
    | "APPLIED"
    | "REJECTED";
  summary: string;
  createdByPrincipalId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface BaselineAccountInput {
  sourceId: string;
  source: string;
  name: string;
  emails?: string[];
  phones?: string[];
  aliases?: string[];
  evidenceRefs?: string[];
}

export interface BaselineEngagementInput {
  sourceId: string;
  source: string;
  projectKey?: string;
  name: string;
  accountRefs?: string[];
  aliases?: string[];
  stage?: string;
  targetDate?: string;
  evidenceRefs?: string[];
}

export interface BaselineActivityInput {
  sourceId: string;
  source: string;
  accountRef?: string;
  engagementRef?: string;
  occurredAt: string;
  summary: string;
  evidenceRefs?: string[];
}

export interface BaselineFinancialInput {
  sourceId: string;
  source: string;
  accountRef?: string;
  engagementRef?: string;
  projectKey?: string;
  direction: "IN" | "OUT";
  netAmountKrw?: string;
  vatAmountKrw?: string;
  grossAmountKrw?: string;
  expectedDate?: string;
  memo: string;
  evidenceRefs?: string[];
}

export interface BaselineBuildInput {
  id: string;
  workspaceId: string;
  snapshotAt: string;
  accounts: BaselineAccountInput[];
  engagements: BaselineEngagementInput[];
  activities: BaselineActivityInput[];
  financialItems: BaselineFinancialInput[];
}

export interface BaselineCanonicalAccount {
  canonicalId: string;
  name: string;
  sourceIds: string[];
  aliases: string[];
  emails: string[];
  phones: string[];
  evidenceRefs: string[];
}

export interface BaselineCanonicalEngagement {
  canonicalId: string;
  projectKey: string | null;
  name: string;
  sourceIds: string[];
  accountCanonicalIds: string[];
  aliases: string[];
  stage: string | null;
  targetDate: string | null;
  evidenceRefs: string[];
}

export interface BaselineUnresolvedItem {
  id: string;
  kind:
    | "DUPLICATE_ACCOUNT"
    | "AMBIGUOUS_ACCOUNT"
    | "AMBIGUOUS_ENGAGEMENT"
    | "ORPHAN_ACTIVITY"
    | "ORPHAN_FINANCE"
    | "MONEY_MISMATCH"
    | "MISSING_PROJECT_KEY"
    | "INVALID_DATE";
  sourceId: string;
  summary: string;
  candidateIds: string[];
  evidenceRefs: string[];
  severity: "INFO" | "WARNING" | "BLOCKING";
}

export interface BaselineBuildResult {
  id: string;
  workspaceId: string;
  snapshotAt: string;
  accounts: BaselineCanonicalAccount[];
  engagements: BaselineCanonicalEngagement[];
  unresolved: BaselineUnresolvedItem[];
  metrics: {
    sourceAccounts: number;
    canonicalAccounts: number;
    sourceEngagements: number;
    canonicalEngagements: number;
    activities: number;
    financialItems: number;
    blockingUnresolved: number;
    totalUnresolved: number;
  };
  status: "READY" | "NEEDS_REVIEW" | "BLOCKED";
  createdByPrincipalId: string;
  createdAt: string;
  version: number;
}

export type LearnableAliasScope = "ACCOUNT" | "ENGAGEMENT" | "CONTACT" | "CATEGORY";

export interface LearnedAlias {
  id: string;
  workspaceId: string;
  scope: LearnableAliasScope;
  alias: string;
  canonicalId: string;
  sourcePlanId: string | null;
  evidenceRef: string;
  approvedByPrincipalId: string;
  active: boolean;
  version: number;
}

export interface CorrectionRecord {
  id: string;
  workspaceId: string;
  sourceEventId: string | null;
  planId: string | null;
  field: string;
  previousValue: unknown;
  correctedValue: unknown;
  learn: boolean;
  learnedAliasId: string | null;
  correctedByPrincipalId: string;
  correctedAt: string;
  version: number;
}

export interface ManagerInputSnapshot {
  asOf: string;
  engagements: Array<{
    id: string;
    name: string;
    stage: string;
    health: string;
    targetDate?: string;
  }>;
  commitments: Array<{
    id: string;
    engagementId: string;
    description: string;
    dueAt: string;
    status: string;
  }>;
  activities: Array<{
    id: string;
    engagementId: string;
    occurredAt: string;
  }>;
  financialItems: Array<{
    id: string;
    engagementId: string | null;
    direction: "IN" | "OUT";
    lifecycle: string;
    grossAmountKrw: string;
    expectedDate: string;
    contractualDueDate?: string;
  }>;
  changeRequests: Array<{
    id: string;
    engagementId: string;
    status: string;
    priceImpactKrw: string;
  }>;
  financeSummaries?: Array<{
    engagementId: string;
    forecastProfitKrw: string;
    forecastMarginBps: number;
    cashPositionKrw: string;
  }>;
}

export interface ManagerFinding {
  id: string;
  workspaceId: string;
  asOf: string;
  kind:
    | "NO_NEXT_ACTION"
    | "OVERDUE_COMMITMENT"
    | "STALE_ENGAGEMENT"
    | "OVERDUE_RECEIVABLE"
    | "OVERDUE_PAYABLE"
    | "MARGIN_RISK"
    | "NEGATIVE_CASH"
    | "UNPRICED_SCOPE_CHANGE";
  severity: "INFO" | "WARNING" | "CRITICAL";
  engagementId: string;
  title: string;
  detail: string;
  recommendedAction: string;
  evidenceRefs: string[];
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  version: number;
}

export interface DailyBrief {
  id: string;
  workspaceId: string;
  asOf: string;
  findingIds: string[];
  criticalCount: number;
  warningCount: number;
  expectedIncoming7dKrw: string;
  expectedOutgoing7dKrw: string;
  summary: string;
  createdByPrincipalId: string;
  createdAt: string;
  version: number;
}

export interface IntelligencePolicy {
  autoApplyThreshold: number;
  linkAutoApplyThreshold: number;
  reviewThreshold: number;
  maxQuestionsPerCapture: number;
  staleEngagementDays: number;
  minimumMarginBps: number;
}

export interface IntelligenceState {
  schemaVersion: 1;
  productVersion: "2.5.0";
  captures: CaptureRecord[];
  plans: UpdatePlan[];
  baselines: BaselineBuildResult[];
  aliases: LearnedAlias[];
  corrections: CorrectionRecord[];
  managerFindings: ManagerFinding[];
  dailyBriefs: DailyBrief[];
  policy: IntelligencePolicy;
}
