import { createHash } from "node:crypto";
import {
  CustomerWorkOsV2Error,
  assertHuman,
  assertWorkspace,
  copy,
  required,
  type V2Actor,
} from "./shared.js";
import type {
  BaselineAccountInput,
  BaselineBuildInput,
  BaselineBuildResult,
  BaselineCanonicalAccount,
  BaselineCanonicalEngagement,
  BaselineEngagementInput,
  BaselineUnresolvedItem,
  CaptureInput,
  CaptureRecord,
  ClarificationOption,
  ClarificationQuestion,
  CorrectionRecord,
  DailyBrief,
  IntelligenceCandidate,
  IntelligenceCandidateKind,
  IntelligenceContext,
  IntelligenceEvidence,
  IntelligencePolicy,
  IntelligenceRisk,
  IntelligenceState,
  InterpretedCommitment,
  InterpretedFinancialItem,
  InterpretedRequirement,
  InterpretedScheduleChange,
  InterpretedUnknown,
  LearnedAlias,
  LearnableAliasScope,
  ManagerFinding,
  ManagerInputSnapshot,
  StructuredInterpretation,
  UpdatePlan,
} from "./intelligence-contracts.js";

const DEFAULT_POLICY: IntelligencePolicy = {
  autoApplyThreshold: 0.9,
  linkAutoApplyThreshold: 0.95,
  reviewThreshold: 0.72,
  maxQuestionsPerCapture: 3,
  staleEngagementDays: 7,
  minimumMarginBps: 1_500,
};

const PROTECTED_KINDS = new Set<IntelligenceCandidateKind>([
  "SCHEDULE_CHANGE",
  "FINANCIAL_ITEM",
  "CHANGE_REQUEST",
  "ACCOUNT_UPDATE",
  "ENGAGEMENT_UPDATE",
]);

const LEARNING_FORBIDDEN_FIELDS = [
  "price",
  "amount",
  "discount",
  "contract",
  "approval",
  "permission",
  "security",
  "delete",
  "payment",
  "bank",
];

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

export function intelligenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(value)) ?? "undefined")
    .digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeEntity(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("ko-KR")
    .replace(/\b(?:주식회사|유한회사|inc\.?|corp\.?|co\.?\s*,?\s*ltd\.?)\b/gi, "")
    .replace(/[()[\]{}<>.,'"`~!@#$%^&*+=|\\/:;?-]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function iso(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new CustomerWorkOsV2Error("INVALID_DATE", `${field} must be a valid date-time`);
  }
  return value;
}

function dateOnly(value: string, field: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new CustomerWorkOsV2Error("INVALID_DATE", `${field} must be YYYY-MM-DD`);
  }
  return value;
}

function integerMoney(value: string | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new CustomerWorkOsV2Error("INVALID_MONEY", `${field} must be a non-negative integer KRW string`);
  }
  return BigInt(value);
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampConfidence(value: number, field = "confidence"): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CustomerWorkOsV2Error("INVALID_CONFIDENCE", `${field} must be between 0 and 1`);
  }
  return value;
}

