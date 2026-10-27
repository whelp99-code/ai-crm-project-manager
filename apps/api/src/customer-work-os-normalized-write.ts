import type { CustomerWorkOsState } from "@ai-crm/domain/customer-work-os";
import type { SnapshotTransaction } from "./customer-work-os-runtime.js";

export interface NormalizedWriteOptions {
  excludeSourceIds?: ReadonlySet<string>;
}

const NOTION_PREFIX = "notion://";

function excluded(id: string, refs: Array<string | undefined>, exclude: ReadonlySet<string>): boolean {
  if (exclude.has(id)) return true;
  return refs.some((ref) => {
    if (!ref) return false;
    if (exclude.has(ref)) return true;
    return ref.startsWith(NOTION_PREFIX) && exclude.has(ref.slice(NOTION_PREFIX.length));
  });
}

function placeholders(columns: readonly string[]): string {
  return columns.map((column, index) => {
    const slot = `$${index + 1}`;
    if (column === "workspace_id") return `${slot}::uuid`;
    if (column === "kinds" || column === "metadata") return `${slot}::jsonb`;
    if (column === "occurred_at" || column === "due_at" || column === "sent_at" || column === "accepted_at") return `${slot}::timestamptz`;
    return slot;
  }).join(", ");
}

async function insertIgnoringConflict(
  connection: SnapshotTransaction,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
): Promise<void> {
  await connection.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders(columns)}) ON CONFLICT (id) DO NOTHING`,
    values,
  );
}

async function insertSettlementIfAbsent(
  connection: SnapshotTransaction,
  columns: readonly string[],
  values: readonly unknown[],
): Promise<void> {
  await connection.query(
    `INSERT INTO cwos_settlements (${columns.join(", ")})
     SELECT ${placeholders(columns)}
      WHERE NOT EXISTS (
        SELECT 1 FROM cwos_settlements existing
         WHERE existing.id = $1 AND existing.workspace_id = $2::uuid
      )`,
    values,
  );
}

export async function writeNormalizedCustomerWorkState(
  connection: SnapshotTransaction,
  state: CustomerWorkOsState,
  options: NormalizedWriteOptions = {},
): Promise<void> {
  const exclude = options.excludeSourceIds ?? new Set<string>();
  const skippedFinancial = new Set<string>();

  for (const item of state.accounts) {
    if (excluded(item.id, [item.sourceRef], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_accounts", [
      "id", "workspace_id", "name", "normalized_name", "kinds", "status", "version", "source_ref",
    ], [item.id, item.workspaceId, item.name, item.normalizedName, JSON.stringify(item.kinds), item.status, item.version, item.sourceRef ?? null]);
  }

  for (const item of state.contacts) {
    if (excluded(item.id, [], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_contacts", [
      "id", "workspace_id", "account_id", "name", "title", "email", "phone", "stakeholder_role", "version",
    ], [item.id, item.workspaceId, item.accountId, item.name, item.title ?? null, item.email ?? null, item.phone ?? null, item.stakeholderRole ?? null, item.version]);
  }

  for (const item of state.engagements) {
    if (excluded(item.id, [], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_engagements", [
      "id", "workspace_id", "project_key", "name", "engagement_type", "stage", "health", "owner_principal_id",
      "start_date", "target_date", "won_quote_id", "contract_id", "delivery_project_id", "terminal_reason", "version",
    ], [
      item.id, item.workspaceId, item.projectKey, item.name, item.type, item.stage, item.health, item.ownerPrincipalId,
      item.startDate ?? null, item.targetDate ?? null, item.wonQuoteId ?? null, item.contractId ?? null,
      item.deliveryProjectId ?? null, item.terminalReason ?? null, item.version,
    ]);
  }

  for (const item of state.parties) {
    if (excluded(item.id, [], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_engagement_parties", [
      "id", "workspace_id", "engagement_id", "account_id", "role", "is_primary", "commercial_responsibility", "delivery_responsibility",
    ], [item.id, item.workspaceId, item.engagementId, item.accountId, item.role, item.primary, item.commercialResponsibility, item.deliveryResponsibility]);
  }

  for (const item of state.activities) {
    if (excluded(item.id, [item.evidenceRef, item.sourceUri], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_activities", [
      "id", "workspace_id", "engagement_id", "account_id", "activity_type", "occurred_at", "summary", "source_uri", "evidence_ref", "ai_confidence", "human_reviewed",
    ], [
      item.id, item.workspaceId, item.engagementId, item.accountId ?? null, item.type, item.occurredAt, item.summary,
      item.sourceUri ?? null, item.evidenceRef ?? null, item.aiConfidence ?? null, item.humanReviewed,
    ]);
  }

  for (const item of state.commitments) {
    if (excluded(item.id, [item.completionEvidenceRef], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_commitments", [
      "id", "workspace_id", "engagement_id", "source_activity_id", "owner_principal_id", "counterparty_account_id",
      "description", "due_at", "status", "priority", "financial_impact", "approval_required", "completion_evidence_ref", "version",
    ], [
      item.id, item.workspaceId, item.engagementId, item.sourceActivityId ?? null, item.ownerPrincipalId,
      item.counterpartyAccountId ?? null, item.description, item.dueAt, item.status, item.priority,
      item.financialImpact, item.approvalRequired, item.completionEvidenceRef ?? null, item.version,
    ]);
  }

  for (const item of state.artifacts ?? []) {
    if (excluded(item.id, [item.storageUri], exclude)) continue;
    await insertIgnoringConflict(connection, "cwos_artifacts", [
      "id", "workspace_id", "engagement_id", "account_id", "artifact_type", "title", "version_label", "status",
      "storage_uri", "content_hash", "source_activity_id", "supersedes_artifact_id", "effective_date",
      "approved_by_principal_id", "sent_at", "accepted_at", "metadata", "version",
    ], [
      item.id, item.workspaceId, item.engagementId, item.accountId ?? null, item.type, item.title, item.versionLabel, item.status,
      item.storageUri, item.contentHash ?? null, item.sourceActivityId ?? null, item.supersedesArtifactId ?? null,
      item.effectiveDate ?? null, item.approvedByPrincipalId ?? null, item.sentAt ?? null, item.acceptedAt ?? null,
      JSON.stringify(item.metadata), item.version,
    ]);
  }

  for (const item of state.financialItems) {
    if (excluded(item.id, [item.evidenceRef], exclude)) {
      skippedFinancial.add(item.id);
      continue;
    }
    await insertIgnoringConflict(connection, "cwos_financial_items", [
      "id", "workspace_id", "engagement_id", "account_id", "direction", "category", "lifecycle",
      "net_amount_krw", "vat_amount_krw", "gross_amount_krw", "expected_date", "contractual_due_date",
      "source_artifact_id", "source_purchase_order_id", "revision", "evidence_ref",
    ], [
      item.id, item.workspaceId, item.engagementId, item.accountId, item.direction, item.category, item.lifecycle,
      item.netAmountKrw, item.vatAmountKrw, item.grossAmountKrw, item.expectedDate, item.contractualDueDate ?? null,
      item.sourceArtifactId ?? null, item.sourcePurchaseOrderId ?? null, item.revision, item.evidenceRef ?? null,
    ]);
  }

  for (const item of state.settlements) {
    if (skippedFinancial.has(item.financialItemId) || excluded(item.id, [item.evidenceRef], exclude)) continue;
    await insertSettlementIfAbsent(connection, [
      "id", "workspace_id", "financial_item_id", "direction", "amount_krw", "settled_at", "account_or_card", "evidence_ref", "reversal_of_settlement_id",
    ], [
      item.id, item.workspaceId, item.financialItemId, item.direction, item.amountKrw, item.settledAt,
      item.accountOrCard, item.evidenceRef, item.reversalOfSettlementId ?? null,
    ]);
  }
}
