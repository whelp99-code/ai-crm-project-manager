/**
 * Pure desired-vs-live diff for Notion incremental sync.
 * No database. Settlement rows are never updated, archived, or deleted.
 */

export type NotionSyncKind =
  | "account"
  | "engagement"
  | "party"
  | "activity"
  | "commitment"
  | "artifact"
  | "financial_item";

export type NotionSyncHoldReason =
  | "AMOUNT_OR_DIRECTION"
  | "SETTLED_ARCHIVE"
  | "COMMITMENT_DONE"
  | "CORE5_DRIFT"
  | "QUARANTINED"
  | "KIND_CHANGED"
  | "SCHEMA_REJECT"
  | "MISSING_DATE"
  | "MISSING_ACCOUNT";

export interface NotionSyncEntity {
  kind: NotionSyncKind;
  id: string;
  /** Stable unique key stored in notion_page_id. */
  notionPageId: string;
  /** Snapshot membership key. Derived rows use the parent page id. */
  pageId: string;
  fields: Record<string, unknown>;
}

export interface NotionSyncLiveEntity extends NotionSyncEntity {
  version?: number;
  syncedVersion?: number | null;
  archivedAt?: string | null;
  hasSettlement?: boolean;
  commitmentDoneWithEvidence?: boolean;
}

export interface NotionSyncSettlement {
  id: string;
  financialItemId: string;
  notionPageId: string;
  direction: string;
  amountKrw: string;
  settledAt: string;
}

export interface NotionSyncHold {
  notionPageId: string;
  kind: string;
  reason: NotionSyncHoldReason;
}

export interface NotionSyncDiff {
  inserts: NotionSyncEntity[];
  updates: NotionSyncEntity[];
  archives: Array<{ kind: NotionSyncKind; id: string; notionPageId: string; pageId: string; fields: Record<string, unknown> }>;
  holds: NotionSyncHold[];
  settlementInserts: NotionSyncSettlement[];
  /** Always empty. Settlements are append-only and this diff never mutates them. */
  settlementUpdates: never[];
  deletes: never[];
}

const UPDATABLE: Record<NotionSyncKind, readonly string[]> = {
  account: ["name", "normalized_name", "kinds", "status", "source_ref"],
  engagement: ["name", "project_key", "engagement_type", "stage", "source_stage", "start_date", "target_date"],
  party: ["role", "is_primary", "commercial_responsibility", "delivery_responsibility"],
  activity: ["activity_type", "occurred_at", "summary", "engagement_id", "account_id"],
  commitment: ["description", "due_at", "priority", "financial_impact", "status"],
  artifact: ["title", "status", "storage_uri", "metadata"],
  financial_item: [
    "net_amount_krw", "vat_amount_krw", "gross_amount_krw", "expected_date", "lifecycle",
    "category", "engagement_id", "account_id", "direction",
  ],
};

const MONEY_FIELDS = ["net_amount_krw", "vat_amount_krw", "gross_amount_krw", "direction", "account_id"];

const ENGAGEMENT_STAGES = new Set([
  "INQUIRY", "DISCOVERY", "PROPOSAL", "NEGOTIATION", "CONTRACTED", "DELIVERY", "ACCEPTANCE",
  "BILLING", "COLLECTION", "CLOSED", "ON_HOLD", "LOST", "CANCELLED",
]);
const ENGAGEMENT_TYPES = new Set([
  "inquiry", "opportunity", "consulting", "delivery", "support", "maintenance", "renewal", "internal",
]);

export function notionSyncFieldEqual(left: unknown, right: unknown): boolean {
  return normalizeField(left) === normalizeField(right);
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function normalizeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  const timestamp = normalizeTimestamp(value);
  if (timestamp) return timestamp;
  if (typeof value === "object") return canonicalJson(value);
  return String(value);
}

function changedFields(desired: NotionSyncEntity, live: NotionSyncLiveEntity): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of UPDATABLE[desired.kind]) {
    if (!(key in desired.fields)) continue;
    if (!notionSyncFieldEqual(desired.fields[key], live.fields[key])) next[key] = desired.fields[key];
  }
  return next;
}

function schemaReject(entity: NotionSyncEntity): boolean {
  if (entity.kind === "engagement") {
    const stage = entity.fields.stage;
    const type = entity.fields.engagement_type;
    if (stage !== undefined && !ENGAGEMENT_STAGES.has(String(stage))) return true;
    if (type !== undefined && !ENGAGEMENT_TYPES.has(String(type))) return true;
  }
  return false;
}

