import { CustomerWorkOsError } from "@ai-crm/domain/customer-work-os";
import {
  diffNotionSync,
  notionArtifactIdentity,
  notionCwosHash,
  stableNotionStorageKey,
  type NotionCwosImportPlan,
  type NotionSyncDiff,
  type NotionSyncEntity,
  type NotionSyncHold,
  type NotionSyncKind,
  type NotionSyncLiveEntity,
  type NotionSyncSettlement,
} from "@ai-crm/imports";
import type { NotionPlanRecord } from "./customer-work-os-notion.js";

interface QueryResult<T> { rows: T[]; rowCount?: number | null }
export interface NotionSyncConnection {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}
export interface NotionSyncPool {
  connect(): Promise<NotionSyncConnection>;
}

export interface NotionSyncReport {
  alreadyApplied: boolean;
  dryRun: boolean;
  inserts: number;
  updates: number;
  archives: number;
  holds: number;
  settlementInserts: number;
  settlementUpdates: number;
  deletes: number;
  holdReasons: string[];
}

const FORBIDDEN_DATABASES = new Set(["ai_crm"]);

function importedEngagementType(stage: string): "opportunity" | "delivery" | "maintenance" {
  if (["DELIVERY", "ACCEPTANCE", "BILLING", "COLLECTION", "CLOSED"].includes(stage)) return "delivery";
  if (stage === "ON_HOLD") return "maintenance";
  return "opportunity";
}

function artifactType(kind: string): string {
  if (kind === "quote") return "customer_quote";
  if (kind === "proposal") return "proposal";
  if (kind === "contract") return "contract";
  return "completion_report";
}

