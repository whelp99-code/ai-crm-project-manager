import { CustomerWorkOsV2Error } from "@ai-crm/domain/customer-work-os-v2";
import type { V2PgQueryable } from "./customer-work-os-v2-runtime.js";

export interface NormalizedBusinessProjection {
  readonly workspaceId: string;
  readonly planId: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly planHash: string;
  readonly sourceObservedAt: string;
  readonly planVersion: number;
  readonly authority: "ARCHIVE_PROJECTION_ONLY";
  readonly accounts: readonly Record<string, unknown>[];
  readonly engagements: readonly Record<string, unknown>[];
  readonly financialItems: readonly Record<string, unknown>[];
}

/** Read existing normalized business rows, not a second ledger or Notion fallback. */
export async function readNormalizedBusinessProjection(
  pool: V2PgQueryable,
  workspaceId: string,
  planId: string,
): Promise<NormalizedBusinessProjection> {
  if (!pool.withWorkspaceScope) {
    throw new CustomerWorkOsV2Error("PG_SCOPE_REQUIRED", "normalized projection requires workspace-scoped PG");
  }
  return pool.withWorkspaceScope(workspaceId, async (db) => {
    // One statement observes the plan and its normalized rows at the same PG snapshot.
    const result = await db.query<{
      id: string; snapshot_id: string; snapshot_hash: string; plan_hash: string;
      captured_at: string | Date; version: number; status: string;
      accounts: Record<string, unknown>[]; engagements: Record<string, unknown>[];
      financial_items: Record<string, unknown>[];
    }>(`
      SELECT p.id,p.snapshot_id,p.snapshot_hash,p.plan_hash,p.captured_at,p.version,p.status,
        COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
          FROM cwos_accounts a WHERE a.workspace_id=p.workspace_id
          AND a.id IN (SELECT item->>'id' FROM jsonb_array_elements(p.plan->'accounts') item)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.plan->'quarantined') q
            WHERE q->>'sourceId'=a.id OR q->>'sourceId'=a.source_ref
              OR 'notion://'||(q->>'sourceId')=a.source_ref)), '[]'::jsonb) AS accounts,
        COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
          FROM cwos_engagements e WHERE e.workspace_id=p.workspace_id
          AND e.id IN (SELECT item->>'id' FROM jsonb_array_elements(p.plan->'engagements') item)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.plan->'quarantined') q
            WHERE q->>'sourceId'=e.id)), '[]'::jsonb) AS engagements,
        COALESCE((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object(
            'net_amount_krw',f.net_amount_krw::text,
            'vat_amount_krw',f.vat_amount_krw::text,
            'gross_amount_krw',f.gross_amount_krw::text) ORDER BY f.id)
          FROM cwos_financial_items f WHERE f.workspace_id=p.workspace_id
          AND f.id IN (SELECT item->>'id' FROM jsonb_array_elements(p.plan->'financialItems') item)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.plan->'quarantined') q
            WHERE q->>'sourceId'=f.id OR q->>'sourceId'=f.evidence_ref
              OR 'notion://'||(q->>'sourceId')=f.evidence_ref)), '[]'::jsonb) AS financial_items
      FROM cwos_notion_import_plans p WHERE p.workspace_id=$1 AND p.id=$2
    `, [workspaceId, planId]);
    const row = result.rows[0];
    if (!row) throw new CustomerWorkOsV2Error("NORMALIZED_PLAN_NOT_FOUND", "normalized source plan not found");
    if (row.status !== "APPLIED") {
      throw new CustomerWorkOsV2Error("NORMALIZED_PLAN_NOT_APPLIED", "normalized source plan is not applied");
    }
    return {
      workspaceId, planId: row.id, snapshotId: row.snapshot_id,
      snapshotHash: row.snapshot_hash, planHash: row.plan_hash,
      sourceObservedAt: new Date(row.captured_at).toISOString(), planVersion: row.version,
      authority: "ARCHIVE_PROJECTION_ONLY",
      accounts: row.accounts, engagements: row.engagements, financialItems: row.financial_items,
    };
  });
}
