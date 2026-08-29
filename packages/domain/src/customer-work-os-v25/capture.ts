import {
  CustomerWorkOsV25Error,
  DEFAULT_CONFIDENCE_POLICY,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  confidenceBand,
  copy,
  deterministicHash,
  mapById,
  normalizeText,
  required,
  sorted,
  type AutomationActor,
  type ConfidenceBand,
  type ConfidencePolicy,
  type RiskLevel,
} from "./shared.js";

export type CaptureKind =
  | "TEXT"
  | "EMAIL"
  | "MESSAGE"
  | "MEETING"
  | "VOICE_NOTE"
  | "DOCUMENT"
  | "IMAGE"
  | "CALENDAR"
  | "TRANSACTION"
  | "NOTION";

export interface CaptureAttachment {
  id: string;
  name: string;
  mediaType: string;
  storageRef: string;
  contentHash: string;
  malwareStatus: "CLEAN" | "INFECTED" | "UNKNOWN";
}

export interface CaptureInput {
  id: string;
  workspaceId: string;
  kind: CaptureKind;
  title: string | null;
  content: string;
  occurredAt: string;
  sender: string | null;
  sourceRef: string;
  providerEventId: string | null;
  attachments: CaptureAttachment[];
  language: string | null;
  createdByPrincipalId: string;
  contentHash: string;
  status: "RECEIVED" | "QUARANTINED" | "PLANNED" | "APPLIED" | "REJECTED";
  version: number;
}

export type MutationCategory =
  | "ACTIVITY"
  | "ACCOUNT_LINK"
  | "ENGAGEMENT_LINK"
  | "ENGAGEMENT_FIELD"
  | "REQUIREMENT"
  | "UNKNOWN"
  | "COMMITMENT"
  | "CHANGE_REQUEST"
  | "FINANCIAL_ITEM"
  | "SETTLEMENT"
  | "DOCUMENT";

export interface ProposedMutation {
  id: string;
  category: MutationCategory;
  operation: "CREATE" | "UPDATE" | "LINK";
  targetId: string | null;
  field: string | null;
  value: unknown;
  confidence: number;
  risk: RiskLevel;
  band: ConfidenceBand;
  evidenceRefs: string[];
  rationale: string;
  status: "PROPOSED" | "AUTO_APPROVED" | "APPROVED" | "REJECTED" | "APPLIED";
}

export interface CaptureQuestion {
  id: string;
  sourceId: string;
  mutationId: string | null;
  prompt: string;
  options: Array<{ id: string; label: string; value: unknown }>;
  status: "OPEN" | "ANSWERED" | "DEFERRED";
  answer: unknown | null;
  answeredByPrincipalId: string | null;
  version: number;
}

export interface UpdatePlan {
  id: string;
  workspaceId: string;
  sourceId: string;
  accountCandidateIds: string[];
  engagementCandidateIds: string[];
  mutations: ProposedMutation[];
  questionIds: string[];
  status: "AUTO_READY" | "NEEDS_REVIEW" | "APPROVED" | "APPLIED" | "REJECTED";
  createdAt: string;
  approvedAt: string | null;
  approvedByPrincipalId: string | null;
  version: number;
}

export interface CaptureContext {
  accountAliases: Array<{ id: string; aliases: string[] }>;
  engagementAliases: Array<{ id: string; aliases: string[]; projectKey?: string }>;
  defaultTimezone: string;
}

export interface UniversalCaptureState {
  schemaVersion: 1;
  sources: CaptureInput[];
  plans: UpdatePlan[];
  questions: CaptureQuestion[];
}

function convertMoney(raw: string, unit: string): string {
  const numeric = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new CustomerWorkOsV25Error("INVALID_MONEY", "money value is invalid");
  }
  const multiplier = unit === "억" || unit === "억원"
    ? 100_000_000
    : unit === "천만원"
      ? 10_000_000
      : unit === "만" || unit === "만원"
        ? 10_000
        : 1;
  return Math.round(numeric * multiplier).toString();
}

