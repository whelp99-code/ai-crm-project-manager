import type {
  ExecutionIntent,
  GovernanceAuthorizationService,
} from "@ai-crm/governance";

/** Minimal governance surface required by one worker tick. */
export interface WorkerGovernance {
  recoverExpiredLeases(nowIso: string): ExecutionIntent[];
  snapshot(): { intents: Record<string, ExecutionIntent> };
}

export interface RunWorkerTickInput {
  governance: WorkerGovernance | GovernanceAuthorizationService;
  nowIso: string;
  /** Optional logger; defaults to console. */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface WorkerTickResult {
  recoveredLeases: ExecutionIntent[];
  stuckIntents: Array<{
    id: string;
    workspaceId: string;
    status: string;
    leaseDeadline?: string;
    leaseEpoch: number;
  }>;
  nowIso: string;
}

/**
 * One Option-D worker tick:
 * 1. recover expired LEASED → QUEUED leases (epoch monotonic)
 * 2. scan/log stuck LEASED|DISPATCHING intents (no remote dispatch)
 *
 * Pure w.r.t. I/O aside from the injected governance + optional log.
 * No Temporal; no user-facing HTTP.
 */
export function runWorkerTick(input: RunWorkerTickInput): WorkerTickResult {
  const log = input.log ?? defaultLog;
  const recoveredLeases = input.governance.recoverExpiredLeases(input.nowIso);
  if (recoveredLeases.length > 0) {
    log("worker.lease_recovered", {
      count: recoveredLeases.length,
      intentIds: recoveredLeases.map((i) => i.id),
      nowIso: input.nowIso,
    });
  }

  const snap = input.governance.snapshot();
  const nowMs = Date.parse(input.nowIso);
  const stuckIntents: WorkerTickResult["stuckIntents"] = [];

  for (const intent of Object.values(snap.intents)) {
    if (intent.status !== "LEASED" && intent.status !== "DISPATCHING") continue;
    const deadlineMs = intent.leaseDeadline ? Date.parse(intent.leaseDeadline) : Number.NaN;
    // After recoverExpiredLeases, remaining LEASED should still have future deadlines.
    // DISPATCHING has no automatic recovery in MVP — surface as stuck when past deadline
    // or when deadline is missing (illegal fencing state).
    const pastDeadline = !Number.isFinite(deadlineMs) || deadlineMs <= nowMs;
    if (!pastDeadline) continue;
    stuckIntents.push({
      id: intent.id,
      workspaceId: intent.workspaceId,
      status: intent.status,
      ...(intent.leaseDeadline !== undefined ? { leaseDeadline: intent.leaseDeadline } : {}),
      leaseEpoch: intent.leaseEpoch,
    });
  }

  if (stuckIntents.length > 0) {
    log("worker.stuck_intents", {
      count: stuckIntents.length,
      intents: stuckIntents,
      nowIso: input.nowIso,
    });
  }

  return {
    recoveredLeases,
    stuckIntents,
    nowIso: input.nowIso,
  };
}

function defaultLog(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.info(message, JSON.stringify(data));
  } else {
    console.info(message);
  }
}
