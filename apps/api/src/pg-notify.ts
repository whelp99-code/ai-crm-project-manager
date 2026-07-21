/**
 * Cross-process eventing via PostgreSQL LISTEN/NOTIFY (N-09 / D6).
 *
 * `EventHub` (event-hub.ts) is single-process only: a mutation on API
 * instance A never reaches a `?live=1` SSE subscriber connected to instance
 * B. This module closes that gap when a real PG pool is configured, WITHOUT
 * weakening tenant isolation:
 *
 *  - `publishNotify` sends a Postgres `NOTIFY` whose payload carries ONLY
 *    `{workspaceId, jobId, eventId, kind}` — NEVER row bodies. Two reasons:
 *    (1) `NOTIFY`/`LISTEN` payloads are NOT RLS-protected — every listener on
 *    the channel receives every payload regardless of `app.workspace_id`;
 *    (2) Postgres caps a NOTIFY payload at ~8000 bytes. `encodeNotifyPayload` (inline size guard)
 *    (via `encodeNotifyPayload`) enforces the keys-only contract defensively.
 *  - `PgNotifyBridge` holds a dedicated LISTEN connection (not the scoped
 *    per-request pool). On every notification it NEVER trusts the payload's
 *    implied row content — it re-reads the actual `orch_job_events` row(s)
 *    through `PgQueryable.withWorkspaceScope(workspaceId, ...)`, so FORCE RLS
 *    (0003) filters cross-tenant rows before anything reaches a local
 *    `EventHub.publish` (and therefore before any SSE client). A NOTIFY that
 *    claims a workspace it cannot actually read from ends up reading zero
 *    rows — no leak, by construction.
 *  - `NOTIFY`/`LISTEN` fires only post-commit and has NO replay: a
 *    disconnected/reconnecting listener misses every notification sent while
 *    it was down. `orch_job_events` (the durable outbox, 0003) remains
 *    source of truth — `reconcileWorkspace`/the automatic post-(re)connect
 *    `reconcileAll` catch up any tracked workspace from its last-seen
 *    `(at, id)` cursor, so a reconnect never silently drops history.
 *
 * See docs/ops/eventing.md for the full residual/scope writeup.
 */
import type { PgQueryable } from "@ai-crm/orchestration";

/** Channel every AI-CRM API process LISTENs/NOTIFYs on. */
export const PG_NOTIFY_CHANNEL = "ai_crm_agent_events";

/** Postgres hard-caps a NOTIFY payload around 8000 bytes; we assert well under that. */
export const MAX_NOTIFY_PAYLOAD_BYTES = 8000;

/** Keys-only NOTIFY payload shape. NEVER add row-body fields here. */
export interface NotifyKeys {
  workspaceId: string;
  jobId: string;
  eventId: string;
  kind: string;
}

/** Row shape read back from `orch_job_events` during a scoped re-read/reconcile. */
export interface PgNotifyEventRow {
  id: string;
  job_id: string;
  kind: string;
  at: string;
}

/**
 * Serializes `keys` and asserts the encoded payload stays under the
 * `NOTIFY` payload cap. Throws `PgNotifyPayloadTooLargeError` rather than
 * silently truncating — a truncated payload could reference the wrong job.
 */
export function encodeNotifyPayload(keys: NotifyKeys): string {
  const json = JSON.stringify(keys);
  const size = Buffer.byteLength(json, "utf8");
  if (size >= MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new PgNotifyPayloadTooLargeError(size);
  }
  return json;
}

export class PgNotifyPayloadTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(
      `[PG_NOTIFY_PAYLOAD_TOO_LARGE] encoded NOTIFY payload is ${bytes} bytes, >= the ${MAX_NOTIFY_PAYLOAD_BYTES}-byte cap. ` +
        "NOTIFY payloads must stay keys-only ({workspaceId, jobId, eventId, kind}) — never row bodies.",
    );
  }
}

/** Minimal query surface `publishNotify` needs — any `PgQueryable` (scoped or not) satisfies it. */
export interface NotifyPublisher {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

/** Sends the keys-only NOTIFY. Safe to call on the plain (unscoped) pool — no row data crosses this call. */
export async function publishNotify(
  pool: NotifyPublisher,
  keys: NotifyKeys,
  channel: string = PG_NOTIFY_CHANNEL,
): Promise<void> {
  const payload = encodeNotifyPayload(keys);
  await pool.query("SELECT pg_notify($1, $2)", [channel, payload]);
}

/** Minimal `pg.Client`-shaped surface the bridge needs for a dedicated LISTEN connection. */
export interface PgListenClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: "error" | "end", listener: (err?: unknown) => void): unknown;
  end(): Promise<void>;
}

interface Cursor {
  at: string;
  id: string;
}

const EPOCH_CURSOR: Cursor = { at: "1970-01-01T00:00:00.000Z", id: "" };

