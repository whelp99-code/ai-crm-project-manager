import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadGovernance,
  runDurableOutboxDrainTick,
  runDurableOutboxConsumerTick,
  type WorkerRuntime,
} from "../src/main.js";

/**
 * D3 outbox_events durable ACKED CONSUMER against REAL PostgreSQL
 * (LIVE_PG_TEST=1) — the second half of the "at-least-once EMISSION, not
 * DELIVERY" gap closure. `outbox-drain.live-pg.integration.test.ts` already
 * proves the drainer/relay (PENDING -> PUBLISHED). This test proves the
 * consumer on top of it:
 *
 *  1. Drain then consume: seeded PENDING rows are drained to PUBLISHED, then
 *     consumed exactly once at the durable sink (`outbox_consumed_events`) —
 *     one row per (consumer_name, outbox_id).
 *  2. Redelivery no-op: running the consumer tick AGAIN over the same
 *     already-consumed backlog produces zero new candidates (the persisted
 *     cursor already skips them) — no duplicate sink rows.
 *  3. Crash-between-apply-and-offset: simulates a consumer that durably
 *     applied the sink insert (`outbox_consumed_events`) but crashed before
 *     its own bookkeeping advanced further — the NEXT tick's `listConsumableOutbox`
 *     still returns the row (offset didn't advance in this scenario) but
 *     `applyOutboxConsumed`'s `ON CONFLICT DO NOTHING` makes the redelivery a
 *     no-op: zero newly-consumed ids, dedup ledger stays at exactly one row
 *     for that id.
 *  4. Monotonic offset: the persisted `outbox_consumer_offsets` cursor never
 *     regresses across ticks.
 *
 * Guarded by `LIVE_PG_TEST=1` so CI without a live Postgres stays green.
 * Targets the AI-CRM docker postgres only (default
 * `postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm`) — override via
 * `DATABASE_URL`. Mirrors outbox-drain.live-pg.integration.test.ts's
 * migration bootstrap + workspace seed pattern.
 *
 * Run this file on its own (`vitest run test/outbox-consumer.live-pg...`),
 * not combined with outbox-drain.live-pg.integration.test.ts in the SAME
 * vitest invocation: both drain PENDING outbox_events globally
 * (cross-workspace by design, like `claimPendingOutbox`), and vitest's
 * default file-level parallelism would let their concurrent global drains
 * race over each other's seeded rows, producing spurious count mismatches
 * unrelated to either suite's actual correctness (see docs/ops/worker.md's
 * "## Tests" — each live-pg file is documented as its own separate command).
 */
const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const smokeScript = join(repoRoot, "packages/persistence/scripts/pg-rls-smoke.sh");

const WS_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CONSUMER_NAME = "outbox-consumer-livepg-test";

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

