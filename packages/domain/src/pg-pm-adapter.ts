/**
 * PostgreSQL adapter for PM (`PmPlan`/`PmAssignment`/`PmTarget`/
 * `TargetObservation`/`VarianceException`) + delivery (`DeliveryProject`)
 * persistence (Ultragoal P6-b G001 / PG-B — second and third domain PG
 * proofs after CRM customers).
 *
 * Mirrors `pg-crm-adapter.ts`'s pattern exactly: a stable repository port,
 * pure row <-> domain mappers, an in-memory implementation for unit/restart
 * tests without PostgreSQL, and `createPgPmRepository(pool)` for createApp
 * injection. One repository covers all six PG-B aggregates against the six
 * sidecar tables from 0008_pm_delivery.sql — there is no independent access
 * pattern that would justify splitting PM vs delivery into two ports.
 *
 * Nested arrays (`PmPlan.revisions`; `DeliveryProject.deliverables/tasks/
 * risks/requirementIds`) are stored as jsonb columns and (de)serialized here
 * with plain `JSON.stringify`/`JSON.parse` — see 0008_pm_delivery.sql's doc
 * comment for why `stableStringify` (used by governance's hash-verified
 * audit payloads) is not required for this slice.
 */

import type { PmPlan, PmAssignment, PmTarget, TargetObservation, VarianceException, TargetMetric } from "./pm.js";
import type { DeliveryProject, Deliverable, ProjectTask, ProjectRisk } from "./delivery.js";
export type { PgQueryable, PgQueryResult } from "./pg-crm-adapter.js";
import type { PgQueryable } from "./pg-crm-adapter.js";

export interface PmPlanRow {
  id: string;
  workspace_id: string;
  project_id: string;
  version: number;
  revisions: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PmAssignmentRow {
  id: string;
  workspace_id: string;
  project_id: string;
  plan_id: string;
  task_id: string;
  assignee_principal_id: string;
  assigned_by_principal_id: string;
  status: string;
  created_at: Date | string;
}

export interface PmTargetRow {
  id: string;
  workspace_id: string;
  project_id: string;
  metric: string;
  target: number;
  tolerance: number;
  direction: string;
  version: number;
}

export interface PmTargetObservationRow {
  id: string;
  workspace_id: string;
  project_id: string;
  target_id: string;
  actual: number;
  observed_at: Date | string;
  evidence_ref: string;
}

export interface PmVarianceExceptionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  target_id: string;
  metric: string;
  target: number;
  actual: number;
  variance: number;
  severity: string;
  evidence_ref: string;
}

export interface DeliveryProjectRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  name: string;
  contract_id: string;
  contract_scope: string;
  schedule_start: string;
  schedule_end: string;
  deliverables: unknown;
  completion_rule: string;
  risk_threshold: number;
  tasks: unknown;
  requirement_ids: unknown;
  risks: unknown;
  status: string;
  version: number;
}

export interface PmRepository {
  savePlan(plan: PmPlan): Promise<void>;
  getPlansForWorkspace(workspaceId: string): Promise<PmPlan[]>;
  listAllPlans(): Promise<PmPlan[]>;

  saveAssignment(assignment: PmAssignment): Promise<void>;
  getAssignmentsForWorkspace(workspaceId: string): Promise<PmAssignment[]>;
  listAllAssignments(): Promise<PmAssignment[]>;

  saveTarget(target: PmTarget): Promise<void>;
  getTargetsForWorkspace(workspaceId: string): Promise<PmTarget[]>;
  listAllTargets(): Promise<PmTarget[]>;

  saveObservation(observation: TargetObservation): Promise<void>;
  getObservationsForWorkspace(workspaceId: string): Promise<TargetObservation[]>;
  listAllObservations(): Promise<TargetObservation[]>;

  saveException(exception: VarianceException): Promise<void>;
  getExceptionsForWorkspace(workspaceId: string): Promise<VarianceException[]>;
  listAllExceptions(): Promise<VarianceException[]>;

  saveProject(project: DeliveryProject): Promise<void>;
  getProjectsForWorkspace(workspaceId: string): Promise<DeliveryProject[]>;
  listAllProjects(): Promise<DeliveryProject[]>;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** jsonb columns are auto-parsed to JS values by most pg drivers, but stay defensive for raw-string clients. */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

export function mapPlanRow(row: PmPlanRow): PmPlan {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    version: row.version,
    revisions: parseJson(row.revisions, []),
  };
}

