import {
  CustomerWorkOsV25Error,
  assertHuman,
  assertHumanOrService,
  assertWorkspace,
  copy,
  deterministicHash,
  mapById,
  required,
  sorted,
  type AutomationActor,
} from "./shared.js";

export type BackgroundProvider = "GMAIL" | "OUTLOOK" | "CALENDAR" | "NOTION" | "DRIVE" | "ONEDRIVE" | "CSV";

export interface BackgroundConnector {
  id: string;
  workspaceId: string;
  provider: BackgroundProvider;
  secretRef: string | null;
  mode: "READ_ONLY" | "SHADOW" | "RECONCILED";
  cursor: string | null;
  checkpointSequence: number;
  active: boolean;
  maxBatchSize: number;
  maxRetries: number;
  version: number;
}

export interface PulledSourceItem {
  externalId: string;
  contentHash: string;
  occurredAt: string;
  sourceRef: string;
  payload: Record<string, unknown>;
  suspicious: boolean;
}

export interface SyncItem {
  id: string;
  workspaceId: string;
  connectorId: string;
  externalId: string;
  contentHash: string;
  sourceRef: string;
  payload: Record<string, unknown>;
  status: "ACCEPTED" | "DUPLICATE" | "QUARANTINED" | "FAILED";
  failureCode: string | null;
  attempt: number;
  version: number;
}

export interface SyncBatch {
  id: string;
  workspaceId: string;
  connectorId: string;
  sequence: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  itemIds: string[];
  accepted: number;
  duplicates: number;
  quarantined: number;
  failed: number;
  status: "RUNNING" | "COMPLETED" | "NEEDS_REVIEW" | "FAILED";
  startedAt: string;
  completedAt: string | null;
  version: number;
}

export interface SyncPullResult {
  items: PulledSourceItem[];
  nextCursor: string | null;
}

export interface BackgroundSourceAdapter {
  readonly provider: BackgroundProvider;
  pull(cursor: string | null, limit: number): Promise<SyncPullResult>;
}

export interface BackgroundSyncState {
  schemaVersion: 1;
  connectors: BackgroundConnector[];
  items: SyncItem[];
  batches: SyncBatch[];
}

export class BackgroundSyncService {
  private connectors = new Map<string, BackgroundConnector>();
  private items = new Map<string, SyncItem>();
  private batches = new Map<string, SyncBatch>();

