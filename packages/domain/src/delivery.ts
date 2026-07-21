import type { ActionType } from "@ai-crm/contracts";
import { canonicalHashOf } from "@ai-crm/policy-engine";

export class DeliveryDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DeliveryDomainError";
  }
}

export interface AuthorizationReceipt {
  workspaceId: string;
  resourceId: string;
  resourceVersion: number;
  actionType: ActionType;
  payloadHash: string;
  policyVersion: number;
  status: "CONSUMED";
}

export interface Deliverable {
  id: string;
  title: string;
  required: boolean;
  status: "pending" | "submitted" | "approved" | "rejected";
  requirementIds: string[];
}

export interface ProjectTask {
  id: string;
  title: string;
  status: "todo" | "in_progress" | "blocked" | "done";
  requirementIds: string[];
  deliverableId?: string;
}

export interface ProjectRisk {
  id: string;
  title: string;
  probability: number;
  impact: number;
  status: "open" | "mitigated" | "closed";
}

export interface DeliveryProject {
  id: string;
  workspaceId: string;
  customerId: string;
  name: string;
  contractId: string;
  contractScope: string;
  scheduleStart: string;
  scheduleEnd: string;
  deliverables: Deliverable[];
  completionRule: "all_required_deliverables_approved";
  riskThreshold: number;
  tasks: ProjectTask[];
  requirementIds: string[];
  risks: ProjectRisk[];
  status: "active" | "awaiting_user_approval" | "complete";
  version: number;
}

export interface BaselinePatch {
  contractId?: string;
  contractScope?: string;
  scheduleStart?: string;
  scheduleEnd?: string;
  riskThreshold?: number;
}

export function classifyBaselineMutation(patch: BaselinePatch): ActionType {
  if (patch.contractId !== undefined) return "CONTRACT_CHANGE";
  if (patch.contractScope !== undefined) return "SCOPE_CHANGE";
  if (patch.scheduleStart !== undefined || patch.scheduleEnd !== undefined) return "SCHEDULE_CHANGE";
  return "INTERNAL_REVERSIBLE_UPDATE";
}

export function baselinePayloadHash(actionType: ActionType, patch: BaselinePatch): string {
  return canonicalHashOf(actionType, patch);
}

export class DeliveryService {
  private readonly projects = new Map<string, DeliveryProject>();

  /**
   * Restart-consistency hydrate-on-boot (Ultragoal P6-b G001 / PG-B):
   * rebuild the in-memory projects map wholesale from persisted
   * `DeliveryProject` rows (read back from PG at process start via
   * `PmRepository.listAllProjects`), so a fresh process reflects prior
   * projects instead of starting empty. Mirrors `CrmService.hydrateCustomers`.
   */
  hydrateProjects(projects: readonly DeliveryProject[]): void {
    this.projects.clear();
    for (const project of projects) {
      this.projects.set(project.id, structuredClone(project));
    }
  }

  createProject(project: Omit<DeliveryProject, "version" | "tasks" | "risks" | "status">): DeliveryProject {
    if (this.projects.has(project.id)) throw new DeliveryDomainError("DUPLICATE_ID", `project exists: ${project.id}`);
    if (project.scheduleEnd < project.scheduleStart) throw new DeliveryDomainError("INVALID_SCHEDULE", "schedule end precedes start");
    if (!project.deliverables.some((item) => item.required)) {
      throw new DeliveryDomainError("MISSING_REQUIRED_DELIVERABLE", "at least one required deliverable is required");
    }
    if (project.riskThreshold < 0 || project.riskThreshold > 1) {
      throw new DeliveryDomainError("INVALID_RISK_THRESHOLD", "risk threshold must be between 0 and 1");
    }
    const created: DeliveryProject = {
      ...structuredClone(project),
      tasks: [],
      risks: [],
      status: "active",
      version: 1,
    };
    this.projects.set(project.id, created);
    return structuredClone(created);
  }

  getProject(workspaceId: string, projectId: string): DeliveryProject {
    return structuredClone(this.requireProject(workspaceId, projectId));
  }

  changeBaseline(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    patch: BaselinePatch,
    receipt?: AuthorizationReceipt,
  ): DeliveryProject {
    const project = this.requireProject(workspaceId, projectId);
    if (project.version !== expectedVersion) throw new DeliveryDomainError("STALE_VERSION", "project version is stale");
    const actionType = classifyBaselineMutation(patch);
    if (actionType !== "INTERNAL_REVERSIBLE_UPDATE") this.assertReceipt(project, actionType, patch, receipt);
    const updated = { ...project, ...patch, version: project.version + 1 };
    if (updated.scheduleEnd < updated.scheduleStart) throw new DeliveryDomainError("INVALID_SCHEDULE", "schedule end precedes start");
    this.projects.set(projectId, updated);
    return structuredClone(updated);
  }

