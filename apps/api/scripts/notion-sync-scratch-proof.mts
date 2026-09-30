/**
 * Scratch-only proof for syncApprovedNotionPlan.
 * Requires NOTION_SYNC_SCRATCH_URL pointing at a non-ai_crm database.
 * Does not write Notion. Refuses database name ai_crm.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { installPgDateStringParser } from "../src/pg-date-types.ts";
import { NotionCwosImportPlanner, resolveNotionWorkspaceId, type NotionCwosSnapshot } from "@ai-crm/imports";
import { syncApprovedNotionPlan } from "../src/customer-work-os-notion-sync.js";
import type { NotionPlanRecord } from "../src/customer-work-os-notion.js";

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error("usage: notion-sync-scratch-proof.mts <snapshot.json>");
const connectionString = process.env.NOTION_SYNC_SCRATCH_URL;
if (!connectionString) throw new Error("NOTION_SYNC_SCRATCH_URL is required");
if (new URL(connectionString).pathname === "/ai_crm") throw new Error("refusing ai_crm");

const planner = new NotionCwosImportPlanner();
installPgDateStringParser(pg);
const pool = new pg.Pool({ connectionString, max: 1, application_name: "notion-sync-scratch-proof" });

function recordFrom(snapshot: NotionCwosSnapshot): NotionPlanRecord {
  const resolved = resolveNotionWorkspaceId(snapshot.workspaceId);
  const bound = resolved.rewritten ? { ...snapshot, workspaceId: resolved.workspaceId } : snapshot;
  const plan = planner.plan(bound);
  return {
    id: `notion-plan-${plan.planHash.slice(-8)}`,
    workspaceId: resolved.workspaceId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    planHash: plan.planHash,
    capturedAt: snapshot.capturedAt,
    plan,
    status: "APPROVED",
    createdByPrincipalId: "notion-sync-proof",
    approvedByPrincipalId: "notion-sync-proof",
    createdAt: snapshot.capturedAt,
    approvedAt: snapshot.capturedAt,
    version: 2,
  };
}

async function counts(workspaceId: string) {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.workspace_id', $1, false)", [workspaceId]);
    const result = await client.query(`
      SELECT
        (SELECT count(*) FROM cwos_accounts WHERE workspace_id = $1::uuid) AS accounts,
        (SELECT count(*) FROM cwos_accounts WHERE workspace_id = $1::uuid AND archived_at IS NOT NULL) AS accounts_archived,
        (SELECT count(*) FROM cwos_activities WHERE workspace_id = $1::uuid) AS activities,
        (SELECT count(*) FROM cwos_activities WHERE workspace_id = $1::uuid AND archived_at IS NOT NULL) AS activities_archived,
        (SELECT count(*) FROM cwos_settlements WHERE workspace_id = $1::uuid) AS settlements,
        (SELECT coalesce(sum(amount_krw), 0) FROM cwos_settlements WHERE workspace_id = $1::uuid) AS settlement_sum,
        (SELECT count(*) FROM cwos_notion_sync_runs WHERE workspace_id = $1::uuid) AS runs,
        (SELECT count(*) FROM cwos_notion_sync_holds WHERE workspace_id = $1::uuid) AS holds
    `, [workspaceId]);
    return result.rows[0];
  } finally {
    client.release();
  }
}

function mutate(snapshot: NotionCwosSnapshot) {
  const next = structuredClone(snapshot) as NotionCwosSnapshot;
  const template = next.accounts[0];
  if (!template) throw new Error("snapshot has no account to clone");
  next.accounts.push({
    ...template,
    sourceId: "synthetic-page-add-1",
    sourceUrl: "notion://synthetic-page-add-1",
    properties: { ...template.properties, "회사/조직명": "합성 추가 계정" },
  });
  const project = next.projects[0];
  if (!project) throw new Error("snapshot has no project");
  const titleKey = "프로젝트명(Title)";
  project.properties[titleKey] = `${String(project.properties[titleKey] ?? "프로젝트")} 변경`;
  const removed = next.activities.shift();
  if (!removed) throw new Error("snapshot has no activity to remove");
  const resolved = resolveNotionWorkspaceId(snapshot.workspaceId);
  const planned = planner.plan(resolved.rewritten ? { ...snapshot, workspaceId: resolved.workspaceId } : snapshot);
  const settled = planned.financialItems.find((item) => item.lifecycle === "SETTLED" && BigInt(item.grossAmountKrw) > 0n);
  if (!settled) throw new Error("snapshot plan has no settled financial item");
  const finance = next.finance.find((row) => row.sourceId === settled.legacySourceId);
  if (!finance) throw new Error("settled financial item is missing from the snapshot");
  const gross = Number(finance.properties["합계"] ?? settled.grossAmountKrw);
  const net = Number(finance.properties["금액"] ?? settled.netAmountKrw);
  finance.properties["합계"] = gross + 1000;
  finance.properties["금액"] = net + 1000;
  next.snapshotId = `${snapshot.snapshotId}-synthetic`;
  next.snapshotHash = `${snapshot.snapshotHash}-synthetic`;
  return { next, removedActivityId: removed.sourceId, changedProjectId: project.sourceId, changedFinanceId: finance.sourceId, addedAccountId: "synthetic-page-add-1" };
}

async function main() {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as NotionCwosSnapshot;
  const first = recordFrom(snapshot);
  await pool.query("INSERT INTO workspaces (id, name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING", [first.workspaceId, "notion-sync-scratch"]);
  const applied = await syncApprovedNotionPlan({
    pool, record: first, principalId: "notion-sync-proof", snapshotSha256: snapshot.snapshotHash,
  });
  const afterFirst = await counts(first.workspaceId);
  const unchangedSnapshot = {
    ...snapshot,
    snapshotId: `${snapshot.snapshotId}-unchanged`,
    snapshotHash: `${snapshot.snapshotHash}-unchanged`,
  };
  const unchanged = await syncApprovedNotionPlan({
    pool,
    record: recordFrom(unchangedSnapshot),
    principalId: "notion-sync-proof",
    snapshotSha256: unchangedSnapshot.snapshotHash,
  });
  const afterUnchanged = await counts(first.workspaceId);
  const versionClient = await pool.connect();
  const versions = await versionClient.query(
    `SELECT max(version) AS max_version, count(*) FILTER (WHERE version > 1) AS bumped
       FROM cwos_engagements WHERE workspace_id = $1::uuid`,
    [first.workspaceId],
  );
  versionClient.release();
  const synthetic = mutate(snapshot);
  const second = recordFrom(synthetic.next);
  const changed = await syncApprovedNotionPlan({
    pool, record: second, principalId: "notion-sync-proof", snapshotSha256: synthetic.next.snapshotHash,
  });
  const afterSecond = await counts(first.workspaceId);
  const rerun = await syncApprovedNotionPlan({
    pool, record: second, principalId: "notion-sync-proof", snapshotSha256: synthetic.next.snapshotHash,
  });
  const afterRerun = await counts(first.workspaceId);
  const client = await pool.connect();
  const detail = await client.query(
    `SELECT
       (SELECT name FROM cwos_accounts WHERE workspace_id = $1::uuid AND notion_page_id = $2) AS added_name,
       (SELECT archived_at IS NOT NULL FROM cwos_activities WHERE workspace_id = $1::uuid AND notion_page_id = $3) AS activity_archived,
       (SELECT name FROM cwos_engagements WHERE workspace_id = $1::uuid AND notion_page_id = $4) AS project_name,
       (SELECT count(*) FROM cwos_notion_sync_holds WHERE workspace_id = $1::uuid AND notion_page_id = $5 AND reason = 'AMOUNT_OR_DIRECTION') AS amount_holds,
       (SELECT amount_krw FROM cwos_settlements s JOIN cwos_financial_items f ON f.id = s.financial_item_id AND f.workspace_id = s.workspace_id WHERE f.workspace_id = $1::uuid AND f.notion_page_id = $5 LIMIT 1) AS settlement_amount,
       (SELECT gross_amount_krw FROM cwos_financial_items WHERE workspace_id = $1::uuid AND notion_page_id = $5) AS finance_gross`,
    [first.workspaceId, synthetic.addedAccountId, synthetic.removedActivityId, synthetic.changedProjectId, synthetic.changedFinanceId],
  );
  client.release();
  let injected = "not-run";
  const boom = recordFrom({ ...snapshot, snapshotId: `${snapshot.snapshotId}-boom`, snapshotHash: `${snapshot.snapshotHash}-boom` });
  try {
    await syncApprovedNotionPlan({
      pool, record: boom, principalId: "notion-sync-proof", snapshotSha256: boom.snapshotHash,
      injectFailureAfterMarker: async () => { throw new Error("injected"); },
    });
  } catch (error) {
    injected = error instanceof Error ? error.message : "thrown";
  }
  const afterInject = await counts(first.workspaceId);
  const proof = {
    workspaceId: first.workspaceId,
    first: applied,
    afterFirst,
    unchanged,
    afterUnchanged,
    versionsAfterUnchanged: versions.rows[0],
    changed,
    afterSecond,
    rerun,
    afterRerun,
    detail: detail.rows[0],
    injected,
    afterInject,
    markers: { removed: synthetic.removedActivityId, finance: synthetic.changedFinanceId, project: synthetic.changedProjectId },
  };
  console.log(JSON.stringify(proof, null, 2));
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
