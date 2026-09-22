import { CustomerWorkOsV2Error, assertHuman, assertWorkspace, copy, mapValues, required, sorted, type V2Actor } from "./shared.js";

export interface WorkFollowUp {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  workItemId: string;
  mailHandling: "UNHANDLED" | "TRIAGED" | "DRAFTED" | "SENT" | "DELIVERY_UNKNOWN";
  customerWork: "OPEN" | "IN_PROGRESS" | "CLOSED";
  nextOwner: string;
  dueAt: string | null;
  evidenceRefs: string[];
  correctionReason: string | null;
  version: number;
}

export interface FollowUpState { schemaVersion: 1; items: WorkFollowUp[]; }

export class FollowUpService {
  private items = new Map<string, WorkFollowUp>();

  upsert(input: Omit<WorkFollowUp, "version" | "correctionReason"> & { correctionReason?: string | null }, actor: V2Actor): WorkFollowUp {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId);
    const id = required(input.id, "followUp.id");
    const prior = this.items.get(id);
    if (prior && prior.workspaceId !== actor.workspaceId) throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace access is forbidden");
    if (input.customerWork === "CLOSED" && input.mailHandling !== "SENT" && input.mailHandling !== "DELIVERY_UNKNOWN") throw new CustomerWorkOsV2Error("WORK_CLOSE_REQUIRES_MAIL_STATE", "customer work cannot close before mail handling reaches a terminal state");
    const item: WorkFollowUp = { ...copy(input), id, nextOwner: required(input.nextOwner, "nextOwner"), evidenceRefs: [...new Set(input.evidenceRefs.map((ref) => required(ref, "evidenceRef")))], correctionReason: input.correctionReason?.trim() || null, version: (prior?.version ?? 0) + 1 };
    this.items.set(id, item); return copy(item);
  }

  exportState(): FollowUpState { return { schemaVersion: 1, items: sorted(this.items.values()) }; }
  hydrateState(input: FollowUpState): void { if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported follow-up state"); this.items = mapValues(input.items, "followUp"); }
}