export function mapAssignmentRow(row: PmAssignmentRow): PmAssignment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planId: row.plan_id,
    taskId: row.task_id,
    assigneePrincipalId: row.assignee_principal_id,
    assignedByPrincipalId: row.assigned_by_principal_id,
    status: row.status as PmAssignment["status"],
    createdAt: toIso(row.created_at),
  };
}

export function mapTargetRow(row: PmTargetRow): PmTarget {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    metric: row.metric as TargetMetric,
    target: row.target,
    tolerance: row.tolerance,
    direction: row.direction as PmTarget["direction"],
    version: row.version,
  };
}

export function mapObservationRow(row: PmTargetObservationRow): TargetObservation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    targetId: row.target_id,
    actual: row.actual,
    observedAt: toIso(row.observed_at),
    evidenceRef: row.evidence_ref,
  };
}

export function mapVarianceExceptionRow(row: PmVarianceExceptionRow): VarianceException {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    targetId: row.target_id,
    metric: row.metric as TargetMetric,
    target: row.target,
    actual: row.actual,
    variance: row.variance,
    severity: row.severity as VarianceException["severity"],
    evidenceRef: row.evidence_ref,
  };
}

export function mapProjectRow(row: DeliveryProjectRow): DeliveryProject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    name: row.name,
    contractId: row.contract_id,
    contractScope: row.contract_scope,
    scheduleStart: row.schedule_start,
    scheduleEnd: row.schedule_end,
    deliverables: parseJson<Deliverable[]>(row.deliverables, []),
    completionRule: row.completion_rule as DeliveryProject["completionRule"],
    riskThreshold: row.risk_threshold,
    tasks: parseJson<ProjectTask[]>(row.tasks, []),
    requirementIds: parseJson<string[]>(row.requirement_ids, []),
    risks: parseJson<ProjectRisk[]>(row.risks, []),
    status: row.status as DeliveryProject["status"],
    version: row.version,
  };
}

/**
 * In-memory PG-B repository for unit/restart tests without PostgreSQL.
 * Round-trips every aggregate shape via `structuredClone`.
 */
export class InMemoryPmRepository implements PmRepository {
  private readonly plans = new Map<string, PmPlan>();
  private readonly assignments = new Map<string, PmAssignment>();
  private readonly targets = new Map<string, PmTarget>();
  private readonly observations = new Map<string, TargetObservation>();
  private readonly exceptions = new Map<string, VarianceException>();
  private readonly projects = new Map<string, DeliveryProject>();

  async savePlan(plan: PmPlan): Promise<void> {
    this.plans.set(`${plan.workspaceId}\0${plan.id}`, structuredClone(plan));
  }
  async getPlansForWorkspace(workspaceId: string): Promise<PmPlan[]> {
    return [...this.plans.values()].filter((p) => p.workspaceId === workspaceId).map((p) => structuredClone(p));
  }
  async listAllPlans(): Promise<PmPlan[]> {
    return [...this.plans.values()].map((p) => structuredClone(p));
  }

  async saveAssignment(assignment: PmAssignment): Promise<void> {
    this.assignments.set(`${assignment.workspaceId}\0${assignment.id}`, structuredClone(assignment));
  }
  async getAssignmentsForWorkspace(workspaceId: string): Promise<PmAssignment[]> {
    return [...this.assignments.values()].filter((a) => a.workspaceId === workspaceId).map((a) => structuredClone(a));
  }
  async listAllAssignments(): Promise<PmAssignment[]> {
    return [...this.assignments.values()].map((a) => structuredClone(a));
  }

  async saveTarget(target: PmTarget): Promise<void> {
    this.targets.set(`${target.workspaceId}\0${target.id}`, structuredClone(target));
  }
  async getTargetsForWorkspace(workspaceId: string): Promise<PmTarget[]> {
    return [...this.targets.values()].filter((t) => t.workspaceId === workspaceId).map((t) => structuredClone(t));
  }
  async listAllTargets(): Promise<PmTarget[]> {
    return [...this.targets.values()].map((t) => structuredClone(t));
  }

  async saveObservation(observation: TargetObservation): Promise<void> {
    this.observations.set(`${observation.workspaceId}\0${observation.id}`, structuredClone(observation));
  }
  async getObservationsForWorkspace(workspaceId: string): Promise<TargetObservation[]> {
    return [...this.observations.values()].filter((o) => o.workspaceId === workspaceId).map((o) => structuredClone(o));
  }
  async listAllObservations(): Promise<TargetObservation[]> {
    return [...this.observations.values()].map((o) => structuredClone(o));
  }