function evidence(sourceRef: string, content: string, phrase?: string): IntelligenceEvidence[] {
  const normalized = normalizeWhitespace(content);
  const excerpt = phrase && normalized.includes(phrase)
    ? phrase.slice(0, 500)
    : normalized.slice(0, 500);
  return [{ ref: sourceRef, excerpt }];
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function copyPolicy(input?: Partial<IntelligencePolicy>): IntelligencePolicy {
  const merged: IntelligencePolicy = { ...DEFAULT_POLICY, ...input };
  for (const key of ["autoApplyThreshold", "linkAutoApplyThreshold", "reviewThreshold"] as const) {
    clampConfidence(merged[key], key);
  }
  if (merged.reviewThreshold > merged.autoApplyThreshold || merged.autoApplyThreshold > merged.linkAutoApplyThreshold) {
    throw new CustomerWorkOsV2Error(
      "INVALID_POLICY",
      "reviewThreshold <= autoApplyThreshold <= linkAutoApplyThreshold is required",
    );
  }
  if (!Number.isSafeInteger(merged.maxQuestionsPerCapture) || merged.maxQuestionsPerCapture < 1 || merged.maxQuestionsPerCapture > 10) {
    throw new CustomerWorkOsV2Error("INVALID_POLICY", "maxQuestionsPerCapture must be 1..10");
  }
  if (!Number.isSafeInteger(merged.staleEngagementDays) || merged.staleEngagementDays < 1 || merged.staleEngagementDays > 365) {
    throw new CustomerWorkOsV2Error("INVALID_POLICY", "staleEngagementDays must be 1..365");
  }
  if (!Number.isSafeInteger(merged.minimumMarginBps) || merged.minimumMarginBps < -10_000 || merged.minimumMarginBps > 10_000) {
    throw new CustomerWorkOsV2Error("INVALID_POLICY", "minimumMarginBps must be -10000..10000");
  }
  return merged;
}

function detectPromptInjection(content: string): boolean {
  return [
    /ignore\s+(?:all\s+)?previous\s+instructions/i,
    /system\s+prompt/i,
    /reveal\s+(?:the\s+)?(?:secret|api\s*key|password)/i,
    /이전\s*(?:모든\s*)?지시(?:를|사항을)?\s*무시/i,
    /시스템\s*프롬프트/i,
    /비밀번호|api\s*key|ssh\s*key/i,
    /<script\b|javascript:/i,
  ].some((pattern) => pattern.test(content));
}

function compactSummary(content: string): string {
  const normalized = normalizeWhitespace(content);
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function parseKoreanAmountToken(token: string): string | undefined {
  const normalized = token.replace(/[\s,원]/g, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(억|천만|백만|만)?$/);
  if (!match) return undefined;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  const multiplier = match[2] === "억"
    ? 100_000_000
    : match[2] === "천만"
      ? 10_000_000
      : match[2] === "백만"
        ? 1_000_000
        : match[2] === "만"
          ? 10_000
          : 1;
  const result = numeric * multiplier;
  return Number.isSafeInteger(result) ? String(result) : undefined;
}

function extractMoneyMentions(content: string): Array<{ amountKrw: string; phrase: string; index: number }> {
  const mentions: Array<{ amountKrw: string; phrase: string; index: number }> = [];
  const pattern = /(\d+(?:[.,]\d+)?\s*(?:억|천만|백만|만)?\s*원?)/g;
  for (const match of content.matchAll(pattern)) {
    const phrase = match[1];
    const index = match.index ?? 0;
    if (!phrase) continue;
    const amountKrw = parseKoreanAmountToken(phrase);
    if (!amountKrw) continue;
    mentions.push({ amountKrw, phrase, index });
  }
  return mentions;
}

function dateFromKoreanPhrase(content: string, now: string): { date?: string; phrase?: string; ambiguous: boolean } {
  const isoDate = content.match(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (isoDate) {
    const value = `${isoDate[1]}-${String(Number(isoDate[2])).padStart(2, "0")}-${String(Number(isoDate[3])).padStart(2, "0")}`;
    return { date: dateOnly(value, "extracted date"), phrase: isoDate[0], ambiguous: false };
  }
  const korean = content.match(/(?:(20\d{2})년\s*)?(\d{1,2})월\s*(\d{1,2})일/);
  if (korean) {
    const year = korean[1] ? Number(korean[1]) : new Date(now).getUTCFullYear();
    const value = `${year}-${String(Number(korean[2])).padStart(2, "0")}-${String(Number(korean[3])).padStart(2, "0")}`;
    return { date: dateOnly(value, "extracted date"), phrase: korean[0], ambiguous: false };
  }
  if (/다음\s*주|금주|이번\s*주|월말|검수\s*후|납품\s*후|계약\s*후/.test(content)) {
    const phrase = content.match(/다음\s*주|금주|이번\s*주|월말|검수\s*후|납품\s*후|계약\s*후/)?.[0];
    return { phrase, ambiguous: true };
  }
  return { ambiguous: false };
}

interface MatchCandidate {
  id: string;
  label: string;
  score: number;
}

function bestEntityMatch(
  content: string,
  entities: Array<{ id: string; label: string; aliases: string[] }>,
  learned: LearnedAlias[],
  scope: LearnableAliasScope,
): { best: MatchCandidate | undefined; alternatives: MatchCandidate[] } {
  const normalizedContent = normalizeEntity(content);
  const candidates: MatchCandidate[] = [];
  for (const entity of entities) {
    const labels = unique([entity.label, ...entity.aliases]);
    let score = 0;
    for (const label of labels) {
      const normalizedLabel = normalizeEntity(label);
      if (!normalizedLabel) continue;
      if (normalizedContent === normalizedLabel) score = Math.max(score, 1);
      else if (normalizedContent.includes(normalizedLabel)) score = Math.max(score, normalizedLabel.length >= 4 ? 0.98 : 0.93);
    }
    const learnedAliases = learned.filter((item) => item.scope === scope && item.canonicalId === entity.id && item.active);
    for (const item of learnedAliases) {
      if (normalizedContent.includes(normalizeEntity(item.alias))) score = Math.max(score, 0.995);
    }
    if (score > 0) candidates.push({ id: entity.id, label: entity.label, score });
  }
  candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return { best: candidates[0], alternatives: candidates.slice(0, 5) };
}

function inferDirection(window: string): "IN" | "OUT" | undefined {
  if (/지급|출금|매입|원가|비용|총판|벤더|공급사|외주|발주/.test(window)) return "OUT";
  if (/입금|수금|매출|잔금|계약금|중도금|고객|청구/.test(window)) return "IN";
  return undefined;
}

function riskFor(kind: IntelligenceCandidateKind, value: Record<string, unknown>): IntelligenceRisk {
  if (kind === "FINANCIAL_ITEM") return "CRITICAL";
  if (kind === "SCHEDULE_CHANGE" || kind === "CHANGE_REQUEST") return "HIGH";
  if (kind === "COMMITMENT" && value.externalPromise === true) return "HIGH";
  if (kind === "ACCOUNT_UPDATE" || kind === "ENGAGEMENT_UPDATE") return "HIGH";
  if (kind === "REQUIREMENT" || kind === "DOCUMENT") return "MEDIUM";
  return "LOW";
}

function approvalAction(kind: IntelligenceCandidateKind): string | null {
  switch (kind) {
    case "FINANCIAL_ITEM": return "INTELLIGENCE_FINANCE_APPLY";
    case "SCHEDULE_CHANGE": return "INTELLIGENCE_SCHEDULE_APPLY";
    case "CHANGE_REQUEST": return "INTELLIGENCE_CHANGE_REQUEST_APPLY";
    case "ACCOUNT_UPDATE": return "INTELLIGENCE_ACCOUNT_UPDATE";
    case "ENGAGEMENT_UPDATE": return "INTELLIGENCE_ENGAGEMENT_UPDATE";
    case "COMMITMENT": return "INTELLIGENCE_EXTERNAL_COMMITMENT";
    default: return null;
  }
}

function evidenceFromRefs(refs: readonly string[], source: CaptureRecord, phrase?: string): IntelligenceEvidence[] {
  const normalized = unique(refs);
  if (normalized.length > 0) {
    return normalized.map((ref) => ({ ref, excerpt: phrase ? phrase.slice(0, 500) : source.normalizedContent.slice(0, 500) }));
  }
  return evidence(source.sourceRef, source.normalizedContent, phrase);
}

function planStatus(plan: Pick<UpdatePlan, "candidates" | "questions">): UpdatePlan["status"] {
  if (plan.candidates.some((item) => item.status === "FAILED")) return "PARTIALLY_APPLIED";
  if (plan.candidates.length > 0 && plan.candidates.every((item) => item.status === "APPLIED" || item.status === "REJECTED")) {
    return "APPLIED";
  }
  if (plan.questions.some((item) => item.status === "OPEN")) return "AWAITING_CLARIFICATION";
  if (plan.candidates.some((item) => item.status === "NEEDS_APPROVAL")) return "AWAITING_APPROVAL";
  if (plan.candidates.some((item) => item.status === "READY_AUTO_APPLY" || item.status === "APPROVED")) return "READY";
  return "DRAFT";
}

function defaultInterpretation(
  source: CaptureRecord,
  context: IntelligenceContext,
  aliases: LearnedAlias[],
): StructuredInterpretation {
  const text = source.normalizedContent;
  const accountMatch = bestEntityMatch(
    text,
    context.accounts.map((item) => ({ id: item.id, label: item.name, aliases: item.aliases ?? [] })),
    aliases,
    "ACCOUNT",
  );
  const engagementMatch = bestEntityMatch(
    text,
    context.engagements.map((item) => ({ id: item.id, label: item.name, aliases: unique([item.projectKey, ...(item.aliases ?? [])]) })),
    aliases,
    "ENGAGEMENT",
  );

  const date = dateFromKoreanPhrase(text, context.now);
  const requirements: InterpretedRequirement[] = [];
  const unknowns: InterpretedUnknown[] = [];
  const commitments: InterpretedCommitment[] = [];
  const scheduleChanges: InterpretedScheduleChange[] = [];
  const financialItems: InterpretedFinancialItem[] = [];
  const warnings: string[] = [];

  for (const sentence of text.split(/(?<=[.!?。]|다\.|요\.)\s+|\n+/).map((item) => item.trim()).filter(Boolean)) {
    if (/미확인|확인\s*필요|불명확|모름|아직\s*모르/.test(sentence)) {
      unknowns.push({
        statement: sentence,
        impact: "확정 정보로 사용하기 전에 확인이 필요합니다.",
        evidenceRefs: [source.sourceRef],
        confidence: 0.94,
      });
    } else if (/요구|필요|해야\s*함|원함|부탁/.test(sentence)) {
      requirements.push({
        statement: sentence,
        confirmed: false,
        evidenceRefs: [source.sourceRef],
        confidence: 0.86,
      });
    }
    if (/회신|보내|전달|제출|확인|작성|공유/.test(sentence)) {
      const due = dateFromKoreanPhrase(sentence, context.now);
      commitments.push({
        description: sentence,
        ...(due.date ? { dueAt: `${due.date}T09:00:00.000Z` } : {}),
        externalPromise: /고객|회신|보내|전달|제출/.test(sentence),
        evidenceRefs: [source.sourceRef],
        confidence: due.ambiguous ? 0.68 : due.date ? 0.92 : 0.76,
      });
    }
  }

  if (/검수|납품|착수|완료|일정|예정일/.test(text) && (date.date || date.ambiguous)) {
    scheduleChanges.push({
      field: /검수/.test(text) ? "acceptanceDate" : "targetDate",
      ...(date.date ? { date: date.date } : {}),
      phrase: date.phrase ?? "일정 표현",
      evidenceRefs: [source.sourceRef],
      confidence: date.date ? 0.93 : 0.62,
    });
  }

  for (const mention of extractMoneyMentions(text)) {
    const window = text.slice(Math.max(0, mention.index - 35), Math.min(text.length, mention.index + mention.phrase.length + 35));
    const direction = inferDirection(window);
    if (!direction) {
      warnings.push(`금액 ${mention.phrase}의 입금/출금 방향을 확인해야 합니다.`);
      continue;
    }
    const netAmountKrw = mention.amountKrw;
    const vatAmountKrw = "0";
    financialItems.push({
      direction,
      category: direction === "IN" ? "contract_revenue" : /라이선스/.test(window) ? "license_cost" : "hardware_cost",
      netAmountKrw,
      vatAmountKrw,
      grossAmountKrw: netAmountKrw,
      ...(date.date ? { expectedDate: date.date } : {}),
      memo: window,
      evidenceRefs: [source.sourceRef],
      confidence: date.date ? 0.86 : 0.78,
    });
  }

  const changeRequests = /추가|변경/.test(text) && /요청|연동|범위|작업/.test(text)
    ? [{
        description: compactSummary(text),
        scopeImpact: "기존 계약·제안 범위와 비교가 필요합니다.",
        evidenceRefs: [source.sourceRef],
        confidence: 0.82,
      }]
    : [];

  return {
    ...(accountMatch.best ? { accountId: accountMatch.best.id, accountConfidence: accountMatch.best.score } : {}),
    ...(engagementMatch.best ? { engagementId: engagementMatch.best.id, engagementConfidence: engagementMatch.best.score } : {}),
    activitySummary: compactSummary(text),
    requirements,
    unknowns,
    commitments,
    scheduleChanges,
    financialItems,
    changeRequests,
    documentRefs: source.attachmentRefs.map((storageUri, index) => ({
      title: source.subject ?? `첨부 문서 ${index + 1}`,
      type: "other",
      storageUri,
      evidenceRefs: [source.sourceRef],
      confidence: 0.8,
    })),
    warnings,
  };
}

function validateInterpretation(input: StructuredInterpretation): StructuredInterpretation {
  required(input.activitySummary, "activitySummary");
  const validateRefs = (refs: string[], field: string): string[] => {
    const result = unique(refs);
    if (result.length === 0) throw new CustomerWorkOsV2Error("EVIDENCE_REQUIRED", `${field} requires evidence`);
    return result;
  };
  return {
    ...(input.accountId ? { accountId: required(input.accountId, "accountId") } : {}),
    ...(input.accountConfidence !== undefined ? { accountConfidence: clampConfidence(input.accountConfidence, "accountConfidence") } : {}),
    ...(input.engagementId ? { engagementId: required(input.engagementId, "engagementId") } : {}),
    ...(input.engagementConfidence !== undefined ? { engagementConfidence: clampConfidence(input.engagementConfidence, "engagementConfidence") } : {}),
    activitySummary: required(input.activitySummary, "activitySummary"),
    requirements: input.requirements.map((item) => ({
      ...copy(item),
      statement: required(item.statement, "requirement.statement"),
      evidenceRefs: validateRefs(item.evidenceRefs, "requirement.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    unknowns: input.unknowns.map((item) => ({
      ...copy(item),
      statement: required(item.statement, "unknown.statement"),
      evidenceRefs: validateRefs(item.evidenceRefs, "unknown.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    commitments: input.commitments.map((item) => ({
      ...copy(item),
      description: required(item.description, "commitment.description"),
      ...(item.dueAt ? { dueAt: iso(item.dueAt, "commitment.dueAt") } : {}),
      evidenceRefs: validateRefs(item.evidenceRefs, "commitment.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    scheduleChanges: input.scheduleChanges.map((item) => ({
      ...copy(item),
      ...(item.date ? { date: dateOnly(item.date, "schedule.date") } : {}),
      phrase: required(item.phrase, "schedule.phrase"),
      evidenceRefs: validateRefs(item.evidenceRefs, "schedule.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    financialItems: input.financialItems.map((item) => {
      const net = integerMoney(item.netAmountKrw, "financial.netAmountKrw");
      const vat = integerMoney(item.vatAmountKrw, "financial.vatAmountKrw");
      const gross = integerMoney(item.grossAmountKrw, "financial.grossAmountKrw");
      if (net !== undefined && vat !== undefined && gross !== undefined && net + vat !== gross) {
        throw new CustomerWorkOsV2Error("VAT_MISMATCH", "financial gross must equal net plus VAT");
      }
      return {
        ...copy(item),
        memo: required(item.memo, "financial.memo"),
        ...(item.expectedDate ? { expectedDate: dateOnly(item.expectedDate, "financial.expectedDate") } : {}),
        ...(item.contractualDueDate ? { contractualDueDate: dateOnly(item.contractualDueDate, "financial.contractualDueDate") } : {}),
        evidenceRefs: validateRefs(item.evidenceRefs, "financial.evidenceRefs"),
        confidence: clampConfidence(item.confidence),
      };
    }),
    changeRequests: input.changeRequests.map((item) => ({
      ...copy(item),
      description: required(item.description, "change.description"),
      scopeImpact: required(item.scopeImpact, "change.scopeImpact"),
      evidenceRefs: validateRefs(item.evidenceRefs, "change.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    documentRefs: input.documentRefs.map((item) => ({
      ...copy(item),
      title: required(item.title, "document.title"),
      type: required(item.type, "document.type"),
      storageUri: required(item.storageUri, "document.storageUri"),
      evidenceRefs: validateRefs(item.evidenceRefs, "document.evidenceRefs"),
      confidence: clampConfidence(item.confidence),
    })),
    warnings: unique(input.warnings),
  };
}

export class CustomerWorkIntelligenceService {
  private captures = new Map<string, CaptureRecord>();
  private plans = new Map<string, UpdatePlan>();
  private baselines = new Map<string, BaselineBuildResult>();
  private aliases = new Map<string, LearnedAlias>();
  private corrections = new Map<string, CorrectionRecord>();
  private managerFindings = new Map<string, ManagerFinding>();
  private dailyBriefs = new Map<string, DailyBrief>();
  private policy: IntelligencePolicy;

  constructor(
    policy?: Partial<IntelligencePolicy>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.policy = copyPolicy(policy);
  }

  buildBaseline(input: BaselineBuildInput, actor: V2Actor): BaselineBuildResult {
    assertHuman(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    if (this.baselines.has(input.id)) {
      throw new CustomerWorkOsV2Error("DUPLICATE_BASELINE", `baseline already exists: ${input.id}`);
    }
    iso(input.snapshotAt, "snapshotAt");

    const unresolved: BaselineUnresolvedItem[] = [];
    const accountGroups = new Map<string, BaselineAccountInput[]>();
    for (const account of input.accounts) {
      const name = required(account.name, "baseline account name");
      const key = normalizeEntity(name);
      if (!key) throw new CustomerWorkOsV2Error("INVALID_INPUT", "baseline account name cannot normalize to empty");
      const current = accountGroups.get(key) ?? [];
      current.push(copy(account));
      accountGroups.set(key, current);
    }

    const accounts: BaselineCanonicalAccount[] = [];
    const accountSourceMap = new Map<string, string>();
    for (const [key, group] of [...accountGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const canonicalId = `account-${intelligenceHash({ workspaceId: input.workspaceId, key }).slice(0, 16)}`;
      const names = unique(group.map((item) => item.name));
      const canonical: BaselineCanonicalAccount = {
        canonicalId,
        name: names.sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? key,
        sourceIds: unique(group.map((item) => item.sourceId)),
        aliases: unique(group.flatMap((item) => [item.name, ...(item.aliases ?? [])])),
        emails: unique(group.flatMap((item) => item.emails ?? [])),
        phones: unique(group.flatMap((item) => item.phones ?? [])),
        evidenceRefs: unique(group.flatMap((item) => item.evidenceRefs ?? [])),
      };
      for (const sourceId of canonical.sourceIds) accountSourceMap.set(sourceId, canonicalId);
      if (group.length > 1) {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ canonicalId, kind: "DUPLICATE_ACCOUNT" }).slice(0, 16)}`,
          kind: "DUPLICATE_ACCOUNT",
          sourceId: canonical.sourceIds.join(","),
          summary: `${group.length}개 고객 원본을 ${canonical.name} 후보로 통합했습니다.`,
          candidateIds: [canonicalId],
          evidenceRefs: canonical.evidenceRefs,
          severity: "INFO",
        });
      }
      accounts.push(canonical);
    }

    const engagementGroups = new Map<string, BaselineEngagementInput[]>();
    for (const engagement of input.engagements) {
      const name = required(engagement.name, "baseline engagement name");
      const key = engagement.projectKey?.trim()
        ? `key:${engagement.projectKey.trim().toLocaleUpperCase("en-US")}`
        : `name:${normalizeEntity(name)}:${unique((engagement.accountRefs ?? []).map((ref) => accountSourceMap.get(ref) ?? ref)).join("|")}`;
      const current = engagementGroups.get(key) ?? [];
      current.push(copy(engagement));
      engagementGroups.set(key, current);
    }

    const engagements: BaselineCanonicalEngagement[] = [];
    const engagementSourceMap = new Map<string, string>();
    for (const [key, group] of [...engagementGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const canonicalId = `engagement-${intelligenceHash({ workspaceId: input.workspaceId, key }).slice(0, 16)}`;
      const projectKeys = unique(group.map((item) => item.projectKey ?? ""));
      const targets = unique(group.map((item) => item.targetDate ?? ""));
      for (const target of targets) dateOnly(target, "baseline targetDate");
      const canonical: BaselineCanonicalEngagement = {
        canonicalId,
        projectKey: projectKeys[0] ?? null,
        name: unique(group.map((item) => item.name)).sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? key,
        sourceIds: unique(group.map((item) => item.sourceId)),
        accountCanonicalIds: unique(group.flatMap((item) => (item.accountRefs ?? []).map((ref) => accountSourceMap.get(ref) ?? "")).filter(Boolean)),
        aliases: unique(group.flatMap((item) => [item.name, ...(item.aliases ?? [])])),
        stage: unique(group.map((item) => item.stage ?? ""))[0] ?? null,
        targetDate: targets[0] ?? null,
        evidenceRefs: unique(group.flatMap((item) => item.evidenceRefs ?? [])),
      };
      for (const sourceId of canonical.sourceIds) engagementSourceMap.set(sourceId, canonicalId);
      if (!canonical.projectKey) {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ canonicalId, kind: "MISSING_PROJECT_KEY" }).slice(0, 16)}`,
          kind: "MISSING_PROJECT_KEY",
          sourceId: canonical.sourceIds.join(","),
          summary: `${canonical.name}의 프로젝트 키가 없습니다.`,
          candidateIds: [canonicalId],
          evidenceRefs: canonical.evidenceRefs,
          severity: "WARNING",
        });
      }
      if (targets.length > 1) {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ canonicalId, kind: "INVALID_DATE", targets }).slice(0, 16)}`,
          kind: "INVALID_DATE",
          sourceId: canonical.sourceIds.join(","),
          summary: `${canonical.name}에 서로 다른 목표일이 있습니다: ${targets.join(", ")}`,
          candidateIds: [canonicalId],
          evidenceRefs: canonical.evidenceRefs,
          severity: "BLOCKING",
        });
      }
      engagements.push(canonical);
    }

    for (const activity of input.activities) {
      iso(activity.occurredAt, "activity.occurredAt");
      const accountId = activity.accountRef ? accountSourceMap.get(activity.accountRef) : undefined;
      const engagementId = activity.engagementRef ? engagementSourceMap.get(activity.engagementRef) : undefined;
      if (!accountId && !engagementId) {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ activity: activity.sourceId, kind: "ORPHAN_ACTIVITY" }).slice(0, 16)}`,
          kind: "ORPHAN_ACTIVITY",
          sourceId: activity.sourceId,
          summary: `활동을 고객 또는 프로젝트에 연결할 수 없습니다: ${compactSummary(activity.summary)}`,
          candidateIds: [],
          evidenceRefs: unique(activity.evidenceRefs ?? []),
          severity: "WARNING",
        });
      }
    }

    for (const financial of input.financialItems) {
      const net = integerMoney(financial.netAmountKrw, "baseline financial net");
      const vat = integerMoney(financial.vatAmountKrw, "baseline financial VAT");
      const gross = integerMoney(financial.grossAmountKrw, "baseline financial gross");
      if (net !== undefined && vat !== undefined && gross !== undefined && net + vat !== gross) {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ financial: financial.sourceId, kind: "MONEY_MISMATCH" }).slice(0, 16)}`,
          kind: "MONEY_MISMATCH",
          sourceId: financial.sourceId,
          summary: `공급가액·부가세·합계가 일치하지 않습니다: ${financial.memo}`,
          candidateIds: [],
          evidenceRefs: unique(financial.evidenceRefs ?? []),
          severity: "BLOCKING",
        });
      }
      if (financial.expectedDate) dateOnly(financial.expectedDate, "baseline financial expectedDate");
      const linked = financial.engagementRef
        ? engagementSourceMap.get(financial.engagementRef)
        : financial.projectKey
          ? engagements.find((item) => item.projectKey === financial.projectKey)?.canonicalId
          : undefined;
      if (!linked && financial.direction !== "OUT") {
        unresolved.push({
          id: `unresolved-${intelligenceHash({ financial: financial.sourceId, kind: "ORPHAN_FINANCE" }).slice(0, 16)}`,
          kind: "ORPHAN_FINANCE",
          sourceId: financial.sourceId,
          summary: `재무 항목을 프로젝트에 연결할 수 없습니다: ${financial.memo}`,
          candidateIds: [],
          evidenceRefs: unique(financial.evidenceRefs ?? []),
          severity: "BLOCKING",
        });
      }
    }

    const blockingUnresolved = unresolved.filter((item) => item.severity === "BLOCKING").length;
    const result: BaselineBuildResult = {
      id: required(input.id, "baseline.id"),
      workspaceId: input.workspaceId,
      snapshotAt: input.snapshotAt,
      accounts,
      engagements,
      unresolved: unresolved.sort((left, right) => left.severity.localeCompare(right.severity) || left.id.localeCompare(right.id)),
      metrics: {
        sourceAccounts: input.accounts.length,
        canonicalAccounts: accounts.length,
        sourceEngagements: input.engagements.length,
        canonicalEngagements: engagements.length,
        activities: input.activities.length,
        financialItems: input.financialItems.length,
        blockingUnresolved,
        totalUnresolved: unresolved.length,
      },
      status: blockingUnresolved > 0 ? "BLOCKED" : unresolved.length > 0 ? "NEEDS_REVIEW" : "READY",
      createdByPrincipalId: actor.principalId,
      createdAt: iso(this.now(), "createdAt"),
      version: 1,
    };
    this.baselines.set(result.id, result);
    return copy(result);
  }

  captureAndPlan(
    input: CaptureInput,
    context: IntelligenceContext,
    actor: V2Actor,
    modelInterpretation?: StructuredInterpretation,
  ): { capture: CaptureRecord; plan: UpdatePlan; replayed: boolean } {
    if (actor.kind === "ai") {
      throw new CustomerWorkOsV2Error("HUMAN_OR_SERVICE_REQUIRED", "raw capture requires a human or service principal");
    }
    assertWorkspace(actor.workspaceId, input.workspaceId);
    iso(input.receivedAt, "capture.receivedAt");
    iso(context.now, "context.now");
    required(input.sourceRef, "capture.sourceRef");
    const normalizedContent = normalizeWhitespace(required(input.content, "capture.content"));
    const contentHash = intelligenceHash({ channel: input.channel, sourceRef: input.sourceRef, content: normalizedContent });
    const duplicate = [...this.captures.values()].find((item) =>
      item.workspaceId === input.workspaceId && item.contentHash === contentHash,
    );
    if (duplicate) {
      const existingPlan = [...this.plans.values()].find((item) => item.sourceEventId === duplicate.id);
      if (!existingPlan) throw new CustomerWorkOsV2Error("INVALID_STATE", "duplicate capture has no update plan");
      return { capture: copy(duplicate), plan: copy(existingPlan), replayed: true };
    }
    if (this.captures.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_CAPTURE", `capture id already exists: ${input.id}`);

    const promptInjectionSuspected = detectPromptInjection(normalizedContent);
    const capture: CaptureRecord = {
      id: required(input.id, "capture.id"),
      workspaceId: input.workspaceId,
      channel: input.channel,
      sourceRef: input.sourceRef,
      receivedAt: input.receivedAt,
      contentHash,
      normalizedContent: normalizedContent.slice(0, 20_000),
      sender: input.sender?.trim() || null,
      subject: input.subject?.trim() || null,
      attachmentRefs: unique(input.attachmentRefs ?? []),
      language: input.language?.trim() || "ko",
      metadata: copy(input.metadata ?? {}),
      status: promptInjectionSuspected ? "QUARANTINED" : "CAPTURED",
      promptInjectionSuspected,
      duplicateOfCaptureId: null,
      createdByPrincipalId: actor.principalId,
      version: 1,
    };
    this.captures.set(capture.id, capture);

    const planId = `plan-${capture.id}`;
    if (promptInjectionSuspected) {
      const quarantined: UpdatePlan = {
        id: planId,
        workspaceId: input.workspaceId,
        sourceEventId: capture.id,
        accountId: null,
        engagementId: null,
        candidates: [],
        questions: [],
        deferredQuestionCount: 0,
        status: "QUARANTINED",
        summary: "Prompt injection 또는 비밀정보 탈취 시도가 의심되어 자동 처리를 중단했습니다.",
        createdByPrincipalId: actor.principalId,
        createdAt: iso(this.now(), "createdAt"),
        updatedAt: iso(this.now(), "updatedAt"),
        version: 1,
      };
      this.plans.set(quarantined.id, quarantined);
      return { capture: copy(capture), plan: copy(quarantined), replayed: false };
    }

    const interpretation = validateInterpretation(
      modelInterpretation ?? defaultInterpretation(capture, context, [...this.aliases.values()]),
    );
    const candidates: IntelligenceCandidate[] = [];
    const makeCandidate = (
      kind: IntelligenceCandidateKind,
      targetType: string,
      targetId: string | null,
      field: string,
      value: Record<string, unknown>,
      confidence: number,
      sourceEvidence: IntelligenceEvidence[],
      rationale: string,
    ): void => {
      const id = `candidate-${intelligenceHash({ planId, kind, targetType, targetId, field, value, index: candidates.length }).slice(0, 16)}`;
      const risk = riskFor(kind, value);
      const protectedCandidate = PROTECTED_KINDS.has(kind) || (kind === "COMMITMENT" && value.externalPromise === true);
      const linkCandidate = kind === "ACCOUNT_LINK" || kind === "ENGAGEMENT_LINK";
      const threshold = linkCandidate ? this.policy.linkAutoApplyThreshold : this.policy.autoApplyThreshold;
      const status = protectedCandidate
        ? "NEEDS_APPROVAL"
        : confidence < this.policy.reviewThreshold
          ? "NEEDS_CLARIFICATION"
          : confidence >= threshold
            ? "READY_AUTO_APPLY"
            : "NEEDS_CLARIFICATION";
      const payloadHash = intelligenceHash({ kind, targetType, targetId, field, value, evidence: sourceEvidence });
      candidates.push({
        id,
        workspaceId: input.workspaceId,
        sourceEventId: capture.id,
        planId,
        kind,
        targetType,
        targetId,
        field,
        value: copy(value),
        confidence: clampConfidence(confidence),
        risk,
        evidence: copy(sourceEvidence),
        rationale,
        status,
        payloadHash,
        approvalAction: protectedCandidate ? approvalAction(kind) : null,
        approvedByPrincipalId: null,
        appliedReceiptRef: null,
        failureCode: null,
        version: 1,
      });
    };

    if (interpretation.accountId) {
      makeCandidate(
        "ACCOUNT_LINK",
        "account",
        interpretation.accountId,
        "accountId",
        { accountId: interpretation.accountId },
        interpretation.accountConfidence ?? 0.8,
        evidenceFromRefs([capture.sourceRef], capture),
        "입력 본문과 고객명·별칭을 비교했습니다.",
      );
    }
    if (interpretation.engagementId) {
      makeCandidate(
        "ENGAGEMENT_LINK",
        "engagement",
        interpretation.engagementId,
        "engagementId",
        { engagementId: interpretation.engagementId },
        interpretation.engagementConfidence ?? 0.8,
        evidenceFromRefs([capture.sourceRef], capture),
        "프로젝트 키·프로젝트명·별칭을 비교했습니다.",
      );
    }
    makeCandidate(
      "ACTIVITY",
      "activity",
      null,
      "summary",
      {
        summary: interpretation.activitySummary,
        type: input.channel === "EMAIL" ? "email_in" : input.channel === "MEETING" ? "meeting" : input.channel === "MESSAGE" ? "message" : "note",
        occurredAt: input.receivedAt,
        accountId: interpretation.accountId ?? null,
        engagementId: interpretation.engagementId ?? null,
        sourceRef: capture.sourceRef,
      },
      0.99,
      evidenceFromRefs([capture.sourceRef], capture),
      "모든 입력은 감사 가능한 활동 타임라인으로 남깁니다.",
    );

    for (const item of interpretation.requirements) {
      makeCandidate(
        "REQUIREMENT",
        "knowledge",
        interpretation.engagementId ?? null,
        "requirement",
        { statement: item.statement, confirmed: item.confirmed, engagementId: interpretation.engagementId ?? null },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.statement),
        "요구 표현을 프로젝트 요구사항 후보로 분류했습니다.",
      );
    }
    for (const item of interpretation.unknowns) {
      makeCandidate(
        "UNKNOWN",
        "knowledge",
        interpretation.engagementId ?? null,
        "unknown",
        { statement: item.statement, impact: item.impact ?? null, engagementId: interpretation.engagementId ?? null },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.statement),
        "확정 사실과 가정을 분리하기 위해 미확인 항목으로 등록합니다.",
      );
    }
    for (const item of interpretation.commitments) {
      makeCandidate(
        "COMMITMENT",
        "commitment",
        interpretation.engagementId ?? null,
        "commitment",
        {
          description: item.description,
          dueAt: item.dueAt ?? null,
          externalPromise: item.externalPromise,
          engagementId: interpretation.engagementId ?? null,
          ownerPrincipalId: context.defaultOwnerPrincipalId,
        },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.description),
        item.externalPromise ? "고객에게 영향을 주는 약속은 명시적 승인을 요구합니다." : "내부 다음 행동 후보입니다.",
      );
    }
    for (const item of interpretation.scheduleChanges) {
      makeCandidate(
        "SCHEDULE_CHANGE",
        "engagement",
        interpretation.engagementId ?? null,
        item.field,
        { field: item.field, date: item.date ?? null, phrase: item.phrase, engagementId: interpretation.engagementId ?? null },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.phrase),
        "일정 변경은 다른 약속·청구일에 영향을 줄 수 있어 승인 후 반영합니다.",
      );
    }
    for (const item of interpretation.financialItems) {
      makeCandidate(
        "FINANCIAL_ITEM",
        "financialItem",
        null,
        "financialItem",
        {
          ...copy(item),
          accountId: interpretation.accountId ?? null,
          engagementId: interpretation.engagementId ?? null,
        },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.memo),
        "금액·입출금 정보는 자동 확정하지 않고 정확한 값과 방향을 승인받습니다.",
      );
    }
    for (const item of interpretation.changeRequests) {
      makeCandidate(
        "CHANGE_REQUEST",
        "changeRequest",
        interpretation.engagementId ?? null,
        "scope",
        { ...copy(item), engagementId: interpretation.engagementId ?? null },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.description),
        "계약 밖 범위 확대 가능성이 있어 변경요청으로 검토합니다.",
      );
    }
    for (const item of interpretation.documentRefs) {
      makeCandidate(
        "DOCUMENT",
        "artifact",
        interpretation.engagementId ?? null,
        "document",
        { ...copy(item), engagementId: interpretation.engagementId ?? null, accountId: interpretation.accountId ?? null },
        item.confidence,
        evidenceFromRefs(item.evidenceRefs, capture, item.title),
        "첨부파일을 고객·프로젝트 문서 후보로 연결합니다.",
      );
    }

    const questions = this.questionsFor(planId, capture, candidates, context);
    const openCandidateIds = new Set(questions.flatMap((item) => item.candidateIds));
    let deferredQuestionCount = 0;
    for (const candidate of candidates) {
      if (candidate.status === "NEEDS_CLARIFICATION" && !openCandidateIds.has(candidate.id)) deferredQuestionCount += 1;
    }
    const createdAt = iso(this.now(), "createdAt");
    const plan: UpdatePlan = {
      id: planId,
      workspaceId: input.workspaceId,
      sourceEventId: capture.id,
      accountId: interpretation.accountId ?? null,
      engagementId: interpretation.engagementId ?? null,
      candidates,
      questions,
      deferredQuestionCount,
      status: planStatus({ candidates, questions }),
      summary: `${candidates.length}개 업데이트 후보, ${questions.length}개 확인 질문, ${interpretation.warnings.length}개 경고`,
      createdByPrincipalId: actor.principalId,
      createdAt,
      updatedAt: createdAt,
      version: 1,
    };
    this.plans.set(plan.id, plan);
    this.captures.set(capture.id, { ...capture, status: "ANALYZED", version: capture.version + 1 });
    return { capture: copy(this.captures.get(capture.id)!), plan: copy(plan), replayed: false };
  }

  answerQuestion(
    planId: string,
    questionId: string,
    answer: unknown,
    actor: V2Actor,
  ): UpdatePlan {
    assertHuman(actor);
    const plan = this.plan(actor.workspaceId, planId);
    const question = plan.questions.find((item) => item.id === questionId);
    if (!question) throw new CustomerWorkOsV2Error("QUESTION_NOT_FOUND", `question not found: ${questionId}`);
    if (question.status !== "OPEN") throw new CustomerWorkOsV2Error("QUESTION_ALREADY_ANSWERED", "question is not open");
    const option = typeof answer === "string" ? question.options.find((item) => item.id === answer) : undefined;
    const resolvedValue = option ? option.value : answer;
    if (resolvedValue === undefined || resolvedValue === null || resolvedValue === "") {
      throw new CustomerWorkOsV2Error("INVALID_ANSWER", "clarification answer is required");
    }
    question.status = "ANSWERED";
    question.answer = copy(resolvedValue);
    question.answeredByPrincipalId = actor.principalId;
    question.version += 1;
    for (const candidateId of question.candidateIds) {
      const candidate = plan.candidates.find((item) => item.id === candidateId);
      if (!candidate) continue;
      if (question.prompt.includes("고객")) {
        candidate.targetId = String(resolvedValue);
        candidate.value.accountId = String(resolvedValue);
      } else if (question.prompt.includes("프로젝트")) {
        candidate.targetId = String(resolvedValue);
        candidate.value.engagementId = String(resolvedValue);
      } else if (question.prompt.includes("날짜") || question.prompt.includes("언제")) {
        const value = String(resolvedValue);
        if (value !== "UNSCHEDULED") dateOnly(value, "clarification date");
        candidate.value.date = value === "UNSCHEDULED" ? null : value;
        candidate.value.dueAt = value === "UNSCHEDULED" ? null : `${value}T09:00:00.000Z`;
      } else if (question.prompt.includes("금액")) {
        const value = String(resolvedValue).replace(/[,\s원]/g, "");
        integerMoney(value, "clarification amount");
        candidate.value.netAmountKrw = value;
        candidate.value.grossAmountKrw = value;
        candidate.value.vatAmountKrw = "0";
      } else if (question.prompt.includes("입금") || question.prompt.includes("출금")) {
        if (resolvedValue !== "IN" && resolvedValue !== "OUT") {
          throw new CustomerWorkOsV2Error("INVALID_ANSWER", "financial direction must be IN or OUT");
        }
        candidate.value.direction = resolvedValue;
      } else {
        candidate.value.confirmedValue = copy(resolvedValue);
      }
      candidate.confidence = 1;
      candidate.payloadHash = intelligenceHash({
        kind: candidate.kind,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        field: candidate.field,
        value: candidate.value,
        evidence: candidate.evidence,
      });
      candidate.status = PROTECTED_KINDS.has(candidate.kind) || candidate.risk === "HIGH" || candidate.risk === "CRITICAL"
        ? "NEEDS_APPROVAL"
        : "READY_AUTO_APPLY";
      candidate.version += 1;
    }
    plan.status = planStatus(plan);
    plan.updatedAt = iso(this.now(), "updatedAt");
    plan.version += 1;
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  approveCandidates(
    planId: string,
    approvals: Array<{ candidateId: string; payloadHash: string }>,
    actor: V2Actor,
  ): UpdatePlan {
    assertHuman(actor);
    const plan = this.plan(actor.workspaceId, planId);
    if (approvals.length === 0) throw new CustomerWorkOsV2Error("APPROVAL_REQUIRED", "candidate approvals are required");
    for (const approval of approvals) {
      const candidate = plan.candidates.find((item) => item.id === approval.candidateId);
      if (!candidate) throw new CustomerWorkOsV2Error("CANDIDATE_NOT_FOUND", `candidate not found: ${approval.candidateId}`);
      if (candidate.payloadHash !== approval.payloadHash) {
        throw new CustomerWorkOsV2Error("STALE_APPROVAL", `candidate payload changed: ${candidate.id}`);
      }
      if (candidate.status !== "NEEDS_APPROVAL" && candidate.status !== "NEEDS_CLARIFICATION") {
        throw new CustomerWorkOsV2Error("INVALID_STATUS", `candidate ${candidate.id} cannot be approved from ${candidate.status}`);
      }
      if (candidate.status === "NEEDS_CLARIFICATION") {
        throw new CustomerWorkOsV2Error("CLARIFICATION_REQUIRED", `candidate ${candidate.id} still needs clarification`);
      }
      candidate.status = "APPROVED";
      candidate.approvedByPrincipalId = actor.principalId;
      candidate.version += 1;
    }
    plan.status = planStatus(plan);
    plan.updatedAt = iso(this.now(), "updatedAt");
    plan.version += 1;
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  rejectCandidates(planId: string, candidateIds: string[], actor: V2Actor): UpdatePlan {
    assertHuman(actor);
    const plan = this.plan(actor.workspaceId, planId);
    for (const candidateId of unique(candidateIds)) {
      const candidate = plan.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new CustomerWorkOsV2Error("CANDIDATE_NOT_FOUND", `candidate not found: ${candidateId}`);
      if (candidate.status === "APPLIED") throw new CustomerWorkOsV2Error("ALREADY_APPLIED", "applied candidate cannot be rejected");
      candidate.status = "REJECTED";
      candidate.version += 1;
    }
    plan.status = planStatus(plan);
    plan.updatedAt = iso(this.now(), "updatedAt");
    plan.version += 1;
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  readyCandidates(workspaceId: string, planId: string): IntelligenceCandidate[] {
    const plan = this.plan(workspaceId, planId);
    return plan.candidates
      .filter((item) => item.status === "READY_AUTO_APPLY" || item.status === "APPROVED")
      .map((item) => copy(item));
  }

  markApplied(
    planId: string,
    results: Array<{ candidateId: string; receiptRef: string; failureCode?: string }>,
    actor: V2Actor,
  ): UpdatePlan {
    assertHuman(actor);
    const plan = this.plan(actor.workspaceId, planId);
    for (const result of results) {
      const candidate = plan.candidates.find((item) => item.id === result.candidateId);
      if (!candidate) throw new CustomerWorkOsV2Error("CANDIDATE_NOT_FOUND", `candidate not found: ${result.candidateId}`);
      if (candidate.status !== "READY_AUTO_APPLY" && candidate.status !== "APPROVED") {
        throw new CustomerWorkOsV2Error("INVALID_STATUS", `candidate ${candidate.id} is not ready to apply`);
      }
      if (result.failureCode) {
        candidate.status = "FAILED";
        candidate.failureCode = required(result.failureCode, "failureCode");
      } else {
        candidate.status = "APPLIED";
        candidate.appliedReceiptRef = required(result.receiptRef, "receiptRef");
        candidate.failureCode = null;
      }
      candidate.version += 1;
    }
    plan.status = planStatus(plan);
    plan.updatedAt = iso(this.now(), "updatedAt");
    plan.version += 1;
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  recordCorrection(input: {
    id: string;
    workspaceId: string;
    sourceEventId?: string;
    planId?: string;
    field: string;
    previousValue: unknown;
    correctedValue: unknown;
    learn: boolean;
    learning?: {
      scope: LearnableAliasScope;
      alias: string;
      canonicalId: string;
      evidenceRef: string;
    };
  }, actor: V2Actor): CorrectionRecord {
    assertHuman(actor);
    assertWorkspace(actor.workspaceId, input.workspaceId);
    if (this.corrections.has(input.id)) throw new CustomerWorkOsV2Error("DUPLICATE_CORRECTION", "correction already exists");
    const field = required(input.field, "correction.field");
    if (input.learn && LEARNING_FORBIDDEN_FIELDS.some((token) => field.toLocaleLowerCase("en-US").includes(token))) {
      throw new CustomerWorkOsV2Error("UNSAFE_LEARNING_FORBIDDEN", `automatic learning is forbidden for ${field}`);
    }
    let learnedAliasId: string | null = null;
    if (input.learn) {
      if (!input.learning) throw new CustomerWorkOsV2Error("LEARNING_INPUT_REQUIRED", "safe learning requires alias metadata");
      const alias = normalizeWhitespace(required(input.learning.alias, "learning.alias"));
      const canonicalId = required(input.learning.canonicalId, "learning.canonicalId");
      learnedAliasId = `alias-${intelligenceHash({ workspaceId: input.workspaceId, scope: input.learning.scope, alias, canonicalId }).slice(0, 16)}`;
      const duplicate = [...this.aliases.values()].find((item) =>
        item.workspaceId === input.workspaceId &&
        item.scope === input.learning!.scope &&
        normalizeEntity(item.alias) === normalizeEntity(alias) &&
        item.active,
      );
      if (duplicate && duplicate.canonicalId !== canonicalId) {
        throw new CustomerWorkOsV2Error("ALIAS_CONFLICT", `alias already maps to ${duplicate.canonicalId}`);
      }
      const learned: LearnedAlias = duplicate ?? {
        id: learnedAliasId,
        workspaceId: input.workspaceId,
        scope: input.learning.scope,
        alias,
        canonicalId,
        sourcePlanId: input.planId?.trim() || null,
        evidenceRef: required(input.learning.evidenceRef, "learning.evidenceRef"),
        approvedByPrincipalId: actor.principalId,
        active: true,
        version: 1,
      };
      this.aliases.set(learned.id, learned);
      learnedAliasId = learned.id;
    }
    const correction: CorrectionRecord = {
      id: required(input.id, "correction.id"),
      workspaceId: input.workspaceId,
      sourceEventId: input.sourceEventId?.trim() || null,
      planId: input.planId?.trim() || null,
      field,
      previousValue: copy(input.previousValue),
      correctedValue: copy(input.correctedValue),
      learn: input.learn,
      learnedAliasId,
      correctedByPrincipalId: actor.principalId,
      correctedAt: iso(this.now(), "correctedAt"),
      version: 1,
    };
    this.corrections.set(correction.id, correction);
    return copy(correction);
  }

  runDailyManager(input: ManagerInputSnapshot, actor: V2Actor): DailyBrief {
    assertHuman(actor);
    iso(input.asOf, "manager.asOf");
    const asOfMs = Date.parse(input.asOf);
    const activeStages = new Set(["INQUIRY", "DISCOVERY", "PROPOSAL", "NEGOTIATION", "CONTRACTED", "DELIVERY", "ACCEPTANCE", "BILLING", "COLLECTION"]);
    const findings: ManagerFinding[] = [];
    const addFinding = (
      kind: ManagerFinding["kind"],
      severity: ManagerFinding["severity"],
      engagementId: string,
      title: string,
      detail: string,
      recommendedAction: string,
      evidenceRefs: string[],
    ): void => {
      const id = `finding-${intelligenceHash({ workspaceId: actor.workspaceId, input: input.asOf.slice(0, 10), kind, engagementId, title }).slice(0, 16)}`;
      const existing = this.managerFindings.get(id);
      findings.push(existing ?? {
        id,
        workspaceId: actor.workspaceId,
        asOf: input.asOf,
        kind,
        severity,
        engagementId,
        title,
        detail,
        recommendedAction,
        evidenceRefs: unique(evidenceRefs),
        status: "OPEN",
        version: 1,
      });
    };

    for (const engagement of input.engagements) {
      if (!activeStages.has(engagement.stage)) continue;
      const openCommitments = input.commitments.filter((item) =>
        item.engagementId === engagement.id && !["DONE", "CANCELLED"].includes(item.status),
      );
      if (openCommitments.length === 0) {
        addFinding(
          "NO_NEXT_ACTION",
          "CRITICAL",
          engagement.id,
          `${engagement.name}: 다음 행동 없음`,
          "진행 중인 고객사업에는 완료되지 않은 다음 행동이 최소 하나 필요합니다.",
          "고객 또는 내부 다음 행동과 기한을 등록하세요.",
          [`engagement://${engagement.id}`],
        );
      }
      const lastActivity = input.activities
        .filter((item) => item.engagementId === engagement.id)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
      const staleMs = this.policy.staleEngagementDays * 86_400_000;
      if (!lastActivity || asOfMs - Date.parse(lastActivity.occurredAt) > staleMs) {
        addFinding(
          "STALE_ENGAGEMENT",
          "WARNING",
          engagement.id,
          `${engagement.name}: ${this.policy.staleEngagementDays}일 이상 활동 없음`,
          lastActivity ? `최근 활동: ${lastActivity.occurredAt}` : "기록된 활동이 없습니다.",
          "고객 상태를 확인하고 후속 연락 여부를 결정하세요.",
          lastActivity ? [`activity://${lastActivity.id}`] : [`engagement://${engagement.id}`],
        );
      }
    }

    for (const commitment of input.commitments) {
      if (!["DONE", "CANCELLED"].includes(commitment.status) && Date.parse(commitment.dueAt) < asOfMs) {
        addFinding(
          "OVERDUE_COMMITMENT",
          "CRITICAL",
          commitment.engagementId,
          `기한 초과 약속: ${commitment.description}`,
          `기한 ${commitment.dueAt}이 지났습니다.`,
          "완료·재일정·고객 안내 중 하나를 선택하세요.",
          [`commitment://${commitment.id}`],
        );
      }
    }

    for (const item of input.financialItems) {
      if (!item.engagementId || ["SETTLED", "CANCELLED"].includes(item.lifecycle)) continue;
      const due = item.contractualDueDate ?? item.expectedDate;
      if (Date.parse(`${due}T23:59:59.999Z`) >= asOfMs) continue;
      const incoming = item.direction === "IN";
      addFinding(
        incoming ? "OVERDUE_RECEIVABLE" : "OVERDUE_PAYABLE",
        incoming ? "CRITICAL" : "WARNING",
        item.engagementId,
        `${incoming ? "연체 미수" : "기한 경과 미지급"}: ${item.grossAmountKrw}원`,
        `예정 또는 지급기일 ${due}이 지났고 상태는 ${item.lifecycle}입니다.`,
        incoming ? "고객 회계 담당자 확인과 회신 초안을 준비하세요." : "지급 승인·증빙·자금계획을 확인하세요.",
        [`financial://${item.id}`],
      );
    }

    for (const item of input.changeRequests) {
      if (["ANALYZED", "AWAITING_APPROVAL"].includes(item.status) && BigInt(item.priceImpactKrw) > 0n) {
        addFinding(
          "UNPRICED_SCOPE_CHANGE",
          "CRITICAL",
          item.engagementId,
          "추가금액이 있는 범위 변경 미확정",
          `변경요청 ${item.id}의 추가 제안금액은 ${item.priceImpactKrw}원입니다.`,
          "무상·예비비·추가견적 중 처리방식을 승인하세요.",
          [`change-request://${item.id}`],
        );
      }
    }

    for (const summary of input.financeSummaries ?? []) {
      if (summary.forecastMarginBps < this.policy.minimumMarginBps) {
        addFinding(
          "MARGIN_RISK",
          "CRITICAL",
          summary.engagementId,
          `예상 이익률 저하: ${(summary.forecastMarginBps / 100).toFixed(2)}%`,
          `예상 최종이익 ${summary.forecastProfitKrw}원, 기준 ${this.policy.minimumMarginBps / 100}% 미만입니다.`,
          "원가·범위·판매가·남은 작업시간을 재검토하세요.",
          [`finance-summary://${summary.engagementId}`],
        );
      }
      if (BigInt(summary.cashPositionKrw) < 0n) {
        addFinding(
          "NEGATIVE_CASH",
          "WARNING",
          summary.engagementId,
          `프로젝트 현금 마이너스: ${summary.cashPositionKrw}원`,
          "입금보다 지급이 먼저 발생해 프로젝트 현금위치가 음수입니다.",
          "예상 입금일·지급일과 자금계획을 확인하세요.",
          [`finance-summary://${summary.engagementId}`],
        );
      }
    }

    for (const finding of findings) this.managerFindings.set(finding.id, finding);
    const sevenDays = asOfMs + 7 * 86_400_000;
    let incoming7d = 0n;
    let outgoing7d = 0n;
    for (const item of input.financialItems) {
      if (["SETTLED", "CANCELLED"].includes(item.lifecycle)) continue;
      const date = Date.parse(`${item.expectedDate}T00:00:00.000Z`);
      if (date < asOfMs || date > sevenDays) continue;
      if (item.direction === "IN") incoming7d += BigInt(item.grossAmountKrw);
      else outgoing7d += BigInt(item.grossAmountKrw);
    }
    const criticalCount = findings.filter((item) => item.severity === "CRITICAL").length;
    const warningCount = findings.filter((item) => item.severity === "WARNING").length;
    const brief: DailyBrief = {
      id: `brief-${actor.workspaceId}-${input.asOf.slice(0, 10)}`,
      workspaceId: actor.workspaceId,
      asOf: input.asOf,
      findingIds: findings.map((item) => item.id).sort(),
      criticalCount,
      warningCount,
      expectedIncoming7dKrw: incoming7d.toString(),
      expectedOutgoing7dKrw: outgoing7d.toString(),
      summary: `긴급 ${criticalCount}건, 주의 ${warningCount}건, 7일 입금 ${incoming7d}원, 7일 출금 ${outgoing7d}원`,
      createdByPrincipalId: actor.principalId,
      createdAt: iso(this.now(), "createdAt"),
      version: (this.dailyBriefs.get(`brief-${actor.workspaceId}-${input.asOf.slice(0, 10)}`)?.version ?? 0) + 1,
    };
    this.dailyBriefs.set(brief.id, brief);
    return copy(brief);
  }

  acknowledgeFinding(id: string, actor: V2Actor): ManagerFinding {
    assertHuman(actor);
    const item = this.managerFindings.get(id);
    if (!item) throw new CustomerWorkOsV2Error("FINDING_NOT_FOUND", `manager finding not found: ${id}`);
    assertWorkspace(actor.workspaceId, item.workspaceId);
    const next: ManagerFinding = { ...item, status: "ACKNOWLEDGED", version: item.version + 1 };
    this.managerFindings.set(id, next);
    return copy(next);
  }

  reviewQueue(workspaceId: string): { plans: UpdatePlan[]; questions: ClarificationQuestion[]; findings: ManagerFinding[] } {
    const plans = [...this.plans.values()]
      .filter((item) => item.workspaceId === workspaceId && !["APPLIED", "REJECTED", "QUARANTINED"].includes(item.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      plans: plans.map((item) => copy(item)),
      questions: plans.flatMap((item) => item.questions.filter((question) => question.status === "OPEN").map((question) => copy(question))),
      findings: [...this.managerFindings.values()]
        .filter((item) => item.workspaceId === workspaceId && item.status === "OPEN")
        .sort((left, right) => left.severity.localeCompare(right.severity) || left.id.localeCompare(right.id))
        .map((item) => copy(item)),
    };
  }

  latestBrief(workspaceId: string): DailyBrief | undefined {
    const value = [...this.dailyBriefs.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.asOf.localeCompare(left.asOf))[0];
    return value ? copy(value) : undefined;
  }

  getPlan(workspaceId: string, planId: string): UpdatePlan {
    return copy(this.plan(workspaceId, planId));
  }

  getBaseline(workspaceId: string, baselineId: string): BaselineBuildResult {
    const item = this.baselines.get(baselineId);
    if (!item) throw new CustomerWorkOsV2Error("BASELINE_NOT_FOUND", `baseline not found: ${baselineId}`);
    assertWorkspace(workspaceId, item.workspaceId);
    return copy(item);
  }

  exportState(): IntelligenceState {
    return {
      schemaVersion: 1,
      productVersion: "2.5.0",
      captures: [...this.captures.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      plans: [...this.plans.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      baselines: [...this.baselines.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      aliases: [...this.aliases.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      corrections: [...this.corrections.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      managerFindings: [...this.managerFindings.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      dailyBriefs: [...this.dailyBriefs.values()].sort((left, right) => left.id.localeCompare(right.id)).map((item) => copy(item)),
      policy: copy(this.policy),
    };
  }

  hydrateState(input: IntelligenceState): void {
    if (input.schemaVersion !== 1 || input.productVersion !== "2.5.0") {
      throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported intelligence state");
    }
    const policy = copyPolicy(input.policy);
    const mapById = <T extends { id: string; workspaceId: string }>(items: T[], label: string): Map<string, T> => {
      const result = new Map<string, T>();
      for (const item of items) {
        required(item.id, `${label}.id`);
        required(item.workspaceId, `${label}.workspaceId`);
        if (result.has(item.id)) throw new CustomerWorkOsV2Error("INVALID_STATE", `duplicate ${label}: ${item.id}`);
        result.set(item.id, copy(item));
      }
      return result;
    };
    const captures = mapById(input.captures, "capture");
    const plans = mapById(input.plans, "plan");
    for (const plan of plans.values()) {
      if (!captures.has(plan.sourceEventId)) throw new CustomerWorkOsV2Error("INVALID_STATE", `plan source capture missing: ${plan.id}`);
      for (const candidate of plan.candidates) {
        if (candidate.planId !== plan.id || candidate.sourceEventId !== plan.sourceEventId || candidate.workspaceId !== plan.workspaceId) {
          throw new CustomerWorkOsV2Error("INVALID_STATE", `candidate boundary mismatch: ${candidate.id}`);
        }
        const expectedHash = intelligenceHash({
          kind: candidate.kind,
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          field: candidate.field,
          value: candidate.value,
          evidence: candidate.evidence,
        });
        if (candidate.payloadHash !== expectedHash) throw new CustomerWorkOsV2Error("STATE_HASH_MISMATCH", `candidate hash mismatch: ${candidate.id}`);
      }
    }
    this.captures = captures;
    this.plans = plans;
    this.baselines = mapById(input.baselines, "baseline");
    this.aliases = mapById(input.aliases, "alias");
    this.corrections = mapById(input.corrections, "correction");
    this.managerFindings = mapById(input.managerFindings, "manager finding");
    this.dailyBriefs = mapById(input.dailyBriefs, "daily brief");
    this.policy = policy;
  }

  private questionsFor(
    planId: string,
    capture: CaptureRecord,
    candidates: IntelligenceCandidate[],
    context: IntelligenceContext,
  ): ClarificationQuestion[] {
    const drafts: Array<{ priority: number; candidate: IntelligenceCandidate; prompt: string; options: ClarificationOption[] }> = [];
    for (const candidate of candidates.filter((item) => item.status === "NEEDS_CLARIFICATION")) {
      if (candidate.kind === "ACCOUNT_LINK") {
        drafts.push({
          priority: 100,
          candidate,
          prompt: "이 입력은 어느 고객과 관련 있나요?",
          options: context.accounts.slice(0, 5).map((item) => ({ id: item.id, label: item.name, value: item.id })),
        });
      } else if (candidate.kind === "ENGAGEMENT_LINK" || candidate.targetId === null && candidate.value.engagementId === null) {
        drafts.push({
          priority: 95,
          candidate,
          prompt: "이 입력은 어느 프로젝트와 관련 있나요?",
          options: context.engagements.slice(0, 5).map((item) => ({ id: item.id, label: `${item.projectKey} ${item.name}`, value: item.id })),
        });
      } else if (candidate.kind === "SCHEDULE_CHANGE" || candidate.kind === "COMMITMENT" && !candidate.value.dueAt) {
        drafts.push({
          priority: 90,
          candidate,
          prompt: "정확한 날짜는 언제인가요?",
          options: [{ id: "UNSCHEDULED", label: "날짜 미정으로 등록", value: "UNSCHEDULED" }],
        });
      } else if (candidate.kind === "FINANCIAL_ITEM" && !candidate.value.netAmountKrw) {
        drafts.push({ priority: 100, candidate, prompt: "정확한 금액을 입력해 주세요.", options: [] });
      } else if (candidate.kind === "FINANCIAL_ITEM" && !candidate.value.direction) {
        drafts.push({
          priority: 100,
          candidate,
          prompt: "이 금액은 입금인가요, 출금인가요?",
          options: [
            { id: "IN", label: "입금·매출", value: "IN" },
            { id: "OUT", label: "출금·매입", value: "OUT" },
          ],
        });
      } else {
        drafts.push({ priority: 50, candidate, prompt: `${candidate.field} 값을 확인해 주세요.`, options: [] });
      }
    }
    drafts.sort((left, right) => right.priority - left.priority || left.candidate.id.localeCompare(right.candidate.id));
    return drafts.slice(0, this.policy.maxQuestionsPerCapture).map((draft, index) => ({
      id: `question-${intelligenceHash({ planId, candidateId: draft.candidate.id, index }).slice(0, 16)}`,
      workspaceId: capture.workspaceId,
      sourceEventId: capture.id,
      planId,
      candidateIds: [draft.candidate.id],
      prompt: draft.prompt,
      options: copy(draft.options),
      evidence: copy(draft.candidate.evidence),
      status: "OPEN",
      answer: null,
      answeredByPrincipalId: null,
      version: 1,
    }));
  }

  private plan(workspaceId: string, planId: string): UpdatePlan {
    const item = this.plans.get(planId);
    if (!item) throw new CustomerWorkOsV2Error("PLAN_NOT_FOUND", `update plan not found: ${planId}`);
    assertWorkspace(workspaceId, item.workspaceId);
    return item;
  }
}

export function structuredInterpretationFromUnknown(value: unknown): StructuredInterpretation {
  return validateInterpretation(jsonObject(value, "interpretation") as unknown as StructuredInterpretation);
}
