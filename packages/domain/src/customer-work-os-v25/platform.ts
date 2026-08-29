import { BaselineBuilderService, type BaselineBuilderState } from "./baseline.js";
import { UniversalCaptureService, type UniversalCaptureState } from "./capture.js";
import { ClarificationLearningService, type ClarificationLearningState } from "./clarification.js";
import { BackgroundSyncService, type BackgroundSyncState } from "./sync.js";
import { AiManagerService, type AiManagerState } from "./manager.js";
import {
  CustomerWorkOsV25Error,
  copy,
  deterministicHash,
  required,
  type ConfidencePolicy,
} from "./shared.js";

export interface CustomerWorkOsV25State {
  schemaVersion: 1;
  workspaceId: string;
  baseline: BaselineBuilderState;
  capture: UniversalCaptureState;
  clarification: ClarificationLearningState;
  sync: BackgroundSyncState;
  manager: AiManagerState;
}

export interface UnifiedReviewQueue {
  workspaceId: string;
  baselineQuestions: ReturnType<BaselineBuilderService["reviewQueue"]>;
  capturePlans: ReturnType<UniversalCaptureService["reviewQueue"]>["plans"];
  captureQuestions: ReturnType<UniversalCaptureService["reviewQueue"]>["questions"];
  clarificationTasks: ReturnType<ClarificationLearningService["openTasks"]>;
  syncItems: ReturnType<BackgroundSyncService["reviewQueue"]>;
}

export class CustomerWorkOsV25Platform {
  readonly baseline: BaselineBuilderService;
  readonly capture: UniversalCaptureService;
  readonly clarification = new ClarificationLearningService();
  readonly sync = new BackgroundSyncService();
  readonly manager = new AiManagerService();

  constructor(
    readonly workspaceId: string,
    policy?: ConfidencePolicy,
  ) {
    required(workspaceId, "workspaceId");
    this.baseline = new BaselineBuilderService();
    this.capture = new UniversalCaptureService(policy);
  }

  reviewQueue(): UnifiedReviewQueue {
    const capture = this.capture.reviewQueue(this.workspaceId);
    return {
      workspaceId: this.workspaceId,
      baselineQuestions: this.baseline.reviewQueue(this.workspaceId),
      capturePlans: capture.plans,
      captureQuestions: capture.questions,
      clarificationTasks: this.clarification.openTasks(this.workspaceId),
      syncItems: this.sync.reviewQueue(this.workspaceId),
    };
  }

  exportState(): CustomerWorkOsV25State {
    return {
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      baseline: this.baseline.exportState(),
      capture: this.capture.exportState(),
      clarification: this.clarification.exportState(),
      sync: this.sync.exportState(),
      manager: this.manager.exportState(),
    };
  }

  stateHash(): string {
    return deterministicHash(this.exportState());
  }

  hydrateState(input: CustomerWorkOsV25State): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported v2.5 state");
    if (input.workspaceId !== this.workspaceId) throw new CustomerWorkOsV25Error("CROSS_WORKSPACE_STATE", "state workspace mismatch");
    const snapshot = copy(input);
    this.baseline.hydrateState(snapshot.baseline);
    this.capture.hydrateState(snapshot.capture);
    this.clarification.hydrateState(snapshot.clarification);
    this.sync.hydrateState(snapshot.sync);
    this.manager.hydrateState(snapshot.manager);
  }
}
