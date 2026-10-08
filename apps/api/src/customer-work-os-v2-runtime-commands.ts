import {
  CustomerWorkOsV2Error,
  CustomerWorkOsV2Platform,
  type DeliveryFixtureDecision,
  type DeliveryFixtureQuantity,
  type CustomerWorkOsV2State,
  type IdentityPrincipal,
  type V2Actor,
  type W05ClauseCitation,
  type W05RenewalRevisionInput,
  type WorkspaceMembership,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  buildW01QuoteDraft,
  readMountedTemplateMeasurement,
  type SourceLinkedBomLine,
  type W01QuoteDraftInput,
} from "@ai-crm/domain";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", "payload must be an object");
  }
  return value as Record<string, unknown>;
}

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${key} is required`);
  }
  return value.trim();
}

function num(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${key} must be a number`);
  }
  return value;
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${key} must be boolean`);
  }
  return value;
}

function strings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", `${key} must be a non-empty string array`);
  }
  return value.map((item) => (item as string).trim());
}

function w01QuoteDraftInput(payload: Record<string, unknown>, workspaceId: string): W01QuoteDraftInput {
  const engagement = record(payload.engagement);
  const vat = record(payload.vat);
  const po = record(payload.po);
  const observation = record(payload.templateObservation);
  if (!Array.isArray(payload.lines)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", "lines must be an array");
  }
  const lines: SourceLinkedBomLine[] = payload.lines.map((value) => {
    const line = record(value);
    const parsed: SourceLinkedBomLine = {
      id: str(line, "id"),
      sourceId: str(line, "sourceId"),
      productId: str(line, "productId"),
      description: str(line, "description"),
      quantity: num(line, "quantity"),
      unitCostKrw: str(line, "unitCostKrw"),
      unitPriceKrw: str(line, "unitPriceKrw"),
    };
    if (line.vendorAccountId !== undefined) parsed.vendorAccountId = str(line, "vendorAccountId");
    return parsed;
  });
  return {
    engagement: {
      id: str(engagement, "id"),
      workspaceId,
      version: num(engagement, "version"),
    },
    versionLabel: str(payload, "versionLabel"),
    validUntil: str(payload, "validUntil"),
    scope: str(payload, "scope"),
    lines,
    options: strings(payload, "options"),
    templateRef: str(payload, "templateRef"),
    templateObservation: readMountedTemplateMeasurement({
      filename: str(observation, "filename"),
      bytes: num(observation, "bytes"),
      sha256: str(observation, "sha256"),
      sheetNames: strings(observation, "sheetNames"),
      mountedItemId: str(observation, "mountedItemId"),
      historicalCandidateId: str(observation, "historicalCandidateId"),
    }),
    vat: {
      netAmountKrw: str(vat, "netAmountKrw"),
      vatAmountKrw: str(vat, "vatAmountKrw"),
      grossAmountKrw: str(vat, "grossAmountKrw"),
    },
    po: {
      customerPoId: str(po, "customerPoId"),
      supplierPoId: str(po, "supplierPoId"),
    },
  };
}

function w05RenewalRevisionInput(payload: Record<string, unknown>, workspaceId: string): W05RenewalRevisionInput {
  if (!Array.isArray(payload.citations)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", "citations must be an array");
  }
  const citations: W05ClauseCitation[] = payload.citations.map((value) => {
    const citation = record(value);
    return {
      clauseId: str(citation, "clauseId"),
      startByte: num(citation, "startByte"),
      endByte: num(citation, "endByte"),
      text: str(citation, "text"),
      sourceHash: str(citation, "sourceHash"),
    };
  });
  return {
    renewalId: str(payload, "renewalId"),
    workspaceId,
    revisionId: str(payload, "revisionId"),
    revisionLabel: str(payload, "revisionLabel"),
    observedAt: str(payload, "observedAt"),
    expiresOn: payload.expiresOn === null ? null : str(payload, "expiresOn"),
    noticePeriodDays: payload.noticePeriodDays === null ? null : num(payload, "noticePeriodDays"),
    unknownTerms: strings(payload, "unknownTerms"),
    content: str(payload, "content"),
    citations,
  };
}

function principalForActor(state: CustomerWorkOsV2State, actor: V2Actor): IdentityPrincipal {
  const principal = state.identity.principals.find((item) => item.id === actor.principalId);
  if (!principal || !principal.active) {
    throw new CustomerWorkOsV2Error("PRINCIPAL_REQUIRED", "an active registered principal is required");
  }
  if (principal.workspaceId !== actor.workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace access is forbidden");
  }
  if (principal.kind !== actor.kind) {
    throw new CustomerWorkOsV2Error("PRINCIPAL_KIND_MISMATCH", "principal kind does not match the registered identity");
  }
  return principal;
}

function activeMembership(state: CustomerWorkOsV2State, principalId: string): WorkspaceMembership | undefined {
  return state.identity.memberships.find(
    (item) => item.principalId === principalId && item.workspaceId === state.workspaceId && item.status === "ACTIVE",
  );
}

function assertStepUpHuman(actor: V2Actor): void {
  if (actor.kind !== "human") {
    throw new CustomerWorkOsV2Error("HUMAN_REQUIRED", "a human principal is required");
  }
  if (!actor.stepUpVerified) {
    throw new CustomerWorkOsV2Error("STEP_UP_REQUIRED", "step-up authentication is required");
  }
}

export function assertV2ActorCanRead(state: CustomerWorkOsV2State, actor: V2Actor): void {
  if (state.workspaceId !== actor.workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace access is forbidden");
  }
  if (state.identity.principals.length === 0) {
    // Empty-state inspection is limited to a human who can bootstrap that workspace.
    assertStepUpHuman(actor);
    return;
  }
  const principal = principalForActor(state, actor);
  if (activeMembership(state, principal.id)) return;
  const bootstrapWindow =
    state.identity.principals.length === 1 &&
    state.identity.memberships.length === 0 &&
    principal.id === actor.principalId &&
    actor.stepUpVerified;
  if (!bootstrapWindow) {
    throw new CustomerWorkOsV2Error("MEMBERSHIP_REQUIRED", "active workspace membership required");
  }
}

export function assertV2ActorCanCommand(
  state: CustomerWorkOsV2State,
  actor: V2Actor,
  command: string,
  payload: unknown,
): void {
  if (state.workspaceId !== actor.workspaceId) {
    throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "cross-workspace access is forbidden");
  }
  const input = record(payload);

  if (state.identity.principals.length === 0) {
    assertStepUpHuman(actor);
    if (command !== "identity.registerPrincipal") {
      throw new CustomerWorkOsV2Error("BOOTSTRAP_REQUIRED", "the first command must register the human bootstrap principal");
    }
    if (str(input, "id") !== actor.principalId || str(input, "kind") !== "human" || bool(input, "active") !== true) {
      throw new CustomerWorkOsV2Error(
        "INVALID_BOOTSTRAP_PRINCIPAL",
        "the bootstrap principal must be the authenticated active human",
      );
    }
    return;
  }

  const principal = principalForActor(state, actor);
  if (activeMembership(state, principal.id)) return;

  const selfMembershipBootstrap =
    state.identity.principals.length === 1 &&
    state.identity.memberships.length === 0 &&
    command === "identity.addMembership" &&
    str(input, "principalId") === actor.principalId &&
    actor.kind === "human" &&
    actor.stepUpVerified;
  if (!selfMembershipBootstrap) {
    throw new CustomerWorkOsV2Error("MEMBERSHIP_REQUIRED", "active workspace membership required");
  }
}

export function executeV2Command(
  platform: CustomerWorkOsV2Platform,
  command: string,
  payload: unknown,
  actor: V2Actor,
  now = new Date().toISOString(),
): unknown {
  const input = record(payload);
  switch (command) {
    case "business.reconcileNormalized":
      return platform.recordNormalizedArchiveReference({
        workspaceId: actor.workspaceId,
        planId: str(input, "planId"),
        snapshotHash: str(input, "snapshotHash"),
        planHash: str(input, "planHash"),
        planVersion: num(input, "planVersion"),
        sourceDigest: str(input, "sourceDigest"),
        sourceObservedAt: str(input, "sourceObservedAt"),
        accountIds: strings(input, "accountIds"),
        engagementIds: strings(input, "engagementIds"),
        financialItemIds: strings(input, "financialItemIds"),
      }, actor, now);
    case "identity.registerPrincipal":
      return platform.identity.registerPrincipal(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          kind: str(input, "kind") as "human" | "ai" | "service",
          displayName: str(input, "displayName"),
          active: bool(input, "active"),
          oidcIssuer: null,
          oidcSubject: null,
        },
        actor,
      );
    case "identity.addMembership":
      return platform.identity.addMembership(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          principalId: str(input, "principalId"),
          status: "ACTIVE",
        },
        actor,
      );
    case "identity.addTeam":
      return platform.identity.addTeam(
        { id: str(input, "id"), workspaceId: actor.workspaceId, name: str(input, "name") },
        actor,
      );
    case "psa.addResource":
      return platform.psa.addResource(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          principalId: str(input, "principalId"),
          displayName: str(input, "displayName"),
          hourlyCostKrw: num(input, "hourlyCostKrw"),
          active: true,
        },
        actor,
      );
    case "psa.setCapacity":
      return platform.psa.setCapacity(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          resourceId: str(input, "resourceId"),
          date: str(input, "date"),
          availableHours: num(input, "availableHours"),
          leave: bool(input, "leave"),
        },
        actor,
      );
    case "psa.assign":
      return platform.psa.assign(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          resourceId: str(input, "resourceId"),
          projectId: str(input, "projectId"),
          date: str(input, "date"),
          plannedHours: num(input, "plannedHours"),
        },
        actor,
      );
    case "inbox.ingest":
      return platform.inbox.ingest({
        id: str(input, "id"),
        workspaceId: actor.workspaceId,
        source: str(input, "source") as "GMAIL" | "OUTLOOK" | "CALENDAR" | "DRIVE" | "ONEDRIVE" | "NOTION" | "MESSAGE",
        providerEventId: str(input, "providerEventId"),
        occurredAt: str(input, "occurredAt"),
        subject: str(input, "subject"),
        bodyDigest: str(input, "bodyDigest"),
        sender: str(input, "sender"),
        promptInjectionSuspected: bool(input, "promptInjectionSuspected"),
      });
    case "mail.candidate.create": {
      const provider = str(input, "provider");
      if (provider !== "GMAIL" && provider !== "OUTLOOK") {
        throw new CustomerWorkOsV2Error("INVALID_INPUT", "Mail candidate provider must be GMAIL or OUTLOOK");
      }
      return platform.inbox.createMailCandidate({
        id: str(input, "id"), workspaceId: actor.workspaceId, provider,
        mailbox: str(input, "mailbox"), sourceLocator: str(input, "sourceLocator"),
        providerEventId: str(input, "providerEventId"), subject: str(input, "subject"),
        bodyDigest: str(input, "bodyDigest"),
      }, actor, now);
    }
    case "mail.inbox.receive":
      return platform.inbox.receiveMail({
        id: str(input, "id"), workspaceId: actor.workspaceId, provider: str(input, "provider"), mailbox: str(input, "mailbox"), sourceLocator: str(input, "sourceLocator"), providerEventId: str(input, "providerEventId"), receivedAt: str(input, "receivedAt"),
        ...(input.event && typeof input.event === "object" && !Array.isArray(input.event) ? { event: { ...(input.event as Record<string, unknown>), workspaceId: actor.workspaceId, source: str(input, "provider") as never, id: str(input.event as Record<string, unknown>, "id"), providerEventId: str(input, "providerEventId"), occurredAt: str(input.event as Record<string, unknown>, "occurredAt"), subject: str(input.event as Record<string, unknown>, "subject"), bodyDigest: str(input.event as Record<string, unknown>, "bodyDigest"), sender: str(input.event as Record<string, unknown>, "sender"), promptInjectionSuspected: bool(input.event as Record<string, unknown>, "promptInjectionSuspected") } } : {}),
      }, now);
    case "mail.mapWork":
      return platform.inbox.mapWork({ id: str(input, "id"), workspaceId: actor.workspaceId, provider: str(input, "provider"), mailbox: str(input, "mailbox"), sourceLocator: str(input, "sourceLocator"), sourceEventId: str(input, "sourceEventId"), workItemId: str(input, "workItemId"), ...(typeof input.correctionReason === "string" ? { correctionReason: input.correctionReason } : {}) }, actor, now);
    case "work.followUp":
      return platform.followUps.upsert({
        id: str(input, "id"), workspaceId: actor.workspaceId, sourceEventId: str(input, "sourceEventId"), workItemId: str(input, "workItemId"),
        mailHandling: str(input, "mailHandling") as never, customerWork: str(input, "customerWork") as never, nextOwner: str(input, "nextOwner"),
        dueAt: typeof input.dueAt === "string" ? input.dueAt : null, evidenceRefs: strings(input, "evidenceRefs"), ...(typeof input.correctionReason === "string" ? { correctionReason: input.correctionReason } : {}),
      }, actor);
    case "delivery.recordRevision":
      assertStepUpHuman(actor);
      if (!Array.isArray(input.quantities)) {
        throw new CustomerWorkOsV2Error("INVALID_INPUT", "quantities must be an array");
      }
      return platform.deliveries.recordRevision({
        orderId: str(input, "orderId"),
        workItemId: str(input, "workItemId"),
        sourceEventId: str(input, "sourceEventId"),
        quoteRevision: str(input, "quoteRevision"),
        revisionId: str(input, "revisionId"),
        decision: str(input, "decision") as DeliveryFixtureDecision,
        quantities: input.quantities.map((value) => {
          const line = record(value);
          return {
            lineId: str(line, "lineId"),
            ordered: num(line, "ordered"),
            delivered: num(line, "delivered"),
            accepted: num(line, "accepted"),
          } satisfies DeliveryFixtureQuantity;
        }),
        content: str(input, "content"),
        contentHash: str(input, "contentHash"),
        citationRefs: strings(input, "citationRefs"),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      }, actor);
    case "f2.compareRevisions": {
      assertStepUpHuman(actor);
      const comparison = platform.contractComparisons.compare({
        id: str(input, "comparisonId"), prior: input.prior, next: input.next,
      }, actor, now);
      return {
        comparisonId: comparison.id,
        requestHash: comparison.requestHash,
        priorSourceHash: comparison.prior.sourceHash,
        nextSourceHash: comparison.next.sourceHash,
        createdAt: comparison.createdAt,
        approvalStatus: "NOT_APPROVED",
        approved: comparison.approved,
        sent: comparison.sent,
        sourceVerified: comparison.sourceVerified,
      };
    }
    case "w05.renewalRevision": {
      assertStepUpHuman(actor);
      const revisionInput = w05RenewalRevisionInput(input, actor.workspaceId);
      const draft = platform.renewals.recordRevision(revisionInput, actor, now);
      const revision = draft.revisions.find((item) => item.revisionId === revisionInput.revisionId);
      const receipt = draft.receipts.find((item) => item.revisionId === revisionInput.revisionId);
      if (!revision || !receipt) {
        throw new CustomerWorkOsV2Error("INVALID_STATE", "renewal revision result is missing its internal receipt");
      }
      return {
        renewalId: draft.id,
        revisionId: revision.revisionId,
        revisionVersion: revision.version,
        sourceHash: revision.sourceHash,
        status: receipt.status,
        approvalStatus: receipt.approvalStatus,
        requestHash: receipt.requestHash,
        createdAt: receipt.createdAt,
      };
    }
    case "connectors.register":
      return platform.connectors.register(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          provider: str(input, "provider") as "GMAIL" | "OUTLOOK" | "CALENDAR" | "DRIVE" | "ONEDRIVE" | "NOTION",
          mode: "READ_ONLY",
          permissions: strings(input, "permissions"),
          secretRef: str(input, "secretRef"),
        },
        actor,
      );
    case "graphs.register":
      return platform.graphs.register(input as never, actor);
    case "ai.openCouncil":
      return platform.ai.openCouncil(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          topic: str(input, "topic"),
          participantPrincipalIds: strings(input, "participantPrincipalIds"),
          budgetUsd: num(input, "budgetUsd"),
        },
        actor,
      );
    case "portal.grant":
      return platform.portal.grant(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          principalId: str(input, "principalId"),
          accountId: str(input, "accountId"),
          engagementIds: strings(input, "engagementIds"),
          allowedFields: strings(input, "allowedFields"),
          expiresAt: str(input, "expiresAt"),
        },
        actor,
      );
    case "admin.provision":
      return platform.admin.provision(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          name: str(input, "name"),
          quotaUsers: num(input, "quotaUsers"),
          quotaStorageMb: num(input, "quotaStorageMb"),
          retentionDays: num(input, "retentionDays"),
          templateVersion: str(input, "templateVersion"),
        },
        actor,
      );
    case "operations.defineSlo":
      return platform.operations.defineSlo(
        {
          id: str(input, "id"),
          workspaceId: actor.workspaceId,
          service: str(input, "service"),
          availabilityTarget: num(input, "availabilityTarget"),
          latencyP95Ms: num(input, "latencyP95Ms"),
          errorBudgetMinutes: num(input, "errorBudgetMinutes"),
        },
        actor,
      );
    case "release.startMilestone":
      return platform.startMilestone(str(input, "version") as never, actor);
    case "release.completeMilestone":
      return platform.completeMilestone(str(input, "version") as never, strings(input, "evidenceRefs"), actor);
    case "release.recordFinding":
      return platform.recordFinding(
        {
          id: str(input, "id"),
          version: str(input, "version") as never,
          perspective: str(input, "perspective") as never,
          severity: str(input, "severity") as never,
          title: str(input, "title"),
        },
        actor,
      );
    case "release.resolveFinding":
      return platform.resolveFinding(str(input, "id"), str(input, "evidenceRef"), actor);
    case "release.createManifest":
      return platform.createReleaseManifest(input as never, actor);
    case "w01.quoteDraft":
      assertStepUpHuman(actor);
      return buildW01QuoteDraft(w01QuoteDraftInput(input, actor.workspaceId));
    default:
      throw new CustomerWorkOsV2Error("UNKNOWN_COMMAND", `unknown v2 command: ${command}`);
  }
}
