export class WorkflowGraphError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowGraphError";
  }
}

export type WorkflowRunStatus =
  | "READY"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "NO_PROGRESS"
  | "BUDGET_EXHAUSTED"
  | "CANCELLED";

export type WorkflowNodeKind = "ACTION" | "DECISION" | "APPROVAL" | "VERIFY" | "TERMINAL";

export interface WorkflowNodeSpec {
  id: string;
  kind: WorkflowNodeKind;
  title: string;
  requirementIds: string[];
  maxVisits?: number;
  approvalActionType?: string;
  terminalResult?: "SUCCESS" | "FAILURE";
}

export interface WorkflowEdgeSpec {
  id: string;
  from: string;
  to: string;
  outcome: string;
  loopId?: string;
}

export interface WorkflowLoopPolicy {
  id: string;
  nodeIds: string[];
  maxIterations: number;
  maxNoProgress: number;
  maxSameFailure: number;
  minProgressDelta: number;
}

export interface WorkflowGraphSpec {
  id: string;
  version: string;
  entryNodeId: string;
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeSpec[];
  loops: WorkflowLoopPolicy[];
  defaultMaxNodeVisits: number;
  maxTransitions: number;
  maxCostUnits: number;
  maxDurationMs: number;
}

export interface WorkflowEvidence {
  id: string;
  kind: string;
  ref: string;
  digest?: string;
  requirementIds?: string[];
}

export interface WorkflowApprovalReceipt {
  id: string;
  actionType: string;
  resourceId: string;
  resourceVersion: number;
  payloadHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  status: "APPROVED" | "REJECTED" | "EXPIRED" | "CONSUMED";
}

export interface WorkflowNodeResult<TState extends Record<string, unknown>> {
  outcome: string;
  statePatch?: Partial<TState>;
  progressScore?: number;
  costUnits?: number;
  evidence?: WorkflowEvidence[];
  failureSignature?: string;
  message?: string;
  approvalBinding?: {
    actionType: string;
    resourceId: string;
    resourceVersion: number;
    payloadHash: string;
  };
}

export interface WorkflowTransitionRecord {
  sequence: number;
  nodeId: string;
  edgeId?: string;
  outcome: string;
  fromStatus: WorkflowRunStatus;
  toStatus: WorkflowRunStatus;
  progressBefore: number;
  progressAfter: number;
  costUnits: number;
  failureSignature?: string;
  evidenceIds: string[];
  message?: string;
  occurredAt: string;
}

export interface WorkflowLoopState {
  iterations: number;
  noProgressCount: number;
  sameFailureCount: number;
  lastFailureSignature?: string;
  lastProgressScore: number;
}

export interface WorkflowRun<TState extends Record<string, unknown>> {
  id: string;
  workspaceId: string;
  graphId: string;
  graphVersion: string;
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  status: WorkflowRunStatus;
  currentNodeId: string;
  state: TState;
  progressScore: number;
  spentCostUnits: number;
  transitions: WorkflowTransitionRecord[];
  nodeVisits: Record<string, number>;
  loopStates: Record<string, WorkflowLoopState>;
  evidence: WorkflowEvidence[];
  waitingApproval?: WorkflowNodeResult<TState>["approvalBinding"];
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
}

export interface WorkflowNodeContext<TState extends Record<string, unknown>> {
  run: Readonly<WorkflowRun<TState>>;
  node: Readonly<WorkflowNodeSpec>;
  now: string;
  approvalReceipt?: WorkflowApprovalReceipt;
}

export type WorkflowNodeHandler<TState extends Record<string, unknown>> = (
  context: WorkflowNodeContext<TState>,
) => WorkflowNodeResult<TState> | Promise<WorkflowNodeResult<TState>>;

export interface WorkflowGraphHandlers<TState extends Record<string, unknown>> {
  [nodeId: string]: WorkflowNodeHandler<TState>;
}