function moneyCandidates(content: string): Array<{ amountKrw: string; index: number; raw: string }> {
  const result: Array<{ amountKrw: string; index: number; raw: string }> = [];
  const pattern = /(\d[\d,]*(?:\.\d+)?)\s*(억원|억|천만원|만원|만|원)/g;
  for (const match of content.matchAll(pattern)) {
    result.push({ amountKrw: convertMoney(match[1]!, match[2]!), index: match.index ?? 0, raw: match[0] });
  }
  return result;
}

function dateCandidates(content: string): Array<{ isoDate: string; raw: string; index: number }> {
  const result: Array<{ isoDate: string; raw: string; index: number }> = [];
  const iso = /(20\d{2})[-./](\d{1,2})[-./](\d{1,2})/g;
  for (const match of content.matchAll(iso)) {
    const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    result.push({ isoDate: value.toISOString().slice(0, 10), raw: match[0], index: match.index ?? 0 });
  }
  const korean = /(\d{1,2})월\s*(\d{1,2})일/g;
  const year = new Date().getUTCFullYear();
  for (const match of content.matchAll(korean)) {
    const value = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
    result.push({ isoDate: value.toISOString().slice(0, 10), raw: match[0], index: match.index ?? 0 });
  }
  return result.sort((left, right) => left.index - right.index);
}

function projectKeys(content: string): string[] {
  return [...new Set(content.match(/PRJ-[A-Z0-9-]+/gi)?.map((value) => value.toUpperCase()) ?? [])];
}

function aliasCandidates(content: string, aliases: Array<{ id: string; aliases: string[] }>): string[] {
  const normalized = normalizeText(content);
  return aliases
    .filter((item) => item.aliases.some((alias) => normalized.includes(normalizeText(alias))))
    .map((item) => item.id)
    .sort();
}

function makeMutation(input: Omit<ProposedMutation, "id" | "band" | "status">, policy: ConfidencePolicy): ProposedMutation {
  const band = confidenceBand(input.confidence, input.risk, policy);
  return {
    ...copy(input),
    id: `mutation-${deterministicHash(input).slice(-16)}`,
    band,
    status: band === "AUTO" ? "AUTO_APPROVED" : "PROPOSED",
  };
}

export class UniversalCaptureService {
  private sources = new Map<string, CaptureInput>();
  private plans = new Map<string, UpdatePlan>();
  private questions = new Map<string, CaptureQuestion>();

  constructor(private readonly policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY) {}

