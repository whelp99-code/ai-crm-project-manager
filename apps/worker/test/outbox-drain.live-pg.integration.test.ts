import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGovernance, runDurableOutboxDrainTick, type WorkerRuntime } from "../src/main.js";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";

/**
 * D3 outbox drainer/relay against REAL PostgreSQL (LIVE_PG_TEST=1).
 *
 * Governance's `appendAuditEvents` already dual-writes PENDING
 * `outbox_events` rows (N-08/D3); until this test, nothing drained them.
 * Proves, against the real docker `ai_crm` Postgres:
 *
 *  1. PENDING -> PUBLISHED: seeded outbox rows are claimed, relayed (log
 *     line observed), and marked PUBLISHED with `published_at` set.
 *  2. SKIP LOCKED, no double-publish: two concurrent drainers (two
 *     independent `loadGovernance` runtimes / pg connections) racing the
 *     SAME PENDING backlog never claim the same row twice — the union of
 *     both batches is exactly the seeded set, with zero overlap.
 *  3. At-least-once re-relay: a claim that is aborted (simulating a worker
 *     crash between relay and `markOutboxPublished` — the transaction never
 *     commits) leaves the row PENDING; the NEXT drain tick reclaims and
 *     re-relays the SAME row before it is finally marked PUBLISHED.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Mirrors worker-durable.live-pg.integration.test.ts's
 * migration bootstrap + workspace seed pattern.
 */
const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const openRuntimes: WorkerRuntime[] = [];
async function openRuntime(): Promise<WorkerRuntime> {
  const runtime = await loadGovernance({ DATABASE_URL });
  openRuntimes.push(runtime);
  return runtime;
}

async function withClient<T>(fn: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { Client } = (await import("pg")) as typeof import("pg");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function cleanupOutbox(): Promise<void> {
  await withClient(async (client) => {
    // audit_events / audit_chain_heads are append-only / no-delete by
    // trigger even for the superuser session (see
    // sor-restart-livepg.integration.test.ts). Disable the two triggers for
    // this teardown connection only, delete the fixtures, then restore them.
    await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
    await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
    try {
      await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [WS_ID]);
    } finally {
      await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
      await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
    }
  });
}