export function buildNotionSyncDesired(plan: NotionCwosImportPlan, principalId: string): {
  desired: NotionSyncEntity[];
  settlements: NotionSyncSettlement[];
  holds: NotionSyncHold[];
  pageIds: Set<string>;
} {
  const quarantined = new Set(plan.quarantined.map((row) => row.sourceId));
  const pageIds = new Set<string>([
    ...plan.accounts.map((row) => row.legacySourceId),
    ...plan.engagements.map((row) => row.legacySourceId),
    ...plan.activities.map((row) => row.legacySourceId),
    ...plan.financialItems.map((row) => row.legacySourceId),
    ...plan.quarantined.map((row) => row.sourceId),
    ...plan.outOfScope.map((row) => row.sourceId),
  ]);
  const accountIds = new Map(plan.accounts.map((item) => [item.legacySourceId, item.id]));
  const engagementIds = new Map(plan.engagements.map((item) => [item.legacySourceId, item.id]));
  const desired: NotionSyncEntity[] = [];
  const settlements: NotionSyncSettlement[] = [];
  const holds: NotionSyncHold[] = [];

  for (const item of plan.accounts) {
    if (quarantined.has(item.legacySourceId)) continue;
    desired.push({
      kind: "account",
      id: item.id,
      notionPageId: item.legacySourceId,
      pageId: item.legacySourceId,
      fields: {
        name: item.name,
        normalized_name: item.normalizedName,
        kinds: item.kinds,
        status: item.status,
        source_ref: item.sourceUrl ?? `notion://${item.legacySourceId}`,
      },
    });
  }

  for (const item of plan.engagements) {
    if (quarantined.has(item.legacySourceId)) continue;
    desired.push({
      kind: "engagement",
      id: item.id,
      notionPageId: item.legacySourceId,
      pageId: item.legacySourceId,
      fields: {
        name: item.name,
        project_key: item.projectKey,
        engagement_type: item.engagementType ?? importedEngagementType(item.stage),
        stage: item.stage,
        source_stage: item.sourceStage ?? null,
        start_date: item.startDate ?? null,
        target_date: item.targetDate ?? null,
        health: "normal",
        owner_principal_id: principalId,
        terminal_reason: ["LOST", "CANCELLED"].includes(item.stage) ? "Imported terminal state from Notion" : null,
      },
    });
    for (const party of item.parties) {
      const accountId = accountIds.get(party.accountSourceId);
      if (!accountId) continue;
      const notionPageId = `party:${item.legacySourceId}:${party.accountSourceId}:${party.role}`;
      desired.push({
        kind: "party",
        id: `party-${notionCwosHash({ engagement: item.id, accountId, role: party.role }).slice(-8)}`,
        notionPageId,
        pageId: item.legacySourceId,
        fields: {
          engagement_id: item.id,
          account_id: accountId,
          role: party.role,
          is_primary: party.primary,
          commercial_responsibility: party.commercialResponsibility,
          delivery_responsibility: party.deliveryResponsibility,
        },
      });
    }
    if (item.nextAction && !["CLOSED", "LOST", "CANCELLED"].includes(item.stage)) {
      desired.push({
        kind: "commitment",
        id: `commitment-${notionCwosHash({ engagement: item.id, action: item.nextAction }).slice(-8)}`,
        notionPageId: `commitment:${item.legacySourceId}:${notionCwosHash(item.nextAction).slice(-8)}`,
        pageId: item.legacySourceId,
        fields: {
          engagement_id: item.id,
          owner_principal_id: principalId,
          description: item.nextAction,
          due_at: item.targetDate ?? null,
          status: "OPEN",
          priority: 50,
          financial_impact: false,
          approval_required: false,
        },
      });
    }
    for (const [kind, refs] of Object.entries(item.artifactRefs)) {
      refs.forEach((storageUri, index) => {
        const identity = notionArtifactIdentity({ engagementId: item.id, pageId: item.legacySourceId, kind, storageUri });
        desired.push({
          kind: "artifact",
          id: identity.id,
          notionPageId: identity.notionPageId,
          pageId: item.legacySourceId,
          fields: {
            engagement_id: item.id,
            artifact_type: artifactType(kind),
            title: `${kind} imported from Notion`,
            version_label: `legacy-${index + 1}`,
            status: "REVIEW",
            storage_uri: storageUri,
            metadata: { legacySourceId: item.legacySourceId, importedFrom: "Notion" },
          },
        });
      });
    }
  }

  for (const item of plan.activities) {
    if (quarantined.has(item.legacySourceId)) continue;
    const engagementId = item.projectSourceIds.map((source) => engagementIds.get(source)).find(Boolean) ?? null;
    const accountId = item.accountSourceIds.map((source) => accountIds.get(source)).find(Boolean) ?? null;
    if (!engagementId && !accountId) continue;
    desired.push({
      kind: "activity",
      id: item.id,
      notionPageId: item.legacySourceId,
      pageId: item.legacySourceId,
      fields: {
        engagement_id: engagementId,
        account_id: accountId,
        activity_type: item.activityType,
        occurred_at: item.occurredAt,
        summary: item.summary,
        source_uri: item.sourceUrl ?? null,
        evidence_ref: item.sourceUrl ?? `notion://${item.legacySourceId}`,
        human_reviewed: true,
      },
    });
  }

  for (const item of plan.financialItems) {
    if (quarantined.has(item.legacySourceId)) continue;
    if (!item.accountSourceId) {
      holds.push({ notionPageId: item.legacySourceId, kind: "financial_item", reason: "MISSING_ACCOUNT" });
      continue;
    }
    const accountId = accountIds.get(item.accountSourceId);
    if (!accountId) {
      holds.push({ notionPageId: item.legacySourceId, kind: "financial_item", reason: "MISSING_ACCOUNT" });
      continue;
    }
    const engagementId = item.engagementSourceId ? engagementIds.get(item.engagementSourceId) ?? null : null;
    if (item.expectedDate === undefined) {
      holds.push({ notionPageId: item.legacySourceId, kind: "financial_item", reason: "MISSING_DATE" });
      continue;
    }
    desired.push({
      kind: "financial_item",
      id: item.id,
      notionPageId: item.legacySourceId,
      pageId: item.legacySourceId,
      fields: {
        engagement_id: engagementId,
        account_id: accountId,
        direction: item.direction,
        category: item.category,
        lifecycle: item.lifecycle,
        net_amount_krw: item.netAmountKrw,
        vat_amount_krw: item.vatAmountKrw,
        gross_amount_krw: item.grossAmountKrw,
        expected_date: item.expectedDate,
        import_assignment: item.importAssignment ?? "assigned",
        revision: 1,
        evidence_ref: item.evidenceRefs[0] ?? item.sourceUrl ?? `notion://${item.legacySourceId}`,
      },
    });
    if (item.lifecycle === "SETTLED") {
      const settledAt = item.actualDate ?? item.expectedDate;
      if (!settledAt) {
        holds.push({ notionPageId: item.legacySourceId, kind: "settlement", reason: "MISSING_DATE" });
      } else if (BigInt(item.grossAmountKrw) <= 0n) {
        holds.push({ notionPageId: item.legacySourceId, kind: "settlement", reason: "SCHEMA_REJECT" });
      } else {
        settlements.push({
          id: `settlement-${notionCwosHash(item.id).slice(-8)}`,
          financialItemId: item.id,
          notionPageId: item.legacySourceId,
          direction: item.direction,
          amountKrw: item.grossAmountKrw,
          settledAt,
        });
      }
    }
  }

  return { desired, settlements, holds, pageIds };
}

function metadataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function sameArtifactSlot(desired: NotionSyncEntity, live: NotionSyncLiveEntity): boolean {
  const meta = metadataRecord(live.fields.metadata);
  const page = typeof meta?.legacySourceId === "string" ? meta.legacySourceId : live.pageId;
  if (page !== desired.pageId) return false;
  if (live.fields.artifact_type !== desired.fields.artifact_type) return false;
  if (desired.fields.engagement_id && live.fields.engagement_id && live.fields.engagement_id !== desired.fields.engagement_id) return false;
  return true;
}

/** Keep first-load ids that hashed the signed URL. Match by page id plus stable file path, never insert a twin. */
export function bindExistingArtifactIds(desired: readonly NotionSyncEntity[], live: readonly NotionSyncLiveEntity[]): NotionSyncEntity[] {
  const liveArtifacts = live.filter((row) => row.kind === "artifact" && !row.archivedAt);
  const used = new Set<string>();
  return desired.map((row) => {
    if (row.kind !== "artifact") return row;
    if (liveArtifacts.some((item) => item.id === row.id)) {
      used.add(row.id);
      return row;
    }
    const file = stableNotionStorageKey(String(row.fields.storage_uri ?? ""));
    const byFile = liveArtifacts.find((item) => !used.has(item.id) && sameArtifactSlot(row, item) && stableNotionStorageKey(String(item.fields.storage_uri ?? "")) === file);
    const byLabel = liveArtifacts.find((item) => !used.has(item.id) && sameArtifactSlot(row, item) && item.fields.version_label != null && item.fields.version_label === row.fields.version_label);
    const match = byFile ?? byLabel;
    if (!match) return row;
    used.add(match.id);
    return { ...row, id: match.id };
  });
}

const LIVE_SQL: Record<NotionSyncKind, string> = {
  account: `SELECT id, notion_page_id, notion_parent_page_id, archived_at, version, synced_version,
      name, normalized_name, kinds, status, source_ref FROM cwos_accounts WHERE workspace_id = $1`,
  engagement: `SELECT id, notion_page_id, notion_parent_page_id, archived_at, version, synced_version,
      name, project_key, engagement_type, stage, source_stage, start_date::text AS start_date, target_date::text AS target_date FROM cwos_engagements WHERE workspace_id = $1`,
  party: `SELECT id, notion_page_id, notion_parent_page_id, archived_at,
      role, is_primary, commercial_responsibility, delivery_responsibility FROM cwos_engagement_parties WHERE workspace_id = $1`,
  activity: `SELECT id, notion_page_id, notion_parent_page_id, archived_at,
      activity_type, occurred_at, summary, engagement_id, account_id FROM cwos_activities WHERE workspace_id = $1`,
  commitment: `SELECT id, notion_page_id, notion_parent_page_id, archived_at, version, synced_version,
      description, due_at, priority, financial_impact, status, completion_evidence_ref FROM cwos_commitments WHERE workspace_id = $1`,
  artifact: `SELECT id, notion_page_id, notion_parent_page_id, archived_at, version, synced_version,
      engagement_id, artifact_type, title, version_label, status, storage_uri, metadata FROM cwos_artifacts WHERE workspace_id = $1`,
  financial_item: `SELECT id, notion_page_id, notion_parent_page_id, archived_at,
      net_amount_krw, vat_amount_krw, gross_amount_krw, expected_date::text AS expected_date, lifecycle, category, engagement_id, account_id, direction
      FROM cwos_financial_items WHERE workspace_id = $1`,
};