  submit(
    raw: Omit<CaptureInput, "createdByPrincipalId" | "contentHash" | "status" | "version">,
    context: CaptureContext,
    actor: AutomationActor,
  ): UpdatePlan {
    assertHumanOrService(actor);
    assertWorkspace(actor, raw.workspaceId);
    const content = required(raw.content, "capture.content");
    const fingerprint = raw.providerEventId
      ? `${raw.kind}:${raw.providerEventId}`
      : deterministicHash({ kind: raw.kind, content, occurredAt: raw.occurredAt, sourceRef: raw.sourceRef });
    const duplicate = [...this.sources.values()].find((item) => item.workspaceId === raw.workspaceId && (item.providerEventId ? `${item.kind}:${item.providerEventId}` : item.contentHash) === fingerprint);
    if (duplicate) {
      const existing = [...this.plans.values()].find((item) => item.sourceId === duplicate.id);
      if (!existing) throw new CustomerWorkOsV25Error("INVALID_STATE", "duplicate source has no update plan");
      return copy(existing);
    }

    const unsafeAttachment = raw.attachments.some((item) => item.malwareStatus !== "CLEAN");
    const promptInjection = /ignore\s+(all|previous)|system\s+prompt|developer\s+message|지시를\s*무시|프롬프트를\s*공개/i.test(content);
    const source: CaptureInput = {
      ...copy(raw),
      id: required(raw.id, "capture.id"),
      sourceRef: required(raw.sourceRef, "capture.sourceRef"),
      content,
      createdByPrincipalId: actor.principalId,
      contentHash: fingerprint,
      status: unsafeAttachment || promptInjection ? "QUARANTINED" : "RECEIVED",
      version: 1,
    };
    this.sources.set(source.id, source);
    if (source.status === "QUARANTINED") {
      const plan: UpdatePlan = {
        id: `plan-${source.id}`,
        workspaceId: source.workspaceId,
        sourceId: source.id,
        accountCandidateIds: [],
        engagementCandidateIds: [],
        mutations: [],
        questionIds: [],
        status: "REJECTED",
        createdAt: source.occurredAt,
        approvedAt: null,
        approvedByPrincipalId: null,
        version: 1,
      };
      this.plans.set(plan.id, plan);
      return copy(plan);
    }

    const accountIds = aliasCandidates(content, context.accountAliases);
    const engagementIds = aliasCandidates(content, context.engagementAliases);
    const keys = projectKeys(content);
    for (const key of keys) {
      for (const item of context.engagementAliases) {
        if (item.projectKey?.toUpperCase() === key && !engagementIds.includes(item.id)) engagementIds.push(item.id);
      }
    }
    engagementIds.sort();

    const evidence = [source.sourceRef];
    const mutations: ProposedMutation[] = [];
    mutations.push(makeMutation({
      category: "ACTIVITY",
      operation: "CREATE",
      targetId: engagementIds.length === 1 ? engagementIds[0]! : null,
      field: null,
      value: { kind: source.kind, title: source.title, content, occurredAt: source.occurredAt, sender: source.sender },
      confidence: 0.99,
      risk: "LOW",
      evidenceRefs: evidence,
      rationale: "모든 입력은 원본 활동으로 보존합니다.",
    }, this.policy));

    if (accountIds.length === 1) {
      mutations.push(makeMutation({
        category: "ACCOUNT_LINK",
        operation: "LINK",
        targetId: accountIds[0]!,
        field: "accountId",
        value: accountIds[0]!,
        confidence: 0.97,
        risk: "LOW",
        evidenceRefs: evidence,
        rationale: "등록된 고객 별칭이 입력에 포함되어 있습니다.",
      }, this.policy));
    }
    if (engagementIds.length === 1) {
      mutations.push(makeMutation({
        category: "ENGAGEMENT_LINK",
        operation: "LINK",
        targetId: engagementIds[0]!,
        field: "engagementId",
        value: engagementIds[0]!,
        confidence: keys.length > 0 ? 0.99 : 0.96,
        risk: "LOW",
        evidenceRefs: evidence,
        rationale: keys.length > 0 ? "프로젝트 키가 일치합니다." : "등록된 프로젝트 별칭이 입력에 포함되어 있습니다.",
      }, this.policy));
    }

    const dates = dateCandidates(content);
    const money = moneyCandidates(content);
    const targetEngagement = engagementIds.length === 1 ? engagementIds[0]! : null;

    if (/검수|완료일|납기|일정/.test(content) && dates.length > 0) {
      mutations.push(makeMutation({
        category: "ENGAGEMENT_FIELD",
        operation: "UPDATE",
        targetId: targetEngagement,
        field: /검수/.test(content) ? "acceptanceDate" : "targetDate",
        value: dates[0]!.isoDate,
        confidence: targetEngagement ? 0.91 : 0.68,
        risk: "MEDIUM",
        evidenceRefs: evidence,
        rationale: `일정 표현 '${dates[0]!.raw}'을 프로젝트 일정 후보로 추출했습니다.`,
      }, this.policy));
    }

    if (/회신|보내|전달|확인|요청|준비/.test(content)) {
      mutations.push(makeMutation({
        category: "COMMITMENT",
        operation: "CREATE",
        targetId: targetEngagement,
        field: null,
        value: { description: content.slice(0, 240), dueDate: dates.at(-1)?.isoDate ?? null },
        confidence: dates.length > 0 ? 0.9 : 0.76,
        risk: "MEDIUM",
        evidenceRefs: evidence,
        rationale: "행동 동사와 기한 표현을 고객 약속/다음 행동 후보로 추출했습니다.",
      }, this.policy));
    }

    if (/추가|범위|변경요청|계약\s*밖|무상/.test(content)) {
      mutations.push(makeMutation({
        category: "CHANGE_REQUEST",
        operation: "CREATE",
        targetId: targetEngagement,
        field: null,
        value: { description: content.slice(0, 500), additionalAmountKrw: money[0]?.amountKrw ?? null },
        confidence: targetEngagement ? 0.87 : 0.65,
        risk: "HIGH",
        evidenceRefs: evidence,
        rationale: "기존 범위를 변경할 수 있는 표현을 발견했습니다.",
      }, this.policy));
    }

    for (const candidate of money) {
      const around = content.slice(Math.max(0, candidate.index - 24), candidate.index + candidate.raw.length + 28);
      const outgoing = /지급|출금|매입|원가|총판|벤더|외주/.test(around);
      const incoming = /입금|수금|잔금|계약금|중도금|매출|고객/.test(around);
      mutations.push(makeMutation({
        category: "FINANCIAL_ITEM",
        operation: "CREATE",
        targetId: targetEngagement,
        field: null,
        value: {
          direction: outgoing && !incoming ? "OUT" : incoming && !outgoing ? "IN" : "UNKNOWN",
          amountKrw: candidate.amountKrw,
          expectedDate: dates.find((item) => Math.abs(item.index - candidate.index) < 80)?.isoDate ?? null,
          context: around,
        },
        confidence: outgoing !== incoming && targetEngagement ? 0.86 : 0.62,
        risk: "HIGH",
        evidenceRefs: evidence,
        rationale: `금액 표현 '${candidate.raw}'을 재무 항목 후보로 추출했습니다. 금액은 자동 확정하지 않습니다.`,
      }, this.policy));
    }

    const questions: CaptureQuestion[] = [];
    const addQuestion = (question: Omit<CaptureQuestion, "id" | "sourceId" | "status" | "answer" | "answeredByPrincipalId" | "version">) => {
      if (questions.length >= this.policy.maxQuestionsPerEvent) return;
      const item: CaptureQuestion = {
        ...copy(question),
        id: `capture-question-${deterministicHash({ sourceId: source.id, question }).slice(-16)}`,
        sourceId: source.id,
        status: "OPEN",
        answer: null,
        answeredByPrincipalId: null,
        version: 1,
      };
      questions.push(item);
      this.questions.set(item.id, item);
    };

    if (accountIds.length !== 1) {
      addQuestion({
        mutationId: null,
        prompt: accountIds.length === 0 ? "이 입력은 어느 고객/거래처와 관련되어 있나요?" : "관련 고객 후보가 여러 개입니다. 어느 고객이 맞나요?",
        options: accountIds.map((id) => ({ id, label: id, value: id })),
      });
    }
    if (engagementIds.length !== 1) {
      addQuestion({
        mutationId: null,
        prompt: engagementIds.length === 0 ? "이 입력은 어느 프로젝트와 관련되어 있나요?" : "관련 프로젝트 후보가 여러 개입니다. 어느 프로젝트가 맞나요?",
        options: engagementIds.map((id) => ({ id, label: id, value: id })),
      });
    }
    const ambiguousMoney = mutations.find((item) => item.category === "FINANCIAL_ITEM" && (item.value as { direction?: string }).direction === "UNKNOWN");
    if (ambiguousMoney) {
      addQuestion({
        mutationId: ambiguousMoney.id,
        prompt: "이 금액은 받을 돈인가요, 지급할 돈인가요?",
        options: [
          { id: "IN", label: "받을 돈 / 입금", value: "IN" },
          { id: "OUT", label: "지급할 돈 / 출금", value: "OUT" },
          { id: "DEFER", label: "아직 미확인", value: "DEFER" },
        ],
      });
    }

    for (const question of questions) this.questions.set(question.id, question);
    const reviewRequired = questions.length > 0 || mutations.some((item) => item.band !== "AUTO");
    const plan: UpdatePlan = {
      id: `plan-${source.id}`,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      accountCandidateIds: accountIds,
      engagementCandidateIds: engagementIds,
      mutations,
      questionIds: questions.map((item) => item.id),
      status: reviewRequired ? "NEEDS_REVIEW" : "AUTO_READY",
      createdAt: source.occurredAt,
      approvedAt: null,
      approvedByPrincipalId: null,
      version: 1,
    };
    source.status = "PLANNED";
    source.version += 1;
    this.plans.set(plan.id, plan);
    return copy(plan);
  }