describe.skipIf(!LIVE)("D3 outbox_events drainer/relay against REAL Postgres (LIVE_PG_TEST=1)", () => {
  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        ...pgSmokeConnectionEnv(DATABASE_URL),
      },
      stdio: "pipe",
    });

    await withClient(async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_ID, "outbox-drain-livepg"],
      );
    });
  }, 60_000);


  afterAll(async () => {
    await cleanupOutbox();
    await withClient(async (client) => {
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [WS_ID]);
    });
    for (const runtime of openRuntimes.splice(0)) {
      await runtime.closePool();
    }
  }, 60_000);

  async function seedPendingOutbox(count: number, kind = "OUTBOX_DRAIN_TEST"): Promise<string[]> {
    const runtime = await openRuntime();
    const results = await runtime.govRepo!.appendAuditEvents(
      WS_ID,
      Array.from({ length: count }, (_, i) => ({
        kind,
        subjectId: `subject-${i}`,
        data: { i },
      })),
    );
    const auditEventIds = results.map((r) => r.id);
    // `appendAuditEvents` returns `audit_events.id`, NOT the separate
    // `outbox_events.id` the drainer claims/publishes by — translate via the
    // `audit_event_id` FK so callers assert against the right identifier.
    return withClient(async (client) => {
      const outboxRows = await client.query(
        `SELECT id FROM outbox_events WHERE workspace_id = $1 AND audit_event_id = ANY($2::uuid[])`,
        [WS_ID, auditEventIds],
      );
      return (outboxRows.rows as Array<{ id: string }>).map((r) => r.id);
    });
  }

  async function outboxStatuses(): Promise<Map<string, { status: string; published_at: string | null }>> {
    return withClient(async (client) => {
      const result = await client.query(
        `SELECT id, status, published_at FROM outbox_events WHERE workspace_id = $1`,
        [WS_ID],
      );
      const map = new Map<string, { status: string; published_at: string | null }>();
      for (const row of result.rows as Array<{ id: string; status: string; published_at: string | null }>) {
        map.set(row.id, { status: row.status, published_at: row.published_at });
      }
      return map;
    });
  }

  it(
    "claims PENDING outbox_events, relays each (log line observed), and marks them PUBLISHED",
    async () => {
      const eventIds = await seedPendingOutbox(2, "OUTBOX_DRAIN_BASIC");
      const before = await outboxStatuses();
      for (const id of eventIds) expect(before.get(id)?.status).toBe("PENDING");

      const runtime = await openRuntime();
      const logs: string[] = [];
      const result = await runDurableOutboxDrainTick(runtime, {
        limit: 50,
        log: (message) => logs.push(message),
      });

      expect(result.claimed).toBeGreaterThanOrEqual(eventIds.length);
      expect(result.failed).toHaveLength(0);
      for (const id of eventIds) {
        expect(result.published).toContain(id);
        expect(logs.some((line) => line === `[OUTBOX_PUBLISHED] id=${id} workspace=${WS_ID} event_type=OUTBOX_DRAIN_BASIC`)).toBe(
          true,
        );
      }

      const after = await outboxStatuses();
      for (const id of eventIds) {
        expect(after.get(id)?.status).toBe("PUBLISHED");
        expect(after.get(id)?.published_at).not.toBeNull();
      }
    },
    30_000,
  );

  it(
    "2 concurrent drainers claim the PENDING backlog via SKIP LOCKED with zero overlap (no double-publish)",
    async () => {
      const eventIds = await seedPendingOutbox(6, "OUTBOX_DRAIN_CONCURRENT");
      expect(eventIds).toHaveLength(6);

      const runtimeA = await openRuntime();
      const runtimeB = await openRuntime();

      // Real concurrency: fire both drain ticks together so their
      // `SELECT ... FOR UPDATE SKIP LOCKED` claims genuinely race over the
      // network, not just interleave cooperatively in one event-loop turn.
      const [resultA, resultB] = await Promise.all([
        runDurableOutboxDrainTick(runtimeA, { limit: 4 }),
        runDurableOutboxDrainTick(runtimeB, { limit: 4 }),
      ]);

      const claimedA = new Set(resultA.published);
      const claimedB = new Set(resultB.published);
      const overlap = [...claimedA].filter((id) => claimedB.has(id));
      expect(overlap).toHaveLength(0);

      const union = new Set([...claimedA, ...claimedB]);
      expect(union.size).toBe(6);
      for (const id of eventIds) expect(union.has(id)).toBe(true);

      const after = await outboxStatuses();
      for (const id of eventIds) {
        expect(after.get(id)?.status).toBe("PUBLISHED");
      }
    },
    30_000,
  );

  it(
    "at-least-once: a claim aborted between relay and mark (simulated crash) leaves the row PENDING for re-relay on the next tick",
    async () => {
      const [eventId] = await seedPendingOutbox(1, "OUTBOX_DRAIN_CRASH");
      expect(eventId).toBeDefined();

      // 1. Simulated crash: claim + relay directly against the repo, then
      //    ABORT instead of marking published — models a process that
      //    relayed the event but died before `markOutboxPublished`
      //    committed. The open claim transaction rolls back.
      const crashRuntime = await openRuntime();
      const firstClaim = await crashRuntime.govRepo!.claimPendingOutbox(50);
      const claimedRow = firstClaim.find((r) => r.id === eventId);
      expect(claimedRow).toBeDefined();
      const relayedFirstAttempt = `[OUTBOX_PUBLISHED] id=${claimedRow!.id} workspace=${claimedRow!.workspaceId} event_type=${claimedRow!.eventType}`;
      await crashRuntime.govRepo!.abortOutboxClaim();

      const midway = await outboxStatuses();
      expect(midway.get(eventId!)?.status).toBe("PENDING");
      expect(midway.get(eventId!)?.published_at).toBeNull();

      // 2. Next real drain tick: reclaims and RE-relays the same row before
      //    finally marking it PUBLISHED.
      const retryRuntime = await openRuntime();
      const logs: string[] = [];
      const retryResult = await runDurableOutboxDrainTick(retryRuntime, {
        limit: 50,
        log: (message) => logs.push(message),
      });
      expect(retryResult.published).toContain(eventId);
      expect(logs).toContain(relayedFirstAttempt); // same relay line, observed again = re-relay proof

      const after = await outboxStatuses();
      expect(after.get(eventId!)?.status).toBe("PUBLISHED");
      expect(after.get(eventId!)?.published_at).not.toBeNull();
    },
    30_000,
  );
});
