import {
  CustomerWorkOsError,
  type ApprovalReceipt,
  type CustomerWorkOsService,
  type CustomerWorkOsState,
} from "@ai-crm/domain/customer-work-os";
import {
  NOTION_CWOS_WORKSPACE_NAMESPACE,
  NotionCwosImportPlanner,
  notionArtifactIdentity,
  notionCwosHash,
  resolveNotionWorkspaceId,
  type NotionCwosImportPlan,
  type NotionCwosSnapshot,
} from "@ai-crm/imports";
import {
  CustomerWorkOsRuntimeManager,
  type SnapshotTransaction,
} from "./customer-work-os-runtime.js";
import { writeNormalizedCustomerWorkState } from "./customer-work-os-normalized-write.js";

export interface NotionPlanRecord {
  id: string;
  workspaceId: string;
  snapshotId: string;
  snapshotHash: string;
  planHash: string;
  capturedAt: string;
  plan: NotionCwosImportPlan;
  status: "PLANNED" | "APPROVED" | "APPLIED" | "REJECTED";
  createdByPrincipalId: string;
  approvedByPrincipalId?: string;
  appliedByPrincipalId?: string;
  createdAt: string;
  approvedAt?: string;
  appliedAt?: string;
  version: number;
  workspaceBinding?: NotionCwosImportPlan["workspaceBinding"];
}

