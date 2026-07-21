/**
 * outbox_events drainer/relay (D3): closes the "governance appendAuditEvents
 * enqueues PENDING outbox_events, but nothing drains them" gap.
 *
 * `runOutboxDrainTick` claims a batch of PENDING rows via
 * `GovernanceRepository.claimPendingOutbox` (real `SELECT ... FOR UPDATE
 * SKIP LOCKED` held open across the relay step — see that method's doc for
 * why the transaction must stay open), RELAYs each one, then marks the
 * successfully-relayed ids PUBLISHED via `markOutboxPublished`.
 *
 * Relay target: a structured `[OUTBOX_PUBLISHED] id=.. workspace=..
 * event_type=..` log line (always), plus a best-effort `pg_notify` on
 * `OUTBOX_NOTIFY_CHANNEL` when a `notifier` is supplied (so a live
 * LISTEN-ing subscriber sees it too — NOTIFY failures never block marking
 * a row published; the log line is the durable-enough relay evidence).
 *
 * At-least-once, NOT exactly-once: relay happens strictly BEFORE
 * `markOutboxPublished`. If the process crashes/throws between relaying and
 * that call, `claimPendingOutbox`'s transaction is never committed —
 * Postgres rolls it back on connection loss, the claimed rows stay
 * PENDING/unlocked, and the NEXT `runOutboxDrainTick` re-claims and
 * re-relays them. Consumers of the relay target MUST be idempotent on
 * `id` if they require exactly-once semantics downstream.
 */
import type { GovernanceRepository, PersistedOutboxEventRow } from "@ai-crm/governance";

/** Channel the relay best-effort NOTIFYs on. Payload is keys-only (id/workspace/event_type), never the row body. */
export const OUTBOX_NOTIFY_CHANNEL = "ai_crm_outbox_events";

/** Minimal capability needed to best-effort NOTIFY after a relay. A plain `pg.Pool`/raw connection satisfies this. */
export interface OutboxNotifier {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export type OutboxLogFn = (message: string, data?: Record<string, unknown>) => void;

export interface RunOutboxDrainTickOptions {
  /** Max rows claimed per tick. Default 25. */
  limit?: number;
  log?: OutboxLogFn;
  /** When supplied, each successfully log-relayed row also gets a best-effort `pg_notify`. */
  notifier?: OutboxNotifier;
}

export interface OutboxDrainTickResult {
  claimed: number;
  published: string[];
  failed: string[];
}

const EMPTY_RESULT: OutboxDrainTickResult = { claimed: 0, published: [], failed: [] };

function defaultLog(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.info(message, JSON.stringify(data));
  } else {
    console.info(message);
  }
}

/** The required relay side effect: a structured, greppable log line. MUST be safe to emit more than once per event (at-least-once). */
function relayOutboxRowLog(row: PersistedOutboxEventRow, log: OutboxLogFn): void {
  log(`[OUTBOX_PUBLISHED] id=${row.id} workspace=${row.workspaceId} event_type=${row.eventType}`);
}

/** Best-effort NOTIFY relay. Payload is keys-only — see `OUTBOX_NOTIFY_CHANNEL` doc. Throws on failure; caller treats it as non-fatal. */
async function relayOutboxRowNotify(notifier: OutboxNotifier, row: PersistedOutboxEventRow): Promise<void> {
  const payload = JSON.stringify({ outboxId: row.id, workspaceId: row.workspaceId, eventType: row.eventType });
  await notifier.query("SELECT pg_notify($1, $2)", [OUTBOX_NOTIFY_CHANNEL, payload]);
}

/**
 * One outbox drain tick. No-op (returns zeros, does not touch the repo) when
 * `govRepo` is undefined — outbox drain only applies to the durable
 * (DATABASE_URL-backed) store; the in-memory dev/test default has nothing to
 * drain in the same sense.
 */
export async function runOutboxDrainTick(
  govRepo: GovernanceRepository | undefined,
  options: RunOutboxDrainTickOptions = {},
): Promise<OutboxDrainTickResult> {
  if (!govRepo) return EMPTY_RESULT;
  const { limit = 25, log = defaultLog, notifier } = options;

  const claimed = await govRepo.claimPendingOutbox(limit);
  if (claimed.length === 0) return EMPTY_RESULT;

  const published: string[] = [];
  const failed: string[] = [];
  for (const row of claimed) {
    try {
      relayOutboxRowLog(row, log);
      if (notifier) {
        try {
          await relayOutboxRowNotify(notifier, row);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          log("worker.outbox_notify_failed", { id: row.id, reason });
        }
      }
      published.push(row.id);
    } catch (error) {
      failed.push(row.id);
      const reason = error instanceof Error ? error.message : String(error);
      log("worker.outbox_relay_failed", { id: row.id, reason });
    }
  }

  if (published.length > 0) {
    await govRepo.markOutboxPublished(published);
    log("worker.outbox_published", { count: published.length, ids: published });
  } else {
    // Every relay failed for this batch — abort (rollback) so the whole
    // claimed batch stays PENDING/unlocked for the next tick's retry,
    // rather than committing a no-op UPDATE.
    await govRepo.abortOutboxClaim();
  }
  if (failed.length > 0) {
    log("worker.outbox_relay_incomplete", { count: failed.length, ids: failed });
  }

  return { claimed: claimed.length, published, failed };
}