  addTask(workspaceId: string, projectId: string, expectedVersion: number, task: ProjectTask): DeliveryProject {
    const project = this.requireVersion(workspaceId, projectId, expectedVersion);
    if (project.tasks.some((item) => item.id === task.id)) throw new DeliveryDomainError("DUPLICATE_ID", `task exists: ${task.id}`);
    for (const requirementId of task.requirementIds) {
      if (!project.requirementIds.includes(requirementId)) {
        throw new DeliveryDomainError("UNKNOWN_REQUIREMENT", `task references unknown requirement: ${requirementId}`);
      }
    }
    if (task.deliverableId && !project.deliverables.some((item) => item.id === task.deliverableId)) {
      throw new DeliveryDomainError("UNKNOWN_DELIVERABLE", `task references unknown deliverable: ${task.deliverableId}`);
    }
    project.tasks.push(structuredClone(task));
    project.version += 1;
    return structuredClone(project);
  }

  updateDeliverableStatus(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    deliverableId: string,
    status: Deliverable["status"],
  ): DeliveryProject {
    const project = this.requireVersion(workspaceId, projectId, expectedVersion);
    const deliverable = project.deliverables.find((item) => item.id === deliverableId);
    if (!deliverable) throw new DeliveryDomainError("NOT_FOUND", `deliverable not found: ${deliverableId}`);
    deliverable.status = status;
    project.version += 1;
    return structuredClone(project);
  }

  recordRisk(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    risk: ProjectRisk,
  ): { project: DeliveryProject; thresholdExceeded: boolean; score: number } {
    const project = this.requireVersion(workspaceId, projectId, expectedVersion);
    if (risk.probability < 0 || risk.probability > 1 || risk.impact < 0 || risk.impact > 1) {
      throw new DeliveryDomainError("INVALID_RISK", "probability and impact must be between 0 and 1");
    }
    if (project.risks.some((item) => item.id === risk.id)) throw new DeliveryDomainError("DUPLICATE_ID", `risk exists: ${risk.id}`);
    project.risks.push(structuredClone(risk));
    project.version += 1;
    const score = risk.probability * risk.impact;
    return { project: structuredClone(project), thresholdExceeded: score >= project.riskThreshold, score };
  }

  proposeCompletion(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.requireVersion(workspaceId, projectId, expectedVersion);
    const incomplete = project.deliverables.filter((item) => item.required && item.status !== "approved");
    if (incomplete.length > 0) {
      throw new DeliveryDomainError("COMPLETION_RULE_FAILED", `required deliverables not approved: ${incomplete.map((item) => item.id).join(",")}`);
    }
    if (project.tasks.some((task) => task.status === "blocked" || task.status !== "done")) {
      throw new DeliveryDomainError("COMPLETION_RULE_FAILED", "all project tasks must be done");
    }
    project.status = "awaiting_user_approval";
    project.version += 1;
    return structuredClone(project);
  }

  private assertReceipt(project: DeliveryProject, actionType: ActionType, patch: BaselinePatch, receipt?: AuthorizationReceipt): void {
    if (!receipt) throw new DeliveryDomainError("AUTHORIZATION_REQUIRED", `${actionType} requires consumed authorization`);
    if (
      receipt.status !== "CONSUMED" ||
      receipt.workspaceId !== project.workspaceId ||
      receipt.resourceId !== project.id ||
      receipt.resourceVersion !== project.version ||
      receipt.actionType !== actionType ||
      receipt.payloadHash !== baselinePayloadHash(actionType, patch) ||
      receipt.policyVersion < 1
    ) {
      throw new DeliveryDomainError("STALE_AUTHORIZATION", `authorization is not bound to current ${actionType}`);
    }
  }

  private requireVersion(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.requireProject(workspaceId, projectId);
    if (project.version !== expectedVersion) throw new DeliveryDomainError("STALE_VERSION", "project version is stale");
    return project;
  }

  private requireProject(workspaceId: string, projectId: string): DeliveryProject {
    const project = this.projects.get(projectId);
    if (!project) throw new DeliveryDomainError("NOT_FOUND", `project not found: ${projectId}`);
    if (project.workspaceId !== workspaceId) throw new DeliveryDomainError("CROSS_WORKSPACE", "project belongs to another workspace");
    return project;
  }
}