export function diffNotionSync(input: {
  desired: readonly NotionSyncEntity[];
  live: readonly NotionSyncLiveEntity[];
  quarantinedPageIds?: ReadonlySet<string>;
  snapshotPageIds: ReadonlySet<string>;
  desiredSettlements?: readonly NotionSyncSettlement[];
  liveSettlementFinancialItemIds?: ReadonlySet<string>;
}): NotionSyncDiff {
  const quarantined = input.quarantinedPageIds ?? new Set<string>();
  const liveById = new Map(input.live.map((row) => [`${row.kind}\u0000${row.id}`, row]));
  const inserts: NotionSyncEntity[] = [];
  const updates: NotionSyncEntity[] = [];
  const holds: NotionSyncHold[] = [];
  const desiredIds = new Set<string>();
  const heldMoneyIds = new Set<string>();

  for (const row of input.desired) {
    desiredIds.add(`${row.kind}\u0000${row.id}`);
    if (quarantined.has(row.pageId)) {
      holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "QUARANTINED" });
      continue;
    }
    const primary = row.kind === "account" || row.kind === "engagement" || row.kind === "activity" || row.kind === "financial_item";
    const liveKind = primary
      ? input.live.find((item) => (item.kind === "account" || item.kind === "engagement" || item.kind === "activity" || item.kind === "financial_item") && item.pageId === row.pageId && item.kind !== row.kind)
      : undefined;
    if (liveKind) {
      holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "KIND_CHANGED" });
      continue;
    }
    const live = liveById.get(`${row.kind}\u0000${row.id}`);
    if (!live) {
      if (schemaReject(row)) {
        holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "SCHEMA_REJECT" });
        continue;
      }
      inserts.push(row);
      continue;
    }
    if (live.syncedVersion != null && (live.version ?? 0) > live.syncedVersion) {
      holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "CORE5_DRIFT" });
      continue;
    }
    if (live.commitmentDoneWithEvidence) {
      const changes = changedFields(row, live);
      if (Object.keys(changes).length > 0) {
        holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "COMMITMENT_DONE" });
      }
      continue;
    }
    if (schemaReject(row)) {
      holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "SCHEMA_REJECT" });
      continue;
    }
    let changes = changedFields(row, live);
    if (row.kind === "financial_item") {
      const stopped = Object.keys(changes).filter((key) => MONEY_FIELDS.includes(key));
      if (stopped.length > 0) {
        holds.push({ notionPageId: row.pageId, kind: row.kind, reason: "AMOUNT_OR_DIRECTION" });
        heldMoneyIds.add(row.id);
        for (const key of stopped) delete changes[key];
      }
    }
    if (Object.keys(changes).length === 0 && live.notionPageId === row.notionPageId && !live.archivedAt) continue;
    updates.push({ ...row, fields: { ...changes, ...(live.notionPageId === row.notionPageId ? {} : { notion_page_id: row.notionPageId }) } });
    if (live.archivedAt) updates[updates.length - 1] = { ...updates[updates.length - 1]!, fields: { ...updates[updates.length - 1]!.fields, archived_at: null } };
  }

  const archives: NotionSyncDiff["archives"] = [];
  for (const live of input.live) {
    if (!live.pageId || live.archivedAt) continue;
    if (desiredIds.has(`${live.kind}\u0000${live.id}`)) continue;
    if (quarantined.has(live.pageId)) {
      holds.push({ notionPageId: live.pageId, kind: live.kind, reason: "QUARANTINED" });
      continue;
    }
    if (input.snapshotPageIds.has(live.pageId)) continue;
    if (live.syncedVersion != null && (live.version ?? 0) > live.syncedVersion) {
      holds.push({ notionPageId: live.pageId, kind: live.kind, reason: "CORE5_DRIFT" });
      continue;
    }
    if (live.kind === "financial_item" && live.hasSettlement) {
      holds.push({ notionPageId: live.pageId, kind: live.kind, reason: "SETTLED_ARCHIVE" });
      continue;
    }
    if (live.commitmentDoneWithEvidence) {
      holds.push({ notionPageId: live.pageId, kind: live.kind, reason: "COMMITMENT_DONE" });
      continue;
    }
    const fields: Record<string, unknown> = { archived_at: "now" };
    if (live.kind === "account") fields.status = "inactive";
    if (live.kind === "commitment") fields.status = "CANCELLED";
    if (live.kind === "artifact") fields.status = "SUPERSEDED";
    if (live.kind === "financial_item") fields.lifecycle = "CANCELLED";
    archives.push({ kind: live.kind, id: live.id, notionPageId: live.notionPageId, pageId: live.pageId, fields });
  }

  const settled = input.liveSettlementFinancialItemIds ?? new Set<string>();
  const settlementInserts: NotionSyncSettlement[] = [];
  for (const row of input.desiredSettlements ?? []) {
    if (settled.has(row.financialItemId) || heldMoneyIds.has(row.financialItemId)) continue;
    if (!row.settledAt) {
      holds.push({ notionPageId: row.notionPageId, kind: "settlement", reason: "MISSING_DATE" });
      continue;
    }
    settlementInserts.push(row);
  }

  return { inserts, updates, archives, holds, settlementInserts, settlementUpdates: [], deletes: [] };
}
