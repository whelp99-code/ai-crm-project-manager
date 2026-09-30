/**
 * CLI entry for the Option-D worker (no Temporal).
 *
 * Env:
 *   WORKER_INTERVAL_MS  — when set and > 0, run ticks on this interval; else one shot
 *   WORKER_NOW_ISO      — optional fixed clock for tests/ops; defaults to Date.now()
 *   DATABASE_URL        — optional. When set, the worker opens a `pg` Pool, hydrates
 *                          its GovernanceAuthorizationService from the shared
 *                          orch_governance_controls/orch_governance_intents tables
 *                          (same SoR as apps/api, see G-01), and dual-writes any
 *                          leases it recovers back to that store so lease recovery
 *                          survives a worker restart. When unset, the worker keeps
 *                          a purely in-memory GovernanceAuthorizationService (dev/
 *                          test default) — no durability across restarts.
 *   COMPANY_MEMORY_SB_COMPANY / COMPANY_MEMORY_SB_COMPANY_CONFIG /
 *   COMPANY_MEMORY_SIGNING_KEY_FILE / COMPANY_MEMORY_AUTHORITY_FILE
 *                       — optional. When all four are set to an absolute
 *                          sb-company command plus key files, each tick runs
 *                          the CRM company-memory donor. Absent = disabled.
 *                          Incomplete or unknown COMPANY_MEMORY_* fails
 *                          closed at boot. Personal `sb` is rejected.
 *                          When DATABASE_URL is also set, the tick reads
 *                          pending rows from cwos_v2_mail_outbox and fails
 *                          closed if that schema/queryable is unavailable.
 *                          Empty outbox is used only when DATABASE_URL is
 *                          unset.
 *   ADMIN_DATABASE_URL  — optional (G-01 MEDIUM 4 role separation, mirrors
 *                          apps/api's `ADMIN_DATABASE_URL`). When set, the worker
 *                          opens a SECOND `pg` Pool for cross-workspace admin
 *                          reads/writes — hydrate (`listAllControls`/
 *                          `listAllIntents`) and the outbox drain
 *                          (`claimPendingOutbox`/`markOutboxPublished`) — while
 *                          `DATABASE_URL` becomes a `withWorkspaceScope`-scoped
 *                          pool used only for per-workspace `saveIntent` dual-
 *                          writes, so `DATABASE_URL` can point at a NOBYPASSRLS
 *                          runtime role instead of the admin/superuser role.
 *                          Falls back to the single `DATABASE_URL` pool for both
 *                          concerns when unset (documented dev default — the
 *                          docker superuser DSN bypasses RLS by design).
 *
 * No user-facing HTTP server is started. See docs/ops/worker.md.
 */
import { pathToFileURL } from "node:url";
import { installPgDateStringParser } from "./pg-date-types.js";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
  createPgGovernanceRepository,
  intentToPersisted,
  type GovernanceRepository,
  type GovernancePgQueryable,
  type GovernancePgQueryResult,
} from "@ai-crm/governance";
import { runWorkerTick, type WorkerTickResult } from "./tick.js";
import { runOutboxDrainTick, type OutboxDrainTickResult, type OutboxNotifier } from "./outbox.js";
import {
  runOutboxConsumerTick,
  DEFAULT_OUTBOX_CONSUMER_NAME,
  type OutboxConsumerTickResult,
} from "./outbox-consumer.js";
import {
  loadCompanyMemoryDonorBind,
  runBoundCompanyMemoryDonorTick,
  type CompanyMemoryDonorPgQueryable,
} from "./company-memory-donor-bind.js";

/** Minimal shape of a real `pg.Pool` used here (query + optional end + connect for the outbox drainer). */
interface RealPgPoolConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}
interface RealPgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<RealPgPoolConnection>;
  end?: () => Promise<void>;
}

