/**
 * PostgreSQL adapter for JobSnapshot persistence (P1.5 spine).
 *
 * Maps rows ↔ JobSnapshot for orch_jobs / orch_work_items / orch_job_events.
 * Does not own lifecycle transitions — those stay on OrchestrationService.
 *
 * Injection later from apps/api createApp:
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const orchRepo = createPgOrchestrationRepository(pool);
 *   // after each mutation: await orchRepo.saveSnapshot(service.getJob(ws, id));
 *
 * Requires a client that can apply a SET LOCAL-equivalent via
 * set_config('app.workspace_id', ..., true) (or an already-scoped session)
 * so FORCE RLS policies from 0003 succeed.
 */

import type { Job, JobEvent, JobSnapshot, JobSource, JobStatus, WorkItem, WorkItemStatus } from "./index.js";

/** Minimal query surface compatible with `pg` Pool / PoolClient / Client. */
export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  /**
   * Optional: run `fn` against a single checked-out connection/transaction
   * with `app.workspace_id` set via a SET LOCAL-equivalent
   * (`set_config('app.workspace_id', ..., true)`), so FORCE RLS policies on
   * orch_jobs / orch_work_items / orch_job_events (0003) are enforced for
   * the duration of `fn`. A plain `pg.Pool.query()` checks out a different
   * connection per call, so a SET LOCAL-equivalent set on one call would not apply to the
   * next — callers that inject a real pool MUST implement this (see
   * apps/api/src/app.ts `createScopedPgQueryable`). When absent (unit test
   * mocks, or a caller documenting that the injected pool is already
   * per-request scoped), repository ops fall back to `this.db.query`
   * directly and RLS scoping is the caller's responsibility.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

export interface OrchestrationStore {
  saveSnapshot(snapshot: JobSnapshot): Promise<void>;
  getJob(workspaceId: string, jobId: string): Promise<JobSnapshot | undefined>;
  getByIdempotency(workspaceId: string, idempotencyKey: string): Promise<JobSnapshot | undefined>;
  /**
   * List all persisted job snapshots, optionally scoped to a workspace.
   * Used for hydrate-on-boot restart-consistency: rebuilds in-memory
   * OrchestrationService state from PG on process start.
   */
  listJobSnapshots(workspaceId?: string): Promise<JobSnapshot[]>;
}

export interface OrchJobRow {
  id: string;
  workspace_id: string;
  source: string;
  raw_text: string | null;
  plan_invocation_id: string | null;
  status: string;
  created_by_principal_id: string;
  idempotency_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface OrchWorkItemRow {
  id: string;
  job_id: string;
  workspace_id: string;
  sequence: number;
  title: string;
  status: string;
  suggested_command: string | null;
  action_type: string | null;
  assigned_principal_id: string | null;
  control_id: string | null;
  intent_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  resource_version: number | null;
  progress: number;
  error_code: string | null;
  result_ref: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface OrchJobEventRow {
  id: string;
  job_id: string;
  workspace_id: string;
  kind: string;
  payload: unknown;
  at: Date | string;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // Already an ISO-ish string from a mock; pass through.
    return String(value);
  }
  return parsed.toISOString();
}

function optionalString(value: string | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : value;
}

export function mapJobRow(row: OrchJobRow): Job {
  const job: Job = {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source as JobSource,
    status: row.status as JobStatus,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    workItemIds: [],
  };
  const rawText = optionalString(row.raw_text);
  if (rawText !== undefined) job.rawText = rawText;
  const planInvocationId = optionalString(row.plan_invocation_id);
  if (planInvocationId !== undefined) job.planInvocationId = planInvocationId;
  const idempotencyKey = optionalString(row.idempotency_key);
  if (idempotencyKey !== undefined) job.idempotencyKey = idempotencyKey;
  return job;
}

export function mapWorkItemRow(row: OrchWorkItemRow): WorkItem {
  const item: WorkItem = {
    id: row.id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    title: row.title,
    status: row.status as WorkItemStatus,
    progress: row.progress ?? 0,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  const suggestedCommand = optionalString(row.suggested_command);
  if (suggestedCommand !== undefined) item.suggestedCommand = suggestedCommand;
  const actionType = optionalString(row.action_type);
  if (actionType !== undefined) item.actionType = actionType;
  const assignedPrincipalId = optionalString(row.assigned_principal_id);
  if (assignedPrincipalId !== undefined) item.assignedPrincipalId = assignedPrincipalId;
  const controlId = optionalString(row.control_id);
  if (controlId !== undefined) item.controlId = controlId;
  const intentId = optionalString(row.intent_id);
  if (intentId !== undefined) item.intentId = intentId;
  const resourceType = optionalString(row.resource_type);
  if (resourceType !== undefined) item.resourceType = resourceType;
  const resourceId = optionalString(row.resource_id);
  if (resourceId !== undefined) item.resourceId = resourceId;
  if (row.resource_version !== null && row.resource_version !== undefined) {
    item.resourceVersion = row.resource_version;
  }
  const errorCode = optionalString(row.error_code);
  if (errorCode !== undefined) item.errorCode = errorCode;
  if (row.result_ref !== null && row.result_ref !== undefined) {
    item.resultRef = row.result_ref;
  }
  return item;
}

export function mapEventRow(row: OrchJobEventRow): JobEvent {
  const payload =
    row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    payload,
    at: toIso(row.at),
  };
}

export function assembleSnapshot(
  jobRow: OrchJobRow,
  workItemRows: OrchWorkItemRow[],
  eventRows: OrchJobEventRow[],
): JobSnapshot {
  const workItems = [...workItemRows]
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map(mapWorkItemRow);
  const job = mapJobRow(jobRow);
  job.workItemIds = workItems.map((item) => item.id);
  const events = [...eventRows]
    .sort((a, b) => toIso(a.at).localeCompare(toIso(b.at)) || a.id.localeCompare(b.id))
    .map(mapEventRow);
  return { job, workItems, events };
}

/**
 * In-memory store implementing OrchestrationStore for unit tests and
 * restart-survival simulations (serialize JSON ↔ revive).
 */
export class InMemoryOrchestrationStore implements OrchestrationStore {
  private readonly byId = new Map<string, JobSnapshot>();
  private readonly byIdempotency = new Map<string, string>();

