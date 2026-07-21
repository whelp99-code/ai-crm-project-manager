/**
 * @ai-crm/orchestration — Job / WorkItem lifecycle (in-memory P1).
 *
 * Owns orchestration steps only. Does not call child_process, write files,
 * import provider SDKs, mutate finance/domain, or re-export ai-orchestrator APIs.
 * Effect application stays in apps/api + governance.
 */

/** Keep the workspace dependency linked for consumers that share contract IDs. */
export type { WorkspaceId, PrincipalId } from "@ai-crm/contracts";

export type JobStatus = "open" | "done" | "failed" | "cancelled" | "partial";
export type WorkItemStatus =
  | "queued"
  | "running"
  | "waiting_control"
  | "done"
  | "failed"
  | "cancelled";
export type JobSource = "natural_command" | "api" | string;

export interface Job {
  id: string;
  workspaceId: string;
  source: JobSource;
  rawText?: string;
  planInvocationId?: string;
  status: JobStatus;
  createdByPrincipalId: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  workItemIds: string[];
}

export interface WorkItem {
  id: string;
  jobId: string;
  workspaceId: string;
  sequence: number;
  title: string;
  status: WorkItemStatus;
  suggestedCommand?: string;
  actionType?: string;
  assignedPrincipalId?: string;
  controlId?: string;
  intentId?: string;
  resourceType?: string;
  resourceId?: string;
  resourceVersion?: number;
  progress?: number;
  errorCode?: string;
  resultRef?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent {
  id: string;
  jobId: string;
  workspaceId: string;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface CreateJobStepInput {
  title: string;
  suggestedCommand?: string;
  actionType?: string;
  assignedPrincipalId?: string;
  resourceType?: string;
  resourceId?: string;
  resourceVersion?: number;
}

export interface CreateJobInput {
  workspaceId: string;
  createdBy: string;
  steps: CreateJobStepInput[];
  idempotencyKey?: string;
  planInvocationId?: string;
  rawText?: string;
  source?: JobSource;
}

export interface JobSnapshot {
  job: Job;
  workItems: WorkItem[];
  events: JobEvent[];
}

export class OrchestrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}

const TERMINAL_WORK_ITEM: ReadonlySet<WorkItemStatus> = new Set(["done", "failed", "cancelled"]);
const NON_TERMINAL_WORK_ITEM: ReadonlySet<WorkItemStatus> = new Set([
  "queued",
  "running",
  "waiting_control",
]);

export function isTerminalWorkItemStatus(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM.has(status);
}

/**
 * Derive job status from work-item statuses.
 * - any non-terminal → open
 * - all done → done
 * - all cancelled → cancelled
 * - all failed → failed
 * - mix of terminals → partial
 * Empty set is treated as done (nothing left to run).
 */
export function deriveJobStatus(statuses: readonly WorkItemStatus[]): JobStatus {
  if (statuses.length === 0) return "done";
  if (statuses.some((status) => NON_TERMINAL_WORK_ITEM.has(status))) return "open";
  const unique = new Set(statuses);
  if (unique.size === 1) {
    const only = statuses[0]!;
    if (only === "done") return "done";
    if (only === "cancelled") return "cancelled";
    if (only === "failed") return "failed";
  }
  return "partial";
}

/** Cancel is allowed from queued, running without control, and waiting_control. */
export function canCancelWorkItem(item: Pick<WorkItem, "status" | "controlId">): boolean {
  if (item.status === "queued") return true;
  if (item.status === "waiting_control") return true;
  if (item.status === "running" && item.controlId === undefined) return true;
  return false;
}

export function assertProgress(progress: number): void {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new OrchestrationError("INVALID_PROGRESS", "progress must be between 0 and 100 inclusive");
  }
}

interface OrchestrationState {
  jobs: Record<string, Job>;
  workItems: Record<string, WorkItem>;
  events: JobEvent[];
  /** workspaceId\0idempotencyKey → jobId */
  idempotency: Record<string, string>;
  counters: Record<string, number>;
}

function initialState(): OrchestrationState {
  return { jobs: {}, workItems: {}, events: [], idempotency: {}, counters: {} };
}

