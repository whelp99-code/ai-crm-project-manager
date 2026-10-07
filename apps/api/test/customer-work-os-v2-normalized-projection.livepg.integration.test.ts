import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { describe, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  CustomerWorkOsV2RuntimeManager, PgCwosV2StateStore,
  type V2PgQueryable,
} from "../src/customer-work-os-v2-runtime.js";

describe.skipIf(process.env.LIVE_PG_TEST !== "1")("FP5 isolated maintained v2 normalized projection", () => {
it("preserves exact archive data and denies authority escalation with atomic CAS/audit", async () => {
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
let readOnlyApp: ReturnType<typeof createApp> | undefined;
let noStepUpApp: ReturnType<typeof createApp> | undefined;
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
  const key = "pilot-operator-key";
  const humanHeaders = {
    "x-api-key": key, "x-workspace-id": workspaceId,
    "x-principal-id": human.principalId, "x-principal-kind": human.kind,
  };
  humanApp = createApp({
    authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2ActorBinding: human, customerWorkOsV2NormalizedProjectionPool: scoped,
  });
  await humanApp.ready();
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
      assert.equal((await humanApp.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...humanHeaders, "idempotency-key": key },
        payload: { command, expectedVersion: state.version, payload },
      })).statusCode, 200);
      state = await manager.read(workspaceId);
    }
  }
  const provisioning = {
    command: "admin.provision", expectedVersion: state.version,
    payload: { id: workspaceId, name: "FP5 isolated QA", quotaUsers: 1,
      quotaStorageMb: 1, retentionDays: 1, templateVersion: "ISOLATED_ONLY" },
  };
  noStepUpApp = createApp({
    authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2ActorBinding: { ...human, stepUpVerified: false },
  });
  await noStepUpApp.ready();
  const noStepUp = await noStepUpApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": workspaceId }, payload: provisioning,
  });
  assert.equal(noStepUp.statusCode, 403);
  assert.equal(noStepUp.json().error, "STEP_UP_REQUIRED");
  assert.deepEqual(await manager.read(workspaceId), state);
  const provisioned = await humanApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": workspaceId }, payload: provisioning,
  });
  assert.equal(provisioned.statusCode, 200);
  state = await manager.read(workspaceId);
  const managedWorkspace = state.state.admin.workspaces.find(w => w.id === workspaceId);
  assert(managedWorkspace);
  assert.equal(managedWorkspace.workspaceId, workspaceId);
  assert.equal(managedWorkspace.status, "ACTIVE");
  assert.equal(managedWorkspace.version, 1);
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
  const beforeResponse = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
  assert.equal(beforeResponse.statusCode, 200);
  const before: unknown = beforeResponse.json();
  const auditBefore = await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId]);
  assert(state.state.identity.principals.some(p => p.id === machine.principalId && p.active && p.kind === machine.kind));
  assert(state.state.identity.memberships.some(m => m.principalId === machine.principalId && m.workspaceId === workspaceId && m.status === "ACTIVE"));
  readOnlyApp = createApp({
    authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2MachineBinding: { ...machine, readOnly: true },
    customerWorkOsV2NormalizedProjectionPool: scoped,
  });
  await readOnlyApp.ready();
  const financialBefore = await db.query("SELECT id,net_amount_krw,vat_amount_krw,gross_amount_krw FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
  const readerState = await readOnlyApp.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
  assert.equal(readerState.statusCode, 200);
  assert.deepEqual(readerState.json(), before);
  const readerReadiness = await readOnlyApp.inject({ method: "GET", url: "/api/cwos/v2/readiness", headers });
  assert.equal(readerReadiness.statusCode, 200);
  assert.equal(readerReadiness.json().workspaceId, workspaceId);
  const readerProjection = await readOnlyApp.inject({
    method: "GET", url: "/api/cwos/v2/normalized-projections/fp5-isolated-plan", headers,
  });
  assert.equal(readerProjection.statusCode, 200);
  assert.deepEqual(readerProjection.json(), projected);
  const readerDenied = await readOnlyApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...headers, "idempotency-key": "fp5-machine-reference" },
    payload: { command: "business.reconcileNormalized", expectedVersion: state.version, payload: { planId: "fp5-isolated-plan" } },
  });
  assert.equal(readerDenied.statusCode, 403);
  assert.equal(readerDenied.json().error, "MACHINE_READ_ONLY");
  const readerWrongWorkspace = await readOnlyApp.inject({
    method: "GET", url: "/api/cwos/v2/state",
    headers: { ...headers, "x-workspace-id": "f3333333-3333-4333-8333-333333333333" },
  });
  assert.equal(readerWrongWorkspace.statusCode, 403);
  assert.equal(readerWrongWorkspace.json().error, "ACTOR_BINDING_MISMATCH");
  const readerLegacy = await readOnlyApp.inject({ method: "GET", url: "/api/finance/balances", headers });
  assert.equal(readerLegacy.statusCode, 403);
  assert.equal(readerLegacy.json().error, "MACHINE_ROUTE_DENIED");
  assert.deepEqual((await readOnlyApp.inject({ method: "GET", url: "/api/cwos/v2/state", headers })).json(), before);
  assert.deepEqual((await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId])).rows, auditBefore.rows);
  assert.deepEqual((await db.query("SELECT id,net_amount_krw,vat_amount_krw,gross_amount_krw FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, financialBefore.rows);
  assert.equal((await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers: { ...headers, "x-principal-kind": "human", "x-principal-id": human.principalId } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers: { ...headers, "x-step-up": "true" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/finance/balances", headers })).statusCode, 403);
  const denied = await app.inject({
    url: "/api/cwos/v2/commands",
    method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "fp5-denied" },
    payload: { command: "identity.registerPrincipal", expectedVersion: state.version,
      payload: { id: "forged-operator", kind: "human", displayName: "Forged", active: true } },
  });
  assert.equal(denied.statusCode, 403);
  const deniedBody: unknown = denied.json();
  assert(deniedBody && typeof deniedBody === "object" && "error" in deniedBody);
  assert.equal(deniedBody.error, "HUMAN_REQUIRED");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers })).json(), before);
  assert.deepEqual((await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId])).rows, auditBefore.rows);
  const reopened = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scoped), now);
  assert.equal((await reopened.readAuthorized({ ...machine, stepUpVerified: false })).stateHash, state.stateHash);
  peerApp = createApp({ authApiKey: key, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2ActorBinding: human, customerWorkOsV2NormalizedProjectionPool: scoped });
  await peerApp.ready();
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
  const replayed = await humanApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": "fp5-native-reference" },
    payload: { command: "business.reconcileNormalized", expectedVersion: 0, payload: { planId: "fp5-isolated-plan" } },
  });
  assert.equal(replayed.statusCode, 200);
  assert.deepEqual(replayed.json(), reconciliation);
  assert.equal((await reopened.readAuthorized({ ...machine, stepUpVerified: false })).state.normalizedArchiveRefs?.length, 1);
  const deniedProducer = await app.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...headers, "idempotency-key": "fp5-machine-reference" },
    payload: { command: "business.reconcileNormalized", expectedVersion: reconciliation.runtimeVersion,
      payload: { planId: "fp5-isolated-plan" } },
  });
  assert.equal(deniedProducer.statusCode, 403);
  const forgedSource = await humanApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": "fp5-forged-reference" },
    payload: { command: "business.reconcileNormalized", expectedVersion: reconciliation.runtimeVersion,
      payload: { planId: "fp5-isolated-plan", sourceDigest: "f".repeat(64), approved: true } },
  });
  assert.equal(forgedSource.statusCode, 400);
  const producerState = await manager.read(workspaceId);
  assert.equal(producerState.version, state.version + 1);
  assert.equal(producerState.state.normalizedArchiveRefs?.length, 1);
  const referenceAudit = await db.query<{ operation_id: string; request_hash: string; after_state_hash: string }>(
    "SELECT operation_id,request_hash,after_state_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 AND idempotency_key='fp5-native-reference'",
    [workspaceId],
  );
  assert.equal(referenceAudit.rows.length, 1);
  assert.equal(referenceAudit.rows[0]?.after_state_hash, producerState.stateHash);
  const requests = [humanApp, peerApp].map((caller, suffix) => caller.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": `fp5-cas-${suffix}` },
    payload: { command: "identity.addTeam", expectedVersion: producerState.version, payload: { id: `fp5-team-${suffix}`, name: `QA ${suffix}` } },
  }));
  const cas = await Promise.all(requests);
  assert.deepEqual(cas.map(r => r.statusCode).sort(), [200, 409]);
  const beforeFailure = (await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers })).json();
  const priorAudit = await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId]);
  await db.query(`CREATE FUNCTION fp5_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.idempotency_key='fp5-audit-failure' THEN RAISE EXCEPTION 'isolated audit failure'; END IF; RETURN NEW; END $$`);
  await db.query("CREATE TRIGGER fp5_reject_audit BEFORE INSERT ON cwos_v2_audit_events FOR EACH ROW EXECUTE FUNCTION fp5_reject_audit()");
  const failed = await humanApp.inject({
    method: "POST", url: "/api/cwos/v2/commands",
    headers: { ...humanHeaders, "idempotency-key": "fp5-audit-failure" },
    payload: { command: "identity.addTeam", expectedVersion: producerState.version + 1, payload: { id: "fp5-team-failure", name: "QA failure" } },
  });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers })).json(), beforeFailure);
  assert.deepEqual((await db.query("SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence", [workspaceId])).rows, priorAudit.rows);
  console.log(JSON.stringify({ database: name, level: "ISOLATED_ONLY", runtimeRole: "ai_crm_runtime_api",
    channel: "FASTIFY_HTTP_INJECTION_NO_LISTENER",
    httpState: beforeResponse.statusCode, denials: [403, 403, 403, denied.statusCode], version: state.version,
    stateHash: state.stateHash, auditRows: auditBefore.rows.length, restart: "unchanged",
    projection: projection.statusCode, exactFixtureMoney: "9007199254740993", fixtureAuthority: "ARCHIVE_PROJECTION_ONLY",
    nativeReference: reconciled.statusCode, referenceVersion: producerState.version,
    referenceId: reconciliation.result.id, referenceSourceDigest: reconciliation.result.sourceDigest,
    referenceStateHash: producerState.stateHash, referenceOperationId: referenceAudit.rows[0]?.operation_id,
    referenceRequestHash: referenceAudit.rows[0]?.request_hash,
    readOnlyMachine: { workspaceId, principalId: machine.principalId, kind: machine.kind,
      managedWorkspace: managedWorkspace.status, provisioning: provisioned.statusCode,
      withoutStepUp: noStepUp.statusCode, nonV2: readerLegacy.statusCode,
      membership: "ACTIVE", state: readerState.statusCode, readiness: readerReadiness.statusCode,
      projection: readerProjection.statusCode, mutation: readerDenied.statusCode,
      mutationError: readerDenied.json().error, wrongWorkspace: readerWrongWorkspace.statusCode,
      stateAuditMoney: "unchanged" },
    referenceApproved: reconciliation.result.approved, sourcePlanVersion: reconciliation.result.planVersion,
    referenceReplay: replayed.statusCode, referenceDenials: [deniedProducer.statusCode, forgedSource.statusCode],
    cas: cas.map(r => r.statusCode), auditFailure: failed.statusCode, rollback: "unchanged" }));
} finally {
  await noStepUpApp?.close();
  await readOnlyApp?.close();
  await peerApp?.close();
  await humanApp?.close();
  await app?.close();
  await pool?.end();
  if (created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
  console.log("FP5_CRM_HTTP_PG_CLEANUP_OK");
}
}, 60_000);
});