  answerQuestion(questionId: string, answer: unknown, actor: AutomationActor): CaptureQuestion {
    assertHuman(actor);
    const question = this.questions.get(questionId);
    if (!question) throw new CustomerWorkOsV25Error("QUESTION_NOT_FOUND", "capture question not found");
    const source = this.sources.get(question.sourceId);
    if (!source) throw new CustomerWorkOsV25Error("SOURCE_NOT_FOUND", "capture source not found");
    assertWorkspace(actor, source.workspaceId);
    if (question.status !== "OPEN") throw new CustomerWorkOsV25Error("QUESTION_CLOSED", "question is already closed");
    question.status = answer === "DEFER" ? "DEFERRED" : "ANSWERED";
    question.answer = copy(answer);
    question.answeredByPrincipalId = actor.principalId;
    question.version += 1;
    const plan = [...this.plans.values()].find((item) => item.sourceId === source.id);
    if (plan && plan.questionIds.every((id) => this.questions.get(id)?.status !== "OPEN")) {
      plan.status = "NEEDS_REVIEW";
      plan.version += 1;
    }
    return copy(question);
  }

  approvePlan(
    planId: string,
    approvedMutationIds: string[],
    approvedAt: string,
    actor: AutomationActor,
  ): UpdatePlan {
    assertHuman(actor);
    const plan = this.plans.get(planId);
    if (!plan) throw new CustomerWorkOsV25Error("PLAN_NOT_FOUND", "update plan not found");
    assertWorkspace(actor, plan.workspaceId);
    if (plan.questionIds.some((id) => this.questions.get(id)?.status === "OPEN")) {
      throw new CustomerWorkOsV25Error("CLARIFICATION_REQUIRED", "open clarification questions must be answered or deferred");
    }
    const approved = new Set(approvedMutationIds);
    for (const mutation of plan.mutations) {
      if (mutation.status === "AUTO_APPROVED") continue;
      mutation.status = approved.has(mutation.id) ? "APPROVED" : "REJECTED";
    }
    if (plan.mutations.some((item) => ["HIGH", "CRITICAL"].includes(item.risk) && item.status === "AUTO_APPROVED")) {
      throw new CustomerWorkOsV25Error("HIGH_RISK_AUTO_APPROVAL", "high-risk mutations cannot be automatically approved");
    }
    plan.status = "APPROVED";
    plan.approvedAt = approvedAt;
    plan.approvedByPrincipalId = actor.principalId;
    plan.version += 1;
    return copy(plan);
  }