  private key(workspaceId: string, jobId: string): string {
    return `${workspaceId}\0${jobId}`;
  }

  private idemKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}\0${idempotencyKey}`;
  }

  async saveSnapshot(snapshot: JobSnapshot): Promise<void> {
    const clone: JobSnapshot = structuredClone(snapshot);
    this.byId.set(this.key(clone.job.workspaceId, clone.job.id), clone);
    if (clone.job.idempotencyKey) {
      this.byIdempotency.set(this.idemKey(clone.job.workspaceId, clone.job.idempotencyKey), clone.job.id);
    }
  }

  async getJob(workspaceId: string, jobId: string): Promise<JobSnapshot | undefined> {
    const found = this.byId.get(this.key(workspaceId, jobId));
    return found ? structuredClone(found) : undefined;
  }

  async getByIdempotency(workspaceId: string, idempotencyKey: string): Promise<JobSnapshot | undefined> {
    const jobId = this.byIdempotency.get(this.idemKey(workspaceId, idempotencyKey));
    if (!jobId) return undefined;
    return this.getJob(workspaceId, jobId);
  }
  async listJobSnapshots(workspaceId?: string): Promise<JobSnapshot[]> {
    return [...this.byId.values()]
      .filter((snap) => workspaceId === undefined || snap.job.workspaceId === workspaceId)
      .map((snap) => structuredClone(snap));
  }

  /** Serialize all snapshots for restart-survival tests. */
  toJSON(): JobSnapshot[] {
    return [...this.byId.values()].map((snap) => structuredClone(snap));
  }

  static fromJSON(snapshots: JobSnapshot[]): InMemoryOrchestrationStore {
    const store = new InMemoryOrchestrationStore();
    for (const snap of snapshots) {
      void store.saveSnapshot(snap);
    }
    return store;
  }
}

export function createPgOrchestrationRepository(pool: PgQueryable): OrchestrationStore {
  return new PgOrchestrationRepository(pool);
}

class PgOrchestrationRepository implements OrchestrationStore {
  constructor(private readonly db: PgQueryable) {}

  /**
   * Runs `fn` scoped to `workspaceId` via `db.withWorkspaceScope` when the
   * injected pool implements it (real `pg.Pool` from createApp's onReady),
   * so a SET LOCAL-equivalent (`set_config('app.workspace_id', ..., true)`) is honored by
   * FORCE RLS on orch_jobs / orch_work_items / orch_job_events. Falls back to running `fn` directly
   * against the unscoped pool for callers that do not implement scoping
   * (unit-test mocks, or a pool the caller documents as already
   * per-request scoped).
   */
  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveSnapshot(snapshot: JobSnapshot): Promise<void> {
    const { job, workItems, events } = snapshot;
    await this.scoped(job.workspaceId, async (db) => {
      // Upsert job header.
      await db.query(
        `INSERT INTO orch_jobs (
           id, workspace_id, source, raw_text, plan_invocation_id, status,
           created_by_principal_id, idempotency_key, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           source = EXCLUDED.source,
           raw_text = EXCLUDED.raw_text,
           plan_invocation_id = EXCLUDED.plan_invocation_id,
           status = EXCLUDED.status,
           created_by_principal_id = EXCLUDED.created_by_principal_id,
           idempotency_key = EXCLUDED.idempotency_key,
           updated_at = EXCLUDED.updated_at`,
        [
          job.id,
          job.workspaceId,
          job.source,
          job.rawText ?? null,
          job.planInvocationId ?? null,
          job.status,
          job.createdByPrincipalId,
          job.idempotencyKey ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      );

      // Replace work items for this job (full snapshot write).
      await db.query(`DELETE FROM orch_work_items WHERE workspace_id = $1 AND job_id = $2`, [
        job.workspaceId,
        job.id,
      ]);
      for (const item of workItems) {
        await db.query(
          `INSERT INTO orch_work_items (
             id, job_id, workspace_id, sequence, title, status, suggested_command,
             action_type, assigned_principal_id, control_id, intent_id,
             resource_type, resource_id, resource_version, progress, error_code,
             result_ref, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
           )`,
          [
            item.id,
            item.jobId,
            item.workspaceId,
            item.sequence,
            item.title,
            item.status,
            item.suggestedCommand ?? null,
            item.actionType ?? null,
            item.assignedPrincipalId ?? null,
            item.controlId ?? null,
            item.intentId ?? null,
            item.resourceType ?? null,
            item.resourceId ?? null,
            item.resourceVersion ?? null,
            item.progress ?? 0,
            item.errorCode ?? null,
            item.resultRef === undefined ? null : JSON.stringify(item.resultRef),
            item.createdAt,
            item.updatedAt,
          ],
        );
      }

      // Replace events for this job (append-only at service layer; full rewrite is ok for snapshot adapter).
      await db.query(`DELETE FROM orch_job_events WHERE workspace_id = $1 AND job_id = $2`, [
        job.workspaceId,
        job.id,
      ]);
      for (const event of events) {
        await db.query(
          `INSERT INTO orch_job_events (id, job_id, workspace_id, kind, payload, at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            event.id,
            event.jobId,
            event.workspaceId,
            event.kind,
            JSON.stringify(event.payload ?? {}),
            event.at,
          ],
        );
      }
    });
  }

  private async fetchJob(
    db: PgQueryable,
    workspaceId: string,
    jobId: string,
  ): Promise<JobSnapshot | undefined> {
    const jobResult = await db.query<OrchJobRow>(
      `SELECT * FROM orch_jobs WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, jobId],
    );
    const jobRow = jobResult.rows[0];
    if (!jobRow) return undefined;

    const workItems = await db.query<OrchWorkItemRow>(
      `SELECT * FROM orch_work_items WHERE workspace_id = $1 AND job_id = $2 ORDER BY sequence ASC, id ASC`,
      [workspaceId, jobId],
    );
    const events = await db.query<OrchJobEventRow>(
      `SELECT * FROM orch_job_events WHERE workspace_id = $1 AND job_id = $2 ORDER BY at ASC, id ASC`,
      [workspaceId, jobId],
    );
    return assembleSnapshot(jobRow, workItems.rows, events.rows);
  }

  async getJob(workspaceId: string, jobId: string): Promise<JobSnapshot | undefined> {
    return this.scoped(workspaceId, (db) => this.fetchJob(db, workspaceId, jobId));
  }

  async getByIdempotency(workspaceId: string, idempotencyKey: string): Promise<JobSnapshot | undefined> {
    return this.scoped(workspaceId, async (db) => {
      const jobResult = await db.query<OrchJobRow>(
        `SELECT * FROM orch_jobs WHERE workspace_id = $1 AND idempotency_key = $2`,
        [workspaceId, idempotencyKey],
      );
      const jobRow = jobResult.rows[0];
      if (!jobRow) return undefined;
      return this.fetchJob(db, workspaceId, jobRow.id);
    });
  }

  async listJobSnapshots(workspaceId?: string): Promise<JobSnapshot[]> {
    if (workspaceId !== undefined) {
      const scopedWorkspaceId = workspaceId;
      return this.scoped(scopedWorkspaceId, (db) => this.fetchAllJobs(db, scopedWorkspaceId));
    }
    // Hydrate-on-boot admin path: reads across every workspace. Expected to
    // run under an admin/superuser connection (docker `ai_crm` bootstrap
    // user bypasses RLS entirely) — production must scope hydrate to a
    // dedicated admin role instead of the bootstrap superuser. See
    // docs/ops/sor-persistence.md.
    return this.fetchAllJobs(this.db, undefined);
  }

  private async fetchAllJobs(db: PgQueryable, workspaceId: string | undefined): Promise<JobSnapshot[]> {
    const jobResult = workspaceId
      ? await db.query<OrchJobRow>(
          `SELECT * FROM orch_jobs WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
          [workspaceId],
        )
      : await db.query<OrchJobRow>(`SELECT * FROM orch_jobs ORDER BY created_at ASC, id ASC`);

    const snapshots: JobSnapshot[] = [];
    for (const jobRow of jobResult.rows) {
      const workItems = await db.query<OrchWorkItemRow>(
        `SELECT * FROM orch_work_items WHERE workspace_id = $1 AND job_id = $2 ORDER BY sequence ASC, id ASC`,
        [jobRow.workspace_id, jobRow.id],
      );
      const events = await db.query<OrchJobEventRow>(
        `SELECT * FROM orch_job_events WHERE workspace_id = $1 AND job_id = $2 ORDER BY at ASC, id ASC`,
        [jobRow.workspace_id, jobRow.id],
      );
      snapshots.push(assembleSnapshot(jobRow, workItems.rows, events.rows));
    }
    return snapshots;
  }
}

/** Pure mapper helpers exported for unit tests without a live PG. */
export const orchRowMappers = {
  mapJobRow,
  mapWorkItemRow,
  mapEventRow,
  assembleSnapshot,
};
