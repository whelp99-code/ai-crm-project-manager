import { CustomerWorkOsV2Error, assertHuman, assertWorkspace, copy, mapValues, required, sorted, type V2Actor } from "./shared.js";
export type SourceKind = "GMAIL" | "OUTLOOK" | "CALENDAR" | "DRIVE" | "ONEDRIVE" | "NOTION" | "MESSAGE";
export interface SourceEvent { id: string; workspaceId: string; source: SourceKind; providerEventId: string; occurredAt: string; subject: string; bodyDigest: string; sender: string; promptInjectionSuspected: boolean; status: "NEW" | "TRIAGED" | "QUARANTINED"; version: number; }
export interface InboxAttachment { id: string; workspaceId: string; sourceEventId: string; contentHash: string; mediaType: string; malwareStatus: "CLEAN" | "INFECTED" | "UNKNOWN"; evidenceRef: string; version: number; }
export interface InboxLink { id: string; workspaceId: string; sourceEventId: string; accountId: string; engagementId: string | null; confidence: number; linkedByPrincipalId: string; version: number; }
export interface InboxDraft { id: string; workspaceId: string; sourceEventId: string; kind: "COMMITMENT" | "REQUIREMENT"; title: string; evidenceRefs: string[]; reviewedByPrincipalId: string; status: "DRAFT" | "APPROVED"; version: number; }
export interface MailWorkLink { id: string; workspaceId: string; provider: string; mailbox: string; sourceLocator: string; sourceEventId: string; workItemId: string; linkedByPrincipalId: string; correctionReason: string | null; linkStatus: "ACTIVE" | "CORRECTED"; version: number; }
export interface MailInboxReceipt { id: string; workspaceId: string; provider: string; mailbox: string; sourceLocator: string; providerEventId: string; receivedAt: string; version: number; }
export interface MailOutboxEvent { id: string; workspaceId: string; kind: "WORK_LINKED" | "INBOX_RECEIVED" | "WORK_LINK_CORRECTED"; workItemId: string | null; sourceEventId: string | null; linkId: string | null; status: "PENDING" | "EMITTED"; createdAt: string; version: number; }
export interface InboxState { schemaVersion: 1; events: SourceEvent[]; attachments: InboxAttachment[]; links: InboxLink[]; drafts: InboxDraft[]; mailWorkLinks: MailWorkLink[]; mailInboxReceipts: MailInboxReceipt[]; mailOutbox: MailOutboxEvent[]; }
export class UnifiedInboxService {
  private events = new Map<string, SourceEvent>(); private attachments = new Map<string, InboxAttachment>(); private links = new Map<string, InboxLink>(); private drafts = new Map<string, InboxDraft>(); private mailWorkLinks = new Map<string, MailWorkLink>(); private mailInboxReceipts = new Map<string, MailInboxReceipt>(); private mailOutbox = new Map<string, MailOutboxEvent>();
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
  mapWork(input: Omit<MailWorkLink, "version" | "linkedByPrincipalId" | "correctionReason" | "linkStatus"> & { correctionReason?: string }, actor: V2Actor, createdAt: string): MailWorkLink {
    assertHuman(actor); assertWorkspace(actor.workspaceId, input.workspaceId);
    const provider = required(input.provider, "provider"); const mailbox = required(input.mailbox, "mailbox"); const sourceLocator = required(input.sourceLocator, "sourceLocator"); const workItemId = required(input.workItemId, "workItemId");
    const duplicate = [...this.mailWorkLinks.values()].find((item) => item.workspaceId === input.workspaceId && item.provider === provider && item.mailbox === mailbox && item.sourceLocator === sourceLocator && item.linkStatus !== "CORRECTED");
    if (duplicate && duplicate.workItemId !== workItemId) {
      if (!input.correctionReason?.trim()) throw new CustomerWorkOsV2Error("CORRECTION_REASON_REQUIRED", "correcting a mail work mapping requires a reason");
      const corrected = { ...duplicate, correctionReason: input.correctionReason.trim(), linkStatus: "CORRECTED" as const, version: duplicate.version + 1 };
      this.mailWorkLinks.set(corrected.id, corrected);
      const replacement: MailWorkLink = { ...copy(input), provider, mailbox, sourceLocator, workItemId, linkedByPrincipalId: actor.principalId, correctionReason: null, linkStatus: "ACTIVE", version: 1 };
      this.mailWorkLinks.set(replacement.id, replacement);
      this.enqueue({ id: `outbox-correction-${corrected.id}-${corrected.version}`, workspaceId: input.workspaceId, kind: "WORK_LINK_CORRECTED", workItemId, sourceEventId: input.sourceEventId, linkId: replacement.id, status: "PENDING", createdAt, version: 1 });
      return copy(replacement);
    }
    const item: MailWorkLink = { ...copy(input), provider, mailbox, sourceLocator, workItemId, linkedByPrincipalId: actor.principalId, correctionReason: input.correctionReason?.trim() || null, linkStatus: "ACTIVE", version: 1 };
    this.mailWorkLinks.set(item.id, item);
    this.enqueue({ id: `outbox-link-${item.id}`, workspaceId: item.workspaceId, kind: "WORK_LINKED", workItemId: item.workItemId, sourceEventId: item.sourceEventId, linkId: item.id, status: "PENDING", createdAt, version: 1 });
    return copy(item);
  }
  receiveMail(input: Omit<MailInboxReceipt, "version"> & { event?: Omit<SourceEvent, "version" | "status"> }, createdAt: string): MailInboxReceipt {
    assertWorkspace(input.workspaceId, input.workspaceId); const key = `${input.workspaceId}\0${required(input.provider, "provider")}\0${required(input.mailbox, "mailbox")}\0${required(input.sourceLocator, "sourceLocator")}\0${required(input.providerEventId, "providerEventId")}`;
    const prior = [...this.mailInboxReceipts.values()].find((item) => `${item.workspaceId}\0${item.provider}\0${item.mailbox}\0${item.sourceLocator}\0${item.providerEventId}` === key); if (prior) return copy(prior);
    if (input.event) this.ingest(input.event);
    const receipt: MailInboxReceipt = { ...copy(input), id: required(input.id, "receipt.id"), provider: required(input.provider, "provider"), mailbox: required(input.mailbox, "mailbox"), sourceLocator: required(input.sourceLocator, "sourceLocator"), providerEventId: required(input.providerEventId, "providerEventId"), receivedAt: required(input.receivedAt, "receivedAt"), version: 1 };
    this.mailInboxReceipts.set(receipt.id, receipt); this.enqueue({ id: `outbox-inbox-${receipt.id}`, workspaceId: receipt.workspaceId, kind: "INBOX_RECEIVED", workItemId: null, sourceEventId: input.event?.id ?? null, linkId: null, status: "PENDING", createdAt, version: 1 }); return copy(receipt);
  }
  private enqueue(event: MailOutboxEvent): void { if (!this.mailOutbox.has(event.id)) this.mailOutbox.set(event.id, event); }
  exportState(): InboxState { return { schemaVersion: 1, events: sorted(this.events.values()), attachments: sorted(this.attachments.values()), links: sorted(this.links.values()), drafts: sorted(this.drafts.values()), mailWorkLinks: sorted(this.mailWorkLinks.values()), mailInboxReceipts: sorted(this.mailInboxReceipts.values()), mailOutbox: sorted(this.mailOutbox.values()) }; }
  hydrateState(input: InboxState): void { if (input.schemaVersion !== 1) throw new CustomerWorkOsV2Error("UNSUPPORTED_STATE", "unsupported inbox state"); this.events = mapValues(input.events, "sourceEvent"); this.attachments = mapValues(input.attachments, "attachment"); this.links = mapValues(input.links, "inboxLink"); this.drafts = mapValues(input.drafts, "inboxDraft"); this.mailWorkLinks = mapValues(input.mailWorkLinks ?? [], "mailWorkLink"); this.mailInboxReceipts = mapValues(input.mailInboxReceipts ?? [], "mailInboxReceipt"); this.mailOutbox = mapValues(input.mailOutbox ?? [], "mailOutbox"); }
  private event(workspaceId: string, id: string): SourceEvent { const item = this.events.get(id); if (!item) throw new CustomerWorkOsV2Error("SOURCE_EVENT_NOT_FOUND", "source event not found"); assertWorkspace(workspaceId, item.workspaceId); return item; }
}
