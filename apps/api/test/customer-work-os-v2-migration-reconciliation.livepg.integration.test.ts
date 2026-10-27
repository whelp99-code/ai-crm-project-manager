import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { describe, it } from "vitest";
import { createApp } from "../src/app.js";
import { readNormalizedBusinessProjection } from "../src/customer-work-os-v2-normalized-projection.js";
import { reconcileNormalizedArchive } from "../src/customer-work-os-v2-migration-reconciliation.js";
import {
  CustomerWorkOsV2RuntimeManager, PgCwosV2StateStore, v2Hash,
  type V2PgQueryable,
} from "../src/customer-work-os-v2-runtime.js";

describe.skipIf(process.env.LIVE_PG_TEST !== "1")("R2 existing archive reconciliation", () => {
it("records exact source comparisons and honest residuals with native denial and preservation", async () => {
const run = promisify(execFile);
const name = `fp5_crm_qa_${randomUUID().replaceAll("-", "")}`;
const inspected = await run("docker", ["inspect", "--format", "{{json .Config.Env}}", "core5-crm-pilot-pg"]);
const containerEnv: unknown = JSON.parse(inspected.stdout);
assert(Array.isArray(containerEnv));
const settings = new Map<string, string>();
for (const item of containerEnv) {
  assert.equal(typeof item, "string");
  const at = item.indexOf("=");
  settings.set(item.slice(0, at), item.slice(at + 1));
}
const mapped = await run("docker", ["port", "core5-crm-pilot-pg", "5432/tcp"]);
const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapped.stdout)?.[1];
assert(port);
const user = settings.get("POSTGRES_USER");
const password = settings.get("POSTGRES_PASSWORD");
assert(user && password);
const config = { host: "127.0.0.1", port: Number(port), user, password };
const admin = new Pool({ ...config, database: "postgres" });
let created = false;
let pool: Pool | undefined;
let app: ReturnType<typeof createApp> | undefined;
let humanApp: ReturnType<typeof createApp> | undefined;
let peerApp: ReturnType<typeof createApp> | undefined;
const workspaceId = "b1111111-1111-4111-8111-111111111111";
const human = { workspaceId, principalId: "human-owner", kind: "human" as const, stepUpVerified: true };
const machine = { workspaceId, principalId: "ai-1", kind: "ai" as const };
const now = () => "2026-10-06T00:00:00.000Z";

try {
  // Clone the existing scratch schema/ACL, never an operational database or grant.
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ai_crm_dryrun_20260930`);
  created = true;
  const db = new Pool({ ...config, database: name });
  pool = db;
  const checked = await db.query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(checked.rows[0]?.name, name);
  await db.query("INSERT INTO workspaces(id,name) VALUES($1,'FP5 isolated QA') ON CONFLICT(id) DO NOTHING", [workspaceId]);
  const scoped: V2PgQueryable = {
    async query<T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
      const result = await db.query(sql, args ? [...args] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async withWorkspaceScope<T>(ws: string, action: (q: V2PgQueryable) => Promise<T>) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE ai_crm_runtime_api");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
        const q: V2PgQueryable = {
          async query<T2 = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
            const result = await client.query(sql, args ? [...args] : undefined);
            return { rows: result.rows as T2[], rowCount: result.rowCount };
          },
        };
        const result = await action(q);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
  const manager = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scoped), now);
  let state = await manager.read(workspaceId);
  // Existing cloned test rows may already contain the human bootstrap.
  for (const [command, key, payload, needed] of [
    ["identity.registerPrincipal", "fp5-human", { id: human.principalId, kind: "human", displayName: "Owner", active: true },
      !state.state.identity.principals.some(p => p.id === human.principalId)],
    ["identity.addMembership", "fp5-human-member", { id: "fp5-human-member", principalId: human.principalId },
      !state.state.identity.memberships.some(m => m.principalId === human.principalId)],
    ["identity.registerPrincipal", "fp5-ai", { id: machine.principalId, kind: "ai", displayName: "AI", active: true },
      !state.state.identity.principals.some(p => p.id === machine.principalId)],
    ["identity.addMembership", "fp5-ai-member", { id: "fp5-ai-member", principalId: machine.principalId },
      !state.state.identity.memberships.some(m => m.principalId === machine.principalId)],
  ] as const) {
    if (needed) {
      await manager.command({ workspaceId, actor: human, expectedVersion: state.version, idempotencyKey: key, command, payload });
      state = await manager.read(workspaceId);
    }
  }
  const key = "pilot-operator-key";
  app = createApp({
    authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2MachineBinding: machine, customerWorkOsV2NormalizedProjectionPool: scoped,
  });
  await app.ready();
  const headers = {
    "x-api-key": key, "x-workspace-id": workspaceId,
    "x-principal-id": machine.principalId, "x-principal-kind": machine.kind,
  };
  const plan = {
    workspaceId, snapshotId: "snap", snapshotHash: "sha256:fp5-isolated", planHash: "fnv1a32:fp5-isolated",
    capturedAt: now(), accounts: [
      { id: "fp5-precision-account" }, { id: "fp5-quarantined-account", legacySourceId: "fp5-quarantined-source" },
    ], engagements: [],
    financialItems: [{ id: "fp5-precision-item" }], quarantined: [{ sourceId: "fp5-quarantined-source" }],
  };
  // Explicit isolated consumer fixture; this is not an owner/company approval receipt.
  await db.query(`INSERT INTO cwos_accounts(id,workspace_id,name,normalized_name,kinds,status)
    VALUES('fp5-precision-account',$1,'Isolated precision fixture','isolated precision fixture','["customer"]','active')`, [workspaceId]);
  // A prior normalized row must not bypass the current source's quarantine.
  await db.query(`INSERT INTO cwos_accounts(id,workspace_id,name,normalized_name,kinds,status,source_ref)
    VALUES('fp5-quarantined-account',$1,'Excluded fixture','excluded fixture','["customer"]','active','notion://fp5-quarantined-source')`, [workspaceId]);
  await db.query(`INSERT INTO cwos_financial_items(id,workspace_id,account_id,direction,category,lifecycle,
    net_amount_krw,vat_amount_krw,gross_amount_krw,expected_date)
    VALUES('fp5-precision-item',$1,'fp5-precision-account','OUT','overhead','PLANNED',9007199254740993,0,9007199254740993,'2026-10-06')`, [workspaceId]);
  await db.query(`INSERT INTO cwos_notion_import_plans(id,workspace_id,snapshot_id,snapshot_hash,plan_hash,captured_at,
    plan,source_counts,imported_counts,finance_totals,quarantine_count,orphan_relation_count,duplicate_candidate_count,
    status,read_only_source,created_by_principal_id,approved_by_principal_id,applied_by_principal_id,approved_at,applied_at)
    VALUES('fp5-isolated-plan',$1,'snap','sha256:fp5-isolated','fnv1a32:fp5-isolated',$2,$3,'{}','{}','{}',1,0,0,
    'APPLIED',true,'human-owner','human-owner','human-owner',$2,$2)`, [workspaceId, now(), JSON.stringify(plan)]);
  const projection = await app.inject({
    method: "GET", url: "/api/cwos/v2/normalized-projections/fp5-isolated-plan", headers,
  });
  assert.equal(projection.statusCode, 200);
  const projected: unknown = projection.json();
  assert(projected && typeof projected === "object" && "authority" in projected && "financialItems" in projected);
  assert.equal(projected.authority, "ARCHIVE_PROJECTION_ONLY");
  assert("accounts" in projected && Array.isArray(projected.accounts));
  assert.deepEqual(projected.accounts.map(row => row.id), ["fp5-precision-account"]);
  assert(Array.isArray(projected.financialItems));
  assert.equal(projected.financialItems[0]?.net_amount_krw, "9007199254740993");
  assert.equal(projected.financialItems[0]?.direction, "OUT");
  assert.equal((await app.inject({
    method: "GET", url: "/api/cwos/v2/normalized-projections/fp5-isolated-plan",
    headers: { ...headers, "x-workspace-id": "f3333333-3333-4333-8333-333333333333" },
  })).statusCode, 403);
  humanApp = createApp({ authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2ActorBinding: human, customerWorkOsV2NormalizedProjectionPool: scoped });
  await humanApp.ready();
  const humanHeaders = { ...headers, "x-principal-id": human.principalId, "x-principal-kind": "human" };
  const reconciled = await humanApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": "fp5-native-reference" },
    payload: { command: "business.reconcileNormalized", expectedVersion: state.version, payload: { planId: "fp5-isolated-plan" } },
  });
  assert.equal(reconciled.statusCode, 200);
  const reconciliation = reconciled.json();
  assert.equal(reconciliation.result.approved, false);
  assert.equal(reconciliation.result.planVersion, 1);
  assert.deepEqual(reconciliation.result.accountIds, ["fp5-precision-account"]);
  assert.deepEqual(reconciliation.result.financialItemIds, ["fp5-precision-item"]);
  const producerState = await manager.read(workspaceId);
  assert.equal(producerState.version, state.version + 1);
  assert.equal(producerState.state.normalizedArchiveRefs?.length, 1);
  const reference = producerState.state.normalizedArchiveRefs?.[0]; assert(reference);
  const source = await readNormalizedBusinessProjection(scoped, workspaceId, "fp5-isolated-plan");
  const archiveBytes = Buffer.from(" \n" + JSON.stringify(plan) + "\n");
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const input = { archiveBytes, expectedArchiveSHA256: digest(archiveBytes), projection: source, reference,
    nativeVersion: producerState.version, expectedNativeVersion: producerState.version };
  const receipt = reconcileNormalizedArchive(input);
  assert.equal(receipt.records[0]?.archiveCount, 2);
  assert.equal(receipt.records[0]?.eligibleCount, 1);
  assert.equal(receipt.records[0]?.nativeReferenceCount, 1);
  assert.deepEqual(receipt.records[0]?.missingNormalized, []);
  assert.equal(receipt.relations[0]?.matched, true);
  assert.equal(receipt.money[0]?.fields[0]?.normalized, "9007199254740993");
  assert.equal(receipt.money[0]?.fields[1]?.normalized, "0");
  assert.equal(receipt.money[0]?.fields[0]?.archive, null);
  assert.equal(receipt.approved, false);
  assert.equal(receipt.businessMigrationComplete, false);
  assert(receipt.residuals.some(row => row.reason === "SOURCE_ACL_CONTRACT_MISSING"));
  assert(receipt.residuals.some(row => row.reason === "SOURCE_HISTORY_CONTRACT_MISSING"));
  const changedRelationBytes = Buffer.from(JSON.stringify({
    ...plan, financialItems: [{ id: "fp5-precision-item", accountSourceId: "fp5-quarantined-source" }],
  }));
  const changedRelation = reconcileNormalizedArchive({
    ...input, archiveBytes: changedRelationBytes, expectedArchiveSHA256: digest(changedRelationBytes),
  });
  const sourceRelation: Record<string, unknown> | undefined = changedRelation.relations[0];
  assert.equal(sourceRelation?.["matched"], true);
  assert.equal(sourceRelation?.["sourceTarget"], "fp5-quarantined-account");
  assert.equal(sourceRelation?.["sourceMatched"], false);
  assert(changedRelation.residuals.some(row => row.reason === "DIFF_accountSourceId"));
  const matchingProjection = {
    ...source, financialItems: source.financialItems.map(row => ({ ...row, account_id: "fp5-quarantined-account" })),
  };
  const matchingRelation = reconcileNormalizedArchive({
    ...input, archiveBytes: changedRelationBytes, expectedArchiveSHA256: digest(changedRelationBytes),
    projection: matchingProjection, reference: { ...reference, sourceDigest: v2Hash(matchingProjection) },
  });
  assert.equal(matchingRelation.relations[0]?.sourceMatched, true);
  assert.equal(matchingRelation.relations[0]?.matched, false);
  const unknownRelation: Record<string, unknown> | undefined = receipt.relations[0];
  assert.equal(unknownRelation?.["sourceMatched"], null);
  assert(receipt.residuals.some(row => row.reason === "SOURCE_accountSourceId_MISSING"));
  const unresolvedBytes = Buffer.from(JSON.stringify({
    ...plan, financialItems: [{ id: "fp5-precision-item", accountSourceId: "fp5-precision-account" }],
  }));
  const unresolved = reconcileNormalizedArchive({
    ...input, archiveBytes: unresolvedBytes, expectedArchiveSHA256: digest(unresolvedBytes),
  });
  assert.equal(unresolved.relations[0]?.sourceMatched, null);
  assert(unresolved.residuals.some(row => row.reason === "SOURCE_accountSourceId_UNRESOLVED"));
  assert.throws(() => reconcileNormalizedArchive({ ...input, expectedArchiveSHA256: "f".repeat(64) }), { code: "ARCHIVE_SOURCE_MISMATCH" });
  assert.throws(() => reconcileNormalizedArchive({ ...input, expectedNativeVersion: 0 }), { code: "VERSION_CONFLICT" });
  assert.throws(() => reconcileNormalizedArchive({ ...input, reference: { ...reference, workspaceId: "f3333333-3333-4333-8333-333333333333" } }), { code: "WORKSPACE_MISMATCH" });
  const firstAccount = plan.accounts[0]; assert(firstAccount);
  const duplicateBytes = Buffer.from(JSON.stringify({ ...plan, accounts: [...plan.accounts, firstAccount], quarantined: [] }));
  const diff = reconcileNormalizedArchive({ ...input, archiveBytes: duplicateBytes, expectedArchiveSHA256: digest(duplicateBytes) });
  assert.deepEqual(diff.records[0]?.duplicates, ["fp5-precision-account"]);
  assert.deepEqual(diff.records[0]?.missingNormalized, ["fp5-quarantined-account"]);
  const nativeBefore = await manager.read(workspaceId);
  const rowsBefore = (await db.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows;
  const eventsBefore = (await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId])).rows;
  assert.deepEqual(reconcileNormalizedArchive(input), receipt);
  const reopened = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scoped), now);
  assert.deepEqual(await reopened.read(workspaceId), nativeBefore);
  assert.deepEqual((await db.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, rowsBefore);
  assert.deepEqual((await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId])).rows, eventsBefore);
  assert.deepEqual(archiveBytes, Buffer.from(" \n" + JSON.stringify(plan) + "\n"));
  console.log(JSON.stringify({ level: "R2_LOCAL_ONLY", database: name, receipt,
    denialCases: 4, duplicateAndMissingDiagnostic: diff.records[0], sourceBytes: "unchanged",
    nativeSnapshot: "unchanged", nativeAuditHistory: "unchanged", financialRows: "unchanged",
    sourceACLHistory: "missing contract, not invented", restart: "unchanged" }, null, 2));
} finally {
  await peerApp?.close();
  await humanApp?.close();
  await app?.close();
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
  console.log("FP5_CRM_R2_LOCAL_CLEANUP_OK");
}
}, 60_000);
});