function idempotencyLookupKey(workspaceId: string, idempotencyKey: string): string {
  return `${workspaceId}\0${idempotencyKey}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class OrchestrationService {
  private state: OrchestrationState;

  constructor(state: OrchestrationState = initialState()) {
    this.state = structuredClone(state);
  }

  snapshot(): OrchestrationState {
    return structuredClone(this.state);
  }
  /**
   * Restart-consistency hydrate-on-boot: rebuild in-memory state from
   * persisted JobSnapshots (e.g. read back from PG at process start).
   * Replaces the current state wholesale; counters are advanced past the
   * highest existing numeric suffix per id prefix so newly minted ids never
   * collide with hydrated ones. Does not mutate persisted storage.
   */
  hydrate(snapshots: readonly JobSnapshot[]): void {
    const state = initialState();
    for (const snap of snapshots) {
      const job = structuredClone(snap.job);
      state.jobs[job.id] = job;
      this.bumpCounter(state, job.id);
      if (job.idempotencyKey) {
        state.idempotency[idempotencyLookupKey(job.workspaceId, job.idempotencyKey)] = job.id;
      }
      for (const item of snap.workItems) {
        const cloned = structuredClone(item);
        state.workItems[cloned.id] = cloned;
        this.bumpCounter(state, cloned.id);
      }
      for (const event of snap.events) {
        const cloned = structuredClone(event);
        state.events.push(cloned);
        this.bumpCounter(state, cloned.id);
      }
    }
    state.events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    this.state = state;
  }

  private bumpCounter(state: OrchestrationState, id: string): void {
    const idx = id.lastIndexOf("-");
    if (idx < 0) return;
    const prefix = id.slice(0, idx);
    const suffix = Number(id.slice(idx + 1));
    if (!Number.isFinite(suffix)) return;
    if ((state.counters[prefix] ?? 0) < suffix) {
      state.counters[prefix] = suffix;
    }
  }

  createJob(input: CreateJobInput): JobSnapshot {
    return this.transact((draft) => {
      const workspaceId = input.workspaceId?.trim() ?? "";
      if (!workspaceId) {
        throw new OrchestrationError("INVALID_INPUT", "workspaceId is required");
      }
      const createdBy = input.createdBy?.trim() ?? "";
      if (!createdBy) {
        throw new OrchestrationError("INVALID_INPUT", "createdBy is required");
      }
      if (!Array.isArray(input.steps)) {
        throw new OrchestrationError("INVALID_INPUT", "steps must be an array");
      }

      if (input.idempotencyKey !== undefined && input.idempotencyKey !== "") {
        const existingId = draft.idempotency[idempotencyLookupKey(workspaceId, input.idempotencyKey)];
        if (existingId) {
          return this.snapshotFromDraft(draft, existingId);
        }
      }

      const at = nowIso();
      const jobId = this.nextId(draft, "job");
      const workItemIds: string[] = [];
      const createdItems: WorkItem[] = [];

      input.steps.forEach((step, index) => {
        const title = step.title?.trim() ?? "";
        if (!title) {
          throw new OrchestrationError("INVALID_INPUT", `steps[${index}].title is required`);
        }
        if (
          (step.resourceId !== undefined && step.resourceType === undefined) ||
          (step.resourceType !== undefined && step.resourceId === undefined)
        ) {
          throw new OrchestrationError(
            "INVALID_RESOURCE_BINDING",
            "resourceType and resourceId must be set together",
          );
        }
        const workItemId = this.nextId(draft, "wi");
        const item: WorkItem = {
          id: workItemId,
          jobId,
          workspaceId,
          sequence: index + 1,
          title,
          status: "queued",
          progress: 0,
          createdAt: at,
          updatedAt: at,
          ...(step.suggestedCommand !== undefined ? { suggestedCommand: step.suggestedCommand } : {}),
          ...(step.actionType !== undefined ? { actionType: step.actionType } : {}),
          ...(step.assignedPrincipalId !== undefined
            ? { assignedPrincipalId: step.assignedPrincipalId }
            : {}),
          ...(step.resourceType !== undefined ? { resourceType: step.resourceType } : {}),
          ...(step.resourceId !== undefined ? { resourceId: step.resourceId } : {}),
          ...(step.resourceVersion !== undefined ? { resourceVersion: step.resourceVersion } : {}),
        };
        draft.workItems[workItemId] = item;
        workItemIds.push(workItemId);
        createdItems.push(item);
      });

      const job: Job = {
        id: jobId,
        workspaceId,
        source: input.source ?? "api",
        status: deriveJobStatus(createdItems.map((item) => item.status)),
        createdByPrincipalId: createdBy,
        createdAt: at,
        updatedAt: at,
        workItemIds,
        ...(input.rawText !== undefined ? { rawText: input.rawText } : {}),
        ...(input.planInvocationId !== undefined ? { planInvocationId: input.planInvocationId } : {}),
        ...(input.idempotencyKey !== undefined && input.idempotencyKey !== ""
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      };
      draft.jobs[jobId] = job;
      if (job.idempotencyKey) {
        draft.idempotency[idempotencyLookupKey(workspaceId, job.idempotencyKey)] = jobId;
      }

      this.appendEvent(draft, {
        jobId,
        workspaceId,
        kind: "job.created",
        payload: {
          workItemIds: [...workItemIds],
          stepCount: workItemIds.length,
          source: job.source,
        },
        at,
      });
      for (const item of createdItems) {
        this.appendEvent(draft, {
          jobId,
          workspaceId,
          kind: "work_item.created",
          payload: { workItemId: item.id, sequence: item.sequence, title: item.title },
          at,
        });
      }

      return this.snapshotFromDraft(draft, jobId);
    });
  }

  getJob(workspaceId: string, jobId: string): JobSnapshot {
    const job = this.requireJob(this.state, workspaceId, jobId);
    return {
      job: structuredClone(job),
      workItems: job.workItemIds.map((id) => structuredClone(this.state.workItems[id]!)),
      events: this.state.events
        .filter((event) => event.jobId === jobId && event.workspaceId === workspaceId)
        .map((event) => structuredClone(event)),
    };
  }

  findJobByIdempotencyKey(workspaceId: string, idempotencyKey: string): JobSnapshot | undefined {
    const jobId = this.state.idempotency[idempotencyLookupKey(workspaceId, idempotencyKey)];
    if (!jobId) return undefined;
    const job = this.state.jobs[jobId];
    if (!job || job.workspaceId !== workspaceId) return undefined;
    return this.getJob(workspaceId, jobId);
  }

  listJobs(workspaceId: string): Job[] {
    return Object.values(this.state.jobs)
      .filter((job) => job.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((job) => structuredClone(job));
  }

  getWorkItem(workspaceId: string, workItemId: string): WorkItem {
    return structuredClone(this.requireWorkItem(this.state, workspaceId, workItemId));
  }

  listEvents(workspaceId: string, jobId: string): JobEvent[] {
    this.requireJob(this.state, workspaceId, jobId);
    return this.state.events
      .filter((event) => event.jobId === jobId && event.workspaceId === workspaceId)
      .map((event) => structuredClone(event));
  }

  /** queued → running */
  startWorkItem(workspaceId: string, workItemId: string): WorkItem {
    return this.mutateWorkItem(workspaceId, workItemId, (item, at) => {
      if (item.status !== "queued") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot start work item from status ${item.status}`,
        );
      }
      item.status = "running";
      item.updatedAt = at;
    });
  }

  /**
   * Bind a governance control: queued|running → waiting_control.
   * Stores controlId; caller owns control lifecycle.
   */
  bindControl(workspaceId: string, workItemId: string, controlId: string): WorkItem {
    const trimmed = controlId?.trim() ?? "";
    if (!trimmed) {
      throw new OrchestrationError("INVALID_INPUT", "controlId is required");
    }
    return this.mutateWorkItem(workspaceId, workItemId, (item, at, draft) => {
      if (item.status !== "queued" && item.status !== "running") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot bindControl from status ${item.status}`,
        );
      }
      item.status = "waiting_control";
      item.controlId = trimmed;
      item.updatedAt = at;
      this.appendEvent(draft, {
        jobId: item.jobId,
        workspaceId: item.workspaceId,
        kind: "work_item.waiting_control",
        payload: { workItemId: item.id, controlId: trimmed },
        at,
      });
    });
  }

  /** waiting_control → running after control approved (caller already decided). */
  resumeFromControl(workspaceId: string, workItemId: string, intentId?: string): WorkItem {
    return this.mutateWorkItem(workspaceId, workItemId, (item, at) => {
      if (item.status !== "waiting_control") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot resumeFromControl from status ${item.status}`,
        );
      }
      item.status = "running";
      if (intentId !== undefined) item.intentId = intentId;
      item.updatedAt = at;
    });
  }

  markDone(
    workspaceId: string,
    workItemId: string,
    options?: { resultRef?: unknown; intentId?: string; progress?: number },
  ): WorkItem {
    return this.mutateWorkItem(workspaceId, workItemId, (item, at, draft) => {
      if (item.status !== "running") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot markDone from status ${item.status}`,
        );
      }
      const progress = options?.progress ?? 100;
      assertProgress(progress);
      item.status = "done";
      item.progress = progress;
      if (options?.resultRef !== undefined) item.resultRef = structuredClone(options.resultRef);
      if (options?.intentId !== undefined) item.intentId = options.intentId;
      item.updatedAt = at;
      this.appendEvent(draft, {
        jobId: item.jobId,
        workspaceId: item.workspaceId,
        kind: "work_item.done",
        payload: { workItemId: item.id },
        at,
      });
    });
  }

  markFailed(workspaceId: string, workItemId: string, errorCode: string): WorkItem {
    const code = errorCode?.trim() ?? "";
    if (!code) {
      throw new OrchestrationError("INVALID_INPUT", "errorCode is required");
    }
    return this.mutateWorkItem(workspaceId, workItemId, (item, at, draft) => {
      if (item.status !== "running" && item.status !== "waiting_control" && item.status !== "queued") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot markFailed from status ${item.status}`,
        );
      }
      item.status = "failed";
      item.errorCode = code;
      item.updatedAt = at;
      this.appendEvent(draft, {
        jobId: item.jobId,
        workspaceId: item.workspaceId,
        kind: "work_item.failed",
        payload: { workItemId: item.id, errorCode: code },
        at,
      });
    });
  }
  /**
   * AI review REWORK bridge: reopen a terminal done|failed work item so the
   * agent loop can retry. Clears resultRef and errorCode, returns to queued,
   * and emits work_item.reopened_for_rework. Job status is re-derived.
   */
  reopenFromRework(workspaceId: string, workItemId: string): WorkItem {
    return this.mutateWorkItem(workspaceId, workItemId, (item, at, draft) => {
      if (item.status !== "done" && item.status !== "failed") {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot reopenFromRework from status ${item.status}`,
        );
      }
      const previousStatus = item.status;
      item.status = "queued";
      item.progress = 0;
      if (item.resultRef !== undefined) {
        delete item.resultRef;
      }
      if (item.errorCode !== undefined) {
        delete item.errorCode;
      }
      item.updatedAt = at;
      this.appendEvent(draft, {
        jobId: item.jobId,
        workspaceId: item.workspaceId,
        kind: "work_item.reopened_for_rework",
        payload: {
          workItemId: item.id,
          previousStatus,
          reason: "REWORK_REQUIRED",
        },
        at,
      });
    });
  }

  /**
   * Cancel a single work item per cancel truth table.
   * waiting_control clears controlId (caller cancels the control externally).
   */
  cancelWorkItem(workspaceId: string, workItemId: string): WorkItem {
    return this.mutateWorkItem(workspaceId, workItemId, (item, at, draft) => {
      if (isTerminalWorkItemStatus(item.status)) {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot cancel terminal work item in status ${item.status}`,
        );
      }
      if (!canCancelWorkItem(item)) {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot cancel work item in status ${item.status} with control bound on running`,
        );
      }
      const previousControlId = item.controlId;
      item.status = "cancelled";
      if (item.controlId !== undefined) {
        delete item.controlId;
      }
      item.updatedAt = at;
      this.appendEvent(draft, {
        jobId: item.jobId,
        workspaceId: item.workspaceId,
        kind: "work_item.cancelled",
        payload: {
          workItemId: item.id,
          ...(previousControlId !== undefined ? { clearedControlId: previousControlId } : {}),
        },
        at,
      });
    });
  }

  /**
   * Cascade-cancel all cancellable (non-terminal allowed) work items in one commit.
   * Already-terminal items are left untouched. If every item is already terminal, no-op.
   * If a non-terminal item is not cancellable, throws before mutating.
   */
  cancelJob(workspaceId: string, jobId: string): JobSnapshot {
    return this.transact((draft) => {
      const job = this.requireJob(draft, workspaceId, jobId);
      const items = job.workItemIds.map((id) => draft.workItems[id]!);
      const nonTerminal = items.filter((item) => !isTerminalWorkItemStatus(item.status));

      if (nonTerminal.length === 0) {
        return this.snapshotFromDraft(draft, jobId);
      }

      for (const item of nonTerminal) {
        if (!canCancelWorkItem(item)) {
          throw new OrchestrationError(
            "INVALID_WORK_ITEM_TRANSITION",
            `cannot cancel work item ${item.id} in status ${item.status}`,
          );
        }
      }

      const at = nowIso();
      for (const item of nonTerminal) {
        const previousControlId = item.controlId;
        item.status = "cancelled";
        if (item.controlId !== undefined) {
          delete item.controlId;
        }
        item.updatedAt = at;
        this.appendEvent(draft, {
          jobId: item.jobId,
          workspaceId: item.workspaceId,
          kind: "work_item.cancelled",
          payload: {
            workItemId: item.id,
            cascaded: true,
            ...(previousControlId !== undefined ? { clearedControlId: previousControlId } : {}),
          },
          at,
        });
      }

      this.syncJobStatus(draft, jobId, at);
      this.appendEvent(draft, {
        jobId,
        workspaceId,
        kind: "job.cancelled",
        payload: { cancelledCount: nonTerminal.length },
        at,
      });
      return this.snapshotFromDraft(draft, jobId);
    });
  }

  setProgress(workspaceId: string, workItemId: string, progress: number): WorkItem {
    assertProgress(progress);
    return this.mutateWorkItem(workspaceId, workItemId, (item, at) => {
      if (isTerminalWorkItemStatus(item.status)) {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot set progress on terminal work item in status ${item.status}`,
        );
      }
      item.progress = progress;
      item.updatedAt = at;
    });
  }

  bindIntent(workspaceId: string, workItemId: string, intentId: string): WorkItem {
    const trimmed = intentId?.trim() ?? "";
    if (!trimmed) {
      throw new OrchestrationError("INVALID_INPUT", "intentId is required");
    }
    return this.mutateWorkItem(workspaceId, workItemId, (item, at) => {
      if (isTerminalWorkItemStatus(item.status)) {
        throw new OrchestrationError(
          "INVALID_WORK_ITEM_TRANSITION",
          `cannot bind intent on terminal work item in status ${item.status}`,
        );
      }
      item.intentId = trimmed;
      item.updatedAt = at;
    });
  }

  private mutateWorkItem(
    workspaceId: string,
    workItemId: string,
    mutator: (item: WorkItem, at: string, draft: OrchestrationState) => void,
  ): WorkItem {
    return this.transact((draft) => {
      const item = this.requireWorkItem(draft, workspaceId, workItemId);
      const at = nowIso();
      mutator(item, at, draft);
      this.syncJobStatus(draft, item.jobId, at);
      return structuredClone(item);
    });
  }

  private syncJobStatus(draft: OrchestrationState, jobId: string, at: string): void {
    const job = draft.jobs[jobId];
    if (!job) return;
    const statuses = job.workItemIds.map((id) => draft.workItems[id]!.status);
    const next = deriveJobStatus(statuses);
    if (job.status !== next) {
      job.status = next;
      job.updatedAt = at;
      this.appendEvent(draft, {
        jobId,
        workspaceId: job.workspaceId,
        kind: "job.status",
        payload: { status: next },
        at,
      });
    } else {
      job.updatedAt = at;
    }
  }

  private snapshotFromDraft(draft: OrchestrationState, jobId: string): JobSnapshot {
    const job = draft.jobs[jobId]!;
    return {
      job: structuredClone(job),
      workItems: job.workItemIds.map((id) => structuredClone(draft.workItems[id]!)),
      events: draft.events
        .filter((event) => event.jobId === jobId)
        .map((event) => structuredClone(event)),
    };
  }

  private appendEvent(
    draft: OrchestrationState,
    input: Omit<JobEvent, "id">,
  ): JobEvent {
    const event: JobEvent = {
      id: this.nextId(draft, "evt"),
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      payload: structuredClone(input.payload),
      at: input.at,
    };
    draft.events.push(event);
    return event;
  }

  private nextId(draft: OrchestrationState, prefix: string): string {
    const value = (draft.counters[prefix] ?? 0) + 1;
    draft.counters[prefix] = value;
    return `${prefix}-${value.toString().padStart(6, "0")}`;
  }

  private requireJob(state: OrchestrationState, workspaceId: string, jobId: string): Job {
    const job = state.jobs[jobId];
    if (!job) throw new OrchestrationError("NOT_FOUND", `job not found: ${jobId}`);
    if (job.workspaceId !== workspaceId) {
      throw new OrchestrationError("CROSS_WORKSPACE", "job belongs to another workspace");
    }
    return job;
  }

  private requireWorkItem(state: OrchestrationState, workspaceId: string, workItemId: string): WorkItem {
    const item = state.workItems[workItemId];
    if (!item) throw new OrchestrationError("NOT_FOUND", `work item not found: ${workItemId}`);
    if (item.workspaceId !== workspaceId) {
      throw new OrchestrationError("CROSS_WORKSPACE", "work item belongs to another workspace");
    }
    return item;
  }

  private transact<T>(operation: (draft: OrchestrationState) => T): T {
    const draft = structuredClone(this.state);
    const result = operation(draft);
    this.state = draft;
    return result;
  }
}

export {
  InMemoryOrchestrationStore,
  assembleSnapshot,
  createPgOrchestrationRepository,
  mapEventRow,
  mapJobRow,
  mapWorkItemRow,
  orchRowMappers,
  type OrchestrationStore,
  type OrchJobEventRow,
  type OrchJobRow,
  type OrchWorkItemRow,
  type PgQueryable,
  type PgQueryResult,
} from "./pg-store.js";