export interface NotionPlanStore {
  create(record: NotionPlanRecord): Promise<NotionPlanRecord>;
  get(workspaceId: string, planId: string): Promise<NotionPlanRecord | undefined>;
  list(workspaceId: string): Promise<NotionPlanRecord[]>;
  compareAndSwap(workspaceId: string, planId: string, expectedVersion: number, next: NotionPlanRecord, reason: string): Promise<NotionPlanRecord>;
  markAppliedInTransaction?(connection: SnapshotTransaction | undefined, workspaceId: string, planId: string, expectedVersion: number, principalId: string, reason: string, appliedAt: string): Promise<NotionPlanRecord>;
  close?(): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryNotionPlanStore implements NotionPlanStore {
  private readonly rows = new Map<string, NotionPlanRecord>();
  private readonly snapshotHashes = new Map<string, string>();

  async create(record: NotionPlanRecord): Promise<NotionPlanRecord> {
    const key = `${record.workspaceId}\u0000${record.id}`;
    const digestKey = `${record.workspaceId}\u0000${record.snapshotHash}`;
    const existingId = this.snapshotHashes.get(digestKey);
    if (existingId) return copy(this.rows.get(`${record.workspaceId}\u0000${existingId}`)!);
    if (this.rows.has(key)) throw new CustomerWorkOsError("DUPLICATE_ID", `Notion plan exists: ${record.id}`);
    this.rows.set(key, copy(record));
    this.snapshotHashes.set(digestKey, record.id);
    return copy(record);
  }

  async get(workspaceId: string, planId: string): Promise<NotionPlanRecord | undefined> {
    const row = this.rows.get(`${workspaceId}\u0000${planId}`);
    return row ? copy(row) : undefined;
  }

  async list(workspaceId: string): Promise<NotionPlanRecord[]> {
    return [...this.rows.values()].filter((item) => item.workspaceId === workspaceId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(copy);
  }

  async compareAndSwap(workspaceId: string, planId: string, expectedVersion: number, next: NotionPlanRecord): Promise<NotionPlanRecord> {
    const key = `${workspaceId}\u0000${planId}`;
    const current = this.rows.get(key);
    if (!current) throw new CustomerWorkOsError("NOT_FOUND", `Notion plan not found: ${planId}`);
    if (current.version !== expectedVersion) throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", `expected version ${expectedVersion}, found ${current.version}`);
    if (next.workspaceId !== workspaceId || next.id !== planId || next.version !== expectedVersion + 1 || next.planHash !== current.planHash) throw new CustomerWorkOsError("INVALID_STATE", "invalid Notion plan CAS payload");
    this.rows.set(key, copy(next));
    return copy(next);
  }

  async markAppliedInTransaction(_connection: SnapshotTransaction | undefined, workspaceId: string, planId: string, expectedVersion: number, principalId: string, reason: string, appliedAt: string): Promise<NotionPlanRecord> {
    const current = await this.get(workspaceId, planId);
    if (!current) throw new CustomerWorkOsError("NOT_FOUND", `Notion plan not found: ${planId}`);
    if (current.status === "APPLIED") return current;
    if (current.version !== expectedVersion || current.status !== "APPROVED") throw new CustomerWorkOsError("INVALID_STATE", "only the current APPROVED plan can be applied");
    void reason;
    return this.compareAndSwap(workspaceId, planId, expectedVersion, { ...current, status: "APPLIED", appliedByPrincipalId: principalId, appliedAt, version: expectedVersion + 1 });
  }
}

interface QueryResult<T> { rows: T[]; rowCount?: number | null }
interface SqlConnection {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}
interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

async function withWorkspace<T>(pool: SqlPool, workspaceId: string, operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

interface PlanRow {
  id: string;
  workspace_id: string;
  snapshot_id: string;
  snapshot_hash: string;
  plan_hash: string;
  captured_at: Date | string;
  plan: NotionCwosImportPlan;
  status: NotionPlanRecord["status"];
  created_by_principal_id: string;
  approved_by_principal_id: string | null;
  applied_by_principal_id: string | null;
  created_at: Date | string;
  approved_at: Date | string | null;
  applied_at: Date | string | null;
  version: number;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToPlan(row: PlanRow): NotionPlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    snapshotId: row.snapshot_id,
    snapshotHash: row.snapshot_hash,
    planHash: row.plan_hash,
    capturedAt: iso(row.captured_at),
    plan: copy(row.plan),
    status: row.status,
    createdByPrincipalId: row.created_by_principal_id,
    ...(row.approved_by_principal_id ? { approvedByPrincipalId: row.approved_by_principal_id } : {}),
    ...(row.applied_by_principal_id ? { appliedByPrincipalId: row.applied_by_principal_id } : {}),
    createdAt: iso(row.created_at),
    ...(row.approved_at ? { approvedAt: iso(row.approved_at) } : {}),
    ...(row.applied_at ? { appliedAt: iso(row.applied_at) } : {}),
    version: row.version,
    ...(row.plan.workspaceBinding ? { workspaceBinding: copy(row.plan.workspaceBinding) } : {}),
  };
}

const PLAN_COLUMNS = `id, workspace_id, snapshot_id, snapshot_hash, plan_hash,
  captured_at, plan, status, created_by_principal_id, approved_by_principal_id,
  applied_by_principal_id, created_at, approved_at, applied_at, version`;

export class PgNotionPlanStore implements NotionPlanStore {
  constructor(private readonly pool: SqlPool) {}

  async create(record: NotionPlanRecord): Promise<NotionPlanRecord> {
    return withWorkspace(this.pool, record.workspaceId, async (connection) => {
      const existing = await connection.query<PlanRow>(
        `SELECT ${PLAN_COLUMNS} FROM cwos_notion_import_plans
          WHERE workspace_id = $1 AND snapshot_hash = $2`,
        [record.workspaceId, record.snapshotHash],
      );
      if (existing.rows[0]) return rowToPlan(existing.rows[0]);
      const result = await connection.query<PlanRow>(
        `INSERT INTO cwos_notion_import_plans
          (id, workspace_id, snapshot_id, snapshot_hash, plan_hash, captured_at,
           plan, source_counts, imported_counts, finance_totals, quarantine_count,
           orphan_relation_count, duplicate_candidate_count, status, read_only_source,
           created_by_principal_id, created_at, version)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
                 $11,$12,$13,'PLANNED',true,$14,$15::timestamptz,1)
         RETURNING ${PLAN_COLUMNS}`,
        [record.id, record.workspaceId, record.snapshotId, record.snapshotHash,
         record.planHash, record.capturedAt, JSON.stringify(record.plan),
         JSON.stringify(record.plan.reconciliation.source), JSON.stringify(record.plan.reconciliation.imported),
         JSON.stringify(record.plan.reconciliation.finance), record.plan.reconciliation.quarantined,
         record.plan.reconciliation.orphanRelations, record.plan.reconciliation.duplicateCandidates,
         record.createdByPrincipalId, record.createdAt],
      );
      const row = result.rows[0];
      if (!row) throw new CustomerWorkOsError("PERSISTENCE_FAILED", "Notion plan was not inserted");
      await connection.query(
        `INSERT INTO cwos_notion_import_plan_events
          (workspace_id, plan_id, event_type, actor_principal_id, plan_hash, reason, occurred_at)
         VALUES ($1,$2,'PLANNED',$3,$4,'Read-only Notion snapshot planned',$5::timestamptz)`,
        [record.workspaceId, record.id, record.createdByPrincipalId, record.planHash, record.createdAt],
      );
      return rowToPlan(row);
    });
  }

  async get(workspaceId: string, planId: string): Promise<NotionPlanRecord | undefined> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = await connection.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM cwos_notion_import_plans WHERE workspace_id = $1 AND id = $2`, [workspaceId, planId]);
      return result.rows[0] ? rowToPlan(result.rows[0]) : undefined;
    });
  }

  async list(workspaceId: string): Promise<NotionPlanRecord[]> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = await connection.query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM cwos_notion_import_plans WHERE workspace_id = $1 ORDER BY created_at DESC, id`, [workspaceId]);
      return result.rows.map(rowToPlan);
    });
  }

  async compareAndSwap(workspaceId: string, planId: string, expectedVersion: number, next: NotionPlanRecord, reason: string): Promise<NotionPlanRecord> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = await connection.query<PlanRow>(
        `UPDATE cwos_notion_import_plans
            SET status = $4,
                approved_by_principal_id = $5,
                applied_by_principal_id = $6,
                approved_at = $7::timestamptz,
                applied_at = $8::timestamptz,
                version = version + 1
          WHERE workspace_id = $1 AND id = $2 AND version = $3
          RETURNING ${PLAN_COLUMNS}`,
        [workspaceId, planId, expectedVersion, next.status,
         next.approvedByPrincipalId ?? null, next.appliedByPrincipalId ?? null,
         next.approvedAt ?? null, next.appliedAt ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", "Notion plan changed concurrently");
      await connection.query(
        `INSERT INTO cwos_notion_import_plan_events
          (workspace_id, plan_id, event_type, actor_principal_id, plan_hash, reason, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
        [workspaceId, planId, next.status, next.appliedByPrincipalId ?? next.approvedByPrincipalId ?? next.createdByPrincipalId,
         next.planHash, reason, next.appliedAt ?? next.approvedAt ?? next.createdAt],
      );
      return rowToPlan(row);
    });
  }

  async markAppliedInTransaction(connection: SnapshotTransaction, workspaceId: string, planId: string, expectedVersion: number, principalId: string, reason: string, appliedAt: string): Promise<NotionPlanRecord> {
    const updated = await connection.query<PlanRow>(
      `UPDATE cwos_notion_import_plans
          SET status = 'APPLIED',
              applied_by_principal_id = $4,
              applied_at = $5::timestamptz,
              version = version + 1
        WHERE workspace_id = $1 AND id = $2 AND version = $3 AND status = 'APPROVED'
        RETURNING ${PLAN_COLUMNS}`,
      [workspaceId, planId, expectedVersion, principalId, appliedAt],
    );
    const row = updated.rows[0];
    if (!row) {
      const current = await connection.query<PlanRow>(
        `SELECT ${PLAN_COLUMNS} FROM cwos_notion_import_plans WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, planId],
      );
      const existing = current.rows[0];
      if (existing?.status === "APPLIED") return rowToPlan(existing);
      throw new CustomerWorkOsError("INVALID_STATE", "only the current APPROVED plan can be applied");
    }
    await connection.query(
      `INSERT INTO cwos_notion_import_plan_events
        (workspace_id, plan_id, event_type, actor_principal_id, plan_hash, reason, occurred_at)
       VALUES ($1,$2,'APPLIED',$3,$4,$5,$6::timestamptz)`,
      [workspaceId, planId, principalId, row.plan_hash, reason, appliedAt],
    );
    return rowToPlan(row);
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export class CustomerWorkOsNotionService {
  private readonly planner = new NotionCwosImportPlanner();
  constructor(private readonly store: NotionPlanStore, private readonly now: () => string = () => new Date().toISOString()) {}

  async plan(snapshot: NotionCwosSnapshot, principalId: string): Promise<NotionPlanRecord> {
    const resolved = resolveNotionWorkspaceId(snapshot.workspaceId);
    const boundSnapshot = resolved.rewritten ? { ...snapshot, workspaceId: resolved.workspaceId } : snapshot;
    const plan = this.planner.plan(boundSnapshot);
    const workspaceBinding = {
      algorithm: "uuidv5" as const,
      namespace: NOTION_CWOS_WORKSPACE_NAMESPACE,
      sourceWorkspaceKey: resolved.rewritten ? snapshot.workspaceId.trim() : resolved.workspaceId,
      workspaceId: resolved.workspaceId,
    };
    const record: NotionPlanRecord = {
      id: `notion-plan-${notionCwosHash({ workspaceId: resolved.workspaceId, snapshotHash: snapshot.snapshotHash }).slice(-8)}`,
      workspaceId: resolved.workspaceId,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      planHash: plan.planHash,
      capturedAt: snapshot.capturedAt,
      plan: { ...plan, workspaceBinding },
      workspaceBinding,
      status: "PLANNED",
      createdByPrincipalId: principalId,
      createdAt: this.now(),
      version: 1,
    };
    return this.store.create(record);
  }

  async approve(workspaceId: string, planId: string, expectedVersion: number, principalId: string, receipt: ApprovalReceipt, reason: string): Promise<NotionPlanRecord> {
    const current = await this.require(workspaceId, planId);
    if (current.version !== expectedVersion || current.status !== "PLANNED") throw new CustomerWorkOsError("INVALID_STATE", "only the current PLANNED version can be approved");
    if (receipt.status !== "CONSUMED" || receipt.workspaceId !== workspaceId || receipt.resourceType !== "import_plan" || receipt.resourceId !== planId || receipt.resourceVersion !== expectedVersion || receipt.action !== "NOTION_IMPORT_APPROVE" || receipt.payloadHash !== notionCwosHash({ planId, planHash: current.planHash, quarantine: current.plan.reconciliation.quarantined, orphanRelations: current.plan.reconciliation.orphanRelations, duplicateCandidates: current.plan.reconciliation.duplicateCandidates })) {
      throw new CustomerWorkOsError("STALE_APPROVAL", "Notion plan approval does not match the current reconciliation report");
    }
    const next: NotionPlanRecord = { ...current, status: "APPROVED", approvedByPrincipalId: principalId, approvedAt: this.now(), version: current.version + 1 };
    return this.store.compareAndSwap(workspaceId, planId, expectedVersion, next, reason);
  }

  async markApplied(workspaceId: string, planId: string, expectedVersion: number, principalId: string, reason: string): Promise<NotionPlanRecord> {
    const current = await this.require(workspaceId, planId);
    if (current.status === "APPLIED") return current;
    if (current.version !== expectedVersion || current.status !== "APPROVED") throw new CustomerWorkOsError("INVALID_STATE", "only the current APPROVED plan can be applied");
    const next: NotionPlanRecord = { ...current, status: "APPLIED", appliedByPrincipalId: principalId, appliedAt: this.now(), version: current.version + 1 };
    return this.store.compareAndSwap(workspaceId, planId, expectedVersion, next, reason);
  }

  get(workspaceId: string, planId: string): Promise<NotionPlanRecord | undefined> { return this.store.get(workspaceId, planId); }
  list(workspaceId: string): Promise<NotionPlanRecord[]> { return this.store.list(workspaceId); }

  async markAppliedInTransaction(connection: SnapshotTransaction | undefined, workspaceId: string, planId: string, expectedVersion: number, principalId: string, reason: string, appliedAt: string): Promise<NotionPlanRecord> {
    if (!this.store.markAppliedInTransaction) throw new CustomerWorkOsError("INVALID_STATE", "plan store cannot join an open transaction");
    return this.store.markAppliedInTransaction(connection, workspaceId, planId, expectedVersion, principalId, reason, appliedAt);
  }

  private async require(workspaceId: string, planId: string): Promise<NotionPlanRecord> {
    const current = await this.store.get(workspaceId, planId);
    if (!current) throw new CustomerWorkOsError("NOT_FOUND", `Notion plan not found: ${planId}`);
    return current;
  }
}