/**
 * Wraps a raw `pg.Pool` as the governance package's `PgQueryable` port,
 * without `withWorkspaceScope`. Used as the ADMIN queryable — either the
 * dedicated `ADMIN_DATABASE_URL` pool, or (when that's unset) the single
 * fallback `DATABASE_URL` pool: `listAllControls`/`listAllIntents` are
 * already documented cross-workspace admin reads, and outbox drain
 * (`claimPendingOutbox`/`markOutboxPublished`) is likewise a worker/admin
 * concern that does not go through `withWorkspaceScope` (see PgQueryable doc
 * in pg-governance-adapter.ts).
 */
function createPlainPgQueryable(pool: RealPgPool): GovernancePgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]): Promise<GovernancePgQueryResult<T>> {
      const result = await pool.query(text, params);
      return result as GovernancePgQueryResult<T>;
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query<T = unknown>(text: string, params?: unknown[]): Promise<GovernancePgQueryResult<T>> {
          const result = await client.query(text, params);
          return result as GovernancePgQueryResult<T>;
        },
        release: () => client.release(),
      };
    },
  };
}

/**
 * Wraps a raw `pg.Pool` so `PgQueryable.withWorkspaceScope` runs on a single
 * checked-out connection with `SET LOCAL`-equivalent `app.workspace_id`
 * inside a transaction — required for FORCE RLS on
 * orch_governance_controls/orch_governance_intents (0004) to actually scope
 * a NOBYPASSRLS role's per-workspace `saveIntent` writes. Mirrors
 * apps/api/src/app.ts's `createScopedPgQueryable` (G-01 MEDIUM 4 role
 * separation). Only used for the `DATABASE_URL` pool, and only when
 * `ADMIN_DATABASE_URL` is also set (see `loadGovernance`) — otherwise the
 * single fallback pool stays a plain `createPlainPgQueryable` (documented
 * dev behavior: the docker superuser DSN bypasses RLS by design).
 */
