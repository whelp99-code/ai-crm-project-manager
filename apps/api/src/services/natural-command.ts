import type { ActionType } from "@ai-crm/contracts";
import type { PmCheckpointReceipt, PmService } from "@ai-crm/domain";
import type {
  AuthorizationResult,
  GovernanceAuthorizationService,
} from "@ai-crm/governance";
import type {
  ModelGateway,
  StructuredOutputSchema,
} from "@ai-crm/model-gateway";
import {
  OrchestrationError,
  type JobSnapshot,
  type OrchestrationService,
  type WorkItem,
} from "@ai-crm/orchestration";
import { mapCommand, mapCommandKey, normalizeCommand } from "../command-map.js";

export class NaturalCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NaturalCommandError";
  }
}

export interface NaturalCommandDeps {
  orchestration: OrchestrationService;
  governance: GovernanceAuthorizationService;
  modelGateway?: ModelGateway;
  modelServicePrincipalId: string;
  pm?: PmService;
}

export interface ExecuteNaturalCommandInput {
  workspaceId: string;
  operatorPrincipalId: string;
  text: string;
  /** Resolved idempotency key (header wins; body is alias). */
  idempotencyKey: string;
  /**
   * Optional ADR-012 resource pair applied to plan steps that lack binding.
   * Both fields required when present; fail-closed on half pairs.
   */
  resourceBinding?: { resourceType: string; resourceId: string };
}

export interface NaturalCommandResult {
  jobId: string;
  workItemIds: string[];
  status: string;
  needsApproval: boolean;
}

export interface PlanStep {
  suggestedCommand: string;
  title?: string;
  resourceType?: string;
  resourceId?: string;
  resourceVersion?: number;
  payload?: Record<string, unknown>;
}

/** Structured-output schema for natural-command plan inference. */
export const NATURAL_COMMAND_PLAN_SCHEMA: StructuredOutputSchema = {
  schemaVersion: "natural-command-plan.v1",
  root: {
    kind: "object",
    fields: {
      steps: {
        kind: "array",
        of: {
          kind: "object",
          fields: {
            suggestedCommand: { kind: "string", maxLength: 200 },
            title: { kind: "string", maxLength: 500 },
            resourceType: { kind: "string", maxLength: 100 },
            resourceId: { kind: "string", maxLength: 200 },
            resourceVersion: { kind: "number" },
            payloadJson: { kind: "string", maxLength: 8000 },
          },
        },
      },
    },
  },
};

