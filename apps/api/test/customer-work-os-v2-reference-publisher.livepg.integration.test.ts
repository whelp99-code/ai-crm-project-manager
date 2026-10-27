import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { describe, it } from "vitest";
import { createApp } from "../src/app.js";
import { publishNativeArchiveReference } from "../src/customer-work-os-v2-reference-publisher.js";
import { CustomerWorkOsV2RuntimeManager, PgCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";
import { companyReferenceCli } from "./fixtures/company-reference-cli.js";

describe.skipIf(process.env.LIVE_PG_TEST !== "1")("RS-local native reference to installed S1", () => {
  it("preserves source bytes and unapproved authority through matching receipt acknowledgement", async () => {
    const run = promisify(execFile);
    const inspected = await run("docker", ["inspect", "--format", "{{json .Config.Env}}", "core5-crm-pilot-pg"]);
    const values: unknown = JSON.parse(inspected.stdout);
    assert(Array.isArray(values));
    const env = new Map<string, string>();
    for (const value of values) { assert.equal(typeof value, "string"); const at = value.indexOf("="); env.set(value.slice(0, at), value.slice(at + 1)); }
    const mapped = await run("docker", ["port", "core5-crm-pilot-pg", "5432/tcp"]);
    const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapped.stdout)?.[1];
    assert(port);
    const base = { host: "127.0.0.1", port: Number(port), user: env.get("POSTGRES_USER"), password: env.get("POSTGRES_PASSWORD") };
    const admin = new Pool({ ...base, database: "postgres" });
    const database = `fp5_crm_rs_${randomUUID().replaceAll("-", "")}`;
    let created = false, db: Pool | undefined;
    let humanApp: ReturnType<typeof createApp> | undefined, machineApp: ReturnType<typeof createApp> | undefined;
    let cli: Awaited<ReturnType<typeof companyReferenceCli>> | undefined;
    const workspaceId = "b1111111-1111-4111-8111-111111111111";
    const human = { workspaceId, principalId: "rs-human", kind: "human" as const, stepUpVerified: true };
    const machine = { workspaceId, principalId: "rs-service", kind: "service" as const };
    try {
      await admin.query(`CREATE DATABASE ${database} TEMPLATE ai_crm_dryrun_20260930`); created = true;
      const pool = new Pool({ ...base, database }); db = pool;
      await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'RS owned fixture') ON CONFLICT(id) DO NOTHING", [workspaceId]);
      const scoped: V2PgQueryable = {
        async query<T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
          const result = await pool.query(sql, args ? [...args] : undefined);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        async withWorkspaceScope<T>(ws: string, action: (q: V2PgQueryable) => Promise<T>) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE ai_crm_runtime_api");
            await client.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
            const result = await action({
              async query<T2 = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
                const reply = await client.query(sql, args ? [...args] : undefined);
                return { rows: reply.rows as T2[], rowCount: reply.rowCount };
              },
            });
            await client.query("COMMIT"); return result;
          } catch (error) { await client.query("ROLLBACK"); throw error; }
          finally { client.release(); }
        },
      };
      const manager = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scoped));
      for (const principal of [human, machine]) {
        let current = await manager.read(workspaceId);
        await manager.command({ workspaceId, actor: human, expectedVersion: current.version,
          idempotencyKey: `rs-principal-${principal.kind}`, command: "identity.registerPrincipal",
          payload: { id: principal.principalId, kind: principal.kind, displayName: "RS fixture", active: true } });
        current = await manager.read(workspaceId);
        await manager.command({ workspaceId, actor: human, expectedVersion: current.version,
          idempotencyKey: `rs-member-${principal.kind}`, command: "identity.addMembership",
          payload: { id: `rs-member-${principal.kind}`, principalId: principal.principalId } });
      }
      const captured = "2026-10-06T00:00:00.000Z";
      const plan = { workspaceId, snapshotId: "rs-snapshot", snapshotHash: "sha256:rs-fixture", planHash: "fnv1a32:rs-fixture",
        capturedAt: captured, accounts: [{ id: "rs-account" }], engagements: [], financialItems: [{ id: "rs-money" }], quarantined: [] };
      await pool.query(`INSERT INTO cwos_accounts(id,workspace_id,name,normalized_name,kinds,status)
        VALUES('rs-account',$1,'RS fixture','rs fixture','["customer"]','active')`, [workspaceId]);
      await pool.query(`INSERT INTO cwos_financial_items(id,workspace_id,account_id,direction,category,lifecycle,net_amount_krw,vat_amount_krw,gross_amount_krw,expected_date)
        VALUES('rs-money',$1,'rs-account','OUT','overhead','PLANNED',9007199254740993,0,9007199254740993,'2026-10-06')`, [workspaceId]);
      await pool.query(`INSERT INTO cwos_notion_import_plans(id,workspace_id,snapshot_id,snapshot_hash,plan_hash,captured_at,plan,
        source_counts,imported_counts,finance_totals,quarantine_count,orphan_relation_count,duplicate_candidate_count,status,
        read_only_source,created_by_principal_id,approved_by_principal_id,applied_by_principal_id,approved_at,applied_at)
        VALUES('rs-plan',$1,'rs-snapshot','sha256:rs-fixture','fnv1a32:rs-fixture',$2,$3,'{}','{}','{}',0,0,0,'APPLIED',true,
        'rs-human','rs-human','rs-human',$2,$2)`, [workspaceId, captured, JSON.stringify(plan)]);
      const options = { authApiKey: "rs-fixture-only", customerWorkOsV2Store: new PgCwosV2StateStore(scoped), customerWorkOsV2NormalizedProjectionPool: scoped };
      humanApp = createApp({ ...options, customerWorkOsV2ActorBinding: human }); await humanApp.ready();
      machineApp = createApp({ ...options, customerWorkOsV2MachineBinding: machine }); await machineApp.ready();
      const headers = { "x-api-key": "rs-fixture-only", "x-workspace-id": workspaceId, "x-principal-id": human.principalId, "x-principal-kind": human.kind };
      const initial = await manager.read(workspaceId);
      const produced = await humanApp.inject({ method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...headers, "idempotency-key": "rs-native-reference" },
        payload: { command: "business.reconcileNormalized", expectedVersion: initial.version, payload: { planId: "rs-plan" } } });
      assert.equal(produced.statusCode, 200);
      const sourceResponse = await machineApp.inject({ method: "GET", url: "/api/cwos/v2/normalized-projections/rs-plan",
        headers: { ...headers, "x-principal-id": machine.principalId, "x-principal-kind": machine.kind } });
      assert.equal(sourceResponse.statusCode, 200);
      const state = await manager.read(workspaceId), reference = state.state.normalizedArchiveRefs?.[0];
      assert(reference);
      const bytes = Buffer.from(` \n${sourceResponse.body}\n`); // Preserve original serialization and whitespace.
      const ledgerBefore = await pool.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
      cli = await companyReferenceCli(reference, bytes);
      const fixture = cli;
      // Owned PG fixture outbox: no production schema or mock acknowledgement sink.
      await pool.query(`CREATE TABLE fp5_rs_source_outbox(
        id text PRIMARY KEY,status text NOT NULL,version integer NOT NULL,receipt jsonb)`);
      await pool.query(`INSERT INTO fp5_rs_source_outbox(id,status,version)
        VALUES('rs-source-created','PENDING',1),('rs-source-linked','PENDING',1),('rs-denied','PENDING',1)`);
      const acknowledge = (id: string) => async (receipt: { receipt_id: string }) => {
        await pool.query(`UPDATE fp5_rs_source_outbox SET status='EMITTED',version=version+1,receipt=$2
          WHERE id=$1 AND status='PENDING'`, [id, JSON.stringify(receipt)]);
      };
      const input = { reference, sourceBytes: bytes, context: fixture.context, signer: fixture.signer,
        transport: fixture.transport, eventId: "rs-source-created", now: new Date(),
        acknowledge: acknowledge("rs-source-created") };
      const receipt = await publishNativeArchiveReference(input);
      const ack = (await pool.query("SELECT status,version,receipt FROM fp5_rs_source_outbox WHERE id='rs-source-created'")).rows[0];
      assert.equal(ack?.receipt.receipt_id, receipt.receipt_id);
      assert.equal(ack?.version, 2);
      assert.equal(ack?.status, "EMITTED");
      const first = fixture.calls[0]; assert(first);
      const request = JSON.parse(Buffer.from(first.request).toString());
      assert.equal(Object.hasOwn(request.arguments, "content"), false);
      assert.equal(request.arguments.content_digest, fixture.binding.content_digest);
      assert.equal(request.arguments.locator.approved, "false");
      assert.equal(request.arguments.locator.authority, "ARCHIVE_PROJECTION_ONLY");
      const replay = await fixture.transport.invoke(first.request);
      assert.equal(replay.exitCode, 0);
      assert.equal(JSON.parse(Buffer.from(replay.stdout).toString()).receipt.receipt_id, receipt.receipt_id);
      const otherKind = await publishNativeArchiveReference({ ...input, eventId: "rs-source-linked",
        acknowledge: acknowledge("rs-source-linked") });
      assert.equal(otherKind.candidate_id, receipt.candidate_id);
      const another = JSON.parse(Buffer.from(fixture.calls.at(-1)?.request ?? []).toString());
      assert.deepEqual(another.arguments.locator, request.arguments.locator);
      assert.equal((await fixture.read(receipt.candidate_id)).content, bytes.toString());
      const deniedInput = { ...input, eventId: "rs-denied", acknowledge: acknowledge("rs-denied") };
      const beforeDenied = (await pool.query("SELECT * FROM fp5_rs_source_outbox WHERE id='rs-denied'")).rows;
      await assert.rejects(publishNativeArchiveReference({
        ...deniedInput, sourceBytes: Buffer.from(bytes.toString().replace('"rs-plan"', '"forged-plan"')),
      }), { code: "COMPANY_SOURCE_BINDING_MISMATCH" });
      await assert.rejects(publishNativeArchiveReference({
        ...deniedInput,
        transport: {
          async invoke(requestBytes) {
            const actual = await fixture.transport.invoke(requestBytes);
            assert.equal(actual.exitCode, 0);
            const altered = JSON.parse(Buffer.from(actual.stdout).toString());
            altered.receipt.workspace_id = "22345678-1234-4234-8234-123456789abc";
            return { ...actual, stdout: Buffer.from(JSON.stringify(altered)) };
          },
        },
      }), { code: "COMPANY_RECEIPT_MISMATCH" });
      const wrongKey = generateKeyPairSync("ed25519");
      await assert.rejects(publishNativeArchiveReference({ ...deniedInput,
        signer: { keyId: fixture.signer.keyId, sign: message => sign(null, message, wrongKey.privateKey) } }), { code: "COMPANY_RECEIPT_REQUIRED" });
      fixture.config.workspace_id = "22345678-1234-4234-8234-123456789abc"; await fixture.save();
      await assert.rejects(publishNativeArchiveReference(deniedInput), { code: "COMPANY_RECEIPT_REQUIRED" });
      fixture.config.workspace_id = workspaceId; fixture.binding.content_digest = `sha256:${"b".repeat(64)}`; await fixture.save();
      await assert.rejects(publishNativeArchiveReference(deniedInput), { code: "COMPANY_RECEIPT_REQUIRED" });
      assert.deepEqual((await pool.query("SELECT * FROM fp5_rs_source_outbox WHERE id='rs-denied'")).rows, beforeDenied);
      assert.deepEqual((await pool.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, ledgerBefore.rows);
      assert.equal((await manager.read(workspaceId)).stateHash, state.stateHash);
      await fixture.verifyOriginal();
      console.log(JSON.stringify({ level: "RS_LOCAL_ONLY", database, nativeReferenceId: reference.id,
        nativeSourceDigest: reference.sourceDigest, nativeVersion: state.version, request, receipt, ack,
        sourceBytesSHA256: createHash("sha256").update(bytes).digest("hex"),
        positive: 1, replay: 1, stableEventKinds: 2, denials: 5, nativeLedger: "unchanged",
        approved: reference.approved, authority: "ARCHIVE_PROJECTION_ONLY" }, null, 2));
    } finally {
      await cli?.close(); await machineApp?.close(); await humanApp?.close(); await db?.end();
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
      console.log("FP5_CRM_RS_LOCAL_CLEANUP_OK");
    }
  }, 60_000);
});