function createScopedPgQueryable(pool: RealPgPool): GovernancePgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]): Promise<GovernancePgQueryResult<T>> {
      const result = await pool.query(text, params);
      return result as GovernancePgQueryResult<T>;
    },
    async withWorkspaceScope<T>(
      workspaceId: string,
      fn: (scoped: GovernancePgQueryable) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Postgres does not accept bind parameters in SET/SET LOCAL syntax
        // (`SET LOCAL app.workspace_id = $1` is a syntax error), so use the
        // parameterized set_config(..., is_local=true) equivalent instead.
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: GovernancePgQueryable = {
          async query<T2 = unknown>(text: string, params?: unknown[]): Promise<GovernancePgQueryResult<T2>> {
            const result = await client.query(text, params);
            return result as GovernancePgQueryResult<T2>;
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

export interface WorkerRuntime {
  governance: GovernanceAuthorizationService;
  /**
   * Present only when DATABASE_URL was set and the pool connected
   * successfully. Per-workspace writes (`saveIntent` dual-write of
   * recovered leases) go through this repo — `withWorkspaceScope`-scoped
   * when `ADMIN_DATABASE_URL` is also set, so it can safely run under a
   * NOBYPASSRLS runtime role; otherwise the plain fallback pool (dev
   * default, docker superuser).
   */
  govRepo?: GovernanceRepository;
  /**
   * Present only when DATABASE_URL was set. Cross-workspace admin
   * reads/writes — hydrate (`listAllControls`/`listAllIntents`) and outbox
   * drain (`claimPendingOutbox`/`markOutboxPublished`/`abortOutboxClaim`) —
   * go through this repo. Backed by the dedicated `ADMIN_DATABASE_URL` pool
   * when set; otherwise it is the SAME repo instance as `govRepo` (single
   * fallback pool, documented dev default — see `loadGovernance`).
   */
  adminGovRepo?: GovernanceRepository;
  /**
   * Present only when DATABASE_URL was set. Used solely as the outbox
   * drainer's best-effort `pg_notify` sink (`OutboxNotifier`) — never for
   * governance reads/writes (those all go through `govRepo`/`adminGovRepo`).
   * Points at the admin pool when `ADMIN_DATABASE_URL` is set (the pool the
   * outbox claim transaction actually runs on), else the single fallback pool.
   */
  outboxNotifier?: OutboxNotifier;
  /** Closes the underlying pg Pool(s), if any were opened. No-op otherwise. */
  closePool: () => Promise<void>;
}

/**
 * Builds worker governance for one process lifetime.
 *
 * - DATABASE_URL unset: in-memory GovernanceAuthorizationService (no govRepo).
 * - DATABASE_URL set, ADMIN_DATABASE_URL unset (dev default): opens ONE pg
 *   Pool, wraps it with createPgGovernanceRepository (reused from G-01), and
 *   hydrates the service from listAllControls()/listAllIntents() so the
 *   worker sees the same durable SoR as apps/api. `govRepo` and
 *   `adminGovRepo` are the same repo instance — fine under the docker
 *   superuser DSN, which bypasses RLS by design.
 * - DATABASE_URL AND ADMIN_DATABASE_URL both set (G-01 MEDIUM 4 role
 *   separation, mirrors apps/api): opens TWO pg Pools. `DATABASE_URL` is
 *   wrapped with `createScopedPgQueryable` (`withWorkspaceScope`) and backs
 *   `govRepo`, used only for the per-workspace `saveIntent` dual-write — so
 *   it can run under a NOBYPASSRLS runtime role. `ADMIN_DATABASE_URL` is
 *   wrapped with the plain (unscoped) queryable and backs `adminGovRepo`,
 *   used for hydrate (`listAllControls`/`listAllIntents`) and outbox drain
 *   (`claimPendingOutbox`/`markOutboxPublished`), which are inherently
 *   cross-workspace/admin concerns.
 */
export async function loadGovernance(
  env: Record<string, string | undefined> = process.env,
): Promise<WorkerRuntime> {
  const governance = new GovernanceAuthorizationService(new ActionRegistry({}));
  const databaseUrl = env.DATABASE_URL?.trim();
  const adminDatabaseUrl = env.ADMIN_DATABASE_URL?.trim();
  const noopClose = async () => {};

  if (!databaseUrl) {
    return { governance, closePool: noopClose };
  }

  const pgModuleName = "pg";
  const pgMod = (await import(pgModuleName)) as {
    default?: { Pool: new (cfg: { connectionString: string }) => RealPgPool };
    Pool?: new (cfg: { connectionString: string }) => RealPgPool;
  };
  const PoolCtor = pgMod.Pool ?? pgMod.default?.Pool;
  if (!PoolCtor) {
    throw new Error("pg module loaded but Pool export was missing");
  }
  installPgDateStringParser(pgMod);

  const rawPool = new PoolCtor({ connectionString: databaseUrl });
  let rawAdminPool: RealPgPool | undefined;

  const runtimeQueryable = adminDatabaseUrl ? createScopedPgQueryable(rawPool) : createPlainPgQueryable(rawPool);
  const govRepo = createPgGovernanceRepository(runtimeQueryable);
  let adminGovRepo = govRepo;

  try {
    // Fail-closed connectivity check so a bad DATABASE_URL cannot silently stay half-open.
    await rawPool.query("select 1 as ok");

    if (adminDatabaseUrl) {
      const createdAdmin = new PoolCtor({ connectionString: adminDatabaseUrl });
      rawAdminPool = createdAdmin;
      // Fail-closed connectivity check, same as the main pool.
      await createdAdmin.query("select 1 as ok");
      adminGovRepo = createPgGovernanceRepository(createPlainPgQueryable(createdAdmin));
    }

    const [controls, intents] = await Promise.all([
      adminGovRepo.listAllControls(),
      adminGovRepo.listAllIntents(),
    ]);
    governance.hydrate({ controls, intents });
  } catch (error) {
    // Do not leak either pool if the probe/hydrate fails; loadGovernance is
    // an exported, embeddable API, so a catching long-lived caller must not
    // leak a pool per failed attempt. Close before rethrowing (fail-closed).
    if (rawPool.end) {
      try {
        await rawPool.end();
      } catch {
        // ignore pool shutdown errors during fail-closed cleanup
      }
    }
    if (rawAdminPool?.end) {
      try {
        await rawAdminPool.end();
      } catch {
        // ignore pool shutdown errors during fail-closed cleanup
      }
    }
    throw error;
  }

  return {
    governance,
    govRepo,
    adminGovRepo,
    outboxNotifier: rawAdminPool ?? rawPool,
    closePool: async () => {
      if (rawPool.end) await rawPool.end();
      if (rawAdminPool?.end) await rawAdminPool.end();
    },
  };
}

/**
 * Runs one worker tick and, when a durable govRepo is present, dual-writes any
 * recovered (LEASED -> QUEUED) intents back to the shared store so the
 * recovery survives a worker restart, not just the in-process snapshot.
 */
export async function runDurableWorkerTick(
  runtime: WorkerRuntime,
  nowIso: string,
  log?: (message: string, data?: Record<string, unknown>) => void,
): Promise<WorkerTickResult> {
  const result = runWorkerTick({ governance: runtime.governance, nowIso, ...(log ? { log } : {}) });

  if (runtime.govRepo && result.recoveredLeases.length > 0) {
    const emit = log ?? defaultLog;
    // Best-effort, per-intent durable dual-write (matches apps/api convention):
    // one failed saveIntent must not abort the others or hide the successes.
    const outcomes = await Promise.allSettled(
      result.recoveredLeases.map((intent) => runtime.govRepo!.saveIntent(intentToPersisted(intent))),
    );
    const persisted: string[] = [];
    const failed: string[] = [];
    outcomes.forEach((outcome, index) => {
      const intentId = result.recoveredLeases[index]!.id;
      if (outcome.status === "fulfilled") {
        persisted.push(intentId);
      } else {
        failed.push(intentId);
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        emit("worker.lease_recovered_persist_failed", { intentId, reason });
      }
    });
    if (persisted.length > 0) {
      emit("worker.lease_recovered_persisted", { count: persisted.length, intentIds: persisted });
    }
    if (failed.length > 0) {
      // A failed durable write leaves the row LEASED while in-memory is QUEUED;
      // convergence requires a worker restart to re-hydrate + re-recover it.
      emit("worker.lease_recovered_persist_incomplete", { count: failed.length, intentIds: failed });
    }
  }

  return result;
}
/**
 * Runs one outbox drain tick against `runtime.adminGovRepo` (falling back to
 * `runtime.govRepo` when no dedicated `ADMIN_DATABASE_URL` pool was opened —
 * see `loadGovernance`; outbox drain is a cross-workspace/admin concern, see
 * outbox.ts doc). No-op when neither is present (in-memory/no-DATABASE_URL
 * mode).
 */
export async function runDurableOutboxDrainTick(
  runtime: WorkerRuntime,
  options: { limit?: number; log?: (message: string, data?: Record<string, unknown>) => void } = {},
): Promise<OutboxDrainTickResult> {
  return runOutboxDrainTick(runtime.adminGovRepo ?? runtime.govRepo, {
    ...options,
    ...(runtime.outboxNotifier ? { notifier: runtime.outboxNotifier } : {}),
  });
}
/**
 * Runs one outbox CONSUMER tick (D3, part 2) against `runtime.adminGovRepo`
 * (falling back to `runtime.govRepo`), mirroring `runDurableOutboxDrainTick`'s
 * pool-selection rationale — consumption is a cross-workspace/admin concern
 * like the drain claim, not a per-request one. No-op when neither is present.
 */
export async function runDurableOutboxConsumerTick(
  runtime: WorkerRuntime,
  options: { consumerName?: string; limit?: number; log?: (message: string, data?: Record<string, unknown>) => void } = {},
): Promise<OutboxConsumerTickResult> {
  return runOutboxConsumerTick(runtime.adminGovRepo ?? runtime.govRepo, options);
}

function defaultLog(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.info(message, JSON.stringify(data));
  } else {
    console.info(message);
  }
}

function nowIso(): string {
  const fixed = process.env.WORKER_NOW_ISO?.trim();
  if (fixed) return fixed;
  return new Date().toISOString();
}

async function runOnce(runtime: WorkerRuntime): Promise<void> {
  const result = await runDurableWorkerTick(runtime, nowIso());
  console.info(
    "worker.tick_complete",
    JSON.stringify({
      recovered: result.recoveredLeases.length,
      stuck: result.stuckIntents.length,
      nowIso: result.nowIso,
      durable: Boolean(runtime.govRepo),
    }),
  );

  // Outbox drain (D3 relay/at-least-once) alongside the lease-recover tick,
  // gated on the same DATABASE_URL-backed govRepo. Best-effort: a drain
  // failure never fails the worker tick — the next tick retries.
  if (runtime.govRepo) {
    try {
      const drainResult = await runDurableOutboxDrainTick(runtime);
      if (drainResult.claimed > 0) {
        console.info(
          "worker.outbox_drain_complete",
          JSON.stringify({
            claimed: drainResult.claimed,
            published: drainResult.published.length,
            failed: drainResult.failed.length,
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("worker.outbox_drain_failed", message);
    }

    // Outbox CONSUMER (D3, part 2): durable acked delivery of PUBLISHED rows
    // via idempotent dedup (outbox_consumed_events), converting the drainer's
    // at-least-once emission into effectively-once delivery at this sink.
    // Best-effort: a consumer failure never fails the worker tick.
    try {
      const consumeResult = await runDurableOutboxConsumerTick(runtime, { consumerName: DEFAULT_OUTBOX_CONSUMER_NAME });
      if (consumeResult.candidates > 0) {
        console.info(
          "worker.outbox_consume_complete",
          JSON.stringify({
            consumerName: consumeResult.consumerName,
            candidates: consumeResult.candidates,
            consumed: consumeResult.consumed.length,
            alreadyConsumed: consumeResult.alreadyConsumed.length,
          }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("worker.outbox_consume_failed", message);
    }
  }

  try {
    const donor = await runBoundCompanyMemoryDonorTick(process.env, {
      queryable: runtime.outboxNotifier as CompanyMemoryDonorPgQueryable | undefined,
    });
    if (!donor.skipped) {
      console.info(
        "worker.company_memory_donor_complete",
        JSON.stringify({
          attempted: donor.result.attempted,
          emitted: donor.result.emitted.length,
          pending: donor.result.pending.length,
          rejected: donor.result.rejected.length,
          rejectedCodes: donor.result.rejected.map((item) => item.code),
        }),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("worker.company_memory_donor_failed", message);
  }
}

async function main(): Promise<void> {
  loadCompanyMemoryDonorBind(process.env);
  const runtime = await loadGovernance();
  const intervalRaw = process.env.WORKER_INTERVAL_MS?.trim();
  const intervalMs = intervalRaw ? Number(intervalRaw) : 0;

  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    console.info("worker.interval_start", JSON.stringify({ intervalMs, durable: Boolean(runtime.govRepo) }));
    await runOnce(runtime);
    const timer = setInterval(() => {
      runOnce(runtime).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("worker.tick_failed", message);
      });
    }, intervalMs);
    // `pnpm start` is `sh -c`. Without `exec`, SIGTERM stops pnpm/sh and
    // orphans this process (interval + inherited stdio keep the tree up).
    // When the signal does reach us, drop the interval and the pg pool
    // before exiting with the conventional 128+signal code.
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      runtime.closePool().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("worker.shutdown_failed", message);
      }).finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    return;
  }

  await runOnce(runtime);
  await runtime.closePool();
}

// CLI entrypoint guard: only auto-run when this module is the process's
// entry file (e.g. `node --experimental-strip-types src/main.ts`), not when
// imported by tests for loadGovernance/runDurableWorkerTick.
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("worker.fatal", message);
    process.exitCode = 1;
  });
}