async function cleanupFixtures(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`);
    await client.query(`ALTER TABLE audit_chain_heads DISABLE TRIGGER audit_chain_heads_no_delete`);
    try {
      await client.query(`DELETE FROM outbox_consumed_events WHERE consumer_name = $1`, [CONSUMER_NAME]);
      await client.query(`DELETE FROM outbox_consumer_offsets WHERE consumer_name = $1`, [CONSUMER_NAME]);
      await client.query(`DELETE FROM outbox_events WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM audit_events WHERE workspace_id = $1`, [WS_ID]);
      await client.query(`DELETE FROM audit_chain_heads WHERE workspace_id = $1`, [WS_ID]);
    } finally {
      await client.query(`ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`);
      await client.query(`ALTER TABLE audit_chain_heads ENABLE TRIGGER audit_chain_heads_no_delete`);
    }
  });
}

describe.skipIf(!LIVE)("D3 outbox_events durable acked consumer against REAL Postgres (LIVE_PG_TEST=1)", () => {
  beforeAll(async () => {
    execFileSync("bash", [smokeScript], {
      env: {
        ...process.env,
        PGHOST: "localhost",
        PGPORT: "5432",
        PGUSER: "ai_crm",
        PGPASSWORD: "ai_crm_dev",
        PGDATABASE: "ai_crm",
      },
      stdio: "pipe",
    });

    await withClient(async (client) => {
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [WS_ID, "outbox-consumer-livepg"],
      );
    });
    await cleanupFixtures();
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures();
    await withClient(async (client) => {
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [WS_ID]);
    });
    for (const runtime of openRuntimes.splice(0)) {
      await runtime.closePool();
    }
  }, 60_000);

  async function seedPendingOutbox(count: number, kind: string): Promise<string[]> {
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
    return withClient(async (client) => {
      const outboxRows = await client.query(
        `SELECT id FROM outbox_events WHERE workspace_id = $1 AND audit_event_id = ANY($2::uuid[])`,
        [WS_ID, auditEventIds],
      );
      return (outboxRows.rows as Array<{ id: string }>).map((r) => r.id);
    });
  }

  async function consumedRowsFor(ids: string[]): Promise<Array<{ outbox_id: string; consumer_name: string }>> {
    return withClient(async (client) => {
      const result = await client.query(
        `SELECT outbox_id, consumer_name FROM outbox_consumed_events WHERE consumer_name = $1 AND outbox_id = ANY($2::uuid[])`,
        [CONSUMER_NAME, ids],
      );
      return result.rows as Array<{ outbox_id: string; consumer_name: string }>;
    });
  }

  it(
    "drains PENDING to PUBLISHED, then consumes each PUBLISHED row exactly once at the durable sink",
    async () => {
      const eventIds = await seedPendingOutbox(3, "OUTBOX_CONSUMER_BASIC");

      const drainRuntime = await openRuntime();
      const drainResult = await runDurableOutboxDrainTick(drainRuntime, { limit: 50 });
      for (const id of eventIds) expect(drainResult.published).toContain(id);

      const consumeRuntime = await openRuntime();
      const logs: string[] = [];
      const consumeResult = await runDurableOutboxConsumerTick(consumeRuntime, {
        consumerName: CONSUMER_NAME,
        limit: 50,
        log: (message) => logs.push(message),
      });

      expect(consumeResult.candidates).toBeGreaterThanOrEqual(eventIds.length);
      for (const id of eventIds) {
        expect(consumeResult.consumed).toContain(id);
        expect(consumeResult.alreadyConsumed).not.toContain(id);
        expect(
          logs.some(
            (line) => line === `[OUTBOX_CONSUMED] id=${id} workspace=${WS_ID} event_type=OUTBOX_CONSUMER_BASIC consumer=${CONSUMER_NAME}`,
          ),
        ).toBe(true);
      }

      const sinkRows = await consumedRowsFor(eventIds);
      expect(sinkRows).toHaveLength(eventIds.length);
      for (const id of eventIds) {
        expect(sinkRows.filter((r) => r.outbox_id === id)).toHaveLength(1);
      }

      expect(consumeResult.offset).toBeDefined();
      expect(eventIds).toContain(consumeResult.offset!.lastConsumedId);
    },
    30_000,
  );

  it(
    "running the consumer tick again over the SAME already-consumed backlog is a no-op: zero new candidates, no duplicate sink rows",
    async () => {
      const eventIds = await seedPendingOutbox(2, "OUTBOX_CONSUMER_REDELIVERY");

      const drainRuntime = await openRuntime();
      await runDurableOutboxDrainTick(drainRuntime, { limit: 50 });

      const consumeRuntime1 = await openRuntime();
      const first = await runDurableOutboxConsumerTick(consumeRuntime1, { consumerName: CONSUMER_NAME, limit: 50 });
      for (const id of eventIds) expect(first.consumed).toContain(id);
      const offsetAfterFirst = first.offset!;

      // Second tick over the identical PUBLISHED backlog: the persisted
      // cursor already skips everything <= offsetAfterFirst, so this MUST
      // return zero candidates for ids at/below that cursor.
      const consumeRuntime2 = await openRuntime();
      const second = await runDurableOutboxConsumerTick(consumeRuntime2, { consumerName: CONSUMER_NAME, limit: 50 });
      expect(second.consumed.filter((id) => eventIds.includes(id))).toHaveLength(0);

      const sinkRows = await consumedRowsFor(eventIds);
      expect(sinkRows).toHaveLength(eventIds.length);
      for (const id of eventIds) {
        expect(sinkRows.filter((r) => r.outbox_id === id)).toHaveLength(1);
      }

      // Offset never regresses.
      expect(second.offset).toBeDefined();
      expect(
        second.offset!.lastConsumedCreatedAt > offsetAfterFirst.lastConsumedCreatedAt ||
          (second.offset!.lastConsumedCreatedAt === offsetAfterFirst.lastConsumedCreatedAt &&
            second.offset!.lastConsumedId >= offsetAfterFirst.lastConsumedId),
      ).toBe(true);
    },
    30_000,
  );

  it(
    "crash-between-apply-and-offset: redelivery of an already-sink-applied id is a no-op (dedup keeps exactly-once at the sink)",
    async () => {
      const [eventId] = await seedPendingOutbox(1, "OUTBOX_CONSUMER_CRASH");
      expect(eventId).toBeDefined();

      const drainRuntime = await openRuntime();
      await runDurableOutboxDrainTick(drainRuntime, { limit: 50 });

      // 1. Simulate the sink apply succeeding directly against the repo
      //    (models `applyOutboxConsumed` committing its `outbox_consumed_events`
      //    insert) — a "crash" here means the caller never got to observe/act
      //    on the result, not that the DB write rolled back (there is no open
      //    claim/txn to roll back for the consumer, unlike the drainer's
      //    claim — the dedup table itself is the safety net).
      const crashRuntime = await openRuntime();
      const candidates = await crashRuntime.adminGovRepo!.listConsumableOutbox(CONSUMER_NAME, 50);
      const claimedRow = candidates.find((r) => r.id === eventId);
      expect(claimedRow).toBeDefined();
      const firstApply = await crashRuntime.adminGovRepo!.applyOutboxConsumed(CONSUMER_NAME, [claimedRow!]);
      expect(firstApply.newlyConsumed).toContain(eventId);

      const sinkAfterFirst = await consumedRowsFor([eventId!]);
      expect(sinkAfterFirst).toHaveLength(1);

      // 2. Next real consumer tick: `listConsumableOutbox` will NOT return
      //    this id again (offset advanced past it in step 1's
      //    applyOutboxConsumed), proving the offset-based skip already
      //    prevents rework — and even if it were re-listed (e.g. a
      //    different/newer consumer_name), `applyOutboxConsumed`'s
      //    ON CONFLICT DO NOTHING keeps the sink at exactly one row.
      const retryRuntime = await openRuntime();
      const retryResult = await runDurableOutboxConsumerTick(retryRuntime, { consumerName: CONSUMER_NAME, limit: 50 });
      expect(retryResult.consumed).not.toContain(eventId);

      // Directly exercise the redelivery-no-op path: re-apply the exact same
      // row again (as if a crash caused a second delivery attempt) and
      // assert zero newly-consumed ids + the sink still has exactly one row.
      const secondApply = await retryRuntime.adminGovRepo!.applyOutboxConsumed(CONSUMER_NAME, [claimedRow!]);
      expect(secondApply.newlyConsumed).toHaveLength(0);

      const sinkAfterRedelivery = await consumedRowsFor([eventId!]);
      expect(sinkAfterRedelivery).toHaveLength(1);
    },
    30_000,
  );

  it("consumer offset advances monotonically across ticks", async () => {
    const batch1 = await seedPendingOutbox(1, "OUTBOX_CONSUMER_MONOTONIC_1");
    const drainRuntime1 = await openRuntime();
    await runDurableOutboxDrainTick(drainRuntime1, { limit: 50 });
    const consumeRuntime1 = await openRuntime();
    const tick1 = await runDurableOutboxConsumerTick(consumeRuntime1, { consumerName: CONSUMER_NAME, limit: 50 });
    expect(tick1.consumed).toContain(batch1[0]);
    const offset1 = tick1.offset!;

    const batch2 = await seedPendingOutbox(1, "OUTBOX_CONSUMER_MONOTONIC_2");
    const drainRuntime2 = await openRuntime();
    await runDurableOutboxDrainTick(drainRuntime2, { limit: 50 });
    const consumeRuntime2 = await openRuntime();
    const tick2 = await runDurableOutboxConsumerTick(consumeRuntime2, { consumerName: CONSUMER_NAME, limit: 50 });
    expect(tick2.consumed).toContain(batch2[0]);
    const offset2 = tick2.offset!;

    const advanced =
      offset2.lastConsumedCreatedAt > offset1.lastConsumedCreatedAt ||
      (offset2.lastConsumedCreatedAt === offset1.lastConsumedCreatedAt && offset2.lastConsumedId > offset1.lastConsumedId);
    expect(advanced).toBe(true);
  }, 30_000);

  it(
    "no-loss regression: a never-consumed row whose created_at COMMITS earlier than the persisted cursor is still " +
      "consumed (proves NOT EXISTS, not the (created_at,id) offset, is the sole correctness filter — a " +
      "transaction-start-vs-commit-time skew must never cause silent permanent under-delivery)",
    async () => {
      // 1. Seed + drain + consume row B first, advancing this consumer's
      //    persisted `outbox_consumer_offsets` cursor to B's (created_at, id).
      const [rowB] = await seedPendingOutbox(1, "OUTBOX_NOLOSS_B");
      expect(rowB).toBeDefined();
      const drainRuntimeB = await openRuntime();
      await runDurableOutboxDrainTick(drainRuntimeB, { limit: 50 });
      const consumeRuntimeB = await openRuntime();
      const tickB = await runDurableOutboxConsumerTick(consumeRuntimeB, { consumerName: CONSUMER_NAME, limit: 50 });
      expect(tickB.consumed).toContain(rowB);
      const offsetAfterB = tickB.offset!;

      // 2. Seed + drain row A AFTER B, then directly backdate its
      //    `created_at` to a timestamp strictly BELOW the cursor just
      //    advanced in step 1. This models a transaction that STARTED
      //    before B but COMMITTED after B already advanced the offset —
      //    row A has NEVER been consumed by this consumer.
      const [rowA] = await seedPendingOutbox(1, "OUTBOX_NOLOSS_A");
      expect(rowA).toBeDefined();
      const drainRuntimeA = await openRuntime();
      await runDurableOutboxDrainTick(drainRuntimeA, { limit: 50 });
      await withClient(async (client) => {
        await client.query(`UPDATE outbox_events SET created_at = $1 WHERE id = $2`, [
          "2000-01-01T00:00:00.000Z",
          rowA,
        ]);
      });
      const backdated = await withClient(async (client) => {
        const result = await client.query<{ created_at: Date }>(`SELECT created_at FROM outbox_events WHERE id = $1`, [
          rowA,
        ]);
        return result.rows[0]!.created_at;
      });
      expect(backdated.toISOString() < offsetAfterB.lastConsumedCreatedAt).toBe(true);

      // 3. Row A must have never been consumed by this consumer.
      const sinkBeforeConsume = await consumedRowsFor([rowA!]);
      expect(sinkBeforeConsume).toHaveLength(0);

      // 4. Run the consumer tick. Under the OLD offset-gated query
      //    (`(created_at, id) > cursor`), row A's backdated `created_at`
      //    would be permanently and silently excluded here — this assertion
      //    is the falsifiable proof that the fix removed that gate.
      const consumeRuntimeA = await openRuntime();
      const tickA = await runDurableOutboxConsumerTick(consumeRuntimeA, { consumerName: CONSUMER_NAME, limit: 50 });
      expect(tickA.consumed).toContain(rowA);

      const sinkAfterConsume = await consumedRowsFor([rowA!]);
      expect(sinkAfterConsume).toHaveLength(1);
    },
    30_000,
  );
});
