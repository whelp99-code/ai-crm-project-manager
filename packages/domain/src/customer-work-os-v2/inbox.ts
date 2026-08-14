import { CustomerWorkOsV2Error, assertHuman, assertWorkspace, copy, mapValues, required, sorted, type V2Actor } from "./shared.js";
export type SourceKind = "GMAIL" | "OUTLOOK" | "CALENDAR" | "DRIVE" | "ONEDRIVE" | "NOTION" | "MESSAGE";
export interface SourceEvent { id: string; workspaceId: string; source: SourceKind; providerEventId: string; occurredAt: string; subject: string; bodyDigest: string; sender: string; promptInjectionSuspected: boolean; status: "NEW" | "TRIAGED" | "QUARANTINED"; version: number; }
export interface InboxAttachment { id: string; workspaceId: string; sourceEventId: string; contentHash: string; mediaType: string; malwareStatus: "CLEAN" | "INFECTED" | "UNKNOWN"; evidenceRef: string; version: number; }
export interface InboxLink { id: string; workspaceId: string; sourceEventId: string; accountId: string; engagementId: string | null; confidence: number; linkedByPrincipalId: string; version: number; }
export interface InboxDraft { id: string; workspaceId: string; sourceEventId: string; kind: "COMMITMENT" | "REQUIREMENT"; title: string; evidenceRefs: string[]; reviewedByPrincipalId: string; status: "DRAFT" | "APPROVED"; version: number; }
export interface InboxState { schemaVersion: 1; events: SourceEvent[]; attachments: InboxAttachment[]; links: InboxLink[]; drafts: InboxDraft[]; }
export class UnifiedInboxService {
  private events = new Map<string, SourceEvent>(); private attachments = new Map<string, InboxAttachment>(); private links = new Map<string, InboxLink>(); private drafts = new Map<string, InboxDraft>();
  ingest(input: Omit<SourceEvent, "version" | "status">): SourceEvent {
    assertWorkspace(input.workspaceId, input.workspaceId); const duplicate = [...this.events.values()].find((item) => item.workspaceId === input.workspaceId && item.source === input.source && item.providerEventId === input.providerEventId);
    if (duplicate) return copy(duplicate);
    const status = input.promptInjectionSuspected ? "QUARANTINED" : "NEW";
    const event: SourceEvent = { ...copy(input), id: required(input.id, "event.id"), providerEventId: required(input.providerEventId, "providerEventId"), bodyDigest: required(input.bodyDigest, "bodyDigest"), status, version: 1 };
    this.events.set(event.id, event); return copy(event);
  }
  attach(input: Omit<InboxAttachment, "version">): InboxAttachment {
    const event = this.event(input.workspaceId, input.sourceEventId); if (event.status === "QUARANTINED") throw new CustomerWorkOsV2Error("SOURCE_QUARANTINED", "attachment cannot bypass quarantined source");
    if (input.malwareStatus !== "CLEAN") throw new CustomerWorkOsV2Error("ATTACHMENT_QUARANTINED", "only clean attachments may enter evidence storage");
    const duplicate = [...this.attachments.values()].find((item) => item.workspaceId === input.workspaceId && item.contentHash === input.contentHash); if (duplicate) return copy(duplicate);
    const item: InboxAttachment = { ...copy(input), id: required(input.id, "attachment.id"), evidenceRef: required(input.evidenceRef, "evidenceRef"), version: 1 }; this.attachments.set(item.id, item); return copy(item);
  }
  triage(input: Omit<InboxLink, "version" | "linkedByPrincipalId">, actor: V2Actor): InboxLink {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); const event = this.event(input.workspaceId, input.sourceEventId); if (event.status === "QUARANTINED") throw new CustomerWorkOsV2Error("SOURCE_QUARANTINED", "quarantined source cannot be linked");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new CustomerWorkOsV2Error("INVALID_CONFIDENCE", "confidence must be between 0 and 1");
    const item: InboxLink = { ...copy(input), id: required(input.id, "link.id"), accountId: required(input.accountId, "accountId"), linkedByPrincipalId: actor.principalId, version: 1 }; this.links.set(item.id, item); this.events.set(event.id, { ...event, status: "TRIAGED", version: event.version + 1 }); return copy(item);
  }
  draft(input: Omit<InboxDraft, "version" | "status" | "reviewedByPrincipalId">, actor: V2Actor): InboxDraft {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId); const event = this.event(input.workspaceId, input.sourceEventId); if (event.status !== "TRIAGED") throw new CustomerWorkOsV2Error("TRIAGE_REQUIRED", "source must be human-triaged before drafting");
    const refs = [...new Set(input.evidenceRefs.map((ref) => required(ref, "evidenceRef")))]; if (refs.length === 0) throw new CustomerWorkOsV2Error("EVIDENCE_REQUIRED", "draft requires evidence");
    const item: InboxDraft = { ...copy(input), id: required(input.id, "draft.id"), title: required(input.title, "title"), evidenceRefs: refs, reviewedByPrincipalId: actor.principalId, status: "DRAFT", version: 1 }; this.drafts.set(item.id, item); return copy(item);
  }
  exportState(): InboxState { return { schemaVersion: 1, events: sorted(this.events.values()), attachments: sorted(this.attachments.values()), links: sorted(this.links.values()), drafts: sorted(this.drafts.values()) }; }
  hydrateState(input: InboxState): void { if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported inbox state"); this.events = mapValues(input.events, "sourceEvent"); this.attachments = mapValues(input.attachments, "attachment"); this.links = mapValues(input.links, "inboxLink"); this.drafts = mapValues(input.drafts, "inboxDraft"); }
  private event(workspaceId: string, id: string): SourceEvent { const item = this.events.get(id); if (!item) throw new CustomerWorkOsV2Error("SOURCE_EVENT_NOT_FOUND", "source event not found"); assertWorkspace(workspaceId, item.workspaceId); return item; }
}