export function rowToLive(kind: NotionSyncKind, row: Record<string, unknown>): NotionSyncLiveEntity {
  return rowToLiveImpl(kind, row);
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // DATE must already be the raw YYYY-MM-DD text. node-pg's default OID 1082
  // parser is a local-midnight Date, not UTC midnight; getUTC* on that Date
  // shifts the day in Asia/Seoul. installPgDateStringParser rejects that path
  // at the driver, so a Date here is a missing parser, not a value to format.
  if (typeof value !== "string") {
    throw new Error(`DATE column must be a YYYY-MM-DD string, got ${Object.prototype.toString.call(value)}`);
  }
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function rowToLiveImpl(kind: NotionSyncKind, row: Record<string, unknown>): NotionSyncLiveEntity {
  const notionPageId = row.notion_page_id == null ? "" : String(row.notion_page_id);
  const parent = row.notion_parent_page_id == null ? null : String(row.notion_parent_page_id);
  const pageId = parent ?? (notionPageId || "");
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (["id", "notion_page_id", "notion_parent_page_id", "archived_at", "version", "synced_version", "completion_evidence_ref"].includes(key)) continue;
    if (key.endsWith("_date") || key === "start_date" || key === "target_date" || key === "expected_date") fields[key] = dateText(value);
    else if (key === "occurred_at" || key === "due_at") fields[key] = value instanceof Date ? value.toISOString() : value;
    else if (typeof value === "bigint") fields[key] = value.toString();
    else fields[key] = value;
  }
  return {
    kind,
    id: String(row.id),
    notionPageId,
    pageId,
    ...(row.version == null ? {} : { version: Number(row.version) }),
    syncedVersion: row.synced_version == null ? null : Number(row.synced_version),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    commitmentDoneWithEvidence: kind === "commitment" && row.status === "DONE" && row.completion_evidence_ref != null && String(row.completion_evidence_ref).trim() !== "",
    fields,
  };
}

function reportOf(diff: NotionSyncDiff, extraHolds: NotionSyncHold[], flags: { alreadyApplied: boolean; dryRun: boolean }): NotionSyncReport {
  const holds = [...extraHolds, ...diff.holds];
  return {
    alreadyApplied: flags.alreadyApplied,
    dryRun: flags.dryRun,
    inserts: diff.inserts.length,
    updates: diff.updates.length,
    archives: diff.archives.length,
    holds: holds.length,
    settlementInserts: diff.settlementInserts.length,
    settlementUpdates: 0,
    deletes: 0,
    holdReasons: holds.map((row) => row.reason),
  };
}

async function loadLive(connection: NotionSyncConnection, workspaceId: string): Promise<{ live: NotionSyncLiveEntity[]; settled: Set<string> }> {
  const live: NotionSyncLiveEntity[] = [];
  for (const kind of Object.keys(LIVE_SQL) as NotionSyncKind[]) {
    const result = await connection.query<Record<string, unknown>>(LIVE_SQL[kind], [workspaceId]);
    for (const row of result.rows) live.push(rowToLiveImpl(kind, row));
  }
  const settlements = await connection.query<{ financial_item_id: string }>(
    `SELECT financial_item_id FROM cwos_settlements WHERE workspace_id = $1`,
    [workspaceId],
  );
  const settled = new Set(settlements.rows.map((row) => row.financial_item_id));
  for (const row of live) {
    if (row.kind === "financial_item") row.hasSettlement = settled.has(row.id);
  }
  return { live, settled };
}

const CAST: Record<string, string> = {
  kinds: "::jsonb",
  metadata: "::jsonb",
  start_date: "::date",
  target_date: "::date",
  expected_date: "::date",
  occurred_at: "::timestamptz",
  due_at: "::timestamptz",
  workspace_id: "::uuid",
};

function cast(column: string, slot: string): string {
  return `${slot}${CAST[column] ?? ""}`;
}

async function guarded(connection: NotionSyncConnection, sql: string, values: readonly unknown[], onError: () => void): Promise<boolean> {
  await connection.query("SAVEPOINT sync_row");
  try {
    await connection.query(sql, values);
    await connection.query("RELEASE SAVEPOINT sync_row");
    return true;
  } catch {
    await connection.query("ROLLBACK TO SAVEPOINT sync_row");
    onError();
    return false;
  }
}

function versionBump(table: string): string {
  if (table === "cwos_engagement_parties" || table === "cwos_activities" || table === "cwos_financial_items") return "";
  return ", version = version + 1, synced_version = version + 1, updated_at = now()";
}

const TABLE: Record<NotionSyncKind, string> = {
  account: "cwos_accounts",
  engagement: "cwos_engagements",
  party: "cwos_engagement_parties",
  activity: "cwos_activities",
  commitment: "cwos_commitments",
  artifact: "cwos_artifacts",
  financial_item: "cwos_financial_items",
};

