import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import type { PgQueryable } from "@ai-crm/orchestration";
import { createApp, type CreateAppOptions } from "../src/app.js";
import type { EventHub } from "../src/event-hub.js";
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  PgNotifyBridge,
  PgNotifyPayloadTooLargeError,
  encodeNotifyPayload,
  publishNotify,
} from "../src/pg-notify.js";

/**
 * N-09 (D6) cross-process eventing acceptance against REAL PostgreSQL.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green (same
 * gate/pattern as `n08-pg-primary.livepg.integration.test.ts` and
 * `sor-restart-livepg.integration.test.ts`). Targets the AI-CRM docker
 * postgres only (default `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`)
 * — override via `DATABASE_URL`.
 *
 * Covers, per docs/ops/eventing.md "Cross-process eventing" section:
 *  1. keys-only NOTIFY payload guard (< 8000 bytes, `PgNotifyPayloadTooLargeError`
 *     once over).
 *  2. cross-workspace leak prevention: FORCE RLS (not the NOTIFY payload)
 *     is what gates the re-read — a subscriber scoped to workspace A can
 *     never recover workspace B's row, even by explicit id, under the
 *     NOBYPASSRLS `ai_crm_runtime_api` role.
 *  3. cross-process delivery: two independent `createApp` instances sharing
 *     one DSN — a mutation on instance A is delivered to instance B's local
 *     `EventHub` via a REAL `LISTEN`/`NOTIFY` round trip.
 *  4. reconnect reconcile: events emitted while a listener is torn down are
 *     recovered from `orch_job_events` (the durable log) on reconnect, not
 *     lost.
 */

const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_A = "f0f0f0f0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
const WS_B = "f0f0f0f0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const WS_XPROC = "f0f0f0f0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const WS_RECONNECT = "f0f0f0f0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const OPERATOR = "operator-n09-livepg";

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

function planClient(steps: Array<Record<string, unknown>>): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: steps.map((step) => {
            const {
              suggestedCommand,
              title = "step",
              resourceType = "",
              resourceId = "",
              resourceVersion = 1,
              payload = {},
            } = step;
            return {
              suggestedCommand,
              title,
              resourceType,
              resourceId,
              resourceVersion,
              payloadJson: JSON.stringify(payload ?? {}),
            };
          }),
        },
        modelVersion: "test-plan",
        retentionHonored: true,
      };
    },
  };
}

function headers(ws: string, extra: Record<string, string> = {}) {
  return { "x-workspace-id": ws, "x-principal-id": OPERATOR, ...extra };
}

async function listen(instance: FastifyInstance): Promise<number> {
  await instance.listen({ port: 0, host: "127.0.0.1" });
  const address = instance.server.address() as AddressInfo;
  return address.port;
}

