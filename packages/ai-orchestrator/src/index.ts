/**
 * @ai-crm/ai-orchestrator — structured AI execution and independent review.
 *
 * Capability confinement: this package calls the model gateway ONLY through
 * its typed `@ai-crm/model-gateway` contract. It never imports a model SDK or
 * constructs a model-endpoint client, and it holds no effect/dispatch
 * capability. All inference flows through the injected `ModelGateway`.
 *
 * It enforces the approved AI-control invariants:
 *  - execution requires an evidence manifest and requirement traceability,
 *  - review is performed by an independent principal (never the executor),
 *  - the quality gate blocks on any critical defect and on exceeding the
 *    configured minor-defect threshold,
 *  - failed review returns the work to REWORK_REQUIRED and a fresh attempt
 *    can be resubmitted (retry/restart) without reusing the prior verdict.
 */
import type {
  ModelGateway,
  ModelInvocationResult,
  StructuredOutputSchema,
} from "@ai-crm/model-gateway";

export class AiOrchestratorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiOrchestratorError";
  }
}

export interface ExecutionEvidence {
  objectKey: string;
  version: string;
  digest: string;
}

export interface RequirementTrace {
  requirementId: string;
  deliverableId: string;
}

export interface ExecutionSubmission {
  id: string;
  workspaceId: string;
  projectId: string;
  planId: string;
  taskId: string;
  executorPrincipalId: string;
  summary: string;
  evidence: ExecutionEvidence[];
  requirementTraces: RequirementTrace[];
  submittedAt: string;
}

export type ExecutionStatus = "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REWORK_REQUIRED";

export interface Execution extends ExecutionSubmission {
  attempt: number;
  status: ExecutionStatus;
}

export type DefectSeverity = "critical" | "minor";

export interface Defect {
  id: string;
  description: string;
  severity: DefectSeverity;
}

export interface ReviewSubmission {
  id: string;
  workspaceId: string;
  executionId: string;
  reviewerPrincipalId: string;
  defects: Defect[];
  reviewedAt: string;
}

export interface Review extends ReviewSubmission {
  attempt: number;
  criticalCount: number;
  minorCount: number;
  verdict: "PASS" | "FAIL";
}

export interface QualityGateConfig {
  /** Maximum number of minor defects a passing review may carry. Critical is always 0. */
  minorThreshold: number;
}

export class AiOrchestrator {
  private readonly executions = new Map<string, Execution>();
  private readonly reviews = new Map<string, Review>();

  constructor(private readonly qualityGate: QualityGateConfig) {
    if (!Number.isInteger(qualityGate.minorThreshold) || qualityGate.minorThreshold < 0) {
      throw new AiOrchestratorError("INVALID_CONFIG", "minorThreshold must be a non-negative integer");
    }
  }

  submitExecution(input: ExecutionSubmission): Execution {
    if (this.executions.has(input.id)) throw new AiOrchestratorError("DUPLICATE_ID", `execution exists: ${input.id}`);
    this.assertSubmission(input);
    const execution: Execution = { ...structuredClone(input), attempt: 1, status: "SUBMITTED" };
    this.executions.set(execution.id, execution);
    return structuredClone(execution);
  }

  /** Resubmit after a failed review; increments the attempt and clears the prior verdict. */
  resubmitExecution(
    workspaceId: string,
    executionId: string,
    revision: Pick<ExecutionSubmission, "summary" | "evidence" | "requirementTraces" | "submittedAt" | "executorPrincipalId">,
  ): Execution {
    const execution = this.requireExecution(workspaceId, executionId);
    if (execution.status !== "REWORK_REQUIRED") {
      throw new AiOrchestratorError("INVALID_STATE", `execution ${executionId} is not awaiting rework`);
    }
    this.assertSubmission({ ...execution, ...revision });
    execution.summary = revision.summary;
    execution.evidence = structuredClone(revision.evidence);
    execution.requirementTraces = structuredClone(revision.requirementTraces);
    execution.submittedAt = revision.submittedAt;
    execution.executorPrincipalId = revision.executorPrincipalId;
    execution.attempt += 1;
    execution.status = "SUBMITTED";
    return structuredClone(execution);
  }

