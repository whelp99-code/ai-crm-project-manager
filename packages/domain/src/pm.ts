import type { ActionType } from "@ai-crm/contracts";

export class PmDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PmDomainError";
  }
}

export interface PmCheckpointReceipt {
  workspaceId: string;
  resourceId: string;
  resourceVersion: number;
  actionType: "PM_PLAN_REVISE" | "PM_TASK_ASSIGN" | "PM_TARGET_SET";
  status: "CONSUMED";
}

export interface PmPlanRevision {
  revision: number;
  objective: string;
  taskIds: string[];
  createdByPrincipalId: string;
  createdAt: string;
}

export interface PmPlan {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  revisions: PmPlanRevision[];
}

export interface PmAssignment {
  id: string;
  workspaceId: string;
  projectId: string;
  planId: string;
  taskId: string;
  assigneePrincipalId: string;
  assignedByPrincipalId: string;
  status: "active" | "complete" | "cancelled";
  createdAt: string;
}

export type TargetMetric = "schedule" | "scope" | "deliverable" | "risk";
export interface PmTarget {
  id: string;
  workspaceId: string;
  projectId: string;
  metric: TargetMetric;
  target: number;
  tolerance: number;
  direction: "max" | "min";
  version: number;
}

export interface TargetObservation {
  id: string;
  workspaceId: string;
  projectId: string;
  targetId: string;
  actual: number;
  observedAt: string;
  evidenceRef: string;
}

export interface VarianceException {
  id: string;
  workspaceId: string;
  projectId: string;
  targetId: string;
  metric: TargetMetric;
  target: number;
  actual: number;
  variance: number;
  severity: "medium" | "high" | "critical";
  evidenceRef: string;
}

export const PM_COMMAND_ACTIONS = {
  createPlan: "PM_PLAN_CREATE",
  revisePlan: "PM_PLAN_REVISE",
  assignTask: "PM_TASK_ASSIGN",
  setTarget: "PM_TARGET_SET",
} as const satisfies Record<string, ActionType>;

export class PmService {
  private readonly plans = new Map<string, PmPlan>();
  private readonly assignments = new Map<string, PmAssignment>();
  private readonly targets = new Map<string, PmTarget>();
  private readonly observations = new Map<string, TargetObservation>();
  private readonly exceptions = new Map<string, VarianceException>();

  /**
   * Restart-consistency hydrate-on-boot (Ultragoal P6-b G001 / PG-B):
   * rebuild every in-memory PM map wholesale from persisted rows (read back
   * from PG at process start via `PmRepository.listAll*`), so a fresh
   * process reflects prior plans/assignments/targets/observations/
   * exceptions instead of starting empty. Mirrors
   * `CrmService.hydrateCustomers`.
   */
  hydratePlans(plans: readonly PmPlan[]): void {
    this.plans.clear();
    for (const plan of plans) {
      this.plans.set(plan.id, structuredClone(plan));
    }
  }

  hydrateAssignments(assignments: readonly PmAssignment[]): void {
    this.assignments.clear();
    for (const assignment of assignments) {
      this.assignments.set(assignment.id, structuredClone(assignment));
    }
  }

  hydrateTargets(targets: readonly PmTarget[]): void {
    this.targets.clear();
    for (const target of targets) {
      this.targets.set(target.id, structuredClone(target));
    }
  }

  hydrateObservations(observations: readonly TargetObservation[]): void {
    this.observations.clear();
    for (const observation of observations) {
      this.observations.set(observation.id, structuredClone(observation));
    }
  }

  hydrateExceptions(exceptions: readonly VarianceException[]): void {
    this.exceptions.clear();
    for (const exception of exceptions) {
      this.exceptions.set(exception.id, structuredClone(exception));
    }
  }

  createPlan(input: Omit<PmPlan, "version" | "revisions"> & PmPlanRevision): PmPlan {
    if (this.plans.has(input.id)) throw new PmDomainError("DUPLICATE_ID", `plan exists: ${input.id}`);
    if (input.revision !== 1) throw new PmDomainError("INVALID_REVISION", "initial revision must be 1");
    const plan: PmPlan = {
      id: input.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      version: 1,
      revisions: [{
        revision: 1,
        objective: input.objective,
        taskIds: [...input.taskIds],
        createdByPrincipalId: input.createdByPrincipalId,
        createdAt: input.createdAt,
      }],
    };
    this.plans.set(plan.id, plan);
    return structuredClone(plan);
  }

  revisePlan(
    workspaceId: string,
    planId: string,
    expectedVersion: number,
    revision: Omit<PmPlanRevision, "revision">,
    receipt?: PmCheckpointReceipt,
  ): PmPlan {
    const plan = this.requirePlan(workspaceId, planId, expectedVersion);
    this.assertCheckpoint(receipt, plan, "PM_PLAN_REVISE");
    plan.revisions.push({ ...structuredClone(revision), revision: plan.revisions.length + 1 });
    plan.version += 1;
    return structuredClone(plan);
  }