interface StepContext {
  workspaceId: string;
  suggestedCommand: string;
  commandKey: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  resourceType?: string;
  resourceId: string;
  resourceVersion: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function errorCodeOf(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return fallback;
}

function parsePlanSteps(output: unknown): PlanStep[] {
  const root = asRecord(output);
  const rawSteps = root.steps;
  if (!Array.isArray(rawSteps)) {
    throw new NaturalCommandError("INVALID_PLAN", "model plan must include a steps array");
  }
  return rawSteps.map((raw, index) => {
    const step = asRecord(raw);
    const suggestedCommand = typeof step.suggestedCommand === "string" ? step.suggestedCommand : "";
    if (!suggestedCommand.trim()) {
      throw new NaturalCommandError("INVALID_PLAN", `steps[${index}].suggestedCommand is required`);
    }
    let payload: Record<string, unknown> | undefined;
    if (typeof step.payloadJson === "string" && step.payloadJson.trim()) {
      try {
        payload = asRecord(JSON.parse(step.payloadJson));
      } catch {
        throw new NaturalCommandError("INVALID_PLAN", `steps[${index}].payloadJson is not valid JSON`);
      }
    } else if (step.payload && typeof step.payload === "object" && !Array.isArray(step.payload)) {
      payload = asRecord(step.payload);
    }
    const resourceVersion =
      typeof step.resourceVersion === "number" && Number.isFinite(step.resourceVersion)
        ? step.resourceVersion
        : undefined;
    return {
      suggestedCommand,
      ...(typeof step.title === "string" ? { title: step.title } : {}),
      ...(typeof step.resourceType === "string" && step.resourceType.trim()
        ? { resourceType: step.resourceType.trim() }
        : {}),
      ...(typeof step.resourceId === "string" && step.resourceId.trim()
        ? { resourceId: step.resourceId.trim() }
        : {}),
      ...(resourceVersion !== undefined ? { resourceVersion } : {}),
      ...(payload ? { payload } : {}),
    };
  });
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function normalizeResourceBinding(
  resourceType: string | undefined,
  resourceId: string | undefined,
  label: string,
): { resourceType: string; resourceId: string } | undefined {
  const type = resourceType?.trim() ?? "";
  const id = resourceId?.trim() ?? "";
  if (!type && !id) return undefined;
  if (!type || !id) {
    throw new NaturalCommandError(
      "INVALID_RESOURCE_BINDING",
      `${label}: resourceType and resourceId must be set together (ADR-012)`,
    );
  }
  return { resourceType: type, resourceId: id };
}

function applyResourceBinding(steps: PlanStep[], binding?: { resourceType: string; resourceId: string }): PlanStep[] {
  const defaultBinding = binding
    ? normalizeResourceBinding(binding.resourceType, binding.resourceId, "resourceBinding")
    : undefined;

  return steps.map((step, index) => {
    const type = step.resourceType?.trim() ?? "";
    const id = step.resourceId?.trim() ?? "";

    // Complete plan pair wins.
    if (type && id) {
      return { ...step, resourceType: type, resourceId: id };
    }

    // Incomplete plan pair: complete from request binding when available (S1 UI).
    // Without a default, keep resourceId-only for processStep governance (S0) —
    // createJob still drops unpaired fields so work items never store a half pair.
    if (type || id) {
      if (defaultBinding) {
        return {
          ...step,
          resourceType: type || defaultBinding.resourceType,
          resourceId: id || defaultBinding.resourceId,
        };
      }
      if (type && !id) {
        throw new NaturalCommandError(
          "INVALID_RESOURCE_BINDING",
          `steps[${index}]: resourceType and resourceId must be set together (ADR-012)`,
        );
      }
      return {
        ...step,
        ...(id ? { resourceId: id } : {}),
      };
    }

    if (defaultBinding) {
      return {
        ...step,
        resourceType: defaultBinding.resourceType,
        resourceId: defaultBinding.resourceId,
      };
    }
    return step;
  });
}

export class NaturalCommandService {
  private readonly stepContext = new Map<string, StepContext>();
  private stepCounter = 0;

  constructor(private readonly deps: NaturalCommandDeps) {}

  async execute(input: ExecuteNaturalCommandInput): Promise<NaturalCommandResult> {
    const workspaceId = input.workspaceId.trim();
    const operatorPrincipalId = input.operatorPrincipalId.trim();
    const text = input.text.trim();
    const idempotencyKey = input.idempotencyKey.trim();

    if (!workspaceId) {
      throw new NaturalCommandError("WORKSPACE_REQUIRED", "x-workspace-id header is required");
    }
    if (!operatorPrincipalId) {
      throw new NaturalCommandError("PRINCIPAL_REQUIRED", "x-principal-id header is required");
    }
    if (!text) {
      throw new NaturalCommandError("INVALID_INPUT", "text is required");
    }
    if (text.length > 500) {
      throw new NaturalCommandError("INVALID_INPUT", "text must be at most 500 characters");
    }
    if (!idempotencyKey) {
      throw new NaturalCommandError(
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header or body.idempotencyKey is required",
      );
    }

    const existing = this.deps.orchestration.findJobByIdempotencyKey(workspaceId, idempotencyKey);
    if (existing) {
      return this.toResult(existing);
    }

    const gateway = this.deps.modelGateway;
    if (!gateway) {
      throw new NaturalCommandError(
        "MODEL_UNAVAILABLE",
        "model provider is not configured; inference is disabled fail-closed",
      );
    }

    const invocation = await gateway.invoke<Record<string, unknown>>({
      workspaceId,
      operationId: "natural-command.plan",
      principalId: this.deps.modelServicePrincipalId,
      promptVersion: "natural-command.plan.v1",
      modelVersion: "plan-v1",
      prompt: text,
      outputSchema: NATURAL_COMMAND_PLAN_SCHEMA,
      correlationId: `nc:${workspaceId}:${idempotencyKey}`,
      requestedRetention: "zero-retention",
    });

    const planSteps = applyResourceBinding(parsePlanSteps(invocation.structuredOutput), input.resourceBinding);
    if (planSteps.length === 0) {
      throw new NaturalCommandError("INVALID_PLAN", "model plan must include at least one step");
    }

    const snap = this.deps.orchestration.createJob({
      workspaceId,
      createdBy: operatorPrincipalId,
      idempotencyKey,
      planInvocationId: invocation.invocation.id,
      rawText: text,
      source: "natural_command",
      steps: planSteps.map((step) => {
        const commandKey = mapCommandKey(step.suggestedCommand);
        const actionType = commandKey ? mapCommand(step.suggestedCommand) ?? undefined : undefined;
        const title = (step.title?.trim() || step.suggestedCommand).slice(0, 500);
        return {
          title,
          suggestedCommand: normalizeCommand(step.suggestedCommand),
          ...(actionType ? { actionType } : {}),
          ...(step.resourceType && step.resourceId
            ? { resourceType: step.resourceType, resourceId: step.resourceId }
            : {}),
          ...(typeof step.resourceVersion === "number" ? { resourceVersion: step.resourceVersion } : {}),
        };
      }),
    });

    // Idempotent create may return a prior job; skip re-processing.
    if (snap.job.planInvocationId !== invocation.invocation.id) {
      return this.toResult(snap);
    }

    for (let i = 0; i < snap.workItems.length; i += 1) {
      const workItem = snap.workItems[i]!;
      const planStep = planSteps[i]!;
      this.processStep({
        workspaceId,
        operatorPrincipalId,
        workItem,
        planStep,
      });
    }

    return this.toResult(this.deps.orchestration.getJob(workspaceId, snap.job.id));
  }

  /**
   * After a checkpoint/approval is decided + consumed externally, apply the
   * domain effect (when payload is complete) and mark the work item done.
   */
  completeWorkItem(input: {
    workspaceId: string;
    jobId: string;
    workItemId: string;
    intentId: string;
    operatorPrincipalId: string;
  }): NaturalCommandResult {
    const { workspaceId, jobId, workItemId, intentId, operatorPrincipalId } = input;
    const snap = this.deps.orchestration.getJob(workspaceId, jobId);
    const item = snap.workItems.find((entry) => entry.id === workItemId);
    if (!item) {
      throw new NaturalCommandError("NOT_FOUND", `work item not found on job: ${workItemId}`);
    }

    const ctx = this.stepContext.get(workItemId);
    if (!ctx) {
      throw new NaturalCommandError("STEP_CONTEXT_MISSING", "no step context retained for work item");
    }

    if (item.status === "done") {
      return this.toResult(this.deps.orchestration.getJob(workspaceId, jobId));
    }

    if (item.status === "waiting_control") {
      this.deps.orchestration.resumeFromControl(workspaceId, workItemId, intentId);
    } else if (item.status === "queued") {
      this.deps.orchestration.startWorkItem(workspaceId, workItemId);
      this.deps.orchestration.bindIntent(workspaceId, workItemId, intentId);
    } else if (item.status === "running") {
      this.deps.orchestration.bindIntent(workspaceId, workItemId, intentId);
    } else {
      throw new NaturalCommandError(
        "INVALID_WORK_ITEM_STATE",
        `cannot complete work item in status ${item.status}`,
      );
    }

    const intent = this.deps.governance.getIntent(workspaceId, intentId);
    if (intent.actionType !== ctx.actionType) {
      throw new NaturalCommandError("STALE_INTENT", "intent actionType does not match work item");
    }
    if (intent.resourceId !== ctx.resourceId || intent.resourceVersion !== ctx.resourceVersion) {
      throw new NaturalCommandError("STALE_INTENT", "intent resource binding does not match work item");
    }
    if (intent.status !== "QUEUED") {
      throw new NaturalCommandError("STALE_INTENT", "intent is not a fresh QUEUED authorization");
    }

    try {
      const applied = this.applyDomain(ctx, operatorPrincipalId);
      this.deps.governance.markIntentApplied(workspaceId, intentId);
      this.deps.orchestration.markDone(workspaceId, workItemId, {
        intentId,
        resultRef: applied,
      });
    } catch (error) {
      this.deps.orchestration.markFailed(workspaceId, workItemId, errorCodeOf(error, "APPLY_FAILED"));
      try {
        this.deps.governance.invalidateIntent(intentId, "INVALIDATED");
      } catch {
        // Intent may already be terminal; surface the original apply failure.
      }
      throw error instanceof NaturalCommandError
        ? error
        : new NaturalCommandError(errorCodeOf(error, "APPLY_FAILED"), error instanceof Error ? error.message : "apply failed");
    }

    return this.toResult(this.deps.orchestration.getJob(workspaceId, jobId));
  }

  cancelJob(workspaceId: string, jobId: string): NaturalCommandResult {
    const before = this.deps.orchestration.getJob(workspaceId, jobId);
    for (const item of before.workItems) {
      if (item.controlId && (item.status === "waiting_control" || item.status === "running" || item.status === "queued")) {
        try {
          this.deps.governance.cancelControl(item.controlId, workspaceId);
        } catch {
          // Control may already be terminal; orch cancel still proceeds.
        }
      }
    }
    return this.toResult(this.deps.orchestration.cancelJob(workspaceId, jobId));
  }

  getJob(workspaceId: string, jobId: string): JobSnapshot {
    return this.deps.orchestration.getJob(workspaceId, jobId);
  }

  listEvents(workspaceId: string, jobId: string) {
    return this.deps.orchestration.listEvents(workspaceId, jobId);
  }

  private processStep(input: {
    workspaceId: string;
    operatorPrincipalId: string;
    workItem: WorkItem;
    planStep: PlanStep;
  }): void {
    const { workspaceId, operatorPrincipalId, workItem, planStep } = input;
    const commandKey = mapCommandKey(planStep.suggestedCommand);
    const actionType = commandKey ? mapCommand(planStep.suggestedCommand) : null;

    if (!commandKey || !actionType) {
      this.deps.orchestration.markFailed(workspaceId, workItem.id, "UNMAPPED_COMMAND");
      return;
    }

    this.stepCounter += 1;
    const resourceId = planStep.resourceId?.trim() || `orch:${workItem.jobId}:${workItem.id}`;
    const resourceVersion =
      typeof planStep.resourceVersion === "number" && Number.isFinite(planStep.resourceVersion)
        ? planStep.resourceVersion
        : 1;
    const payload = planStep.payload ?? {};

    const ctx: StepContext = {
      workspaceId,
      suggestedCommand: normalizeCommand(planStep.suggestedCommand),
      commandKey,
      actionType,
      payload,
      resourceId,
      resourceVersion,
      ...(planStep.resourceType ? { resourceType: planStep.resourceType } : {}),
    };
    this.stepContext.set(workItem.id, ctx);

    this.deps.orchestration.startWorkItem(workspaceId, workItem.id);

    let authz: AuthorizationResult;
    try {
      authz = this.deps.governance.authorize({
        command: commandKey,
        workspaceId,
        resourceId,
        resourceVersion,
        payload,
        requesterPrincipalId: operatorPrincipalId,
      });
    } catch (error) {
      this.deps.orchestration.markFailed(workspaceId, workItem.id, errorCodeOf(error, "AUTHORIZE_FAILED"));
      return;
    }

    if (authz.requiredControl === "ALLOW" && authz.intent) {
      try {
        const applied = this.applyDomain(ctx, operatorPrincipalId);
        this.deps.governance.markIntentApplied(workspaceId, authz.intent.id);
        this.deps.orchestration.markDone(workspaceId, workItem.id, {
          intentId: authz.intent.id,
          resultRef: applied,
        });
      } catch (error) {
        this.deps.orchestration.markFailed(workspaceId, workItem.id, errorCodeOf(error, "APPLY_FAILED"));
        if (authz.intent) {
          try {
            this.deps.governance.invalidateIntent(authz.intent.id, "INVALIDATED");
          } catch {
            // Intent may already be terminal; fail-closed orch path still stands.
          }
        }
      }
      return;
    }

    if (
      (authz.requiredControl === "CHECKPOINT" || authz.requiredControl === "REQUIRE_APPROVAL") &&
      authz.control
    ) {
      this.deps.orchestration.bindControl(workspaceId, workItem.id, authz.control.id);
      return;
    }

    this.deps.orchestration.markFailed(workspaceId, workItem.id, "AUTHORIZE_FAILED");
  }

  private applyDomain(
    ctx: StepContext,
    operatorPrincipalId: string,
  ): Record<string, unknown> {
    if (ctx.actionType === "INTERNAL_REVERSIBLE_UPDATE") {
      return { applied: "internal.update" };
    }

    const pm = this.deps.pm;

    if (ctx.actionType === "PM_PLAN_CREATE") {
      if (!pm) {
        throw new NaturalCommandError("APPLY_UNAVAILABLE", "PmService is required for PM_PLAN_CREATE");
      }
      const id = stringField(ctx.payload, "id");
      const projectId = stringField(ctx.payload, "projectId");
      const objective = stringField(ctx.payload, "objective");
      const taskIds = stringArrayField(ctx.payload, "taskIds") ?? [];
      const createdAt = stringField(ctx.payload, "createdAt") ?? new Date().toISOString();
      if (!id || !projectId || !objective) {
        throw new NaturalCommandError("INCOMPLETE_PAYLOAD", "PM_PLAN_CREATE requires id, projectId, objective");
      }
      const plan = pm.createPlan({
        id,
        workspaceId: ctx.workspaceId,
        projectId,
        revision: 1,
        objective,
        taskIds,
        createdByPrincipalId: operatorPrincipalId,
        createdAt,
      });
      return { applied: "pm.plan_create", planId: plan.id };
    }

    if (ctx.actionType === "PM_TASK_ASSIGN") {
      if (!pm) {
        throw new NaturalCommandError("APPLY_UNAVAILABLE", "PmService is required for PM_TASK_ASSIGN");
      }
      const id = stringField(ctx.payload, "id") ?? `assign-${this.stepCounter}`;
      const projectId = stringField(ctx.payload, "projectId");
      const planId = stringField(ctx.payload, "planId") ?? ctx.resourceId;
      const taskId = stringField(ctx.payload, "taskId");
      const assigneePrincipalId = stringField(ctx.payload, "assigneePrincipalId");
      const createdAt = stringField(ctx.payload, "createdAt") ?? new Date().toISOString();
      if (!projectId || !planId || !taskId || !assigneePrincipalId) {
        throw new NaturalCommandError(
          "INCOMPLETE_PAYLOAD",
          "PM_TASK_ASSIGN requires projectId, planId, taskId, assigneePrincipalId",
        );
      }
      const receipt: PmCheckpointReceipt = {
        workspaceId: ctx.workspaceId,
        resourceId: planId,
        resourceVersion: ctx.resourceVersion,
        actionType: "PM_TASK_ASSIGN",
        status: "CONSUMED",
      };
      const assignment = pm.assignTask(
        {
          id,
          workspaceId: ctx.workspaceId,
          projectId,
          planId,
          taskId,
          assigneePrincipalId,
          assignedByPrincipalId: operatorPrincipalId,
          status: "active",
          createdAt,
        },
        ctx.resourceVersion,
        receipt,
      );
      return { applied: "pm.task_assign", assignmentId: assignment.id };
    }

    throw new NaturalCommandError(
      "EFFECT_NOT_IMPLEMENTED",
      `no domain apply implemented for ${ctx.actionType}; cannot mark done`,
    );
  }

  private toResult(snap: JobSnapshot): NaturalCommandResult {
    const needsApproval = snap.workItems.some((item) => item.status === "waiting_control");
    return {
      jobId: snap.job.id,
      workItemIds: snap.workItems.map((item) => item.id),
      status: snap.job.status,
      needsApproval,
    };
  }
}

export function isNaturalCommandError(error: unknown): error is NaturalCommandError {
  return error instanceof NaturalCommandError;
}

export function isOrchestrationError(error: unknown): error is OrchestrationError {
  return error instanceof OrchestrationError;
}