export interface WorkflowRunInput<TState extends Record<string, unknown>> {
  id: string;
  workspaceId: string;
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  initialState: TState;
  now?: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new WorkflowGraphError("INVALID_TIME", `${label} is not an ISO date: ${value}`);
  return parsed;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new WorkflowGraphError("INVALID_NUMBER", `${label} must be a finite non-negative number`);
  }
}

function addMilliseconds(iso: string, durationMs: number): string {
  return new Date(parseTime(iso, "now") + durationMs).toISOString();
}

function terminal(status: WorkflowRunStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "NO_PROGRESS" || status === "BUDGET_EXHAUSTED" || status === "CANCELLED";
}

export class WorkflowGraphRuntime<TState extends Record<string, unknown>> {
  private readonly nodeById: Map<string, WorkflowNodeSpec>;
  private readonly edgesByFrom: Map<string, WorkflowEdgeSpec[]>;
  private readonly loopById: Map<string, WorkflowLoopPolicy>;
  private readonly loopsByNode: Map<string, WorkflowLoopPolicy[]>;

  constructor(
    readonly spec: WorkflowGraphSpec,
    private readonly handlers: WorkflowGraphHandlers<TState>,
  ) {
    this.nodeById = new Map(spec.nodes.map((node) => [node.id, clone(node)]));
    this.edgesByFrom = new Map();
    this.loopById = new Map(spec.loops.map((loop) => [loop.id, clone(loop)]));
    this.loopsByNode = new Map();
    this.validateSpec();
    for (const edge of spec.edges) {
      const current = this.edgesByFrom.get(edge.from) ?? [];
      current.push(clone(edge));
      this.edgesByFrom.set(edge.from, current);
    }
    for (const loop of spec.loops) {
      for (const nodeId of loop.nodeIds) {
        const current = this.loopsByNode.get(nodeId) ?? [];
        current.push(clone(loop));
        this.loopsByNode.set(nodeId, current);
      }
    }
  }