  assignTask(assignment: PmAssignment, planVersion: number, receipt?: PmCheckpointReceipt): PmAssignment {
    const plan = this.requirePlan(assignment.workspaceId, assignment.planId, planVersion);
    if (plan.projectId !== assignment.projectId) throw new PmDomainError("CROSS_PROJECT", "assignment project does not match plan");
    this.assertCheckpoint(receipt, plan, "PM_TASK_ASSIGN");
    if (this.assignments.has(assignment.id)) throw new PmDomainError("DUPLICATE_ID", `assignment exists: ${assignment.id}`);
    const latest = plan.revisions.at(-1)!;
    if (!latest.taskIds.includes(assignment.taskId)) throw new PmDomainError("UNKNOWN_TASK", `task not present in current plan: ${assignment.taskId}`);
    const duplicate = [...this.assignments.values()].find(
      (item) => item.workspaceId === assignment.workspaceId && item.projectId === assignment.projectId && item.taskId === assignment.taskId && item.status === "active",
    );
    if (duplicate) throw new PmDomainError("DUPLICATE_ACTIVE_ASSIGNMENT", `task already has active assignment: ${assignment.taskId}`);
    this.assignments.set(assignment.id, structuredClone(assignment));
    return structuredClone(assignment);
  }

  setTarget(target: Omit<PmTarget, "version">, planId: string, planVersion: number, receipt?: PmCheckpointReceipt): PmTarget {
    const plan = this.requirePlan(target.workspaceId, planId, planVersion);
    if (plan.projectId !== target.projectId) throw new PmDomainError("CROSS_PROJECT", "target project does not match plan");
    this.assertCheckpoint(receipt, plan, "PM_TARGET_SET");
    if (this.targets.has(target.id)) throw new PmDomainError("DUPLICATE_ID", `target exists: ${target.id}`);
    if (target.tolerance < 0) throw new PmDomainError("INVALID_TOLERANCE", "tolerance cannot be negative");
    const stored: PmTarget = { ...target, version: 1 };
    this.targets.set(target.id, stored);
    return structuredClone(stored);
  }

  observe(observation: TargetObservation): { observation: TargetObservation; exception?: VarianceException } {
    if (this.observations.has(observation.id)) throw new PmDomainError("DUPLICATE_ID", `observation exists: ${observation.id}`);
    const target = this.targets.get(observation.targetId);
    if (!target) throw new PmDomainError("NOT_FOUND", `target not found: ${observation.targetId}`);
    if (target.workspaceId !== observation.workspaceId || target.projectId !== observation.projectId) {
      throw new PmDomainError("CROSS_WORKSPACE", "observation is not bound to target workspace/project");
    }
    if (!observation.evidenceRef) throw new PmDomainError("MISSING_EVIDENCE", "observation requires evidence");
    this.observations.set(observation.id, structuredClone(observation));
    const signedVariance = observation.actual - target.target;
    const breach = target.direction === "max"
      ? observation.actual > target.target + target.tolerance
      : observation.actual < target.target - target.tolerance;
    if (!breach) return { observation: structuredClone(observation) };
    const magnitude = Math.abs(signedVariance) / Math.max(Math.abs(target.target), 1);
    const severity: VarianceException["severity"] = magnitude >= 0.5 ? "critical" : magnitude >= 0.2 ? "high" : "medium";
    const exception: VarianceException = {
      id: `variance:${observation.id}`,
      workspaceId: observation.workspaceId,
      projectId: observation.projectId,
      targetId: target.id,
      metric: target.metric,
      target: target.target,
      actual: observation.actual,
      variance: signedVariance,
      severity,
      evidenceRef: observation.evidenceRef,
    };
    this.exceptions.set(exception.id, exception);
    return { observation: structuredClone(observation), exception: structuredClone(exception) };
  }

  planHistory(workspaceId: string, planId: string): PmPlanRevision[] {
    return structuredClone(this.requirePlan(workspaceId, planId).revisions);
  }

  listExceptions(workspaceId: string, projectId: string): VarianceException[] {
    return [...this.exceptions.values()]
      .filter((item) => item.workspaceId === workspaceId && item.projectId === projectId)
      .map((item) => structuredClone(item));
  }

  private assertCheckpoint(receipt: PmCheckpointReceipt | undefined, plan: PmPlan, actionType: PmCheckpointReceipt["actionType"]): void {
    if (!receipt) throw new PmDomainError("CHECKPOINT_REQUIRED", `${actionType} requires a consumed checkpoint`);
    if (
      receipt.status !== "CONSUMED" ||
      receipt.workspaceId !== plan.workspaceId ||
      receipt.resourceId !== plan.id ||
      receipt.resourceVersion !== plan.version ||
      receipt.actionType !== actionType
    ) {
      throw new PmDomainError("STALE_CHECKPOINT", `${actionType} checkpoint is stale or mismatched`);
    }
  }

  private requirePlan(workspaceId: string, planId: string, expectedVersion?: number): PmPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new PmDomainError("NOT_FOUND", `plan not found: ${planId}`);
    if (plan.workspaceId !== workspaceId) throw new PmDomainError("CROSS_WORKSPACE", "plan belongs to another workspace");
    if (expectedVersion !== undefined && plan.version !== expectedVersion) {
      throw new PmDomainError("STALE_VERSION", `expected plan version ${expectedVersion}, found ${plan.version}`);
    }
    return plan;
  }
}