function httpPost(
  port: number,
  path: string,
  ws: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { ...headers(ws, { "content-type": "application/json" }), "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function hubOf(instance: FastifyInstance): EventHub {
  return (instance as unknown as { eventHub: EventHub }).eventHub;
}

function bridgeOf(instance: FastifyInstance): PgNotifyBridge {
  return (instance as unknown as { notifyBridge: PgNotifyBridge }).notifyBridge;
}

/** Waits for `hub.subscribe(ws, jobId, ...)` to fire once, or rejects on timeout. */
function waitForHubEvent(hub: EventHub, ws: string, jobId: string, timeoutMs = 5000): Promise<{ kind: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for EventHub event on (${ws}, ${jobId})`));
    }, timeoutMs);
    const unsubscribe = hub.subscribe(ws, jobId, (event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve({ kind: event.kind });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal real-`pg.Pool`-backed `PgQueryable` — same pattern as
 * `n08-pg-primary.livepg.integration.test.ts`'s `scopedQueryableFromPool`,
 * except `withWorkspaceScope` additionally `SET LOCAL ROLE
 * ai_crm_runtime_api` (NOBYPASSRLS) so the scoped re-read is actually
 * subject to FORCE RLS rather than running as the docker-bootstrap `ai_crm`
 * superuser (which bypasses RLS by design — see docs/ops/sor-persistence.md).
 */
function rlsEnforcedQueryable(pool: import("pg").Pool): PgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return result as unknown as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE ai_crm_runtime_api");
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: PgQueryable = {
          async query<T2 = unknown>(text: string, params?: unknown[]) {
            const result = await client.query(text, params);
            return result as unknown as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure; original error is what matters
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function insertJobWithEvent(
  client: import("pg").Client,
  opts: { workspaceId: string; jobId: string; eventId: string; kind: string },
): Promise<void> {
  await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [opts.workspaceId]);
  await client.query(
    `INSERT INTO orch_jobs (id, workspace_id, source, status, created_by_principal_id, created_at, updated_at)
     VALUES ($1, $2, 'natural_command', 'completed', $3, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [opts.jobId, opts.workspaceId, OPERATOR],
  );
  await client.query(
    `INSERT INTO orch_job_events (id, job_id, workspace_id, kind, payload, at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
    [opts.eventId, opts.jobId, opts.workspaceId, opts.kind],
  );
}

describe.skipIf(!LIVE)("N-09 cross-process eventing via PG LISTEN/NOTIFY against REAL Postgres (LIVE_PG_TEST=1)", () => {
  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: { ...process.env, PGHOST: "localhost", PGPORT: "5432", PGUSER: "ai_crm", PGPASSWORD: "ai_crm_dev", PGDATABASE: "ai_crm" },
      stdio: "pipe",
    });

    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1,$2), ($3,$4), ($5,$6), ($7,$8)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_A, "n09-a", WS_B, "n09-b", WS_XPROC, "n09-xproc", WS_RECONNECT, "n09-reconnect"],
      );
      await client.query(`GRANT ai_crm_runtime_api TO CURRENT_USER`);
    } finally {
      await client.end();
    }
  }, 60_000);

  afterEach(async () => {
    while (apps.length) {
      await apps.pop()?.close();
    }
  });

  afterAll(async () => {
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      // audit_events / audit_chain_heads are append-only / no-delete by
      // trigger — the natural-command flow's dual-write may have created
      // rows for these workspaces even though the test itself never touches
      // governance directly. Disable the two triggers for this superuser
      // cleanup connection only (test teardown, not a runtime path).
      await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
      await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
      try {
        for (const ws of [WS_A, WS_B, WS_XPROC, WS_RECONNECT]) {
          await client.query(`SELECT set_config('app.workspace_id', $1, false)`, [ws]);
          await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_intents WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_governance_controls WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_job_events WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_work_items WHERE workspace_id = $1`, [ws]);
          await client.query(`DELETE FROM orch_jobs WHERE workspace_id = $1`, [ws]);
        }
      } finally {
        await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
        await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
      }
      await client.query(`RESET app.workspace_id`);
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[WS_A, WS_B, WS_XPROC, WS_RECONNECT]]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("payload guard: keys-only NOTIFY payload stays well under the 8000-byte cap; an oversized payload is rejected, not truncated", () => {
    const keysOnly = encodeNotifyPayload({ workspaceId: WS_A, jobId: "job-1", eventId: "evt-1", kind: "job.updated" });
    expect(Buffer.byteLength(keysOnly, "utf8")).toBeLessThan(200);
    expect(Buffer.byteLength(keysOnly, "utf8")).toBeLessThan(MAX_NOTIFY_PAYLOAD_BYTES);

    const oversizedKind = "x".repeat(MAX_NOTIFY_PAYLOAD_BYTES);
    expect(() => encodeNotifyPayload({ workspaceId: WS_A, jobId: "job-1", eventId: "evt-1", kind: oversizedKind })).toThrow(
      PgNotifyPayloadTooLargeError,
    );
  });

  it(
    "cross-workspace leak: FORCE RLS (ai_crm_runtime_api, NOBYPASSRLS) — not the NOTIFY payload — gates the re-read; workspace A never recovers workspace B's row, even by explicit id",
    async () => {
      const { Pool, Client } = (await import("pg")) as typeof import("pg");
      const superuserClient = new Client({ connectionString: DATABASE_URL });
      await superuserClient.connect();
      const bJobId = "job-n09-leak-b";
      const bEventId = "evt-n09-leak-b";
      try {
        await insertJobWithEvent(superuserClient, { workspaceId: WS_B, jobId: bJobId, eventId: bEventId, kind: "job.updated" });

        // Falsifiability: prove the row actually exists (superuser bypasses RLS by design).
        const superuserRead = await superuserClient.query(`SELECT id FROM orch_job_events WHERE id = $1`, [bEventId]);
        expect(superuserRead.rows).toHaveLength(1);

        const pool = new Pool({ connectionString: DATABASE_URL });
        try {
          const rlsPool = rlsEnforcedQueryable(pool);

          // Direct RLS proof (no app-level WHERE clause involved): scoped to
          // WS_A, look up WS_B's event by id alone. FORCE RLS must deny it.
          const denied = await rlsPool.withWorkspaceScope!(WS_A, (scoped) =>
            scoped.query(`SELECT id FROM orch_job_events WHERE id = $1`, [bEventId]),
          );
          expect((denied as { rows: unknown[] }).rows).toHaveLength(0);

          // PgNotifyBridge-level proof: a bridge tracking ONLY workspace A,
          // asked to reconcile workspace A, never surfaces workspace B's job.
          const recovered: Array<{ workspaceId: string; jobId: string; kind: string }> = [];
          const bridge = new PgNotifyBridge({
            pool: rlsPool,
            channel: "n09-leak-test-unused",
            connect: async () => {
              throw new Error("not used in this test — reconcileWorkspace is called directly");
            },
            onEvent: (event) => recovered.push(event),
          });
          bridge.trackWorkspace(WS_A);
          const countForA = await bridge.reconcileWorkspace(WS_A);
          expect(countForA).toBe(0);
          expect(recovered.some((event) => event.jobId === bJobId)).toBe(false);

          // A NOTIFY claiming workspace B's keys does not change that: the
          // bridge always re-reads under withWorkspaceScope(payload.workspaceId,
          // ...), so asking it to reconcile workspace A specifically stays
          // scoped to A no matter what a NOTIFY on the shared channel claims.
          await publishNotify(pool, { workspaceId: WS_B, jobId: bJobId, eventId: bEventId, kind: "job.updated" }, "n09-leak-test-unused");
          const countForAAgain = await bridge.reconcileWorkspace(WS_A);
          expect(countForAAgain).toBe(0);
        } finally {
          await pool.end();
        }
      } finally {
        await superuserClient.query(`SELECT set_config('app.workspace_id', $1, false)`, [WS_B]);
        await superuserClient.query(`DELETE FROM orch_job_events WHERE id = $1`, [bEventId]);
        await superuserClient.query(`DELETE FROM orch_jobs WHERE id = $1`, [bJobId]);
        await superuserClient.query(`RESET app.workspace_id`);
        await superuserClient.end();
      }
    },
    30_000,
  );

  it(
    "cross-process delivery: instance A's mutation is delivered to instance B's local EventHub via a real LISTEN/NOTIFY round trip",
    async () => {
      const channel = "ai_crm_agent_events_n09_xproc";
      const instanceA = await bootApp({
        databaseUrl: DATABASE_URL,
        pgNotifyChannel: channel,
        modelClient: planClient([
          {
            suggestedCommand: "pm.task_assign",
            title: "A",
            resourceId: "plan-n09-xproc",
            resourceVersion: 1,
            payload: { projectId: "p", planId: "plan-n09-xproc", taskId: "t1", assigneePrincipalId: "w" },
          },
        ]),
      });
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL, pgNotifyChannel: channel });
      expect((instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm?.persistenceMode).toBe("pg");
      expect(bridgeOf(instanceB)).toBeDefined();

      const portA = await listen(instanceA);

      const planCreated = await httpPost(portA, "/api/pm/plans", WS_XPROC, {
        id: "plan-n09-xproc",
        projectId: "p",
        objective: "c",
        taskIds: ["t1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      });
      expect(planCreated.status).toBe(201);

      const created = await httpPost(portA, "/api/agent/commands", WS_XPROC, {
        text: "assign for xproc",
        idempotencyKey: "idem-n09-xproc-1",
      });
      expect(created.status).toBe(202);
      const jobId = (JSON.parse(created.body) as { jobId: string }).jobId;

      // Give instance B's bridge time to receive + reconcile the first NOTIFY
      // (job creation) so it starts tracking WS_XPROC before we subscribe.
      await sleep(300);

      const waiter = waitForHubEvent(hubOf(instanceB), WS_XPROC, jobId, 5000);
      const cancelled = await httpPost(portA, `/api/agent/jobs/${jobId}/cancel`, WS_XPROC, {});
      expect(cancelled.status).toBe(200);

      const delivered = await waiter;
      expect(delivered.kind).toBe("work_item.cancelled");

      // Instance B's SoR is otherwise independent (in-memory, per-process) —
      // the durable log is what makes this provable, not shared memory.
      expect((instanceB as FastifyInstance & { aiCrm?: { orchStore?: unknown } }).aiCrm?.orchStore).toBeDefined();
    },
    20_000,
  );

  it(
    "reconnect reconcile: events NOTIFYd while instance B's listener is disconnected are recovered from orch_job_events on reconnect, not lost",
    async () => {
      const channel = "ai_crm_agent_events_n09_reconnect";
      const instanceA = await bootApp({
        databaseUrl: DATABASE_URL,
        pgNotifyChannel: channel,
        modelClient: planClient([
          {
            suggestedCommand: "pm.task_assign",
            title: "A",
            resourceId: "plan-n09-reconnect",
            resourceVersion: 1,
            payload: { projectId: "p", planId: "plan-n09-reconnect", taskId: "t1", assigneePrincipalId: "w" },
          },
        ]),
      });
      const instanceB = await bootApp({ databaseUrl: DATABASE_URL, pgNotifyChannel: channel });
      const portA = await listen(instanceA);

      const planCreated = await httpPost(portA, "/api/pm/plans", WS_RECONNECT, {
        id: "plan-n09-reconnect",
        projectId: "p",
        objective: "c",
        taskIds: ["t1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      });
      expect(planCreated.status).toBe(201);

      const created = await httpPost(portA, "/api/agent/commands", WS_RECONNECT, {
        text: "assign for reconnect",
        idempotencyKey: "idem-n09-reconnect-1",
      });
      expect(created.status).toBe(202);
      const jobId = (JSON.parse(created.body) as { jobId: string }).jobId;

      // Let instance B's bridge see + reconcile the creation NOTIFY, so
      // WS_RECONNECT is tracked (cursor established) before we cut it off.
      await sleep(300);
      const cursorBeforeDrop = bridgeOf(instanceB).cursorFor(WS_RECONNECT);
      expect(cursorBeforeDrop).toBeDefined();

      // Simulate the listener connection dropping.
      await bridgeOf(instanceB).simulateDisconnect();

      // Mutate on instance A while instance B's LISTEN connection is down —
      // the NOTIFY fires but nobody on instance B is listening to receive it.
      const cancelled = await httpPost(portA, `/api/agent/jobs/${jobId}/cancel`, WS_RECONNECT, {});
      expect(cancelled.status).toBe(200);

      // Subscribe on instance B BEFORE reconnect completes, so the
      // reconnect-triggered reconcileAll's publish lands on an active
      // subscriber (proves recovery, not just a lucky race on the NOTIFY).
      const waiter = waitForHubEvent(hubOf(instanceB), WS_RECONNECT, jobId, 8000);

      const recovered = await waiter;
      expect(recovered.kind).toBe("work_item.cancelled");

      const cursorAfterReconnect = bridgeOf(instanceB).cursorFor(WS_RECONNECT);
      expect(cursorAfterReconnect).toBeDefined();
      expect(cursorAfterReconnect!.id).not.toBe(cursorBeforeDrop!.id);
    },
    20_000,
  );
});