async function insertEntity(connection: NotionSyncConnection, workspaceId: string, entity: NotionSyncEntity, onError: () => void): Promise<boolean> {
  const columns = ["id", "workspace_id", "notion_page_id", "notion_parent_page_id"];
  const values: unknown[] = [entity.id, workspaceId, entity.notionPageId, entity.pageId === entity.notionPageId ? null : entity.pageId];
  for (const [key, value] of Object.entries(entity.fields)) {
    if (key === "notion_page_id" || key === "archived_at") continue;
    columns.push(key);
    values.push(key === "kinds" || key === "metadata" ? JSON.stringify(value) : value);
  }
  if (TABLE[entity.kind] !== "cwos_engagement_parties" && TABLE[entity.kind] !== "cwos_activities" && TABLE[entity.kind] !== "cwos_financial_items") {
    columns.push("version", "synced_version");
    values.push(1, 1);
  }
  const placeholders = columns.map((column, index) => cast(column, `$${index + 1}`)).join(", ");
  return guarded(
    connection,
    `INSERT INTO ${TABLE[entity.kind]} (${columns.join(", ")}) VALUES (${placeholders})`,
    values,
    onError,
  );
}

async function updateEntity(connection: NotionSyncConnection, workspaceId: string, entity: NotionSyncEntity, onError: () => void): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [workspaceId, entity.id];
  for (const [key, value] of Object.entries(entity.fields)) {
    if (key === "notion_page_id" || key === "archived_at") continue;
    values.push(key === "kinds" || key === "metadata" ? JSON.stringify(value) : value);
    assignments.push(`${key} = ${cast(key, `$${values.length}`)}`);
  }
  values.push(entity.notionPageId, entity.pageId === entity.notionPageId ? null : entity.pageId);
  assignments.push(`notion_page_id = $${values.length - 1}`);
  assignments.push(`notion_parent_page_id = $${values.length}`);
  assignments.push("archived_at = NULL");
  return guarded(
    connection,
    `UPDATE ${TABLE[entity.kind]} SET ${assignments.join(", ")}${versionBump(TABLE[entity.kind])} WHERE workspace_id = $1::uuid AND id = $2`,
    values,
    onError,
  );
}

async function archiveEntity(connection: NotionSyncConnection, workspaceId: string, kind: NotionSyncKind, id: string, fields: Record<string, unknown>, onError: () => void): Promise<boolean> {
  const assignments = ["archived_at = now()"];
  const values: unknown[] = [workspaceId, id];
  if (fields.status !== undefined) {
    values.push(fields.status);
    assignments.push(`status = $${values.length}`);
  }
  if (fields.lifecycle !== undefined) {
    values.push(fields.lifecycle);
    assignments.push(`lifecycle = $${values.length}`);
  }
  return guarded(
    connection,
    `UPDATE ${TABLE[kind]} SET ${assignments.join(", ")}${versionBump(TABLE[kind])} WHERE workspace_id = $1::uuid AND id = $2`,
    values,
    onError,
  );
}