  async saveException(exception: VarianceException): Promise<void> {
    this.exceptions.set(`${exception.workspaceId}\0${exception.id}`, structuredClone(exception));
  }
  async getExceptionsForWorkspace(workspaceId: string): Promise<VarianceException[]> {
    return [...this.exceptions.values()].filter((e) => e.workspaceId === workspaceId).map((e) => structuredClone(e));
  }
  async listAllExceptions(): Promise<VarianceException[]> {
    return [...this.exceptions.values()].map((e) => structuredClone(e));
  }

  async saveProject(project: DeliveryProject): Promise<void> {
    this.projects.set(`${project.workspaceId}\0${project.id}`, structuredClone(project));
  }
  async getProjectsForWorkspace(workspaceId: string): Promise<DeliveryProject[]> {
    return [...this.projects.values()].filter((p) => p.workspaceId === workspaceId).map((p) => structuredClone(p));
  }
  async listAllProjects(): Promise<DeliveryProject[]> {
    return [...this.projects.values()].map((p) => structuredClone(p));
  }
}

export function createPgPmRepository(pool: PgQueryable): PmRepository {
  return new PgPmRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against the six tables from 0008_pm_delivery.sql (mirrors
 * `PgCrmRepository`).
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * `listAll*` are the hydrate-on-boot admin paths: they read across every
 * workspace and are expected to run under an admin/superuser connection —
 * production must scope hydrate to a dedicated admin role instead of the
 * bootstrap superuser. See docs/ops/sor-persistence.md.
 */
class PgPmRepository implements PmRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async savePlan(plan: PmPlan): Promise<void> {
    await this.scoped(plan.workspaceId, (db) =>
      db.query(
        `INSERT INTO pm_plans (id, workspace_id, project_id, version, revisions, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (id) DO UPDATE SET
           version = EXCLUDED.version,
           revisions = EXCLUDED.revisions,
           updated_at = now()`,
        [plan.id, plan.workspaceId, plan.projectId, plan.version, JSON.stringify(plan.revisions)],
      ),
    );
  }
  async getPlansForWorkspace(workspaceId: string): Promise<PmPlan[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<PmPlanRow>(`SELECT * FROM pm_plans WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [workspaceId]),
    );
    return result.rows.map(mapPlanRow);
  }
  async listAllPlans(): Promise<PmPlan[]> {
    const result = await this.db.query<PmPlanRow>(`SELECT * FROM pm_plans ORDER BY created_at ASC, id ASC`);
    return result.rows.map(mapPlanRow);
  }

  async saveAssignment(assignment: PmAssignment): Promise<void> {
    await this.scoped(assignment.workspaceId, (db) =>
      db.query(
        `INSERT INTO pm_assignments (id, workspace_id, project_id, plan_id, task_id, assignee_principal_id, assigned_by_principal_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`,
        [
          assignment.id,
          assignment.workspaceId,
          assignment.projectId,
          assignment.planId,
          assignment.taskId,
          assignment.assigneePrincipalId,
          assignment.assignedByPrincipalId,
          assignment.status,
          assignment.createdAt,
        ],
      ),
    );
  }
  async getAssignmentsForWorkspace(workspaceId: string): Promise<PmAssignment[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<PmAssignmentRow>(`SELECT * FROM pm_assignments WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [
        workspaceId,
      ]),
    );
    return result.rows.map(mapAssignmentRow);
  }
  async listAllAssignments(): Promise<PmAssignment[]> {
    const result = await this.db.query<PmAssignmentRow>(`SELECT * FROM pm_assignments ORDER BY created_at ASC, id ASC`);
    return result.rows.map(mapAssignmentRow);
  }

  async saveTarget(target: PmTarget): Promise<void> {
    await this.scoped(target.workspaceId, (db) =>
      db.query(
        `INSERT INTO pm_targets (id, workspace_id, project_id, metric, target, tolerance, direction, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
        [target.id, target.workspaceId, target.projectId, target.metric, target.target, target.tolerance, target.direction, target.version],
      ),
    );
  }
  async getTargetsForWorkspace(workspaceId: string): Promise<PmTarget[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<PmTargetRow>(`SELECT * FROM pm_targets WHERE workspace_id = $1 ORDER BY id ASC`, [workspaceId]),
    );
    return result.rows.map(mapTargetRow);
  }
  async listAllTargets(): Promise<PmTarget[]> {
    const result = await this.db.query<PmTargetRow>(`SELECT * FROM pm_targets ORDER BY id ASC`);
    return result.rows.map(mapTargetRow);
  }

  async saveObservation(observation: TargetObservation): Promise<void> {
    await this.scoped(observation.workspaceId, (db) =>
      db.query(
        `INSERT INTO pm_target_observations (id, workspace_id, project_id, target_id, actual, observed_at, evidence_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          observation.id,
          observation.workspaceId,
          observation.projectId,
          observation.targetId,
          observation.actual,
          observation.observedAt,
          observation.evidenceRef,
        ],
      ),
    );
  }
  async getObservationsForWorkspace(workspaceId: string): Promise<TargetObservation[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<PmTargetObservationRow>(
        `SELECT * FROM pm_target_observations WHERE workspace_id = $1 ORDER BY observed_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map(mapObservationRow);
  }
  async listAllObservations(): Promise<TargetObservation[]> {
    const result = await this.db.query<PmTargetObservationRow>(
      `SELECT * FROM pm_target_observations ORDER BY observed_at ASC, id ASC`,
    );
    return result.rows.map(mapObservationRow);
  }

  async saveException(exception: VarianceException): Promise<void> {
    await this.scoped(exception.workspaceId, (db) =>
      db.query(
        `INSERT INTO pm_variance_exceptions (id, workspace_id, project_id, target_id, metric, target, actual, variance, severity, evidence_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          exception.id,
          exception.workspaceId,
          exception.projectId,
          exception.targetId,
          exception.metric,
          exception.target,
          exception.actual,
          exception.variance,
          exception.severity,
          exception.evidenceRef,
        ],
      ),
    );
  }
  async getExceptionsForWorkspace(workspaceId: string): Promise<VarianceException[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<PmVarianceExceptionRow>(`SELECT * FROM pm_variance_exceptions WHERE workspace_id = $1 ORDER BY id ASC`, [
        workspaceId,
      ]),
    );
    return result.rows.map(mapVarianceExceptionRow);
  }
  async listAllExceptions(): Promise<VarianceException[]> {
    const result = await this.db.query<PmVarianceExceptionRow>(`SELECT * FROM pm_variance_exceptions ORDER BY id ASC`);
    return result.rows.map(mapVarianceExceptionRow);
  }

  async saveProject(project: DeliveryProject): Promise<void> {
    await this.scoped(project.workspaceId, (db) =>
      db.query(
        `INSERT INTO delivery_projects (
           id, workspace_id, customer_id, name, contract_id, contract_scope,
           schedule_start, schedule_end, deliverables, completion_rule,
           risk_threshold, tasks, requirement_ids, risks, status, version
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           contract_id = EXCLUDED.contract_id,
           contract_scope = EXCLUDED.contract_scope,
           schedule_start = EXCLUDED.schedule_start,
           schedule_end = EXCLUDED.schedule_end,
           deliverables = EXCLUDED.deliverables,
           risk_threshold = EXCLUDED.risk_threshold,
           tasks = EXCLUDED.tasks,
           requirement_ids = EXCLUDED.requirement_ids,
           risks = EXCLUDED.risks,
           status = EXCLUDED.status,
           version = EXCLUDED.version`,
        [
          project.id,
          project.workspaceId,
          project.customerId,
          project.name,
          project.contractId,
          project.contractScope,
          project.scheduleStart,
          project.scheduleEnd,
          JSON.stringify(project.deliverables),
          project.completionRule,
          project.riskThreshold,
          JSON.stringify(project.tasks),
          JSON.stringify(project.requirementIds),
          JSON.stringify(project.risks),
          project.status,
          project.version,
        ],
      ),
    );
  }
  async getProjectsForWorkspace(workspaceId: string): Promise<DeliveryProject[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<DeliveryProjectRow>(`SELECT * FROM delivery_projects WHERE workspace_id = $1 ORDER BY id ASC`, [
        workspaceId,
      ]),
    );
    return result.rows.map(mapProjectRow);
  }
  async listAllProjects(): Promise<DeliveryProject[]> {
    const result = await this.db.query<DeliveryProjectRow>(`SELECT * FROM delivery_projects ORDER BY id ASC`);
    return result.rows.map(mapProjectRow);
  }
}
