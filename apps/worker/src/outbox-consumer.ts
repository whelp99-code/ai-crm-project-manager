/**
 * outbox_events durable ACKED CONSUMER (D3, part 2): closes the "at-least-once
 * EMISSION, not DELIVERY" gap left by `outbox.ts`'s drainer/relay.
 *
 * `runOutboxDrainTick` (see outbox.ts) claims PENDING rows, RELAYs them (a
 * structured log line, plus best-effort NOTIFY), and marks them PUBLISHED.
 * That is emission, not delivery: nothing durably ACKS that a PUBLISHED row
 * was actually applied anywhere. `runOutboxConsumerTick` is that missing
 * consumer: it reads PUBLISHED rows a given `consumerName` has not yet
 * durably consumed (via `GovernanceRepository.listConsumableOutbox`), APPLIES
 * each to a durable sink — an idempotent insert into `outbox_consumed_events`
 * (`ON CONFLICT (consumer_name, outbox_id) DO NOTHING`, see
 * 0006_outbox_consumer.sql) plus a structured `[OUTBOX_CONSUMED]` log line —
 * then advances that consumer's persisted cursor
 * (`outbox_consumer_offsets`).
 *
 * Effectively-once delivery at the sink: the drainer's relay is at-least-once
 * (a crash between relay and `markOutboxPublished` re-relays the same row on
 * the next drain tick). The consumer inherits that same at-least-once
 * redelivery risk — a crash between `applyOutboxConsumed` committing the
 * dedup insert and this tick's caller observing success could cause the next
 * tick to re-list and re-apply the SAME row — but `applyOutboxConsumed`'s
 * `ON CONFLICT (consumer_name, outbox_id) DO NOTHING` makes every re-apply a
 * no-op at the sink: the row is inserted at most once, no matter how many
 * times it is redelivered. That converts at-least-once emission into
 * effectively-once delivery at this sink.
 */
import type { GovernanceRepository, PersistedOutboxEventRow } from "@ai-crm/governance";

/** Default logical consumer name used by the worker's built-in tick when no override is supplied. */
export const DEFAULT_OUTBOX_CONSUMER_NAME = "worker-default";

export type OutboxConsumerLogFn = (message: string, data?: Record<string, unknown>) => void;

export interface RunOutboxConsumerTickOptions {
  /** Logical consumer identity — its own independent cursor/dedup ledger. Default `DEFAULT_OUTBOX_CONSUMER_NAME`. */
  consumerName?: string;
  /** Max rows consumed per tick. Default 25. */
  limit?: number;
  log?: OutboxConsumerLogFn;
}

export interface OutboxConsumerTickResult {
  consumerName: string;
  /** Rows returned by `listConsumableOutbox` this tick (PUBLISHED, not yet consumed by `consumerName`). */
  candidates: number;
  /** Ids newly applied to the durable sink this tick — the true idempotent-dedup sink effect. */
  consumed: string[];
  /** Candidate ids that turned out to already be consumed at the sink (redelivery no-op proof). */
  alreadyConsumed: string[];
  /** This consumer's persisted cursor after the tick (undefined only if it has never consumed anything). */
  offset: { lastConsumedId: string; lastConsumedCreatedAt: string } | undefined;
}

function defaultLog(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.info(message, JSON.stringify(data));
  } else {
    console.info(message);
  }
}

/** The durable sink's required side effect: a structured, greppable log line. Safe to emit more than once per (consumer, id) — the sink's real dedup is `outbox_consumed_events`, not this log line. */
function logConsumedRow(row: PersistedOutboxEventRow, consumerName: string, log: OutboxConsumerLogFn): void {
  log(`[OUTBOX_CONSUMED] id=${row.id} workspace=${row.workspaceId} event_type=${row.eventType} consumer=${consumerName}`);
}

const EMPTY_RESULT_FOR = (consumerName: string): OutboxConsumerTickResult => ({
  consumerName,
  candidates: 0,
  consumed: [],
  alreadyConsumed: [],
  offset: undefined,
});

/**
 * One outbox consumer tick. No-op (returns zeros, does not touch the repo)
 * when `govRepo` is undefined — consumption only applies to the durable
 * (DATABASE_URL-backed) store, mirroring `runOutboxDrainTick`'s no-op
 * contract in outbox.ts.
 */
export async function runOutboxConsumerTick(
  govRepo: GovernanceRepository | undefined,
  options: RunOutboxConsumerTickOptions = {},
): Promise<OutboxConsumerTickResult> {
  const { consumerName = DEFAULT_OUTBOX_CONSUMER_NAME, limit = 25, log = defaultLog } = options;
  if (!govRepo) return EMPTY_RESULT_FOR(consumerName);

  const candidates = await govRepo.listConsumableOutbox(consumerName, limit);
  if (candidates.length === 0) {
    const offset = await govRepo.getOutboxConsumerOffset(consumerName);
    return { consumerName, candidates: 0, consumed: [], alreadyConsumed: [], offset };
  }

  for (const row of candidates) {
    logConsumedRow(row, consumerName, log);
  }

  const { newlyConsumed } = await govRepo.applyOutboxConsumed(consumerName, candidates);
  const newlyConsumedSet = new Set(newlyConsumed);
  const alreadyConsumed = candidates.map((row) => row.id).filter((id) => !newlyConsumedSet.has(id));
  const offset = await govRepo.getOutboxConsumerOffset(consumerName);

  log("worker.outbox_consumed", {
    consumerName,
    candidates: candidates.length,
    consumed: newlyConsumed.length,
    alreadyConsumed: alreadyConsumed.length,
  });

  return { consumerName, candidates: candidates.length, consumed: newlyConsumed, alreadyConsumed, offset };
}