export async function syncApprovedNotionPlan(input: {
  pool: NotionSyncPool;
  record: NotionPlanRecord;
  principalId: string;
  snapshotSha256: string;
  dryRun?: boolean;
  now?: string;
  snapshotPageIds?: ReadonlySet<string>;
  injectFailureAfterMarker?: () => Promise<void>;
}): Promise<NotionSyncReport> {
  if (input.record.status !== "APPROVED" && input.record.status !== "APPLIED") {
    throw new CustomerWorkOsError("INVALID_STATE", "only an APPROVED plan can be synced");
  }
  const appliedAt = input.now ?? new Date().toISOString();
  const connection = await input.pool.connect();
  let committed = false;
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT set_config('app.workspace_id', $1, true)", [input.record.workspaceId]);
    await connection.query("SELECT set_config('app.cwos_notion_sync', 'on', true)", []);
    const database = await connection.query<{ name: string }>("SELECT current_database() AS name");
    const databaseName = database.rows[0]?.name;
    if (!input.dryRun && databaseName && FORBIDDEN_DATABASES.has(databaseName)) {
      throw new CustomerWorkOsError("INVALID_STATE", "refusing to sync into ai_crm");
    }
    const existing = await connection.query(
      `SELECT id FROM cwos_notion_sync_runs WHERE workspace_id = $1::uuid AND plan_hash = $2 AND status = 'applied'`,
      [input.record.workspaceId, input.record.planHash],
    );
    if (existing.rows[0]) {
      await connection.query("ROLLBACK");
      committed = true;
      return {
        alreadyApplied: true, dryRun: false, inserts: 0, updates: 0, archives: 0, holds: 0,
        settlementInserts: 0, settlementUpdates: 0, deletes: 0, holdReasons: [],
      };
    }
    const built = buildNotionSyncDesired(input.record.plan, input.principalId);
    const { live, settled } = await loadLive(connection, input.record.workspaceId);
    const desired = bindExistingArtifactIds(built.desired, live);
    const diff = diffNotionSync({
      desired,
      live,
      quarantinedPageIds: new Set(input.record.plan.quarantined.map((row) => row.sourceId)),
      snapshotPageIds: input.snapshotPageIds ?? built.pageIds,
      desiredSettlements: built.settlements,
      liveSettlementFinancialItemIds: settled,
    });
    const schemaHolds: NotionSyncHold[] = [];
    if (input.dryRun) {
      await connection.query("ROLLBACK");
      committed = true;
      return reportOf(diff, built.holds, { alreadyApplied: false, dryRun: true });
    }
    for (const entity of diff.inserts) {
      await insertEntity(connection, input.record.workspaceId, entity, () => {
        schemaHolds.push({ notionPageId: entity.pageId, kind: entity.kind, reason: "SCHEMA_REJECT" });
      });
    }
    for (const entity of diff.updates) {
      await updateEntity(connection, input.record.workspaceId, entity, () => {
        schemaHolds.push({ notionPageId: entity.pageId, kind: entity.kind, reason: "SCHEMA_REJECT" });
      });
    }
    for (const entity of diff.archives) {
      await archiveEntity(connection, input.record.workspaceId, entity.kind, entity.id, entity.fields, () => {
        schemaHolds.push({ notionPageId: entity.pageId, kind: entity.kind, reason: "SCHEMA_REJECT" });
      });
    }
    for (const settlement of diff.settlementInserts) {
      await guarded(connection, `
        INSERT INTO cwos_settlements (id, workspace_id, financial_item_id, direction, amount_krw, settled_at, account_or_card, evidence_ref)
        SELECT $1, $2::uuid, $3, $4, $5, $6::date, 'notion-import', $7
         WHERE NOT EXISTS (
           SELECT 1 FROM cwos_settlements existing
            WHERE existing.workspace_id = $2::uuid AND existing.financial_item_id = $3
         )`, [
        settlement.id, input.record.workspaceId, settlement.financialItemId, settlement.direction,
        settlement.amountKrw, settlement.settledAt, `notion://${settlement.notionPageId}`,
      ], () => schemaHolds.push({ notionPageId: settlement.notionPageId, kind: "settlement", reason: "SCHEMA_REJECT" }));
    }
    const mergedHolds = [...built.holds, ...diff.holds, ...schemaHolds];
    for (const hold of mergedHolds) {
      await guarded(connection, `
        INSERT INTO cwos_notion_sync_holds (id, workspace_id, notion_page_id, kind, reason, plan_hash, created_at)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
        ON CONFLICT (workspace_id, notion_page_id, reason) DO NOTHING`, [
        `hold-${notionCwosHash({ workspaceId: input.record.workspaceId, page: hold.notionPageId, reason: hold.reason }).slice(-8)}`,
        input.record.workspaceId, hold.notionPageId, hold.kind, hold.reason, input.record.planHash, appliedAt,
      ], () => undefined);
    }
    const summary = reportOf(diff, [...built.holds, ...schemaHolds], { alreadyApplied: false, dryRun: false });
    await connection.query(
      `INSERT INTO cwos_notion_sync_runs (id, workspace_id, plan_hash, snapshot_sha256, status, applied_at, report)
       VALUES ($1, $2::uuid, $3, $4, 'applied', $5::timestamptz, $6::jsonb)`,
      [
        `notion-sync-${notionCwosHash({ workspaceId: input.record.workspaceId, planHash: input.record.planHash }).slice(-8)}`,
        input.record.workspaceId, input.record.planHash, input.snapshotSha256, appliedAt, JSON.stringify(summary),
      ],
    );
    if (input.injectFailureAfterMarker) await input.injectFailureAfterMarker();
    await connection.query("COMMIT");
    committed = true;
    return summary;
  } catch (error) {
    if (!committed) await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
