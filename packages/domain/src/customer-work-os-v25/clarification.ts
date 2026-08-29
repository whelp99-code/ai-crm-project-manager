import {
  CustomerWorkOsV25Error,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  copy,
  deterministicHash,
  mapById,
  normalizeText,
  required,
  sorted,
  type AutomationActor,
} from "./shared.js";

export type LearningRuleKind =
  | "ACCOUNT_ALIAS"
  | "ENGAGEMENT_ALIAS"
  | "VENDOR_ALIAS"
  | "COST_CATEGORY"
  | "DOCUMENT_TYPE"
  | "COMMUNICATION_STYLE";

export type ProtectedRuleKind =
  | "PRICE_POLICY"
  | "CONTRACT_TERM"
  | "APPROVAL_POLICY"
  | "SECURITY_POLICY"
  | "DELETE_POLICY"
  | "OUTBOUND_PERMISSION";

export interface ClarificationTask {
  id: string;
  workspaceId: string;
  sourceId: string;
  prompt: string;
  field: string;
  options: Array<{ id: string; label: string; value: unknown; evidenceRefs: string[] }>;
  answer: unknown | null;
  status: "OPEN" | "ANSWERED" | "DEFERRED" | "CANCELLED";
  priority: number;
  createdAt: string;
  answeredAt: string | null;
  answeredByPrincipalId: string | null;
  version: number;
}

export interface LearningRule {
  id: string;
  workspaceId: string;
  kind: LearningRuleKind;
  inputPattern: string;
  normalizedPattern: string;
  outputValue: string;
  evidenceRefs: string[];
  createdFromTaskId: string;
  approvedByPrincipalId: string;
  active: boolean;
  version: number;
}

export interface ClarificationLearningState {
  schemaVersion: 1;
  tasks: ClarificationTask[];
  rules: LearningRule[];
}

const SAFE_RULE_KINDS = new Set<LearningRuleKind>([
  "ACCOUNT_ALIAS",
  "ENGAGEMENT_ALIAS",
  "VENDOR_ALIAS",
  "COST_CATEGORY",
  "DOCUMENT_TYPE",
  "COMMUNICATION_STYLE",
]);

export class ClarificationLearningService {
  private tasks = new Map<string, ClarificationTask>();
  private rules = new Map<string, LearningRule>();

  createTasks(
    input: {
      workspaceId: string;
      sourceId: string;
      questions: Array<{
        id?: string;
        prompt: string;
        field: string;
        options: Array<{ id: string; label: string; value: unknown; evidenceRefs?: string[] }>;
        priority?: number;
      }>;
      createdAt: string;
      maxQuestions?: number;
    },
    actor: AutomationActor,
  ): ClarificationTask[] {
    assertHumanOrService(actor);
    assertWorkspace(actor, input.workspaceId);
    const max = Math.min(Math.max(input.maxQuestions ?? 3, 1), 3);
    return input.questions.slice(0, max).map((question, index) => {
      const task: ClarificationTask = {
        id: question.id?.trim() || `clarification-${deterministicHash({ sourceId: input.sourceId, question, index }).slice(-16)}`,
        workspaceId: input.workspaceId,
        sourceId: required(input.sourceId, "sourceId"),
        prompt: required(question.prompt, "clarification.prompt"),
        field: required(question.field, "clarification.field"),
        options: question.options.map((option) => ({
          id: required(option.id, "option.id"),
          label: required(option.label, "option.label"),
          value: copy(option.value),
          evidenceRefs: [...new Set(option.evidenceRefs ?? [])].sort(),
        })),
        answer: null,
        status: "OPEN",
        priority: Math.min(Math.max(question.priority ?? 50, 0), 100),
        createdAt: input.createdAt,
        answeredAt: null,
        answeredByPrincipalId: null,
        version: 1,
      };
      if (this.tasks.has(task.id)) throw new CustomerWorkOsV25Error("DUPLICATE_TASK", "clarification task already exists");
      this.tasks.set(task.id, task);
      return copy(task);
    });
  }