  createRun(input: WorkflowRunInput<TState>): WorkflowRun<TState> {
    if (!input.id.trim() || !input.workspaceId.trim() || !input.resourceType.trim() || !input.resourceId.trim()) {
      throw new WorkflowGraphError("INVALID_INPUT", "id, workspaceId, resourceType and resourceId are required");
    }
    if (!Number.isInteger(input.resourceVersion) || input.resourceVersion < 1) {
      throw new WorkflowGraphError("INVALID_RESOURCE_VERSION", "resourceVersion must be a positive integer");
    }
    const now = input.now ?? new Date().toISOString();
    parseTime(now, "now");
    const loopStates: Record<string, WorkflowLoopState> = {};
    for (const loop of this.spec.loops) {
      loopStates[loop.id] = {
        iterations: 0,
        noProgressCount: 0,
        sameFailureCount: 0,
        lastProgressScore: 0,
      };
    }
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      graphId: this.spec.id,
      graphVersion: this.spec.version,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      status: "READY",
      currentNodeId: this.spec.entryNodeId,
      state: clone(input.initialState),
      progressScore: 0,
      spentCostUnits: 0,
      transitions: [],
      nodeVisits: {},
      loopStates,
      evidence: [],
      createdAt: now,
      updatedAt: now,
      deadlineAt: addMilliseconds(now, this.spec.maxDurationMs),
    };
  }

  async run(
    runInput: WorkflowRun<TState>,
    options: { now?: () => string; approvalReceipt?: WorkflowApprovalReceipt } = {},
  ): Promise<WorkflowRun<TState>> {
    let run = clone(runInput);
    const now = options.now ?? (() => new Date().toISOString());
    if (terminal(run.status)) return run;
    if (run.status === "WAITING_APPROVAL") {
      if (!options.approvalReceipt) return run;
      run = await this.step(run, { now: now(), approvalReceipt: options.approvalReceipt });
      options = { now };
    }
    while (!terminal(run.status) && run.status !== "WAITING_APPROVAL") {
      run = await this.step(run, { now: now() });
    }
    return run;
  }

  async step(
    runInput: WorkflowRun<TState>,
    input: { now?: string; approvalReceipt?: WorkflowApprovalReceipt } = {},
  ): Promise<WorkflowRun<TState>> {
    const run = clone(runInput);
    if (terminal(run.status)) return run;
    if (run.graphId !== this.spec.id || run.graphVersion !== this.spec.version) {
      throw new WorkflowGraphError("GRAPH_VERSION_MISMATCH", "run does not match this graph version");
    }
    const now = input.now ?? new Date().toISOString();
    const nowMs = parseTime(now, "now");
    if (nowMs > parseTime(run.deadlineAt, "deadlineAt")) {
      return this.stop(run, "BUDGET_EXHAUSTED", "WORKFLOW_TIMEOUT", now, "workflow duration budget exhausted");
    }
    if (run.transitions.length >= this.spec.maxTransitions) {
      return this.stop(run, "BUDGET_EXHAUSTED", "MAX_TRANSITIONS", now, "transition budget exhausted");
    }
    if (run.spentCostUnits >= this.spec.maxCostUnits) {
      return this.stop(run, "BUDGET_EXHAUSTED", "MAX_COST", now, "cost budget exhausted");
    }

    const node = this.requireNode(run.currentNodeId);
    const visits = (run.nodeVisits[node.id] ?? 0) + 1;
    const maxVisits = node.maxVisits ?? this.spec.defaultMaxNodeVisits;
    if (visits > maxVisits) {
      return this.stop(run, "BUDGET_EXHAUSTED", "MAX_NODE_VISITS", now, `node ${node.id} visit budget exhausted`);
    }
    run.nodeVisits[node.id] = visits;
    const priorStatus = run.status;
    run.status = "RUNNING";

    let approvalReceipt: WorkflowApprovalReceipt | undefined;
    if (node.kind === "APPROVAL" && run.waitingApproval) {
      approvalReceipt = this.consumeApproval(run, input.approvalReceipt, now);
      if (!approvalReceipt) return run;
    }

    const handler = this.handlers[node.id];
    if (!handler && node.kind !== "TERMINAL") {
      throw new WorkflowGraphError("HANDLER_MISSING", `handler missing for node ${node.id}`);
    }

    let result: WorkflowNodeResult<TState>;
    try {
      result = node.kind === "TERMINAL"
        ? { outcome: node.terminalResult === "SUCCESS" ? "complete" : "fail" }
        : await handler!({ run: clone(run), node: clone(node), now, approvalReceipt });
    } catch (error) {
      const signature = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      result = { outcome: "error", failureSignature: signature, message: signature };
    }

    const cost = result.costUnits ?? 0;
    assertFiniteNonNegative(cost, "costUnits");
    if (run.spentCostUnits + cost > this.spec.maxCostUnits) {
      return this.stop(run, "BUDGET_EXHAUSTED", "MAX_COST", now, "node result would exceed cost budget");
    }
    run.spentCostUnits += cost;

    const progressBefore = run.progressScore;
    const progressAfter = result.progressScore ?? progressBefore;
    assertFiniteNonNegative(progressAfter, "progressScore");
    run.progressScore = progressAfter;
    if (result.statePatch) run.state = { ...run.state, ...clone(result.statePatch) };
    if (result.evidence) {
      for (const evidence of result.evidence) {
        if (!evidence.id.trim() || !evidence.ref.trim() || !evidence.kind.trim()) {
          throw new WorkflowGraphError("INVALID_EVIDENCE", "evidence id, kind and ref are required");
        }
        if (run.evidence.some((item) => item.id === evidence.id)) {
          throw new WorkflowGraphError("DUPLICATE_EVIDENCE", `evidence already exists: ${evidence.id}`);
        }
        run.evidence.push(clone(evidence));
      }
    }

    if (node.kind === "APPROVAL" && !approvalReceipt) {
      const binding = result.approvalBinding;
      if (!binding || binding.actionType !== node.approvalActionType) {
        throw new WorkflowGraphError("INVALID_APPROVAL_BINDING", `approval node ${node.id} requires a matching immutable binding`);
      }
      run.status = "WAITING_APPROVAL";
      run.waitingApproval = clone(binding);
      this.record(run, {
        nodeId: node.id,
        outcome: result.outcome,
        fromStatus: priorStatus,
        toStatus: run.status,
        progressBefore,
        progressAfter,
        costUnits: cost,
        failureSignature: result.failureSignature,
        evidenceIds: result.evidence?.map((item) => item.id) ?? [],
        message: result.message,
        occurredAt: now,
      });
      run.updatedAt = now;
      return run;
    }

    if (node.kind === "TERMINAL") {
      run.status = node.terminalResult === "SUCCESS" ? "COMPLETED" : "FAILED";
      this.record(run, {
        nodeId: node.id,
        outcome: result.outcome,
        fromStatus: priorStatus,
        toStatus: run.status,
        progressBefore,
        progressAfter,
        costUnits: cost,
        failureSignature: result.failureSignature,
        evidenceIds: result.evidence?.map((item) => item.id) ?? [],
        message: result.message,
        occurredAt: now,
      });
      run.updatedAt = now;
      delete run.waitingApproval;
      return run;
    }

    const edge = this.resolveEdge(node.id, result.outcome);
    this.applyLoopPolicies(run, node.id, edge, result, progressAfter, now);
    if (terminal(run.status)) return run;

    run.currentNodeId = edge.to;
    run.status = "RUNNING";
    delete run.waitingApproval;
    this.record(run, {
      nodeId: node.id,
      edgeId: edge.id,
      outcome: result.outcome,
      fromStatus: priorStatus,
      toStatus: run.status,
      progressBefore,
      progressAfter,
      costUnits: cost,
      failureSignature: result.failureSignature,
      evidenceIds: result.evidence?.map((item) => item.id) ?? [],
      message: result.message,
      occurredAt: now,
    });
    run.updatedAt = now;
    return run;
  }

  cancel(runInput: WorkflowRun<TState>, now = new Date().toISOString()): WorkflowRun<TState> {
    const run = clone(runInput);
    if (terminal(run.status)) return run;
    return this.stop(run, "CANCELLED", "CANCELLED_BY_OPERATOR", now, "cancelled by operator");
  }

  private consumeApproval(
    run: WorkflowRun<TState>,
    receipt: WorkflowApprovalReceipt | undefined,
    now: string,
  ): WorkflowApprovalReceipt | undefined {
    if (!receipt) return undefined;
    const binding = run.waitingApproval!;
    if (receipt.status !== "APPROVED") {
      run.status = "WAITING_APPROVAL";
      return undefined;
    }
    if (
      receipt.actionType !== binding.actionType ||
      receipt.resourceId !== binding.resourceId ||
      receipt.resourceVersion !== binding.resourceVersion ||
      receipt.payloadHash !== binding.payloadHash
    ) {
      throw new WorkflowGraphError("STALE_APPROVAL", "approval receipt is not bound to the current resource version and payload");
    }
    if (parseTime(receipt.expiresAt, "approval.expiresAt") < parseTime(now, "now")) {
      throw new WorkflowGraphError("APPROVAL_EXPIRED", "approval receipt expired");
    }
    return { ...clone(receipt), status: "CONSUMED" };
  }

  private applyLoopPolicies(
    run: WorkflowRun<TState>,
    nodeId: string,
    edge: WorkflowEdgeSpec,
    result: WorkflowNodeResult<TState>,
    progressAfter: number,
    now: string,
  ): void {
    const loops = new Map<string, WorkflowLoopPolicy>();
    for (const loop of this.loopsByNode.get(nodeId) ?? []) loops.set(loop.id, loop);
    if (edge.loopId) {
      const loop = this.loopById.get(edge.loopId);
      if (!loop) throw new WorkflowGraphError("UNKNOWN_LOOP", `unknown loop ${edge.loopId}`);
      loops.set(loop.id, loop);
    }
    for (const loop of loops.values()) {
      const state = run.loopStates[loop.id];
      if (!state) throw new WorkflowGraphError("LOOP_STATE_MISSING", `loop state missing: ${loop.id}`);
      const remainsInLoop = loop.nodeIds.includes(edge.to);
      if (remainsInLoop) state.iterations += 1;
      const delta = progressAfter - state.lastProgressScore;
      if (delta < loop.minProgressDelta) state.noProgressCount += 1;
      else state.noProgressCount = 0;
      state.lastProgressScore = progressAfter;
      if (result.failureSignature) {
        if (state.lastFailureSignature === result.failureSignature) state.sameFailureCount += 1;
        else state.sameFailureCount = 1;
        state.lastFailureSignature = result.failureSignature;
      } else {
        state.sameFailureCount = 0;
        delete state.lastFailureSignature;
      }
      if (state.iterations > loop.maxIterations) {
        this.stop(run, "BUDGET_EXHAUSTED", `LOOP_MAX_ITERATIONS:${loop.id}`, now, `loop ${loop.id} exceeded max iterations`);
        return;
      }
      if (state.noProgressCount > loop.maxNoProgress) {
        this.stop(run, "NO_PROGRESS", `LOOP_NO_PROGRESS:${loop.id}`, now, `loop ${loop.id} made no measurable progress`);
        return;
      }
      if (state.sameFailureCount > loop.maxSameFailure) {
        this.stop(run, "FAILED", `LOOP_CIRCUIT_BREAKER:${loop.id}`, now, `loop ${loop.id} repeated the same failure`);
        return;
      }
      if (!remainsInLoop) {
        state.noProgressCount = 0;
        state.sameFailureCount = 0;
        delete state.lastFailureSignature;
      }
    }
  }

  private stop(
    run: WorkflowRun<TState>,
    status: WorkflowRunStatus,
    failureCode: string,
    now: string,
    message: string,
  ): WorkflowRun<TState> {
    const fromStatus = run.status;
    run.status = status;
    run.failureCode = failureCode;
    this.record(run, {
      nodeId: run.currentNodeId,
      outcome: "stop",
      fromStatus,
      toStatus: status,
      progressBefore: run.progressScore,
      progressAfter: run.progressScore,
      costUnits: 0,
      evidenceIds: [],
      message,
      occurredAt: now,
    });
    run.updatedAt = now;
    return run;
  }

  private record(run: WorkflowRun<TState>, record: Omit<WorkflowTransitionRecord, "sequence">): void {
    run.transitions.push({ ...record, sequence: run.transitions.length + 1 });
  }

  private resolveEdge(nodeId: string, outcome: string): WorkflowEdgeSpec {
    const matches = (this.edgesByFrom.get(nodeId) ?? []).filter((edge) => edge.outcome === outcome);
    if (matches.length === 0) throw new WorkflowGraphError("TRANSITION_NOT_FOUND", `no edge from ${nodeId} for outcome ${outcome}`);
    if (matches.length > 1) throw new WorkflowGraphError("AMBIGUOUS_TRANSITION", `multiple edges from ${nodeId} for outcome ${outcome}`);
    return matches[0]!;
  }

  private requireNode(nodeId: string): WorkflowNodeSpec {
    const node = this.nodeById.get(nodeId);
    if (!node) throw new WorkflowGraphError("NODE_NOT_FOUND", `node not found: ${nodeId}`);
    return node;
  }

  private validateSpec(): void {
    if (!this.spec.id.trim() || !this.spec.version.trim()) throw new WorkflowGraphError("INVALID_GRAPH", "graph id and version are required");
    if (!Number.isInteger(this.spec.defaultMaxNodeVisits) || this.spec.defaultMaxNodeVisits < 1) throw new WorkflowGraphError("INVALID_GRAPH", "defaultMaxNodeVisits must be positive");
    if (!Number.isInteger(this.spec.maxTransitions) || this.spec.maxTransitions < 1) throw new WorkflowGraphError("INVALID_GRAPH", "maxTransitions must be positive");
    assertFiniteNonNegative(this.spec.maxCostUnits, "maxCostUnits");
    if (!Number.isFinite(this.spec.maxDurationMs) || this.spec.maxDurationMs <= 0) throw new WorkflowGraphError("INVALID_GRAPH", "maxDurationMs must be positive");
    if (!this.nodeById.has(this.spec.entryNodeId)) throw new WorkflowGraphError("INVALID_GRAPH", "entry node does not exist");
    if (this.nodeById.size !== this.spec.nodes.length) throw new WorkflowGraphError("INVALID_GRAPH", "node IDs must be unique");
    const edgeIds = new Set<string>();
    for (const edge of this.spec.edges) {
      if (edgeIds.has(edge.id)) throw new WorkflowGraphError("INVALID_GRAPH", `duplicate edge id: ${edge.id}`);
      edgeIds.add(edge.id);
      if (!this.nodeById.has(edge.from) || !this.nodeById.has(edge.to)) throw new WorkflowGraphError("INVALID_GRAPH", `edge ${edge.id} references unknown node`);
    }
    for (const node of this.spec.nodes) {
      if (node.kind === "APPROVAL" && !node.approvalActionType) throw new WorkflowGraphError("INVALID_GRAPH", `approval node ${node.id} requires approvalActionType`);
      if (node.kind === "TERMINAL" && !node.terminalResult) throw new WorkflowGraphError("INVALID_GRAPH", `terminal node ${node.id} requires terminalResult`);
      if (node.kind !== "TERMINAL" && !this.handlers[node.id]) throw new WorkflowGraphError("HANDLER_MISSING", `handler missing for node ${node.id}`);
      if (node.kind !== "TERMINAL" && !this.spec.edges.some((edge) => edge.from === node.id)) throw new WorkflowGraphError("INVALID_GRAPH", `non-terminal node ${node.id} has no outgoing edges`);
    }
    const loopIds = new Set<string>();
    for (const loop of this.spec.loops) {
      if (loopIds.has(loop.id)) throw new WorkflowGraphError("INVALID_GRAPH", `duplicate loop id: ${loop.id}`);
      loopIds.add(loop.id);
      if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1) throw new WorkflowGraphError("INVALID_GRAPH", `loop ${loop.id} maxIterations must be positive`);
      if (!Number.isInteger(loop.maxNoProgress) || loop.maxNoProgress < 0) throw new WorkflowGraphError("INVALID_GRAPH", `loop ${loop.id} maxNoProgress must be non-negative`);
      if (!Number.isInteger(loop.maxSameFailure) || loop.maxSameFailure < 0) throw new WorkflowGraphError("INVALID_GRAPH", `loop ${loop.id} maxSameFailure must be non-negative`);
      assertFiniteNonNegative(loop.minProgressDelta, `loop ${loop.id} minProgressDelta`);
      for (const nodeId of loop.nodeIds) {
        if (!this.nodeById.has(nodeId)) throw new WorkflowGraphError("INVALID_GRAPH", `loop ${loop.id} references unknown node ${nodeId}`);
      }
    }
    for (const edge of this.spec.edges) {
      if (edge.loopId && !loopIds.has(edge.loopId)) throw new WorkflowGraphError("INVALID_GRAPH", `edge ${edge.id} references unknown loop ${edge.loopId}`);
    }
  }
}
