import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { CustomerWorkOsV2RuntimeManager, PgCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";

const database = "ai_crm_dryrun_20260930";
const live = process.env.LIVE_PG_TEST === "1" && process.env.F2_DRYRUN_TEST_DB === database;
const workspaceId = "f2222222-2222-4222-8222-222222222222";
const actor: V2Actor = { workspaceId, principalId: "f2-local-owner", kind: "human", stepUpVerified: true };
const now = () => "2026-10-06T00:00:00.000Z";
let pool: Pool | undefined;
let queryable: V2PgQueryable;
let store: PgCwosV2StateStore;

function source(revisionId: string, dueOn: string) {
  const text = `Accept by ${dueOn}`;
  const content = ` \n${text}\n `;
  return { workspaceId, sourceId: "f2-local-contract", revisionId, sourceUrl: `contract://local/${revisionId}`,
    observedAt: now(), content, sourceHash: createHash("sha256").update(content).digest("hex"),
    clauses: [{ id: "accept", text, conditional: false, kind: "acceptance", dueOn,
      startByte: 2, endByte: 2 + Buffer.byteLength(text) }] };
}
const payload = { comparisonId: "f2-local-comparison", prior: source("rev-1", "2026-10-01"), next: source("rev-2", "2026-10-05") };

describe.skipIf(!live)("F2 existing authorized local PostgreSQL persistence", () => {
  beforeAll(async () => {
    const run = promisify(execFile);
    // Reuse the named local pilot container, but connect exclusively to the verified scratch DB.
    // Credential bytes remain in memory and are never printed or passed in shell command text.
    const inspected = await run("docker", ["inspect", "--format", "{{json .Config.Env}}", "core5-crm-pilot-pg"]);
    const envValues: unknown = JSON.parse(inspected.stdout);
    if (!Array.isArray(envValues) || envValues.some(value => typeof value !== "string")) throw new Error("invalid local container environment");
    const values = new Map<string, string>();
    for (const value of envValues) {
      if (typeof value !== "string") throw new Error("invalid local container variable");
      const index = value.indexOf("=");
      values.set(value.slice(0, index), value.slice(index + 1));
    }
    const portOutput = await run("docker", ["port", "core5-crm-pilot-pg", "5432/tcp"]);
    const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(portOutput.stdout)?.[1];
    const user = values.get("POSTGRES_USER");
    const password = values.get("POSTGRES_PASSWORD");
    if (!port || !user || !password) throw new Error("named local pilot credentials or port unavailable");
    const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
    url.username = user;
    url.password = password;
    const connection = new Pool({ connectionString: url.toString() });
    pool = connection;
    const current = await connection.query<{ name: string }>("SELECT current_database() AS name");
    if (current.rows[0]?.name !== database) throw new Error("refusing non-dry-run database");
    queryable = {
      async query<T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
        const result = await connection.query(sql, args ? [...args] : undefined);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
      async withWorkspaceScope<T>(ws: string, fn: (db: V2PgQueryable) => Promise<T>) {
        const client = await connection.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE ai_crm_runtime_api");
          await client.query("SELECT set_config('app.workspace_id',$1,true)", [ws]);
          const db: V2PgQueryable = {
            async query<T2 = Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
              const result = await client.query(sql, args ? [...args] : undefined);
              return { rows: result.rows as T2[], rowCount: result.rowCount };
            },
          };
          const result = await fn(db);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      },
    };
    store = new PgCwosV2StateStore(queryable);
  }, 30_000);
  afterAll(async () => { await pool?.end(); }, 30_000);

  it("reopens a persisted unapproved comparison with unchanged audit and runtime-role tenant isolation", async () => {
    const manager = new CustomerWorkOsV2RuntimeManager(store, now);
    let state = await manager.read(workspaceId);
    for (const [command, key, data, needed] of [
      ["identity.registerPrincipal", "f2-pg-owner", { id: actor.principalId, kind: "human", displayName: "F2 Local Owner", active: true },
        !state.state.identity.principals.some(p => p.id === actor.principalId)],
      ["identity.addMembership", "f2-pg-member", { id: "f2-member", principalId: actor.principalId },
        !state.state.identity.memberships.some(m => m.principalId === actor.principalId && m.status === "ACTIVE")],
    ] as const) {
      if (needed) {
        await manager.command({ workspaceId, actor, command, expectedVersion: state.version, idempotencyKey: key, payload: data });
        state = await manager.read(workspaceId);
      }
    }
    const first = await manager.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: state.version,
      idempotencyKey: "f2-pg-comparison", payload });
    expect(first.result).toMatchObject({ comparisonId: payload.comparisonId, approved: false, sent: false, sourceVerified: false });
    const audit = async () => {
      if (!queryable.withWorkspaceScope) throw new Error("workspace scoping is required");
      return queryable.withWorkspaceScope(workspaceId, db => db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM cwos_v2_audit_events WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, "f2-pg-comparison"]));
    };
    const before = await audit();
    const reopened = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(queryable), now);
    const replay = await reopened.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: 0,
      idempotencyKey: "f2-pg-comparison", payload });
    expect(replay.result).toEqual(first.result);
    expect(replay.envelope.version).toBe(first.envelope.version);
    expect((await audit()).rows).toEqual(before.rows);
    const comparison = (await reopened.readAuthorized(actor)).state.contractComparisons?.comparisons[0];
    expect(comparison?.prior.content).toBe(payload.prior.content);
    expect(comparison?.next.sourceHash).toBe(payload.next.sourceHash);
    expect(comparison?.findings[0]?.deadlineStatus).toBe("UNKNOWN");
    await expect(reopened.command({ workspaceId, actor: { ...actor, stepUpVerified: false }, command: "f2.compareRevisions",
      expectedVersion: replay.envelope.version, idempotencyKey: "f2-pg-denied", payload })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    if (!queryable.withWorkspaceScope) throw new Error("workspace scoping is required");
    const foreign = await queryable.withWorkspaceScope("f3333333-3333-4333-8333-333333333333", db => db.query(
      "SELECT workspace_id FROM cwos_v2_runtime_snapshots WHERE workspace_id=$1", [workspaceId]));
    expect(foreign.rows).toHaveLength(0);
    console.log(JSON.stringify({ database, runtimeRole: "ai_crm_runtime_api", version: replay.envelope.version,
      candidates: replay.envelope.state.contractComparisons?.comparisons.length, auditCount: before.rows[0]?.count,
      foreignRows: foreign.rows.length, sourceVerified: comparison?.sourceVerified, approved: comparison?.approved }));
  });
});