function importedEngagementType(stage: string): "opportunity" | "delivery" | "maintenance" {
  if (["DELIVERY", "ACCEPTANCE", "BILLING", "COLLECTION", "CLOSED"].includes(stage)) return "delivery";
  if (stage === "ON_HOLD") return "maintenance";
  return "opportunity";
}

export interface ApplyNotionPlanResult {
  alreadyApplied: boolean;
  accounts: number;
  contacts: number;
  engagements: number;
  parties: number;
  activities: number;
  commitments: number;
  artifacts: number;
  financialItems: number;
  settlements: number;
  quarantined: number;
}

export function applyNotionPlanToDomain(input: {
  service: CustomerWorkOsService;
  record: NotionPlanRecord;
  principalId: string;
  receipt: ApprovalReceipt;
}): ApplyNotionPlanResult {
  const { service, record, principalId, receipt } = input;
  const plan = record.plan;
  if (service.isImportPlanApplied(plan.planHash)) {
    return { alreadyApplied: true, accounts: 0, contacts: 0, engagements: 0, parties: 0, activities: 0, commitments: 0, artifacts: 0, financialItems: 0, settlements: 0, quarantined: plan.quarantined.length };
  }
  const accountIds = new Map(plan.accounts.map((item) => [item.legacySourceId, item.id]));
  const engagementIds = new Map(plan.engagements.map((item) => [item.legacySourceId, item.id]));
  let contacts = 0;
  let parties = 0;
  let commitments = 0;
  let artifacts = 0;
  let settlements = 0;

  for (const item of plan.accounts) {
    service.createAccount({ id: item.id, workspaceId: item.workspaceId, name: item.name, kinds: item.kinds as Array<"customer" | "partner" | "vendor" | "manufacturer" | "outsourcer" | "other">, status: item.status, sourceRef: item.sourceUrl ?? `notion://${item.legacySourceId}` });
    if (item.primaryContactName) {
      service.addContact({
        id: `contact-${notionCwosHash({ account: item.id, name: item.primaryContactName }).slice(-8)}`,
        workspaceId: item.workspaceId,
        accountId: item.id,
        name: item.primaryContactName,
        ...(item.primaryEmail ? { email: item.primaryEmail } : {}),
        ...(item.primaryPhone ? { phone: item.primaryPhone } : {}),
        roles: ["business"],
        relationship: "unknown",
      });
      contacts += 1;
    }
  }

  for (const item of plan.engagements) {
    service.createEngagement({
      id: item.id,
      workspaceId: item.workspaceId,
      projectKey: item.projectKey,
      name: item.name,
      type: importedEngagementType(item.stage),
      stage: item.stage as Parameters<CustomerWorkOsService["createEngagement"]>[0]["stage"],
      health: "normal",
      ownerPrincipalId: principalId,
      ...(item.startDate ? { startDate: item.startDate } : {}),
      ...(item.targetDate ? { targetDate: item.targetDate } : {}),
      ...(["LOST", "CANCELLED"].includes(item.stage) ? { terminalReason: "Imported terminal state from Notion" } : {}),
    });
    for (const party of item.parties) {
      const accountId = accountIds.get(party.accountSourceId)!;
      service.assignParty({ id: `party-${notionCwosHash({ engagement: item.id, accountId, role: party.role }).slice(-8)}`, workspaceId: item.workspaceId, engagementId: item.id, accountId, role: party.role, primary: party.primary, commercialResponsibility: party.commercialResponsibility, deliveryResponsibility: party.deliveryResponsibility });
      parties += 1;
    }
    if (item.nextAction && !["CLOSED", "LOST", "CANCELLED"].includes(item.stage)) {
      service.addCommitment({ id: `commitment-${notionCwosHash({ engagement: item.id, action: item.nextAction }).slice(-8)}`, workspaceId: item.workspaceId, engagementId: item.id, ownerPrincipalId: principalId, description: item.nextAction, dueAt: item.targetDate ?? null, status: "OPEN", priority: 50, financialImpact: false, approvalRequired: false });
      commitments += 1;
    }
    for (const [kind, refs] of Object.entries(item.artifactRefs)) {
      refs.forEach((storageUri, index) => {
        const identity = notionArtifactIdentity({ engagementId: item.id, pageId: item.legacySourceId, kind, storageUri });
        service.addArtifact({ id: identity.id, workspaceId: item.workspaceId, engagementId: item.id, type: kind === "quote" ? "customer_quote" : kind === "proposal" ? "proposal" : kind === "contract" ? "contract" : "completion_report", title: `${kind} imported from Notion`, versionLabel: `legacy-${index + 1}`, status: "REVIEW", storageUri, metadata: { legacySourceId: item.legacySourceId, provenance: item.provenance, importedFrom: "Notion" } });
        artifacts += 1;
      });
    }
  }

  for (const item of plan.activities) {
    const engagementId = item.projectSourceIds.map((source) => engagementIds.get(source)).find(Boolean);
    if (!engagementId) continue;
    service.recordActivity({ id: item.id, workspaceId: item.workspaceId, engagementId, type: item.activityType, occurredAt: item.occurredAt, summary: item.summary, ...(item.decision ? { decision: item.decision } : {}), evidenceRef: item.sourceUrl ?? `notion://${item.legacySourceId}`, humanReviewed: true });
  }

  for (const item of plan.financialItems) {
    if (!item.accountSourceId) throw new CustomerWorkOsError("IMPORT_ACCOUNT_REQUIRED", `financial item ${item.legacySourceId} has no account`);
    const engagementId = item.engagementSourceId ? engagementIds.get(item.engagementSourceId) ?? null : null;
    const accountId = accountIds.get(item.accountSourceId);
    if (!accountId) throw new CustomerWorkOsError("IMPORT_MAPPING_MISSING", `account mapping missing for ${item.accountSourceId}`);
    service.addFinancialItem({ id: item.id, workspaceId: item.workspaceId, engagementId, accountId, direction: item.direction, category: item.category as Parameters<CustomerWorkOsService["addFinancialItem"]>[0]["category"], lifecycle: item.lifecycle as Parameters<CustomerWorkOsService["addFinancialItem"]>[0]["lifecycle"], netAmountKrw: item.netAmountKrw, vatAmountKrw: item.vatAmountKrw, grossAmountKrw: item.grossAmountKrw, expectedDate: item.expectedDate ?? plan.capturedAt.slice(0, 10), revision: 1, evidenceRef: item.evidenceRefs[0] ?? item.sourceUrl ?? `notion://${item.legacySourceId}` });
    if (item.lifecycle === "SETTLED") {
      service.recordSettlement({ id: `settlement-${notionCwosHash(item.id).slice(-8)}`, workspaceId: item.workspaceId, financialItemId: item.id, direction: item.direction, amountKrw: item.grossAmountKrw, settledAt: item.actualDate ?? item.expectedDate ?? plan.capturedAt.slice(0, 10), accountOrCard: "notion-import", evidenceRef: item.evidenceRefs[0] ?? item.sourceUrl ?? `notion://${item.legacySourceId}` });
      settlements += 1;
    }
  }

  service.markImportPlanApplied(record.workspaceId, record.id, receipt.resourceVersion, record.planHash, receipt);
  return { alreadyApplied: false, accounts: plan.accounts.length, contacts, engagements: plan.engagements.length, parties, activities: plan.activities.length, commitments, artifacts, financialItems: plan.financialItems.length, settlements, quarantined: plan.quarantined.length };
}