export interface PgNotifyBridgeOptions {
  /** Scoped pool (implements `withWorkspaceScope`) used ONLY for the re-read/reconcile query. */
  pool: PgQueryable;
  /** Opens a fresh dedicated LISTEN connection. Called on start and on every reconnect. */
  connect: () => Promise<PgListenClient>;
  /** Invoked once per recovered row (already RLS-scoped) to fan into the local `EventHub`. */
  onEvent: (event: { workspaceId: string; jobId: string; kind: string }) => void;
  channel?: string;
  /** Reconnect backoff base, ms. Defaults to 200; doubles per attempt, capped at 5000. */
  reconnectBaseMs?: number;
  log?: (message: string) => void;
}

/**
 * Owns one dedicated LISTEN connection, fans recovered `orch_job_events`
 * rows into the local `EventHub`, and reconciles any tracked workspace from
 * its durable-log cursor on every (re)connect. See module doc comment.
 */
export class PgNotifyBridge {
  private readonly cursors = new Map<string, Cursor>();
  private readonly channel: string;
  private client: PgListenClient | undefined;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  constructor(private readonly opts: PgNotifyBridgeOptions) {
    this.channel = opts.channel ?? PG_NOTIFY_CHANNEL;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore shutdown errors
      }
    }
  }

  /** Test/ops hook: current last-seen (at, id) cursor for a workspace, if tracked. */
  cursorFor(workspaceId: string): { at: string; id: string } | undefined {
    return this.cursors.get(workspaceId);
  }

  /**
   * Starts tracking `workspaceId` with the EPOCH cursor, so the next
   * reconcile call replays its full `orch_job_events` history once). No-op
   * if already tracked. Call before a listener gap you want fully covered.
   */
  trackWorkspace(workspaceId: string): void {
    if (!this.cursors.has(workspaceId)) this.cursors.set(workspaceId, EPOCH_CURSOR);
  }

  /** Simulates a connection drop for tests: closes the socket without stopping the bridge (auto-reconnects). */
  async simulateDisconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const client = await this.opts.connect();
    this.client = client;
    client.on("notification", (msg) => {
      if (msg.channel !== this.channel) return;
      void this.handleNotification(msg.payload);
    });
    client.on("error", () => this.scheduleReconnect());
    client.on("end", () => this.scheduleReconnect());
    await client.query(`LISTEN ${this.channel}`);
    this.reconnectAttempt = 0;
    // Reconnect reconcile (post-connect, including the very first connect):
    // catch up every already-tracked workspace from its durable-log cursor
    // in case NOTIFYs were missed while this connection was down/absent.
    await this.reconcileAll();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.opts.reconnectBaseMs ?? 200;
    const delay = Math.min(5000, base * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      void this.connectOnce().catch((error) => {
        this.opts.log?.(`[PG_NOTIFY_RECONNECT_FAILED] ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async handleNotification(payloadText?: string): Promise<void> {
    if (!payloadText) return;
    let keys: NotifyKeys;
    try {
      keys = JSON.parse(payloadText) as NotifyKeys;
    } catch {
      return;
    }
    if (!keys.workspaceId || !keys.jobId) return;
    this.trackWorkspace(keys.workspaceId);
    try {
      await this.reconcileWorkspace(keys.workspaceId);
    } catch (error) {
      this.opts.log?.(
        `[PG_NOTIFY_RECONCILE_FAILED] workspaceId=${keys.workspaceId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Re-reads `orch_job_events` for `workspaceId` since the last-seen cursor
   * through `withWorkspaceScope` (FORCE RLS) — row content NEVER comes from
   * the NOTIFY payload. Publishes one event per recovered row (in (at, id)
   * order) via `onEvent` and advances the cursor. Public so both the
   * notification handler and reconnect/backfill paths share one code path;
   * also callable directly to force-reconcile a workspace (e.g. tests).
   */
  async reconcileWorkspace(workspaceId: string): Promise<number> {
    const pool = this.opts.pool;
    const withScope = pool.withWorkspaceScope;
    if (!withScope) {
      throw new Error(
        "[PG_NOTIFY_UNSCOPED_POOL] PgNotifyBridge requires a PgQueryable with withWorkspaceScope (FORCE RLS re-read); refusing to read orch_job_events without workspace scoping.",
      );
    }
    const cursor = this.cursors.get(workspaceId) ?? EPOCH_CURSOR;
    const result = await withScope(workspaceId, (scoped) =>
      scoped.query<PgNotifyEventRow>(
        `SELECT id, job_id, kind, at::text AS at FROM orch_job_events
         WHERE workspace_id = $1 AND (at, id) > ($2, $3)
         ORDER BY at ASC, id ASC`,
        [workspaceId, cursor.at, cursor.id],
      ),
    );
    let advanced = cursor;
    for (const row of result.rows) {
      this.opts.onEvent({ workspaceId, jobId: row.job_id, kind: row.kind });
      advanced = { at: row.at, id: row.id };
    }
    this.cursors.set(workspaceId, advanced);
    return result.rows.length;
  }

  private async reconcileAll(): Promise<void> {
    for (const workspaceId of [...this.cursors.keys()]) {
      try {
        await this.reconcileWorkspace(workspaceId);
      } catch (error) {
        // Best-effort: one workspace's re-read failure must not crash the
        // bridge or block reconciling the others.
        this.opts.log?.(
          `[PG_NOTIFY_RECONCILE_FAILED] workspaceId=${workspaceId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