  review(input: ReviewSubmission): { review: Review; execution: Execution } {
    if (this.reviews.has(input.id)) throw new AiOrchestratorError("DUPLICATE_ID", `review exists: ${input.id}`);
    const execution = this.requireExecution(input.workspaceId, input.executionId);
    if (execution.status !== "SUBMITTED" && execution.status !== "UNDER_REVIEW") {
      throw new AiOrchestratorError("INVALID_STATE", `execution ${execution.id} is not reviewable`);
    }
    if (input.reviewerPrincipalId === execution.executorPrincipalId) {
      throw new AiOrchestratorError("INDEPENDENT_REVIEW_REQUIRED", "reviewer must be independent of the executor principal");
    }
    for (const defect of input.defects) {
      if (defect.severity !== "critical" && defect.severity !== "minor") {
        throw new AiOrchestratorError("INVALID_DEFECT", `unknown defect severity: ${String(defect.severity)}`);
      }
    }
    const criticalCount = input.defects.filter((defect) => defect.severity === "critical").length;
    const minorCount = input.defects.filter((defect) => defect.severity === "minor").length;
    const verdict: Review["verdict"] = criticalCount === 0 && minorCount <= this.qualityGate.minorThreshold ? "PASS" : "FAIL";
    const review: Review = { ...structuredClone(input), attempt: execution.attempt, criticalCount, minorCount, verdict };
    this.reviews.set(review.id, review);
    execution.status = verdict === "PASS" ? "ACCEPTED" : "REWORK_REQUIRED";
    return { review: structuredClone(review), execution: structuredClone(execution) };
  }

  /**
   * Structured AI analysis via the model gateway. Demonstrates and enforces
   * gateway-only inference: the orchestrator passes a request and receives
   * validated structured output; it never touches a model client directly.
   */
  async analyze<T = Record<string, unknown>>(
    gateway: ModelGateway,
    request: {
      workspaceId: string;
      operationId: string;
      principalId: string;
      promptVersion: string;
      modelVersion: string;
      prompt: string;
      outputSchema: StructuredOutputSchema;
      correlationId: string;
    },
  ): Promise<ModelInvocationResult<T>> {
    return gateway.invoke<T>({ ...request, requestedRetention: "zero-retention" });
  }

  getExecution(workspaceId: string, executionId: string): Execution {
    return structuredClone(this.requireExecution(workspaceId, executionId));
  }

  reviewsFor(workspaceId: string, executionId: string): Review[] {
    return [...this.reviews.values()]
      .filter((review) => review.workspaceId === workspaceId && review.executionId === executionId)
      .sort((a, b) => a.attempt - b.attempt)
      .map((review) => structuredClone(review));
  }

  private assertSubmission(input: Pick<ExecutionSubmission, "executorPrincipalId" | "evidence" | "requirementTraces">): void {
    if (!input.executorPrincipalId.trim()) throw new AiOrchestratorError("INVALID_INPUT", "executorPrincipalId is required");
    if (input.evidence.length === 0) throw new AiOrchestratorError("MISSING_EVIDENCE", "execution requires an evidence manifest");
    for (const item of input.evidence) {
      if (!item.objectKey.trim() || !item.version.trim() || !item.digest.trim()) {
        throw new AiOrchestratorError("INVALID_EVIDENCE", "each evidence item requires objectKey, version and digest");
      }
    }
    if (input.requirementTraces.length === 0) throw new AiOrchestratorError("MISSING_TRACE", "execution requires requirement traceability");
    for (const trace of input.requirementTraces) {
      if (!trace.requirementId.trim() || !trace.deliverableId.trim()) {
        throw new AiOrchestratorError("INVALID_TRACE", "each trace requires requirementId and deliverableId");
      }
    }
  }

  private requireExecution(workspaceId: string, executionId: string): Execution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new AiOrchestratorError("NOT_FOUND", `execution not found: ${executionId}`);
    if (execution.workspaceId !== workspaceId) throw new AiOrchestratorError("CROSS_WORKSPACE", "execution belongs to another workspace");
    return execution;
  }
}