  answer(
    input: {
      taskId: string;
      answer: unknown;
      answeredAt: string;
      learn?: {
        kind: LearningRuleKind | ProtectedRuleKind;
        inputPattern: string;
        outputValue: string;
        evidenceRefs: string[];
      };
    },
    actor: AutomationActor,
  ): { task: ClarificationTask; learnedRule: LearningRule | null } {
    assertHuman(actor);
    const task = this.tasks.get(input.taskId);
    if (!task) throw new CustomerWorkOsV25Error("TASK_NOT_FOUND", "clarification task not found");
    assertWorkspace(actor, task.workspaceId);
    if (task.status !== "OPEN") throw new CustomerWorkOsV25Error("TASK_CLOSED", "clarification task is already closed");

    task.answer = copy(input.answer);
    task.status = input.answer === "DEFER" ? "DEFERRED" : "ANSWERED";
    task.answeredAt = input.answeredAt;
    task.answeredByPrincipalId = actor.principalId;
    task.version += 1;

    let learnedRule: LearningRule | null = null;
    if (input.learn) {
      if (!SAFE_RULE_KINDS.has(input.learn.kind as LearningRuleKind)) {
        throw new CustomerWorkOsV25Error("PROTECTED_LEARNING_FORBIDDEN", `${input.learn.kind} cannot be changed through implicit learning`);
      }
      if (task.status !== "ANSWERED") {
        throw new CustomerWorkOsV25Error("CONFIRMED_ANSWER_REQUIRED", "learning requires a confirmed answer");
      }
      const normalizedPattern = normalizeText(required(input.learn.inputPattern, "learning.inputPattern"));
      const duplicate = [...this.rules.values()].find((item) =>
        item.workspaceId === task.workspaceId &&
        item.kind === input.learn!.kind &&
        item.normalizedPattern === normalizedPattern &&
        item.active,
      );
      if (duplicate && duplicate.outputValue !== input.learn.outputValue) {
        throw new CustomerWorkOsV25Error("LEARNING_CONFLICT", "an active learning rule already maps this pattern to another value");
      }
      learnedRule = duplicate ?? {
        id: `learning-${deterministicHash({ workspaceId: task.workspaceId, kind: input.learn.kind, normalizedPattern }).slice(-16)}`,
        workspaceId: task.workspaceId,
        kind: input.learn.kind as LearningRuleKind,
        inputPattern: required(input.learn.inputPattern, "learning.inputPattern"),
        normalizedPattern,
        outputValue: required(input.learn.outputValue, "learning.outputValue"),
        evidenceRefs: [...new Set(input.learn.evidenceRefs.map((value) => required(value, "learning.evidenceRef")))].sort(),
        createdFromTaskId: task.id,
        approvedByPrincipalId: actor.principalId,
        active: true,
        version: 1,
      };
      this.rules.set(learnedRule.id, copy(learnedRule));
    }
    return { task: copy(task), learnedRule: learnedRule ? copy(learnedRule) : null };
  }

  resolveAlias(workspaceId: string, kind: Extract<LearningRuleKind, "ACCOUNT_ALIAS" | "ENGAGEMENT_ALIAS" | "VENDOR_ALIAS">, input: string): string | null {
    const normalized = normalizeText(input);
    const matches = [...this.rules.values()].filter((item) =>
      item.workspaceId === workspaceId && item.kind === kind && item.active && normalized.includes(item.normalizedPattern),
    );
    if (matches.length === 0) return null;
    const outputs = [...new Set(matches.map((item) => item.outputValue))];
    if (outputs.length > 1) throw new CustomerWorkOsV25Error("AMBIGUOUS_LEARNING", "multiple active rules produce different outputs");
    return outputs[0]!;
  }

  openTasks(workspaceId: string): ClarificationTask[] {
    return [...this.tasks.values()]
      .filter((item) => item.workspaceId === workspaceId && item.status === "OPEN")
      .map(copy)
      .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));
  }

  exportState(): ClarificationLearningState {
    return { schemaVersion: 1, tasks: sorted(this.tasks.values()), rules: sorted(this.rules.values()) };
  }

  hydrateState(input: ClarificationLearningState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported clarification state");
    this.tasks = mapById(input.tasks, "clarificationTask");
    this.rules = mapById(input.rules, "learningRule");
  }
}