  register(
    input: Omit<BackgroundConnector, "mode" | "cursor" | "checkpointSequence" | "active" | "version">,
    actor: AutomationActor,
  ): BackgroundConnector {
    assertHuman(actor);
    assertWorkspace(actor, input.workspaceId);
    if (this.connectors.has(input.id)) throw new CustomerWorkOsV25Error("DUPLICATE_CONNECTOR", "connector already exists");
    if (input.provider !== "CSV" && (!input.secretRef || !input.secretRef.startsWith("secret://"))) {
      throw new CustomerWorkOsV25Error("SECRET_REFERENCE_REQUIRED", "remote connector credentials must use a secret:// reference");
    }
    if (!Number.isInteger(input.maxBatchSize) || input.maxBatchSize < 1 || input.maxBatchSize > 1000) {
      throw new CustomerWorkOsV25Error("INVALID_BATCH_SIZE", "maxBatchSize must be 1..1000");
    }
    if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 10) {
      throw new CustomerWorkOsV25Error("INVALID_RETRY_POLICY", "maxRetries must be 0..10");
    }
    const connector: BackgroundConnector = {
      ...copy(input),
      id: required(input.id, "connector.id"),
      mode: "READ_ONLY",
      cursor: null,
      checkpointSequence: 0,
      active: true,
      version: 1,
    };
    this.connectors.set(connector.id, connector);
    return copy(connector);
  }

  ingestBatch(
    input: {
      id: string;
      workspaceId: string;
      connectorId: string;
      items: PulledSourceItem[];
      nextCursor: string | null;
      startedAt: string;
      completedAt: string;
    },
    actor: AutomationActor,
  ): SyncBatch {
    assertHumanOrService(actor);
    assertWorkspace(actor, input.workspaceId);
    const connector = this.connector(input.workspaceId, input.connectorId);
    if (input.items.length > connector.maxBatchSize) {
      throw new CustomerWorkOsV25Error("BATCH_TOO_LARGE", "sync batch exceeds connector maxBatchSize");
    }
    const sequence = connector.checkpointSequence + 1;
    const batch: SyncBatch = {
      id: required(input.id, "batch.id"),
      workspaceId: input.workspaceId,
      connectorId: connector.id,
      sequence,
      cursorBefore: connector.cursor,
      cursorAfter: input.nextCursor,
      itemIds: [],
      accepted: 0,
      duplicates: 0,
      quarantined: 0,
      failed: 0,
      status: "RUNNING",
      startedAt: input.startedAt,
      completedAt: null,
      version: 1,
    };
    if (this.batches.has(batch.id)) return copy(this.batches.get(batch.id)!);

    for (const [itemIndex, raw] of input.items.entries()) {
      const externalId = required(raw.externalId, "sync.externalId");
      const contentHash = required(raw.contentHash, "sync.contentHash");
      const existing = [...this.items.values()].find((item) =>
        item.workspaceId === input.workspaceId &&
        item.connectorId === connector.id &&
        (item.externalId === externalId || item.contentHash === contentHash) &&
        item.status !== "FAILED",
      );
      const itemId = `sync-item-${deterministicHash({ batchId: batch.id, itemIndex, connectorId: connector.id, externalId, contentHash }).slice(-16)}`;
      let item: SyncItem;
      if (existing) {
        item = {
          id: itemId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          externalId,
          contentHash,
          sourceRef: required(raw.sourceRef, "sync.sourceRef"),
          payload: copy(raw.payload),
          status: "DUPLICATE",
          failureCode: null,
          attempt: 1,
          version: 1,
        };
        batch.duplicates += 1;
      } else if (raw.suspicious) {
        item = {
          id: itemId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          externalId,
          contentHash,
          sourceRef: required(raw.sourceRef, "sync.sourceRef"),
          payload: copy(raw.payload),
          status: "QUARANTINED",
          failureCode: "SUSPICIOUS_CONTENT",
          attempt: 1,
          version: 1,
        };
        batch.quarantined += 1;
      } else {
        item = {
          id: itemId,
          workspaceId: input.workspaceId,
          connectorId: connector.id,
          externalId,
          contentHash,
          sourceRef: required(raw.sourceRef, "sync.sourceRef"),
          payload: copy(raw.payload),
          status: "ACCEPTED",
          failureCode: null,
          attempt: 1,
          version: 1,
        };
        batch.accepted += 1;
      }
      this.items.set(item.id, item);
      batch.itemIds.push(item.id);
    }

    batch.status = batch.failed > 0 ? "FAILED" : batch.quarantined > 0 ? "NEEDS_REVIEW" : "COMPLETED";
    batch.completedAt = input.completedAt;
    batch.version += 1;
    connector.cursor = input.nextCursor;
    connector.checkpointSequence = sequence;
    connector.mode = batch.status === "COMPLETED" ? "RECONCILED" : "SHADOW";
    connector.version += 1;
    this.batches.set(batch.id, batch);
    return copy(batch);
  }

  async runOnce(
    connectorId: string,
    adapter: BackgroundSourceAdapter,
    now: () => string,
    actor: AutomationActor,
  ): Promise<SyncBatch> {
    assertHumanOrService(actor);
    const connector = this.connector(actor.workspaceId, connectorId);
    if (adapter.provider !== connector.provider) throw new CustomerWorkOsV25Error("PROVIDER_MISMATCH", "adapter provider does not match connector");
    const startedAt = now();
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= connector.maxRetries) {
      attempt += 1;
      try {
        const result = await adapter.pull(connector.cursor, connector.maxBatchSize);
        return this.ingestBatch({
          id: `sync-batch-${connector.id}-${connector.checkpointSequence + 1}`,
          workspaceId: connector.workspaceId,
          connectorId: connector.id,
          items: result.items,
          nextCursor: result.nextCursor,
          startedAt,
          completedAt: now(),
        }, actor);
      } catch (error) {
        lastError = error;
      }
    }
    throw new CustomerWorkOsV25Error("SYNC_RETRIES_EXHAUSTED", `sync failed after ${attempt} attempts: ${String(lastError)}`);
  }

  acceptedItems(workspaceId: string, afterSequence = 0): SyncItem[] {
    const connectorIds = new Set(
      [...this.connectors.values()]
        .filter((item) => item.workspaceId === workspaceId && item.checkpointSequence > afterSequence)
        .map((item) => item.id),
    );
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && connectorIds.has(item.connectorId) && item.status === "ACCEPTED")
      .map(copy)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  reviewQueue(workspaceId: string): SyncItem[] {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && ["QUARANTINED", "FAILED"].includes(item.status))
      .map(copy)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  exportState(): BackgroundSyncState {
    return {
      schemaVersion: 1,
      connectors: sorted(this.connectors.values()),
      items: sorted(this.items.values()),
      batches: sorted(this.batches.values()),
    };
  }

  hydrateState(input: BackgroundSyncState): void {
    if (input.schemaVersion !== 1) throw new CustomerWorkOsV25Error("UNSUPPORTED_STATE", "unsupported sync state");
    this.connectors = mapById(input.connectors, "backgroundConnector");
    this.items = mapById(input.items, "syncItem");
    this.batches = mapById(input.batches, "syncBatch");
  }

  private connector(workspaceId: string, id: string): BackgroundConnector {
    const item = this.connectors.get(id);
    if (!item) throw new CustomerWorkOsV25Error("CONNECTOR_NOT_FOUND", "background connector not found");
    if (item.workspaceId !== workspaceId) throw new CustomerWorkOsV25Error("CROSS_WORKSPACE", "cross-workspace connector access is forbidden");
    if (!item.active) throw new CustomerWorkOsV25Error("CONNECTOR_INACTIVE", "connector is inactive");
    return item;
  }
}