export async function applyApprovedNotionPlan(input: {
  service: CustomerWorkOsNotionService;
  manager: CustomerWorkOsRuntimeManager;
  workspaceId: string;
  planId: string;
  expectedVersion: number;
  principalId: string;
  idempotencyKey: string;
  receipt: ApprovalReceipt;
  reason: string;
  now?: string;
  participate?: (connection: SnapshotTransaction) => Promise<void>;
}): Promise<{ replayed: boolean; payload: ApplyNotionPlanResult; plan: NotionPlanRecord }> {
  const current = await input.service.get(input.workspaceId, input.planId);
  if (!current || current.version !== input.expectedVersion || current.status !== "APPROVED") {
    throw new CustomerWorkOsError("INVALID_STATE", "only the current APPROVED plan can be applied");
  }
  const appliedAt = input.now ?? new Date().toISOString();
  const excludeSourceIds = new Set(current.plan.quarantined.map((row) => row.sourceId));
  let domain: CustomerWorkOsState | undefined;
  const result = await input.manager.mutate({
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    requestHash: current.planHash,
    operationId: "NOTION_IMPORT_APPLY",
    now: appliedAt,
    operation: (service) => {
      const payload = applyNotionPlanToDomain({
        service,
        record: current,
        principalId: input.principalId,
        receipt: input.receipt,
      });
      domain = service.exportState();
      return payload;
    },
    participate: async (connection) => {
      if (!domain) throw new CustomerWorkOsError("INVALID_STATE", "normalized write has no domain state");
      await writeNormalizedCustomerWorkState(connection, domain, { excludeSourceIds });
      await input.participate?.(connection);
      await input.service.markAppliedInTransaction(connection, input.workspaceId, input.planId, input.expectedVersion, input.principalId, input.reason, appliedAt);
    },
  });
  const plan = await input.service.get(input.workspaceId, input.planId);
  if (!plan) throw new CustomerWorkOsError("NOT_FOUND", `Notion plan not found: ${input.planId}`);
  return { replayed: result.replayed, payload: result.payload, plan };
}

export async function createPgNotionPlanStoreFromEnvironment(): Promise<PgNotionPlanStore | undefined> {
  const connectionString = process.env.CWOS_DATABASE_URL ?? process.env.AI_CRM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const module = await dynamicImport("pg");
  const Pool = module.Pool as new (options: { connectionString: string; max: number; application_name: string }) => SqlPool;
  if (!Pool) throw new CustomerWorkOsError("PG_DRIVER_UNAVAILABLE", "pg Pool export is unavailable");
  const max = Number(process.env.CWOS_NOTION_PG_POOL_MAX ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new CustomerWorkOsError("INVALID_CONFIG", "CWOS_NOTION_PG_POOL_MAX must be 1..10");
  return new PgNotionPlanStore(new Pool({ connectionString, max, application_name: "ai-crm-cwos-notion" }));
}
