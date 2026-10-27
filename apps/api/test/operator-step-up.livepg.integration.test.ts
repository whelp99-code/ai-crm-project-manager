import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";
import { describe, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord, OperatorAuthStore } from "../src/operator-auth-store.js";
import { operatorPasswordHash } from "../src/operator-auth-crypto.js";
import { PgCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";

const errorSchema = z.object({ error: z.string() });
const proofSchema = z.object({ csrf: z.string().min(1) });
const stateSchema = z.object({
  workspaceId: z.string(), version: z.number().int(),
  state: z.object({
    admin: z.object({ workspaces: z.array(z.object({ id: z.string(), status: z.string() })) }),
  }),
});
const resultSchema = z.object({ runtimeVersion: z.number().int() });

describe.skipIf(process.env.LIVE_PG_TEST !== "1")("owned PG real HTTP operator step-up", () => {
  it("authenticates a human, provisions ACTIVE, then reads only as dedicated Mail service", async () => {
    const run = promisify(execFile);
    const name = `fp5_stepup_qa_${randomUUID().replaceAll("-", "")}`;
    const inspected = await run("docker", ["inspect", "--format", "{{json .Config.Env}}", "core5-crm-pilot-pg"]);
    const entries: unknown = JSON.parse(inspected.stdout);
    assert(Array.isArray(entries));
    const settings = new Map<string, string>();
    for (const entry of entries) {
      assert.equal(typeof entry, "string");
      const at = entry.indexOf("=");
      settings.set(entry.slice(0, at), entry.slice(at + 1));
    }
    const mapped = await run("docker", ["port", "core5-crm-pilot-pg", "5432/tcp"]);
    const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapped.stdout)?.[1];
    const user = settings.get("POSTGRES_USER");
    const password = settings.get("POSTGRES_PASSWORD");
    assert(port && user && password);
    const config = { host: "127.0.0.1", port: Number(port), user, password };
    const admin = new Pool({ ...config, database: "postgres" });
    let created = false;
    let db: Pool | undefined;
    let humanApp: ReturnType<typeof createApp> | undefined;
    let readerApp: ReturnType<typeof createApp> | undefined;
    const workspaceId = "b1111111-1111-4111-8111-111111111111";
    const principalId = "human-owner";
    const readerId = "fp5-stepup-mail-reader";
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ai_crm_dryrun_20260930`);
      created = true;
      const pool = new Pool({ ...config, database: name });
      db = pool;
      const actual = await pool.query<{ name: string }>("SELECT current_database() AS name");
      assert.equal(actual.rows[0]?.name, name);
      // Physical test scaffolding only, never canonical/operating workspace provisioning.
      await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Owned step-up QA') ON CONFLICT(id) DO NOTHING", [workspaceId]);
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
            const queryable: V2PgQueryable = {
              async query<R = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
                const result = await client.query(sql, args ? [...args] : undefined);
                return { rows: result.rows as R[], rowCount: result.rowCount };
              },
            };
            const value = await action(queryable);
            await client.query("COMMIT");
            return value;
          } catch (error) { await client.query("ROLLBACK"); throw error; }
          finally { client.release(); }
        },
      };
      const humanKey = randomBytes(32).toString("hex");
      const readerKey = randomBytes(32).toString("hex");
      const humanPassword = "isolated-http-owner-password";
      const now = 59_000;
      let record: OperatorAuthRecord = {
        generation: 1, enrolled: true, totpPending: false,
        passwordHash: operatorPasswordHash(humanPassword),
        totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      };
      const authStore: OperatorAuthStore = {
        read: () => structuredClone(record), write: next => { record = structuredClone(next); },
      };
      const auth = new OperatorStepUpService({
        workspaceId, principalId, sessionSecret: randomBytes(32).toString("hex"), store: authStore,
        now: () => now, cookieSecure: false,
      });
      humanApp = createApp({
        authApiKey: humanKey, customerWorkOsV2Profile: "production",
        customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
        customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
        customerWorkOsV2OperatorStepUp: auth,
      });
      const origin = await humanApp.listen({ port: 0, host: "127.0.0.1" });
      const humanHeaders = {
        "x-api-key": humanKey, "x-workspace-id": workspaceId,
        "x-principal-id": principalId, "x-principal-kind": "human", "content-type": "application/json",
      };
      const denied = await fetch(`${origin}/api/cwos/v2/state`, {
        headers: humanHeaders, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      assert.equal(denied.status, 403);
      assert.equal(errorSchema.parse(await denied.json()).error, "STEP_UP_REQUIRED");
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
      const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
      const last = digest.at(-1);
      assert(last !== undefined);
      const code = ((digest.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
      const login = await fetch(`${origin}/api/cwos/v2/operator-step-up`, {
        method: "POST", headers: humanHeaders, body: JSON.stringify({ password: humanPassword, totp: code }),
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      assert(cookie);
      const proof = proofSchema.parse(await login.json());
      const authenticated = { ...humanHeaders, cookie, "x-csrf-token": proof.csrf };
      const stateResponse = await fetch(`${origin}/api/cwos/v2/state`, {
        headers: authenticated, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      assert.equal(stateResponse.status, 200);
      let version = stateSchema.parse(await stateResponse.json()).version;
      for (const [command, id, payload] of [
        ["identity.registerPrincipal", "stepup-owner", { id: principalId, kind: "human", displayName: "Owned QA owner", active: true }],
        ["identity.addMembership", "stepup-owner-member", { id: "stepup-owner-member", principalId }],
        ["admin.provision", "stepup-workspace", { id: workspaceId, name: "Owned QA managed workspace", quotaUsers: 1,
          quotaStorageMb: 1, retentionDays: 1, templateVersion: "OWNED_QA_ONLY" }],
        ["identity.registerPrincipal", "stepup-reader", { id: readerId, kind: "service", displayName: "Owned QA Mail reader", active: true }],
        ["identity.addMembership", "stepup-reader-member", { id: "stepup-reader-member", principalId: readerId }],
      ] as const) {
        const response = await fetch(`${origin}/api/cwos/v2/commands`, {
          method: "POST", headers: { ...authenticated, "idempotency-key": id },
          body: JSON.stringify({ command, expectedVersion: version, payload }),
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200);
        version = resultSchema.parse(await response.json()).runtimeVersion;
      }
      readerApp = createApp({
        authApiKey: readerKey, customerWorkOsV2Profile: "production",
        customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
        customerWorkOsV2MachineBinding: { workspaceId, principalId: readerId, kind: "service", readOnly: true },
      });
      const readerOrigin = await readerApp.listen({ port: 0, host: "127.0.0.1" });
      const readerHeaders = {
        "x-api-key": readerKey, "x-workspace-id": workspaceId,
        "x-principal-id": readerId, "x-principal-kind": "service",
      };
      const before = await pool.query("SELECT workspace_id,version,state_hash FROM cwos_v2_runtime_snapshots ORDER BY workspace_id");
      const audit = await pool.query("SELECT workspace_id,sequence,event_hash FROM cwos_v2_audit_events ORDER BY workspace_id,sequence");
      const money = await pool.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
      const read = await fetch(`${readerOrigin}/api/cwos/v2/state`, {
        headers: readerHeaders, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      assert.equal(read.status, 200);
      const state = stateSchema.parse(await read.json());
      assert.equal(state.workspaceId, workspaceId);
      assert(state.state.admin.workspaces.some(item => item.id === workspaceId && item.status === "ACTIVE"));
      for (const path of ["/api/cwos/v2/commands", "/api/cwos/v2/operator-step-up"]) {
        const write = await fetch(`${readerOrigin}${path}`, {
          method: "POST", headers: { ...readerHeaders, "content-type": "application/json" }, body: "{}",
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        assert.equal(write.status, 403);
        assert.equal(errorSchema.parse(await write.json()).error, "MACHINE_READ_ONLY");
      }
      assert.deepEqual((await pool.query("SELECT workspace_id,version,state_hash FROM cwos_v2_runtime_snapshots ORDER BY workspace_id")).rows, before.rows);
      assert.deepEqual((await pool.query("SELECT workspace_id,sequence,event_hash FROM cwos_v2_audit_events ORDER BY workspace_id,sequence")).rows, audit.rows);
      assert.deepEqual((await pool.query("SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, money.rows);
      console.log(JSON.stringify({ proof: "OWNED_PG_HTTP_STEP_UP", database: name,
        humanStepUp: 200, provision: 200, managedWorkspace: "ACTIVE", reader: 200,
        write: 403, machineStepUp: 403, stateAuditMoneyUnchanged: true }));
    } finally {
      if (readerApp) await readerApp.close();
      if (humanApp) await humanApp.close();
      if (db) await db.end();
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      console.log("OWNED_STEPUP_PG_CLEANUP_OK");
    }
  }, 120_000);
});