  markApplied(planId: string, actor: AutomationActor): UpdatePlan {
    assertHuman(actor);
    const plan = this.plans.get(planId);
    if (!plan) throw new CustomerWorkOsV25Error("PLAN_NOT_FOUND", "update plan not found");
    assertWorkspace(actor, plan.workspaceId);
    if (plan.status !== "APPROVED" && plan.status !== "AUTO_READY") {
      throw new CustomerWorkOsV25Error("PLAN_NOT_APPROVED", "plan must be approved before applying");
    }
    for (const mutation of plan.mutations) {
      if (["AUTO_APPROVED", "APPROVED"].includes(mutation.status)) mutation.status = "APPLIED";
    }
    plan.status = "APPLIED";
    plan.version += 1;
    const source = this.sources.get(plan.sourceId);
    if (source) {
      source.status = "APPLIED";
      source.version += 1;
    }
    return copy(plan);
  }

  reviewQueue(workspaceId: string): { plans: UpdatePlan[]; questions: CaptureQuestion[] } {
    const plans = [...this.plans.values()]
      .filter((item) => item.workspaceId === workspaceId && item.status === "NEEDS_REVIEW")
      .map(copy)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const sourceIds = new Set(plans.map((item) => item.sourceId));
    const questions = [...this.questions.values()]
      .filter((item) => sourceIds.has(item.sourceId) && item.status === "OPEN")
      .map(copy)
      .sort((left, right) => left.id.localeCompare(right.id));
    return { plans, questions };
  }

  exportState(): UniversalCaptureState {
    return {
      schemaVersion: 1,
      sources: sorted(this.sources.values()),
      plans: sorted(this.plans.values()),
      questions: sorted(this.questions.values()),
    };
  }

  hydrateState(input: UniversalCaptureState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported capture state");
    this.sources = mapById(input.sources, "captureSource");
    this.plans = mapById(input.plans, "updatePlan");
    this.questions = mapById(input.questions, "captureQuestion");
  }
}
