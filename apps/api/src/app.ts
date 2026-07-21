import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  CrmDomainError,
  CrmService,
  DeliveryDomainError,
  DeliveryService,
  PmDomainError,
  PmService,
  baselinePayloadHash,
  classifyBaselineMutation,
  createPgCrmRepository,
  createPgCrmSubRepository,
  createPgPmRepository,
  type AuthorizationReceipt,
  type BaselinePatch,
  type Communication,
  type CrmRepository,
  type CrmSubRepository,
  type CustomerContract,
  type DeliveryProject,
  type FinanceSummary,
  type NextAction,
  type OperationalException,
  type PmAssignment,
  type PmCheckpointReceipt,
  type PmPlan,
  type PmRepository,
  type PmTarget,
  type ProjectSummary,
  type TargetObservation,
  type VarianceException,
} from "@ai-crm/domain";
import { ImportDomainError, ImportService, type ImportSourceKind } from "@ai-crm/imports";
import {
  DailyGate,
  FinanceDomainError,
  LedgerService,
  ReconciliationService,
  type DayRecord,
  type FinancePackConfig,
  type StatementRowRef,
} from "@ai-crm/finance";
import {
  createPgLedgerRepository,
  type LedgerRepository,
} from "@ai-crm/finance/pg-finance-ledger-adapter";
import {
  createPgDailyGateRepository,
  createPgFinanceReconciliationRepository,
  type DailyGateRepository,
  type FinanceReconciliationRepository,
} from "@ai-crm/finance/pg-finance-recon-adapter";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
  GovernanceError,
  controlFromPersisted,
  controlToPersisted,
  createPgGovernanceRepository,
  intentToPersisted,
  type Binding,
  type GovernanceRepository,
  type GovernanceState,
} from "@ai-crm/governance";
import {
  ModelGateway,
  ModelGatewayError,
  resolveModelClientFromEnv,
  type ModelClient,
  type StructuredOutputSchema,
} from "@ai-crm/model-gateway";
import { AiOrchestrator, AiOrchestratorError } from "@ai-crm/ai-orchestrator";
import {
  OrchestrationError,
  OrchestrationService,
  createPgOrchestrationRepository,
  type OrchestrationStore,
  type PgQueryable,
} from "@ai-crm/orchestration";
import { ReportDomainError, ReportService, type FinalReportSnapshot } from "@ai-crm/reports";
import { canonicalHashOf } from "@ai-crm/policy-engine";
import {
  NaturalCommandError,
  NaturalCommandService,
} from "./services/natural-command.js";
import { PgNotifyBridge, publishNotify, PG_NOTIFY_CHANNEL, type PgListenClient } from "./pg-notify.js";
import { EventHub } from "./event-hub.js";
import { buildOpenApiDocument, type RouteInfo } from "./openapi.js";

/**
 * Minimal shape of a real `pg.Pool`/`pg.Client` connection checked out via
 * `pool.connect()`: enough to run `SET LOCAL app.workspace_id`, the scoped
 * statement(s), and release the connection back to the pool.
 */
interface PgPoolConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

interface RealPgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgPoolConnection>;
  end?: () => Promise<void>;
}

/**
 * Wraps a real `pg.Pool` so `PgQueryable.withWorkspaceScope` runs on a
 * single checked-out connection with `SET LOCAL app.workspace_id` inside a
 * transaction — required for FORCE RLS on orch_jobs / orch_work_items /
 * orch_job_events (0003) and orch_governance_controls / orch_governance_intents
 * (0004) to actually scope per-workspace reads/writes. A plain
 * `pool.query()` per call would check out a *different* connection each
 * time, so `SET LOCAL` on one call would silently not apply to the next —
 * that was the RLS scoping gap this wrapper closes. `query()` on the
 * returned object stays a thin passthrough to `pool.query()` for ops that
 * are not workspace-scoped (fail-closed `select 1`, hydrate-on-boot
 * `listAllControls`/`listAllIntents`/`listJobSnapshots()` cross-workspace
 * admin reads under the docker `ai_crm` superuser, which bypasses RLS by
 * design — see docs/ops/sor-persistence.md for the production scoping note).
 */
function createScopedPgQueryable(pool: RealPgPool): PgQueryable {
  return {
    async query<T = unknown>(text: string, params?: unknown[]) {
      const result = await pool.query(text, params);
      return result as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Postgres does not accept bind parameters in SET/SET LOCAL syntax
        // (`SET LOCAL app.workspace_id = $1` is a syntax error), so use the
        // parameterized set_config(..., is_local=true) equivalent instead.
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const scoped: PgQueryable = {
          async query<T2 = unknown>(text: string, params?: unknown[]) {
            const result = await client.query(text, params);
            return result as { rows: T2[]; rowCount: number | null };
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

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CrmDomainError("INVALID_INPUT", "body must be an object");
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new CrmDomainError("INVALID_INPUT", `${key} is required`);
  return value;
}

function numberValue(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CrmDomainError("INVALID_INPUT", `${key} must be a finite number`);
  return value;
}

function workspace(request: FastifyRequest): string {
  const value = request.headers["x-workspace-id"];
  if (typeof value !== "string" || !value.trim()) throw new CrmDomainError("WORKSPACE_REQUIRED", "x-workspace-id header is required");
  return value;
}

function principal(request: FastifyRequest): string {
  const value = request.headers["x-principal-id"];
  if (typeof value !== "string" || !value.trim()) {
    throw new NaturalCommandError("PRINCIPAL_REQUIRED", "x-principal-id header is required");
  }
  return value;
}

function headerText(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export class AuthnError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthnError";
    this.code = code;
  }
}

function resolveConfiguredApiKey(options: CreateAppOptions): string | undefined {
  if (typeof options.authApiKey === "string" && options.authApiKey.trim()) {
    return options.authApiKey.trim();
  }
  if (typeof process === "undefined" || !process.env) return undefined;
  const fromAuth = typeof process.env.AUTH_API_KEY === "string" ? process.env.AUTH_API_KEY.trim() : "";
  if (fromAuth) return fromAuth;
  const fromAlias = typeof process.env.API_AUTH_TOKEN === "string" ? process.env.API_AUTH_TOKEN.trim() : "";
  return fromAlias || undefined;
}

function extractPresentedApiKey(request: FastifyRequest): string | undefined {
  const headerKey = headerText(request, "x-api-key");
  if (headerKey) return headerKey;
  const authorization = headerText(request, "authorization");
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim();
  return token || undefined;
}

function apiKeysEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Path without query string. */
function requestPath(request: FastifyRequest): string {
  const url = request.url ?? "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Versioned-alias-aware: `/api` and `/v1` are both treated as the API
 * namespace. A naive `/v1` alias that only added routes without extending
 * this predicate would silently bypass the onRequest API-key auth hook below
 * (SECURITY-CRITICAL — see N-10). Any new version prefix must be added here,
 * not layered on top via a separate check.
 */
function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || path === "/v1" || path.startsWith("/v1/");
}

/** Same versioned-alias-aware rule as isApiPath, scoped to the agent surface. */
function isAgentPath(path: string): boolean {
  return (
    path === "/api/agent" ||
    path.startsWith("/api/agent/") ||
    path === "/v1/agent" ||
    path.startsWith("/v1/agent/")
  );
}

function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

function arrayOfStrings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CrmDomainError("INVALID_INPUT", `${key} must be a string array`);
  }
  return value as string[];
}

/** Registry of governance-protected commands; callers never choose the ActionType. */
export const GOVERNANCE_COMMANDS = {
  "customer.send": "CUSTOMER_SEND",
  "project.scope_change": "SCOPE_CHANGE",
  "project.schedule_change": "SCHEDULE_CHANGE",
  "contract.change": "CONTRACT_CHANGE",
  "finance.invoice_issue": "INVOICE_ISSUE",
  "finance.payment_execute": "PAYMENT_EXECUTE",
  "finance.ledger_post": "LEDGER_POST",
  "record.delete": "DELETE_RECORD",
  "permission.change": "PERMISSION_CHANGE",
  "pm.plan_revise": "PM_PLAN_REVISE",
  "pm.task_assign": "PM_TASK_ASSIGN",
  "pm.target_set": "PM_TARGET_SET",
  "pm.plan_create": "PM_PLAN_CREATE",
  "finance.verify": "FINANCE_VERIFY",
  "internal.update": "INTERNAL_REVERSIBLE_UPDATE",
} as const;

export interface CreateAppOptions {
  /**
   * Accounting-pack configuration. Finance routes and the customer-360
   * finance projection stay fail-closed (503 / pending) until it is injected;
   * the pack is `BLOCKING — unset` until certified review signs real values.
   *
   * Explicit test fixtures may pass `financePack` directly. Pilot/local
   * bootstrap of an *unsigned* pack is only honest when
   * `DEV_UNSIGNED_FINANCE_PACK=1` and `NODE_ENV !== 'production'` (and/or
   * `allowUnsignedFinancePack: true` on non-prod bootstrap). Production must
   * not enable unsigned pack by default — see `docs/ops/finance-pack-pilot.md`.
   */
  financePack?: FinancePackConfig;
  /**
   * Non-prod bootstrap only: acknowledges an unsigned/pilot `financePack`.
   * Tests may omit this and still inject `financePack` as an explicit fixture.
   * Production loaders must not set this. See `docs/ops/finance-pack-pilot.md`
   * and env gate `DEV_UNSIGNED_FINANCE_PACK=1`.
   */
  allowUnsignedFinancePack?: boolean;
  /**
   * Injected model provider adapter. The model-invoke route stays fail-closed
   * (503) until it is supplied; only the model-gateway runtime constructs one.
   */
  modelClient?: ModelClient;
  modelServicePrincipalId?: string;
  /** Maximum minor defects a passing AI review may carry. */
  aiMinorThreshold?: number;
  /**
   * Optional Postgres connection string. Defaults to `process.env.DATABASE_URL`
   * when omitted. When set (and no `pgPool` injected), `pg` is dynamically
   * imported and a Pool is constructed with a fail-closed `select 1` on ready.
   * Request path SoR remains in-memory; successful agent mutations best-effort
   * dual-write orch snapshots + governance controls/intents.
   */
  databaseUrl?: string;
  /**
   * Injected minimal queryable (Pool / PoolClient / test double). Takes
   * precedence over `databaseUrl`. Shape matches orchestration/governance adapters.
   */
  pgPool?: PgQueryable;
  /**
   * Optional Postgres connection string used ONLY for the hydrate-on-boot
   * cross-workspace admin reads (`listAllControls` / `listAllIntents` /
   * `listJobSnapshots()` no-arg). Defaults to `process.env.ADMIN_DATABASE_URL`
   * when omitted. Production role-separation: point this at a role that can
   * read across workspaces (e.g. `ai_crm_audit_verifier` semantics or a
   * dedicated admin role) instead of granting the per-request runtime pool
   * BYPASSRLS. When unset, hydrate falls back to the main pool/DSN — the
   * documented dev behavior where the docker bootstrap `ai_crm` superuser
   * bypasses RLS by design. See `docs/ops/sor-persistence.md`. Per-request
   * scoped queries always use the main `databaseUrl`/`pgPool`, never this.
   */
  adminDatabaseUrl?: string;
  /**
   * Optional shared API key for fail-closed authn. When set (or when
   * `AUTH_API_KEY` / `API_AUTH_TOKEN` env is set), mutating `/api/*` methods
   * and all `/api/agent/*` routes require `x-api-key` or `Authorization: Bearer`.
   * See `docs/ops/authn.md`.
   */
  authApiKey?: string;
  /**
   * Escape hatch for the production fail-closed auth guard. When
   * `NODE_ENV==='production'` and no `AUTH_API_KEY`/`API_AUTH_TOKEN`/`authApiKey`
   * is configured, `createApp` throws by default (fail-closed) so a prod deploy
   * can never silently run unauthenticated. Set this to `true` (or env
   * `ALLOW_INSECURE_PROD=1`) only for an explicit, audited insecure bring-up.
   */
  allowInsecureProd?: boolean;
  /**
   * Live-mode `/api/agent/jobs/:id/events?live=1` SSE connections auto-close
   * with `stream.end` after this many ms of no further mutation, so a client
   * that never disconnects cannot pin a subscriber (and a test) open forever.
   * Default 30000. See docs/ops/eventing.md.
   */
  sseLiveTimeoutMs?: number;
  /**
   * Cross-process eventing (N-09 / D6): when a real Postgres pool is opened
   * from `databaseUrl`/`DATABASE_URL` (NOT an injected `pgPool` test double,
   * which has no DSN to open a dedicated LISTEN connection from), a
   * `PgNotifyBridge` opens a dedicated LISTEN connection on
   * `ai_crm_agent_events` and every agent-mutation NOTIFY publishes a
   * keys-only payload (`{workspaceId, jobId, eventId, kind}` — never row
   * bodies). Defaults to `true`. Set `false` to keep pg mode's per-process
   * `EventHub` in-process-only (matches pre-N-09 behavior). See
   * docs/ops/eventing.md.
   */
  pgNotify?: boolean;
  /** Overrides the LISTEN/NOTIFY channel name. Defaults to `ai_crm_agent_events`. Test-only knob. */
  pgNotifyChannel?: string;
}

/** Runtime decoration attached to the Fastify instance for tests / ops. */
export interface AiCrmRuntime {
  persistenceMode: "memory" | "pg";
  pool?: PgQueryable;
  orchStore?: OrchestrationStore;
  govRepo?: GovernanceRepository;
  /** PG-backed CRM customers repository (N-12 / D2). Absent in memory mode. */
  crmRepo?: CrmRepository;
  /** PG-backed CRM sub-aggregates repository (PG-A / P6-b G001). Absent in memory mode. */
  crmSubRepo?: CrmSubRepository;
  /** PG-backed PM + delivery repository (PG-B / P6-b G001). Absent in memory mode. */
  pmRepo?: PmRepository;
  /** PG-backed finance ledger repository (PG-C1 / F6, PG-first fail-closed). Absent in memory mode. */
  ledgerRepo?: LedgerRepository;
  /** PG-backed finance reconciliation repository (PG-C2 / P6-b G001). Absent in memory mode. */
  financeReconRepo?: FinanceReconciliationRepository;
  /** PG-backed daily-gate repository (PG-C2 / P6-b G001). Absent in memory mode. */
  dailyGateRepo?: DailyGateRepository;
  /**
   * Count of best-effort dual-write failures (DUALWRITE_FAILED) observed
   * since boot. Memory stays authoritative for the request path; this is
   * exposed for future /metrics wiring and test assertions only.
   */
  dualWriteFailures: number;
  /**
   * Fail-closed authn posture actually in effect for this instance (G-05):
   * `"apikey"` when AUTH_API_KEY/API_AUTH_TOKEN/options.authApiKey resolved
   * to a configured key, `"dev"` otherwise (header-principal mode, see
   * docs/ops/authn.md). Production deployments must resolve `"apikey"`;
   * see docs/ops/runtime-dsn.md for the fail-closed contract.
   */
  authMode: "apikey" | "dev";
  /**
   * Live snapshot of every route Fastify has registered (populated via the
   * `onRoute` hook, not hand-maintained), filtered/annotated into the
   * `GET /api/agent/openapi.json` document by openapi.ts. Exposed for tests
   * that need to prove the machine spec cannot drift from the real route
   * table.
   */
  /**
   * Hydrate-on-boot snapshot of `audit_chain_heads.head_sequence` per
   * workspace (N-08 / D3), read from PG at boot via `getAuditChainHead`
   * for every workspace observed in the hydrated controls/intents. Proves
   * a fresh instance is aware of the continuing PG chain (does not restart
   * numbering from 1) — real audit sequence allocation for NEW events still
   * always re-reads the live head under `FOR UPDATE` in
   * `PgGovernanceRepository.appendAuditEvents`, this snapshot is exposed
   * only for tests/ops visibility. Absent in memory mode.
   */
  auditChainHeads?: Record<string, number>;
  registeredRoutes: RouteInfo[];
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const configuredApiKey = resolveConfiguredApiKey(options);
  const isProdEnv = typeof process !== "undefined" && process.env?.NODE_ENV === "production";
  const allowInsecureProd =
    options.allowInsecureProd === true ||
    (typeof process !== "undefined" && process.env?.ALLOW_INSECURE_PROD === "1");
  if (!configuredApiKey && isProdEnv) {
    if (!allowInsecureProd) {
      // Fail-closed at construction: a production deploy must never silently
      // run unauthenticated. Set allowInsecureProd / ALLOW_INSECURE_PROD=1 only
      // for an explicit, audited insecure bring-up. See docs/ops/runtime-dsn.md.
      throw new Error(
        "[AUTH_REQUIRED_IN_PROD] NODE_ENV=production but no AUTH_API_KEY/API_AUTH_TOKEN/authApiKey configured; " +
          "refusing to start unauthenticated. Configure an API key or set ALLOW_INSECURE_PROD=1 for an audited insecure bring-up.",
      );
    }
    console.warn(
      "[AUTH_DISABLED_IN_PROD] NODE_ENV=production with no API key but ALLOW_INSECURE_PROD is set; " +
        "running in dev header-principal mode. This is an audited insecure bring-up. See docs/ops/runtime-dsn.md.",
    );
  }

  // Fail-closed API key gate (T-017). When AUTH_API_KEY / API_AUTH_TOKEN /
  // options.authApiKey is set, require x-api-key or Authorization: Bearer on
  // mutating /api/* and all /api/agent/* routes. When unset, keep header
  // principal mode for local/dev (documented in docs/ops/authn.md).
  app.addHook("onRequest", async (request) => {
    if (!configuredApiKey) return;
    const path = requestPath(request);
    if (!isApiPath(path)) return;
    const requiresKey = isMutatingMethod(request.method) || isAgentPath(path);
    if (!requiresKey) return;
    const presented = extractPresentedApiKey(request);
    if (!presented || !apiKeysEqual(presented, configuredApiKey)) {
      throw new AuthnError("UNAUTHENTICATED", "valid API key required (x-api-key or Authorization: Bearer)");
    }
  });
  // Live route registry (N-10): single source for GET /api/agent/openapi.json
  // and its drift test — records every route as Fastify actually registers
  // it, not a hand-maintained list that could silently fall out of sync.
  const registeredRoutes: RouteInfo[] = [];
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      registeredRoutes.push({ method: String(method).toUpperCase(), path: routeOptions.url });
    }
  });
  // Pilot-grade in-process rate limiting (N-10): per-workspace fixed/tumbling
  // 1-minute window counter. Not distributed/durable — documented as
  // pilot-grade in the openapi.json description. Advisory headers only;
  // does not (yet) reject over-limit requests, matching the "echo +
  // observe" scope of this deliverable.
  const AGENT_RATE_LIMIT_PER_MINUTE = 120;
  const agentRateLimitWindows = new Map<string, { windowStart: number; count: number }>();
  function noteAgentCommandRateLimit(workspaceId: string): { limit: number; remaining: number } {
    const now = Date.now();
    const windowMs = 60_000;
    let entry = agentRateLimitWindows.get(workspaceId);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { windowStart: now, count: 0 };
      agentRateLimitWindows.set(workspaceId, entry);
    }
    entry.count += 1;
    return { limit: AGENT_RATE_LIMIT_PER_MINUTE, remaining: Math.max(0, AGENT_RATE_LIMIT_PER_MINUTE - entry.count) };
  }
  const crm = new CrmService();
  const delivery = new DeliveryService();
  const pm = new PmService();
  const financePack = options.financePack;
  const ledger = financePack ? new LedgerService(financePack) : undefined;
  const reconciliation = financePack ? new ReconciliationService(financePack) : undefined;
  const dailyGates = new Map<string, DailyGate>();
  const governance = new GovernanceAuthorizationService(new ActionRegistry(GOVERNANCE_COMMANDS));
  const aiOrchestrator = new AiOrchestrator({ minorThreshold: options.aiMinorThreshold ?? 0 });
  const reports = new ReportService();
  const modelServicePrincipalId = options.modelServicePrincipalId ?? "principal-model-gateway";
  // D7: explicit injection (tests / callers) always wins. Otherwise resolve a
  // live client from MODEL_PROVIDER; unset/mock/none keeps today's offline
  // fail-closed default byte-for-byte unchanged.
  const resolvedModelClient = options.modelClient ?? resolveModelClientFromEnv();
  const modelGateway = resolvedModelClient
    ? new ModelGateway(resolvedModelClient, {
        servicePrincipalId: modelServicePrincipalId,
        resolveOperation: () => "MODEL_INVOKE",
      })
    : undefined;
  const orchestration = new OrchestrationService();
  const naturalCommands = new NaturalCommandService({
    orchestration,
    governance,
    modelGateway,
    modelServicePrincipalId,
    pm,
  });
  // In-process live SSE fanout (G-03). Single-process only — see
  // docs/ops/eventing.md for the durable-outbox-vs-live-hub boundary.
  const eventHub = new EventHub();

  // Dual-write spine: request SoR stays in-memory; optional PG pool mirrors
  // orch job snapshots + governance controls/intents for the workspace.
  const resolvedDatabaseUrl =
    options.databaseUrl ??
    (typeof process !== "undefined" && typeof process.env?.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()
      ? process.env.DATABASE_URL.trim()
      : undefined);
  // Admin DSN (G-01 MEDIUM 4 role separation): used ONLY for hydrate-on-boot
  // cross-workspace admin reads. Falls back to the main pool/DSN when unset
  // (documented dev behavior — see CreateAppOptions.adminDatabaseUrl doc).
  const resolvedAdminDatabaseUrl =
    options.adminDatabaseUrl ??
    (typeof process !== "undefined" && typeof process.env?.ADMIN_DATABASE_URL === "string" && process.env.ADMIN_DATABASE_URL.trim()
      ? process.env.ADMIN_DATABASE_URL.trim()
      : undefined);
  let pool: PgQueryable | undefined = options.pgPool;
  // Raw `pg.Pool` handle (pre-scoping-wrapper) kept only for onClose shutdown;
  // `pool` above may be `createScopedPgQueryable(rawPgPool)` once onReady runs.
  let rawPgPool: RealPgPool | undefined;
  // Separate admin `pg.Pool` handle, opened only when `resolvedAdminDatabaseUrl`
  // is set. Used solely for hydrate-on-boot cross-workspace reads below; the
  // per-request scoped `pool` above never uses this.
  let rawAdminPgPool: RealPgPool | undefined;
  let orchStore: OrchestrationStore | undefined;
  let govRepo: GovernanceRepository | undefined;
  let crmRepo: CrmRepository | undefined;
  let crmSubRepo: CrmSubRepository | undefined;
  let pmRepo: PmRepository | undefined;
  let ledgerRepo: LedgerRepository | undefined;
  let financeReconRepo: FinanceReconciliationRepository | undefined;
  let dailyGateRepo: DailyGateRepository | undefined;
  // Stores hydrate-on-boot reads from: admin pool when configured, else the
  // main runtime pool/store (fallback documented on CreateAppOptions.adminDatabaseUrl).
  let hydrateOrchStore: OrchestrationStore | undefined;
  let hydrateGovRepo: GovernanceRepository | undefined;
  let hydrateCrmRepo: CrmRepository | undefined;
  let hydrateCrmSubRepo: CrmSubRepository | undefined;
  let hydratePmRepo: PmRepository | undefined;
  let hydrateFinanceReconRepo: FinanceReconciliationRepository | undefined;
  let hydrateDailyGateRepo: DailyGateRepository | undefined;
  // Cross-process eventing (N-09 / D6): opened in onReady only when a real
  // `databaseUrl`/`DATABASE_URL` pool is configured and `options.pgNotify`
  // is not explicitly `false`. See pg-notify.ts module doc comment.
  let notifyBridge: PgNotifyBridge | undefined;
  const notifyChannel = options.pgNotifyChannel ?? PG_NOTIFY_CHANNEL;
  let persistenceMode: AiCrmRuntime["persistenceMode"] = "memory";

  if (!pool && resolvedDatabaseUrl) {
    // Synchronous mode marker; Pool opens in onReady (dynamic `pg` import).
    persistenceMode = "pg";
  }

  if (pool) {
    orchStore = createPgOrchestrationRepository(pool);
    govRepo = createPgGovernanceRepository(pool);
    crmRepo = createPgCrmRepository(pool);
    crmSubRepo = createPgCrmSubRepository(pool);
    pmRepo = createPgPmRepository(pool);
    ledgerRepo = createPgLedgerRepository(pool);
    financeReconRepo = createPgFinanceReconciliationRepository(pool);
    dailyGateRepo = createPgDailyGateRepository(pool);
    persistenceMode = "pg";
    // Fallback hydrate source when no adminDatabaseUrl is configured (dev default).
    hydrateOrchStore = orchStore;
    hydrateGovRepo = govRepo;
    hydrateCrmRepo = crmRepo;
    hydrateCrmSubRepo = crmSubRepo;
    hydratePmRepo = pmRepo;
    hydrateFinanceReconRepo = financeReconRepo;
    hydrateDailyGateRepo = dailyGateRepo;
  }

  const aiCrm: AiCrmRuntime = {
    persistenceMode,
    dualWriteFailures: 0,
    authMode: configuredApiKey ? "apikey" : "dev",
    registeredRoutes,
  };
  if (pool) aiCrm.pool = pool;
  if (orchStore) aiCrm.orchStore = orchStore;
  if (govRepo) aiCrm.govRepo = govRepo;
  if (crmRepo) aiCrm.crmRepo = crmRepo;
  if (crmSubRepo) aiCrm.crmSubRepo = crmSubRepo;
  if (pmRepo) aiCrm.pmRepo = pmRepo;
  if (ledgerRepo) aiCrm.ledgerRepo = ledgerRepo;
  if (financeReconRepo) aiCrm.financeReconRepo = financeReconRepo;
  if (dailyGateRepo) aiCrm.dailyGateRepo = dailyGateRepo;
  (app as FastifyInstance & { aiCrm?: AiCrmRuntime }).aiCrm = aiCrm;
  (app as FastifyInstance & { eventHub?: EventHub }).eventHub = eventHub;
  const decorateNotifyBridge = (bridge: PgNotifyBridge | undefined): void => {
    (app as FastifyInstance & { notifyBridge?: PgNotifyBridge | undefined }).notifyBridge = bridge;
  };

  async function dualWriteJobSnapshot(workspaceId: string, jobId: string): Promise<void> {
    const store = orchStore;
    if (!store) return;
    try {
      const snap = naturalCommands.getJob(workspaceId, jobId);
      await store.saveSnapshot(snap);
      // Cross-process NOTIFY (N-09 / D6): fire-and-forget, keys-only, only
      // after the durable dual-write above succeeded — the receiving side
      // re-reads via withWorkspaceScope, so it never depends on payload
      // freshness/correctness beyond "go re-check this job". Never
      // publishes when the mutation had no recorded events yet.
      const lastEvent = snap.events.at(-1);
      if (notifyBridge && pool && lastEvent) {
        try {
          await publishNotify(
            pool,
            { workspaceId, jobId, eventId: lastEvent.id, kind: lastEvent.kind },
            notifyChannel,
          );
        } catch (notifyError) {
          const message = notifyError instanceof Error ? notifyError.message : String(notifyError);
          console.warn(`[PG_NOTIFY_PUBLISH_FAILED] workspaceId=${workspaceId} jobId=${jobId} error=${message}`);
        }
      }
    } catch (error) {
      // Best-effort dual-write; memory SoR remains authoritative for the request path.
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[DUALWRITE_FAILED] target=orch_job_snapshot workspaceId=${workspaceId} jobId=${jobId} error=${message}`,
      );
    }
  }

  async function dualWriteGovernance(workspaceId: string): Promise<void> {
    const repo = govRepo;
    if (!repo) return;
    try {
      const snap = governance.snapshot();
      for (const control of Object.values(snap.controls)) {
        if (control.workspaceId !== workspaceId) continue;
        await repo.saveControl(controlToPersisted(control));
      }
      for (const intent of Object.values(snap.intents)) {
        if (intent.workspaceId !== workspaceId) continue;
        await repo.saveIntent(intentToPersisted(intent));
      }
    } catch (error) {
      // Best-effort dual-write; memory SoR remains authoritative.
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=orch_governance workspaceId=${workspaceId} error=${message}`);
    }
  }

  /**
   * Dual-writes a single CRM customer onto `crm_customers` (N-12 / D2,
   * first CRM domain PG proof). Best-effort like the other dual-write
   * helpers — a failure here never fails the in-flight request; the
   * in-memory `CrmService` stays authoritative for the request path. Scoped
   * to CUSTOMERS ONLY; contracts/communications/nextActions/exceptions are
   * not dual-written yet (documented residual, see docs/ops/sor-persistence.md).
   */
  async function dualWriteCrmCustomer(customer: ReturnType<CrmService["createCustomer"]>): Promise<void> {
    const repo = crmRepo;
    if (!repo) return;
    try {
      await repo.saveCustomer(customer);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=crm_customers workspaceId=${customer.workspaceId} customerId=${customer.id} error=${message}`);
    }
  }
  /**
   * Dual-writes a single CRM contract onto `crm_contracts` (PG-A). Best-effort
   * like `dualWriteCrmCustomer` — never fails the in-flight request.
   */
  async function dualWriteCrmContract(contract: CustomerContract): Promise<void> {
    const repo = crmSubRepo;
    if (!repo) return;
    try {
      await repo.saveContract(contract);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=crm_contracts workspaceId=${contract.workspaceId} contractId=${contract.id} error=${message}`);
    }
  }

  async function dualWriteCrmCommunication(communication: Communication): Promise<void> {
    const repo = crmSubRepo;
    if (!repo) return;
    try {
      await repo.saveCommunication(communication);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=crm_communications workspaceId=${communication.workspaceId} communicationId=${communication.id} error=${message}`);
    }
  }

  async function dualWriteCrmNextAction(action: NextAction): Promise<void> {
    const repo = crmSubRepo;
    if (!repo) return;
    try {
      await repo.saveNextAction(action);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=crm_next_actions workspaceId=${action.workspaceId} actionId=${action.id} error=${message}`);
    }
  }

  async function dualWriteCrmException(exception: OperationalException): Promise<void> {
    const repo = crmSubRepo;
    if (!repo) return;
    try {
      await repo.saveException(exception);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=crm_operational_exceptions workspaceId=${exception.workspaceId} exceptionId=${exception.id} error=${message}`);
    }
  }

  async function dualWritePmPlan(plan: PmPlan): Promise<void> {
    const repo = pmRepo;
    if (!repo) return;
    try {
      await repo.savePlan(plan);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=pm_plans workspaceId=${plan.workspaceId} planId=${plan.id} error=${message}`);
    }
  }

  async function dualWritePmAssignment(assignment: PmAssignment): Promise<void> {
    const repo = pmRepo;
    if (!repo) return;
    try {
      await repo.saveAssignment(assignment);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=pm_assignments workspaceId=${assignment.workspaceId} assignmentId=${assignment.id} error=${message}`);
    }
  }

  async function dualWritePmTarget(target: PmTarget): Promise<void> {
    const repo = pmRepo;
    if (!repo) return;
    try {
      await repo.saveTarget(target);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=pm_targets workspaceId=${target.workspaceId} targetId=${target.id} error=${message}`);
    }
  }

  async function dualWritePmObservation(observation: TargetObservation, exception?: VarianceException): Promise<void> {
    const repo = pmRepo;
    if (!repo) return;
    try {
      await repo.saveObservation(observation);
      if (exception) await repo.saveException(exception);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=pm_target_observations workspaceId=${observation.workspaceId} observationId=${observation.id} error=${message}`);
    }
  }

  async function dualWriteDeliveryProject(project: DeliveryProject): Promise<void> {
    const repo = pmRepo;
    if (!repo) return;
    try {
      await repo.saveProject(project);
    } catch (error) {
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=delivery_projects workspaceId=${project.workspaceId} projectId=${project.id} error=${message}`);
    }
  }

  /**
   * Per-workspace cursor into `governance.listAuditEvents(workspaceId)`
   * (in-memory, append-only within this process) tracking how many of that
   * workspace's audit events have already been dual-written to PG
   * (N-08 / D3). PG allocates its OWN sequence numbers under a row-locked
   * `audit_chain_heads` head (see `PgGovernanceRepository.appendAuditEvents`)
   * independent of the in-memory `AuditEvent.sequence` field, so this map
   * only needs to answer "which in-memory events are new since the last
   * flush for this workspace" — it is NOT the source of PG sequence
   * numbers. Starts empty on process boot; onReady's hydrate-on-boot step
   * (N-13 / D3) seeds it to `governance.listAuditEvents(ws).length` for
   * every workspace whose audit history was just replayed from PG, so a
   * post-restart mutation does not re-flush the hydrated events onto the
   * PG chain a second time — only genuinely new in-memory events flush.
   */
  const dualWrittenAuditCount = new Map<string, number>();

  /**
   * Flushes any in-memory audit events for `workspaceId` created since the
   * last flush onto the real PG audit chain: `audit_events` +
   * `audit_chain_heads` + `outbox_events`, atomically inside one
   * `withWorkspaceScope` transaction (N-08 / D3). Best-effort like the
   * other dual-write helpers — a failure here never fails the in-flight
   * request; memory stays authoritative for the request path.
   */
  async function dualWriteAudit(workspaceId: string): Promise<void> {
    const repo = govRepo;
    if (!repo) return;
    const audits = governance.listAuditEvents(workspaceId);
    const already = dualWrittenAuditCount.get(workspaceId) ?? 0;
    const pending = audits.slice(already);
    if (pending.length === 0) return;
    try {
      await repo.appendAuditEvents(
        workspaceId,
        pending.map((event) => ({ kind: event.kind, subjectId: event.subjectId, data: event.data })),
      );
      dualWrittenAuditCount.set(workspaceId, audits.length);
    } catch (error) {
      // Best-effort dual-write; memory SoR remains authoritative.
      aiCrm.dualWriteFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DUALWRITE_FAILED] target=audit_chain workspaceId=${workspaceId} error=${message}`);
    }
  }
  /**
   * PG-FIRST fail-closed audit append (D3, closes the N-08/§3F residual):
   * mirrors the ledger's `previewDraft`/PG-write/`commitDraft` split
   * (PG-C1). Used ONLY by the governance-bearing mutation routes
   * (authorize/decide/consume) — appends the NEW audit event(s) already
   * present in `preview.draft` (produced by `governance.preview*` but not
   * yet committed to `this.state`) onto `audit_events`/`audit_chain_heads`/
   * `outbox_events` inside one `withWorkspaceScope` transaction and MUST
   * succeed before the caller commits the preview. Unlike `dualWriteAudit`,
   * a PG failure here is NEVER swallowed — it propagates (5xx) so the
   * caller never calls `governance.commit*`, and in-memory governance state
   * therefore never advances past a failed PG audit write. No-op in memory
   * mode (no `govRepo`) — behavior there is byte-identical to before D3.
   */
  async function pgFirstAuditAppend(workspaceId: string, draft: GovernanceState): Promise<void> {
    const repo = govRepo;
    if (!repo) return;
    const pendingAll = draft.audits.filter((event) => event.workspaceId === workspaceId);
    const already = dualWrittenAuditCount.get(workspaceId) ?? 0;
    const pending = pendingAll.slice(already);
    if (pending.length === 0) return;
    await repo.appendAuditEvents(
      workspaceId,
      pending.map((event) => ({ kind: event.kind, subjectId: event.subjectId, data: event.data })),
    );
    dualWrittenAuditCount.set(workspaceId, pendingAll.length);
  }
  /**
   * Per-workspace async mutex (P6-b G002 / PG-D fix, architect P2): the
   * PG-first governance (authorize/decide/consume) and ledger
   * (draft/verify/post/reverse) routes all follow the same
   * preview -> await PG write -> commit shape. The `await` lets a second
   * same-workspace request interleave between preview (snapshot of the
   * pre-image via `structuredClone(this.state)`) and commit (`this.state =
   * draft`): both requests preview from the SAME pre-image, both commit,
   * and the later commit clobbers the earlier in-memory (lost update on
   * GET /audit / GET /controls), while a concurrent pair of
   * `/consume` calls on one APPROVED control can both pass the
   * `control.status === "APPROVED"` preview check before either commits
   * (TOCTOU: two `CONTROL_CONSUMED` for a single-use control). PG chain
   * integrity itself is safe (`FOR UPDATE` on the head row serializes the
   * PG write), but the in-memory SoR can transiently diverge from it and
   * from itself.
   *
   * `withWorkspaceMutex` closes this by serializing the ENTIRE
   * preview->PG-write->commit critical section per workspace: a Promise
   * chain keyed by workspace id, so a second same-workspace mutation's
   * `fn` never starts until the first's has fully settled (success OR
   * failure — a thrown/rejected mutation releases the lock immediately,
   * it never wedges the workspace). Different workspaces get independent
   * chains and never block each other (no global lock, no cross-workspace
   * head-of-line blocking, no deadlock — there is only ever one lock per
   * key, acquired and released in FIFO order, never nested). In-process
   * only (single-instance); multi-instance ordering is already handled by
   * PG's `FOR UPDATE` head lock plus the documented single-instance
   * eventing note. Memory mode is unaffected: the mutex still serializes
   * the in-memory preview/commit pair even with no `govRepo`/`ledgerRepo`,
   * which is strictly safer and adds negligible overhead (a resolved-
   * promise `.then()` hop) for the single-request common case.
   */
  const workspaceMutexChains = new Map<string, Promise<void>>();
  function withWorkspaceMutex<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const tail = workspaceMutexChains.get(workspaceId) ?? Promise.resolve();
    const result = tail.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    workspaceMutexChains.set(workspaceId, settled);
    void settled.then(() => {
      if (workspaceMutexChains.get(workspaceId) === settled) {
        workspaceMutexChains.delete(workspaceId);
      }
    });
    return result;
  }

  async function dualWriteAgentState(workspaceId: string, jobId: string): Promise<void> {
    await dualWriteJobSnapshot(workspaceId, jobId);
    await dualWriteGovernance(workspaceId);
    await dualWriteAudit(workspaceId);
  }

  app.addHook("onReady", async () => {
    if (!pool && resolvedDatabaseUrl) {
      try {
        const pgModuleName = "pg";
        const pgMod = (await import(pgModuleName)) as {
          default?: {
            Pool: new (cfg: { connectionString: string }) => RealPgPool;
            Client: new (cfg: { connectionString: string }) => PgListenClient;
          };
          Pool?: new (cfg: { connectionString: string }) => RealPgPool;
          Client?: new (cfg: { connectionString: string }) => PgListenClient;
        };
        const PoolCtor = pgMod.Pool ?? pgMod.default?.Pool;
        if (!PoolCtor) {
          throw new Error("pg module loaded but Pool export was missing");
        }
        const created = new PoolCtor({ connectionString: resolvedDatabaseUrl });
        // Fail-closed connectivity check so a bad DATABASE_URL cannot silently stay half-open.
        await created.query("select 1 as ok");
        rawPgPool = created;
        // Wrap with RLS workspace scoping (G-01): a plain Pool.query() checks
        // out a different connection per call, so a bare `SET LOCAL
        // app.workspace_id` would not reliably apply to the following
        // statement. createScopedPgQueryable runs per-workspace ops on one
        // checked-out connection/transaction instead. See its doc comment.
        pool = createScopedPgQueryable(created);
        orchStore = createPgOrchestrationRepository(pool);
        govRepo = createPgGovernanceRepository(pool);
        crmRepo = createPgCrmRepository(pool);
        crmSubRepo = createPgCrmSubRepository(pool);
        pmRepo = createPgPmRepository(pool);
        ledgerRepo = createPgLedgerRepository(pool);
        financeReconRepo = createPgFinanceReconciliationRepository(pool);
        dailyGateRepo = createPgDailyGateRepository(pool);
        aiCrm.persistenceMode = "pg";
        aiCrm.pool = pool;
        aiCrm.orchStore = orchStore;
        aiCrm.govRepo = govRepo;
        aiCrm.crmRepo = crmRepo;
        aiCrm.crmSubRepo = crmSubRepo;
        aiCrm.pmRepo = pmRepo;
        aiCrm.ledgerRepo = ledgerRepo;
        aiCrm.financeReconRepo = financeReconRepo;
        aiCrm.dailyGateRepo = dailyGateRepo;
        const notifyEnabled = options.pgNotify !== false;
        const ClientCtor = pgMod.Client ?? pgMod.default?.Client;
        if (notifyEnabled && ClientCtor && pool) {
          const scopedPool = pool;
          const bridge = new PgNotifyBridge({
            pool: scopedPool,
            channel: notifyChannel,
            connect: async () => {
              const client = new ClientCtor({ connectionString: resolvedDatabaseUrl! });
              await client.connect();
              return client;
            },
            onEvent: (event) => eventHub.publish(event),
            log: (message) => console.warn(message),
          });
          notifyBridge = bridge;
          decorateNotifyBridge(bridge);
          try {
            await bridge.start();
          } catch (notifyStartError) {
            // Best-effort like the other dual-write paths: cross-process
            // NOTIFY is an enhancement over the durable outbox, never a
            // boot-blocking requirement. Single-process EventHub fanout
            // still works even if the LISTEN connection could not open.
            const message = notifyStartError instanceof Error ? notifyStartError.message : String(notifyStartError);
            console.warn(`[PG_NOTIFY_START_FAILED] ${message}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `DATABASE_URL/databaseUrl is set but Postgres pool could not be created (is the pg package installed?): ${message}`,
        );
      }
    }

    // Admin pool (G-01 MEDIUM 4 role separation): opened only when
    // resolvedAdminDatabaseUrl is configured, used ONLY for the
    // cross-workspace hydrate reads below. Per-request scoping keeps using
    // the main `pool` above; this pool is never wrapped with
    // createScopedPgQueryable because listAllControls/listAllIntents/
    // listJobSnapshots() are intentionally unscoped (they read across every
    // workspace and are expected to run under an admin-capable role).
    if (resolvedAdminDatabaseUrl) {
      try {
        const pgModuleName = "pg";
        const pgMod = (await import(pgModuleName)) as {
          default?: { Pool: new (cfg: { connectionString: string }) => RealPgPool };
          Pool?: new (cfg: { connectionString: string }) => RealPgPool;
        };
        const PoolCtor = pgMod.Pool ?? pgMod.default?.Pool;
        if (!PoolCtor) {
          throw new Error("pg module loaded but Pool export was missing");
        }
        const createdAdmin = new PoolCtor({ connectionString: resolvedAdminDatabaseUrl });
        // Fail-closed connectivity check, same as the main pool.
        await createdAdmin.query("select 1 as ok");
        rawAdminPgPool = createdAdmin;
        const adminQueryable: PgQueryable = {
          async query<T = unknown>(text: string, params?: unknown[]) {
            const result = await createdAdmin.query(text, params);
            return result as { rows: T[]; rowCount: number | null };
          },
        };
        hydrateOrchStore = createPgOrchestrationRepository(adminQueryable);
        hydrateGovRepo = createPgGovernanceRepository(adminQueryable);
        hydrateCrmRepo = createPgCrmRepository(adminQueryable);
        hydrateCrmSubRepo = createPgCrmSubRepository(adminQueryable);
        hydratePmRepo = createPgPmRepository(adminQueryable);
        hydrateFinanceReconRepo = createPgFinanceReconciliationRepository(adminQueryable);
        hydrateDailyGateRepo = createPgDailyGateRepository(adminQueryable);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `ADMIN_DATABASE_URL/adminDatabaseUrl is set but the admin Postgres pool could not be created: ${message}`,
        );
      }
    }

    // Restart-consistency hydrate-on-boot (G-01): when a pool is present
    // (injected or freshly opened above), read PG back into the in-memory
    // OrchestrationService / GovernanceAuthorizationService that serve the
    // request path. Memory mode (no pool) is untouched. Failure here is
    // FAIL-CLOSED — a boot that cannot prove it matches PG state must not
    // silently start serving stale/empty in-memory state as if it were
    // authoritative.
    if (pool && orchStore && govRepo && crmRepo && crmSubRepo && pmRepo && financeReconRepo && dailyGateRepo) {
      // Prefer the admin pool source when adminDatabaseUrl is configured;
      // otherwise fall back to the main runtime pool/store (documented dev
      // behavior on CreateAppOptions.adminDatabaseUrl).
      const hOrchStore = hydrateOrchStore ?? orchStore;
      const hGovRepo = hydrateGovRepo ?? govRepo;
      const hCrmRepo = hydrateCrmRepo ?? crmRepo;
      const hCrmSubRepo = hydrateCrmSubRepo ?? crmSubRepo;
      const hPmRepo = hydratePmRepo ?? pmRepo;
      const hFinanceReconRepo = hydrateFinanceReconRepo ?? financeReconRepo;
      const hDailyGateRepo = hydrateDailyGateRepo ?? dailyGateRepo;
      try {
        const [
          snapshots,
          controls,
          intents,
          customers,
          contracts,
          communications,
          nextActions,
          exceptions,
          plans,
          assignments,
          targets,
          observations,
          pmExceptions,
          projects,
          allReconciliations,
          allFinanceExceptions,
          allGateStates,
          allDayRecords,
        ] = await Promise.all([
          hOrchStore.listJobSnapshots(),
          hGovRepo.listAllControls(),
          hGovRepo.listAllIntents(),
          hCrmRepo.listAllCustomers(),
          hCrmSubRepo.listAllContracts(),
          hCrmSubRepo.listAllCommunications(),
          hCrmSubRepo.listAllNextActions(),
          hCrmSubRepo.listAllExceptions(),
          hPmRepo.listAllPlans(),
          hPmRepo.listAllAssignments(),
          hPmRepo.listAllTargets(),
          hPmRepo.listAllObservations(),
          hPmRepo.listAllExceptions(),
          hPmRepo.listAllProjects(),
          hFinanceReconRepo.listAllReconciliations(),
          hFinanceReconRepo.listAllExceptions(),
          hDailyGateRepo.listAllDailyGateStates(),
          hDailyGateRepo.listAllDayRecords(),
        ]);
        orchestration.hydrate(snapshots);
        crm.hydrateCustomers(customers);
        crm.hydrateSubAggregates({ contracts, communications, nextActions, exceptions });
        pm.hydratePlans(plans);
        pm.hydrateAssignments(assignments);
        pm.hydrateTargets(targets);
        pm.hydrateObservations(observations);
        pm.hydrateExceptions(pmExceptions);
        delivery.hydrateProjects(projects);
        if (reconciliation) {
          reconciliation.hydrateReconciliations(allReconciliations, allFinanceExceptions);
        }
        // Rebuild one DailyGate per workspace observed in the persisted state —
        // NEVER replay recordDay (would double-backfill missing-day gaps and trip
        // OUT_OF_ORDER). policyVersion is reconstructed from the LIVE pack, not
        // from any persisted column (finance_daily_gate_state has none).
        if (financePack) {
          const dayRecordsByWorkspace = new Map<string, DayRecord[]>();
          for (const row of allDayRecords) {
            const list = dayRecordsByWorkspace.get(row.workspaceId) ?? [];
            list.push(row);
            dayRecordsByWorkspace.set(row.workspaceId, list);
          }
          for (const state of allGateStates) {
            const restored = new DailyGate(financePack, state.workspaceId, financePack.packVersion);
            restored.restoreState(state);
            restored.hydrateDayRecords(dayRecordsByWorkspace.get(state.workspaceId) ?? []);
            dailyGates.set(state.workspaceId, restored);
          }
        }
        // Audit restart-sourcing (N-13 / D3, closes the N-08 residual):
        // replay every persisted `audit_events` row for each workspace
        // observed in the hydrated controls/intents into the in-memory
        // audit array/hash chain BEFORE calling governance.hydrate, so GET
        // /api/governance/audit and /audit/verify reflect PG history and
        // validate the continuing chain immediately after restart instead
        // of resetting to empty. See index.ts `hydrate()` doc comment for
        // the tamper-evidence contract this provides.
        const hydratedWorkspaceIds = [...new Set([...controls, ...intents].map((row) => row.workspaceId))];
        const auditRowsByWorkspace = await Promise.all(
          hydratedWorkspaceIds.map((ws) => hGovRepo.getAuditEventsForWorkspace(ws)),
        );
        const audits = auditRowsByWorkspace.flat();
        governance.hydrate({ controls, intents, audits });
        // Seed the dual-write flush cursor to the hydrated count per
        // workspace so a post-restart mutation does not re-flush the
        // already-persisted events onto the PG chain a second time.
        for (const ws of hydratedWorkspaceIds) {
          dualWrittenAuditCount.set(ws, governance.listAuditEvents(ws).length);
        }
        // Audit chain-head continuity (N-08 / D3): read
        // `audit_chain_heads.head_sequence` for every workspace observed in
        // the hydrated controls/intents, so this instance is provably aware
        // of the continuing PG chain rather than assuming it starts at 0.
        // New audit appends after boot still always re-read the live head
        // under FOR UPDATE (see PgGovernanceRepository.appendAuditEvents),
        // so this is a continuity snapshot for ops/tests, not the sequence
        // source of truth.
        const auditChainHeads: Record<string, number> = {};
        await Promise.all(
          hydratedWorkspaceIds.map(async (ws) => {
            auditChainHeads[ws] = await hGovRepo.getAuditChainHead(ws);
          }),
        );
        aiCrm.auditChainHeads = auditChainHeads;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`hydrate-on-boot failed; restart-consistent SoR could not be established: ${message}`);
      }
    }
    // Ledger hydrate-on-boot (PG-C1 / F6, PG-first fail-closed): independent
    // of the orch/gov/crm hydrate condition above since the ledger requires
    // only `ledgerRepo` + a configured `financePack`/`ledger` instance, not
    // the orchestration/governance repos.
    if (ledgerRepo && ledger) {
      try {
        const entries = await ledgerRepo.listAllEntries();
        ledger.hydrateJournalEntries(entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`ledger hydrate-on-boot failed; restart-consistent SoR could not be established: ${message}`);
      }
    }
  });

  app.addHook("onClose", async () => {
    if (notifyBridge) {
      await notifyBridge.stop();
    }
    if (rawPgPool && typeof rawPgPool.end === "function" && resolvedDatabaseUrl && !options.pgPool) {
      try {
        await rawPgPool.end();
      } catch {
        // ignore pool shutdown errors
      }
    }
    if (rawAdminPgPool && typeof rawAdminPgPool.end === "function") {
      try {
        await rawAdminPgPool.end();
      } catch {
        // ignore pool shutdown errors
      }
    }
  });

  function requireModelGateway(): ModelGateway {
    if (!modelGateway) {
      throw new ModelGatewayError("MODEL_GATEWAY_UNSET", "model provider is not configured; inference is disabled fail-closed");
    }
    return modelGateway;
  }

  /**
   * Dereferences a caller-supplied intent id against governance state and marks
   * it applied (single-use). This is the ONLY way protected effects are
   * authorized: the API never trusts a client-supplied receipt. The intent must
   * be a fresh QUEUED consumed authorization bound to exactly this action,
   * resource, version and (when provided) payload hash.
   */
  function consumeGovernedIntent(
    ws: string,
    intentId: string,
    actionType: string,
    resourceId: string,
    resourceVersion: number,
    payloadHash?: string,
  ): { policyVersion: number; payloadHash: string } {
    const intent = governance.getIntent(ws, intentId);
    if (
      intent.actionType !== actionType ||
      intent.resourceId !== resourceId ||
      intent.resourceVersion !== resourceVersion ||
      intent.status !== "QUEUED" ||
      (payloadHash !== undefined && intent.payloadHash !== payloadHash)
    ) {
      throw new GovernanceError("STALE_INTENT", "intent is not a fresh consumed authorization bound to this action");
    }
    governance.markIntentApplied(ws, intentId);
    return { policyVersion: intent.policyVersion, payloadHash: intent.payloadHash };
  }

  function requireFinance(): { ledger: LedgerService; reconciliation: ReconciliationService; pack: FinancePackConfig } {
    if (!financePack || !ledger || !reconciliation) {
      throw new FinanceDomainError("FINANCE_PACK_UNSET", "accounting pack is not configured; finance surface is disabled fail-closed");
    }
    return { ledger, reconciliation, pack: financePack };
  }

  function dailyGate(ws: string): DailyGate {
    const { pack } = requireFinance();
    let gate = dailyGates.get(ws);
    if (!gate) {
      // §4 rule 5: the gate's policy version tracks the signed pack version, so
      // a pack change resets the qualifying-day streak rather than silently carrying it.
      gate = new DailyGate(pack, ws, pack.packVersion);
      dailyGates.set(ws, gate);
    }
    return gate;
  }
  const projectsByCustomer = new Map<string, string[]>();
  const imports = new ImportService({
    CRM: (batch, row) => {
      const customer = crm.createCustomer({
        id: row.values.customer_id!,
        workspaceId: batch.workspaceId,
        name: row.values.name!,
        status: row.values.status as "active" | "at_risk" | "inactive",
        createdAt: row.values.created_at!,
        updatedAt: row.values.created_at!,
      });
      return customer.id;
    },
  });

  /**
   * Evidence-backed finance projection for the customer 360. Undefined —
   * rendered as honest "pending" — until the pack is configured AND at least
   * one bank statement was successfully imported; figures must never claim
   * to be fresher than the last imported statement `as_of`.
   */
  function financeSummaryFor(ws: string): FinanceSummary | undefined {
    if (!financePack || !ledger) return undefined;
    const freshness = imports.bankFreshness(ws);
    if (!freshness.asOf) return undefined;
    const balances = ledger.balances(ws);
    let cash = 0n;
    let receivable = 0n;
    let payable = 0n;
    let revenue = 0n;
    let expense = 0n;
    for (const account of financePack.chartOfAccounts) {
      const balance = BigInt(balances[account.code] ?? "0");
      if (account.projectionRole === "cash") cash += balance;
      if (account.projectionRole === "receivable") receivable += balance;
      if (account.projectionRole === "payable") payable -= balance;
      if (account.type === "revenue") revenue -= balance;
      if (account.type === "expense") expense += balance;
    }
    return {
      status: "available",
      asOf: freshness.asOf,
      cashKrw: cash.toString(),
      receivableKrw: receivable.toString(),
      payableKrw: payable.toString(),
      projectMarginKrw: (revenue - expense).toString(),
    };
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthnError) {
      return reply.status(401).send({ error: error.code, message: error.message });
    }
    if (
      error instanceof CrmDomainError ||
      error instanceof DeliveryDomainError ||
      error instanceof PmDomainError ||
      error instanceof ImportDomainError ||
      error instanceof FinanceDomainError ||
      error instanceof GovernanceError ||
      error instanceof ModelGatewayError ||
      error instanceof AiOrchestratorError ||
      error instanceof ReportDomainError ||
      error instanceof NaturalCommandError ||
      error instanceof OrchestrationError
    ) {
      const unsetCode =
        error.code === "FINANCE_PACK_UNSET" ||
        error.code === "MODEL_GATEWAY_UNSET" ||
        error.code === "MODEL_UNAVAILABLE";
      const notFound =
        error.code === "NOT_FOUND" ||
        error.code.endsWith("_NOT_FOUND") ||
        (error instanceof OrchestrationError && error.code === "CROSS_WORKSPACE");
      const conflict = error.code.includes("STALE") || error.code.startsWith("DUPLICATE_");
      const status = notFound ? 404 : unsetCode ? 503 : conflict ? 409 : 400;
      return reply.status(status).send({ error: error.code, message: error.message });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR", message: "Unexpected server error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  /**
   * Readiness probe (T-018).
   * - memory mode (no DATABASE_URL / no pool required): always ready
   * - pg mode: ready only when pool is present and `select 1` succeeds
   * - pg mode with missing pool or failed query: 503 not_ready
   */
  app.get("/ready", async (_request, reply) => {
    const mode = aiCrm.persistenceMode;
    if (mode !== "pg") {
      return reply.status(200).send({ status: "ready" });
    }
    const activePool = aiCrm.pool ?? pool;
    if (!activePool || typeof (activePool as { query?: unknown }).query !== "function") {
      return reply.status(503).send({ status: "not_ready" });
    }
    try {
      await (activePool as PgQueryable & { query: (sql: string) => Promise<unknown> }).query("select 1 as ok");
      return reply.status(200).send({ status: "ready" });
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });
  /**
   * Operational counters (G-04). No auth required, same posture as /health —
   * this exposes shape/volume, not tenant data. Cross-workspace in-memory
   * counts are read directly off the live OrchestrationService/
   * GovernanceAuthorizationService state (same source the request path
   * serves from), plus the best-effort dual-write failure counter and the
   * live SSE subscriber count from EventHub.
   */
  interface MetricsSnapshot {
    status: "ok";
    agent: { jobsTotal: number; jobsByStatus: Record<string, number> };
    governance: {
      controlsTotal: number;
      controlsByStatus: Record<string, number>;
      intentsTotal: number;
      intentsByStatus: Record<string, number>;
    };
    dualWriteFailures: number;
    sse: { activeJobSubscriptions: number };
  }

  function computeMetrics(): MetricsSnapshot {
    const orchState = orchestration.snapshot();
    const jobsByStatus: Record<string, number> = {};
    for (const job of Object.values(orchState.jobs)) {
      jobsByStatus[job.status] = (jobsByStatus[job.status] ?? 0) + 1;
    }
    const govState = governance.snapshot();
    const controlsByStatus: Record<string, number> = {};
    for (const control of Object.values(govState.controls)) {
      controlsByStatus[control.status] = (controlsByStatus[control.status] ?? 0) + 1;
    }
    const intentsByStatus: Record<string, number> = {};
    for (const intent of Object.values(govState.intents)) {
      intentsByStatus[intent.status] = (intentsByStatus[intent.status] ?? 0) + 1;
    }
    return {
      status: "ok",
      agent: {
        jobsTotal: Object.keys(orchState.jobs).length,
        jobsByStatus,
      },
      governance: {
        controlsTotal: Object.keys(govState.controls).length,
        controlsByStatus,
        intentsTotal: Object.keys(govState.intents).length,
        intentsByStatus,
      },
      dualWriteFailures: aiCrm.dualWriteFailures,
      sse: {
        activeJobSubscriptions: eventHub.activeJobCount(),
      },
    };
  }

  /** Prometheus label-value escaping: backslash, double-quote, newline. */
  function promLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  function gauge(lines: string[], name: string, help: string, value: number, labels?: Record<string, string>): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    const labelPart = labels
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${promLabel(v)}"`)
          .join(",")}}`
      : "";
    lines.push(`${name}${labelPart} ${value}`);
  }

  function gaugeByStatus(
    lines: string[],
    name: string,
    help: string,
    byStatus: Record<string, number>,
  ): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    for (const [status, count] of Object.entries(byStatus)) {
      lines.push(`${name}{status="${promLabel(status)}"} ${count}`);
    }
  }

  /** Renders the same counters as GET /metrics JSON in Prometheus/OpenMetrics text exposition format. */
  // NOTE: gauge families use the `_total` suffix for readability; this is
// Prometheus 0.0.4 text exposition (TYPE gauge), not strict OpenMetrics where
// `_total` denotes a counter. Scrape-compatible; no functional impact.
function renderPrometheus(metrics: MetricsSnapshot): string {
    const lines: string[] = [];
    gauge(lines, "ai_crm_agent_jobs_total", "Total agent orchestration jobs.", metrics.agent.jobsTotal);
    gaugeByStatus(
      lines,
      "ai_crm_agent_jobs_by_status",
      "Agent orchestration jobs by status.",
      metrics.agent.jobsByStatus,
    );
    gauge(
      lines,
      "ai_crm_governance_controls_total",
      "Total governance checkpoint controls.",
      metrics.governance.controlsTotal,
    );
    gaugeByStatus(
      lines,
      "ai_crm_governance_controls_by_status",
      "Governance checkpoint controls by status.",
      metrics.governance.controlsByStatus,
    );
    gauge(
      lines,
      "ai_crm_governance_intents_total",
      "Total governance execution intents.",
      metrics.governance.intentsTotal,
    );
    gaugeByStatus(
      lines,
      "ai_crm_governance_intents_by_status",
      "Governance execution intents by status.",
      metrics.governance.intentsByStatus,
    );
    gauge(lines, "ai_crm_dual_write_failures", "Best-effort dual-write failure counter.", metrics.dualWriteFailures);
    gauge(
      lines,
      "ai_crm_sse_active_job_subscriptions",
      "Live SSE subscriber count from EventHub.",
      metrics.sse.activeJobSubscriptions,
    );
    return lines.join("\n") + "\n";
  }

  /**
   * Operational counters (G-04, extended N-15/D12 with a Prometheus text
   * exposition). No auth required, same posture as /health — this exposes
   * shape/volume, not tenant data. Cross-workspace in-memory counts are read
   * directly off the live OrchestrationService/GovernanceAuthorizationService
   * state (same source the request path serves from), plus the best-effort
   * dual-write failure counter and the live SSE subscriber count from
   * EventHub.
   *
   * JSON remains the default response. Prometheus text exposition is served
   * when the client asks for it via `Accept: text/plain` or
   * `?format=prometheus`; `/metrics/prometheus` always serves the text form.
   */
  app.get("/metrics", async (request, reply) => {
    const metrics = computeMetrics();
    const query = request.query as Record<string, unknown> | undefined;
    const wantsPrometheus =
      query?.format === "prometheus" ||
      (typeof request.headers.accept === "string" && request.headers.accept.includes("text/plain"));
    if (wantsPrometheus) {
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return renderPrometheus(metrics);
    }
    return metrics;
  });

  app.get("/metrics/prometheus", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return renderPrometheus(computeMetrics());
  });

  app.post("/api/customers", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const customer = crm.createCustomer({
      id: text(body, "id"),
      workspaceId: ws,
      name: text(body, "name"),
      status: (body.status as "active" | "at_risk" | "inactive") ?? "active",
      createdAt: text(body, "createdAt"),
      updatedAt: text(body, "createdAt"),
    });
    await dualWriteCrmCustomer(customer);
    return reply.status(201).send(customer);
  });

  app.patch<{ Params: { customerId: string } }>("/api/customers/:customerId", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const customer = crm.updateCustomer(
      ws,
      request.params.customerId,
      numberValue(body, "expectedVersion"),
      {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.status === "string" ? { status: body.status as "active" | "at_risk" | "inactive" } : {}),
      },
      text(body, "updatedAt"),
    );
    await dualWriteCrmCustomer(customer);
    return customer;
  });

  app.post<{ Params: { customerId: string } }>("/api/customers/:customerId/contracts", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const contract = crm.addContract({
      id: text(body, "id"),
      workspaceId: ws,
      customerId: request.params.customerId,
      title: text(body, "title"),
      scope: text(body, "scope"),
      effectiveFrom: text(body, "effectiveFrom"),
      ...(typeof body.effectiveTo === "string" ? { effectiveTo: body.effectiveTo } : {}),
      ...(typeof body.valueKrw === "string" ? { valueKrw: body.valueKrw } : {}),
    });
    await dualWriteCrmContract(contract);
    return reply.status(201).send(contract);
  });

  app.post<{ Params: { customerId: string } }>("/api/customers/:customerId/communications", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const communication = crm.recordCommunication({
      id: text(body, "id"), workspaceId: ws, customerId: request.params.customerId,
      channel: text(body, "channel") as "email" | "meeting" | "phone" | "note",
      summary: text(body, "summary"), occurredAt: text(body, "occurredAt"),
    });
    await dualWriteCrmCommunication(communication);
    return reply.status(201).send(communication);
  });

  app.post<{ Params: { customerId: string } }>("/api/customers/:customerId/exceptions", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const exception = crm.addException({
      id: text(body, "id"), workspaceId: ws, customerId: request.params.customerId,
      title: text(body, "title"), severity: text(body, "severity") as "critical" | "high" | "medium" | "low",
      priority: numberValue(body, "priority"), occurredAt: text(body, "occurredAt"), status: "open",
    });
    await dualWriteCrmException(exception);
    return reply.status(201).send(exception);
  });

  app.post<{ Params: { customerId: string } }>("/api/customers/:customerId/next-actions", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const action = crm.addNextAction({
      id: text(body, "id"), workspaceId: ws, customerId: request.params.customerId,
      title: text(body, "title"), priority: numberValue(body, "priority"), dueAt: text(body, "dueAt"), status: "open",
    });
    await dualWriteCrmNextAction(action);
    return reply.status(201).send(action);
  });

  app.get<{ Params: { customerId: string } }>("/api/customers/:customerId/overview", async (request) => {
    const ws = workspace(request);
    const projectIds = projectsByCustomer.get(`${ws}:${request.params.customerId}`) ?? [];
    const summaries: ProjectSummary[] = projectIds.map((id) => {
      const project = delivery.getProject(ws, id);
      const approved = project.deliverables.filter((item) => item.status === "approved").length;
      return {
        id: project.id, workspaceId: project.workspaceId, customerId: project.customerId,
        name: project.name, status: project.status,
        progress: project.deliverables.length === 0 ? 0 : approved / project.deliverables.length,
      };
    });
    return crm.overview(ws, request.params.customerId, summaries, financeSummaryFor(ws));
  });

  app.post("/api/projects", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const deliverables = Array.isArray(body.deliverables) ? body.deliverables : [];
    const project = delivery.createProject({
      id: text(body, "id"), workspaceId: ws, customerId: text(body, "customerId"), name: text(body, "name"),
      contractId: text(body, "contractId"), contractScope: text(body, "contractScope"),
      scheduleStart: text(body, "scheduleStart"), scheduleEnd: text(body, "scheduleEnd"),
      deliverables: deliverables as Parameters<DeliveryService["createProject"]>[0]["deliverables"],
      completionRule: "all_required_deliverables_approved",
      riskThreshold: numberValue(body, "riskThreshold"),
      requirementIds: arrayOfStrings(body.requirementIds, "requirementIds"),
    });
    const key = `${ws}:${project.customerId}`;
    projectsByCustomer.set(key, [...(projectsByCustomer.get(key) ?? []), project.id]);
    await dualWriteDeliveryProject(project);
    return reply.status(201).send(project);
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request) =>
    delivery.getProject(workspace(request), request.params.projectId),
  );

  app.patch<{ Params: { projectId: string } }>("/api/projects/:projectId/baseline", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const expectedVersion = numberValue(body, "expectedVersion");
    const patch = objectBody(body.patch) as BaselinePatch;
    const actionType = classifyBaselineMutation(patch);
    let receipt: AuthorizationReceipt | undefined;
    if (actionType !== "INTERNAL_REVERSIBLE_UPDATE") {
      const payloadHash = baselinePayloadHash(actionType, patch);
      const applied = consumeGovernedIntent(ws, text(body, "intentId"), actionType, request.params.projectId, expectedVersion, payloadHash);
      receipt = {
        workspaceId: ws,
        resourceId: request.params.projectId,
        resourceVersion: expectedVersion,
        actionType,
        payloadHash: applied.payloadHash,
        policyVersion: applied.policyVersion,
        status: "CONSUMED",
      };
    }
    const updated = delivery.changeBaseline(ws, request.params.projectId, expectedVersion, patch, receipt);
    await dualWriteDeliveryProject(updated);
    return updated;
  });

  app.post("/api/pm/plans", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const plan = pm.createPlan({
      id: text(body, "id"), workspaceId: ws, projectId: text(body, "projectId"), revision: 1,
      objective: text(body, "objective"), taskIds: arrayOfStrings(body.taskIds, "taskIds"),
      createdByPrincipalId: text(body, "createdByPrincipalId"), createdAt: text(body, "createdAt"),
    });
    await dualWritePmPlan(plan);
    return reply.status(201).send(plan);
  });

  app.post<{ Params: { planId: string } }>("/api/pm/plans/:planId/revisions", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const expectedVersion = numberValue(body, "expectedVersion");
    const objective = text(body, "objective");
    const taskIds = arrayOfStrings(body.taskIds, "taskIds");
    consumeGovernedIntent(
      ws, text(body, "intentId"), "PM_PLAN_REVISE", request.params.planId, expectedVersion,
      canonicalHashOf("PM_PLAN_REVISE", { objective, taskIds }),
    );
    const receipt: PmCheckpointReceipt = {
      workspaceId: ws, resourceId: request.params.planId, resourceVersion: expectedVersion, actionType: "PM_PLAN_REVISE", status: "CONSUMED",
    };
    const revised = pm.revisePlan(ws, request.params.planId, expectedVersion, {
      objective, taskIds,
      createdByPrincipalId: text(body, "createdByPrincipalId"), createdAt: text(body, "createdAt"),
    }, receipt);
    await dualWritePmPlan(revised);
    return revised;
  });

  app.post("/api/pm/assignments", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const planId = text(body, "planId");
    const planVersion = numberValue(body, "planVersion");
    const taskId = text(body, "taskId");
    const assigneePrincipalId = text(body, "assigneePrincipalId");
    consumeGovernedIntent(
      ws, text(body, "intentId"), "PM_TASK_ASSIGN", planId, planVersion,
      canonicalHashOf("PM_TASK_ASSIGN", { taskId, assigneePrincipalId }),
    );
    const receipt: PmCheckpointReceipt = {
      workspaceId: ws, resourceId: planId, resourceVersion: planVersion, actionType: "PM_TASK_ASSIGN", status: "CONSUMED",
    };
    const assignment = pm.assignTask({
      id: text(body, "id"), workspaceId: ws, projectId: text(body, "projectId"), planId,
      taskId, assigneePrincipalId,
      assignedByPrincipalId: text(body, "assignedByPrincipalId"), status: "active", createdAt: text(body, "createdAt"),
    }, planVersion, receipt);
    await dualWritePmAssignment(assignment);
    return reply.status(201).send(assignment);
  });

  app.post("/api/pm/targets", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const planId = text(body, "planId");
    const planVersion = numberValue(body, "planVersion");
    const metric = text(body, "metric") as "schedule" | "scope" | "deliverable" | "risk";
    const targetValue = numberValue(body, "target");
    const tolerance = numberValue(body, "tolerance");
    const direction = text(body, "direction") as "max" | "min";
    consumeGovernedIntent(
      ws, text(body, "intentId"), "PM_TARGET_SET", planId, planVersion,
      canonicalHashOf("PM_TARGET_SET", { metric, target: targetValue, tolerance, direction }),
    );
    const receipt: PmCheckpointReceipt = {
      workspaceId: ws, resourceId: planId, resourceVersion: planVersion, actionType: "PM_TARGET_SET", status: "CONSUMED",
    };
    const target = pm.setTarget({
      id: text(body, "id"), workspaceId: ws, projectId: text(body, "projectId"),
      metric, target: targetValue, tolerance, direction,
    }, planId, planVersion, receipt);
    await dualWritePmTarget(target);
    return reply.status(201).send(target);
  });

  app.post("/api/pm/observations", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const { observation, exception } = pm.observe({
      id: text(body, "id"), workspaceId: ws, projectId: text(body, "projectId"), targetId: text(body, "targetId"),
      actual: numberValue(body, "actual"), observedAt: text(body, "observedAt"), evidenceRef: text(body, "evidenceRef"),
    });
    await dualWritePmObservation(observation, exception);
    return reply.status(201).send({ observation, exception });
  });

  app.post("/api/imports", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const sourceKind = text(body, "sourceKind");
    if (!["CRM", "LEDGER", "BANK_STATEMENT"].includes(sourceKind)) {
      throw new ImportDomainError("INVALID_INPUT", "sourceKind must be CRM|LEDGER|BANK_STATEMENT");
    }
    const batch = imports.submitBatch({
      id: text(body, "id"),
      workspaceId: ws,
      sourceKind: sourceKind as ImportSourceKind,
      schemaVersion: numberValue(body, "schemaVersion"),
      content: text(body, "content"),
      operatorPrincipalId: text(body, "operatorPrincipalId"),
      submittedAt: text(body, "submittedAt"),
    });
    return reply.status(201).send(batch);
  });

  app.get<{ Params: { batchId: string } }>("/api/imports/:batchId", async (request) =>
    imports.getBatch(workspace(request), request.params.batchId),
  );

  app.get("/api/imports/bank/freshness", async (request) => imports.bankFreshness(workspace(request)));

  app.post("/api/finance/journal-entries", async (request, reply) => {
    const { ledger: journal } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    const draftInput = {
      id: text(body, "id"),
      workspaceId: ws,
      entryDate: text(body, "entryDate"),
      description: text(body, "description"),
      ...(typeof body.evidenceRef === "string" ? { evidenceRef: body.evidenceRef } : {}),
      ...(typeof body.importBatchId === "string" ? { importBatchId: body.importBatchId } : {}),
      lines: (Array.isArray(body.lines) ? body.lines : []) as Parameters<LedgerService["draft"]>[0]["lines"],
      createdByPrincipalId: text(body, "createdByPrincipalId"),
    };
    // PG-FIRST fail-closed (F6): compute the validated DRAFT without touching
    // memory, persist to PG first (let a PG failure throw and 5xx before
    // memory diverges), then commit the SAME already-validated entry to
    // memory — inside the per-workspace mutex (P6-b G002 / PG-D fix) so a
    // concurrent same-workspace mutation can never preview from a pre-image
    // this request already committed past.
    const entry = await withWorkspaceMutex(ws, async () => {
      const draftEntry = journal.previewDraft(draftInput);
      if (ledgerRepo) {
        await ledgerRepo.saveEntry(draftEntry);
      }
      return journal.commitDraft(draftEntry);
    });
    return reply.status(201).send(entry);
  });

  app.post<{ Params: { entryId: string } }>("/api/finance/journal-entries/:entryId/verify", async (request) => {
    const { ledger: journal } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    const verifier = text(body, "verifierPrincipalId");
    const entry = journal.getEntry(ws, request.params.entryId);
    if (entry.importBatchId) imports.assertVerifierDistinct(ws, entry.importBatchId, verifier);
    // Per-workspace mutex (P6-b G002 / PG-D fix): serializes preview->PG-
    // write->commit the same way the governance routes do (see
    // /api/governance/authorize doc).
    return withWorkspaceMutex(ws, async () => {
      const verified = journal.previewVerify(ws, request.params.entryId, verifier);
      if (ledgerRepo) {
        await ledgerRepo.saveEntry(verified);
      }
      return journal.commitVerify(verified);
    });
  });

  app.post<{ Params: { entryId: string } }>("/api/finance/journal-entries/:entryId/post", async (request) => {
    const { ledger: journal } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    const poster = text(body, "posterPrincipalId");
    const entry = journal.getEntry(ws, request.params.entryId);
    // Validate the import-operator separation of duty before consuming the
    // single-use intent, so a doomed post never burns a valid authorization.
    if (entry.importBatchId) imports.assertVerifierDistinct(ws, entry.importBatchId, poster);
    // LEDGER_POST is permanently REQUIRE_APPROVAL: a fresh consumed governance
    // intent bound to this entry+version+payload must exist before posting.
    // Per-workspace mutex (P6-b G002 / PG-D fix): the single-use intent
    // consumption + preview->PG-write->commit all run inside one critical
    // section per workspace, so a concurrent same-workspace post can never
    // observe/consume the same intent or preview from a pre-image this
    // request already committed past.
    return withWorkspaceMutex(ws, async () => {
      consumeGovernedIntent(
        ws,
        text(body, "intentId"),
        "LEDGER_POST",
        request.params.entryId,
        entry.version,
        canonicalHashOf("LEDGER_POST", { entryId: request.params.entryId }),
      );
      const { next, reversedOriginal } = journal.previewPost(ws, request.params.entryId, poster);
      if (ledgerRepo) {
        await ledgerRepo.postEntryAtomic(next, reversedOriginal);
      }
      return journal.commitPost(next, reversedOriginal);
    });
  });

  app.post<{ Params: { entryId: string } }>("/api/finance/journal-entries/:entryId/reverse", async (request, reply) => {
    const { ledger: journal } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    // Per-workspace mutex (P6-b G002 / PG-D fix): serializes preview->PG-
    // write->commit the same way the governance routes do.
    const reversed = await withWorkspaceMutex(ws, async () => {
      const reversalDraft = journal.previewReverse(
        ws, request.params.entryId, text(body, "reversalEntryId"), text(body, "principalId"), text(body, "entryDate"),
      );
      if (ledgerRepo) {
        await ledgerRepo.saveEntry(reversalDraft);
      }
      return journal.commitDraft(reversalDraft);
    });
    return reply.status(201).send(reversed);
  });

  app.get("/api/finance/balances", async (request) => {
    const { ledger: journal } = requireFinance();
    return journal.balances(workspace(request));
  });

  app.post("/api/finance/reconciliations", async (request, reply) => {
    const { reconciliation: recon } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    const statementRow = objectBody(body.statementRow) as unknown as StatementRowRef;
    const result = recon.reconcile({
      id: text(body, "id"),
      workspaceId: ws,
      statementRow,
      ledgerAmountKrw: text(body, "ledgerAmountKrw"),
      reconciledByPrincipalId: text(body, "reconciledByPrincipalId"),
      reconciledAt: text(body, "reconciledAt"),
      ...(typeof body.exceptionId === "string" ? { exceptionId: body.exceptionId } : {}),
    });
    if (financeReconRepo) {
      try {
        await financeReconRepo.saveReconciliation(result);
        if (result.exceptionId) {
          const exception = recon.openExceptions(ws).find((e) => e.id === result.exceptionId);
          if (exception) await financeReconRepo.saveException(exception);
        }
      } catch (error) {
        aiCrm.dualWriteFailures += 1;
        app.log.error({ error }, "finance reconciliation dual-write failed");
      }
    }
    return reply.status(201).send(result);
  });

  app.post<{ Params: { exceptionId: string } }>("/api/finance/exceptions/:exceptionId/resolve", async (request) => {
    const { reconciliation: recon } = requireFinance();
    const ws = workspace(request);
    const body = objectBody(request.body);
    const resolved = recon.resolveException(
      ws,
      request.params.exceptionId,
      text(body, "resolvedByPrincipalId"),
      text(body, "resolvedAt"),
      text(body, "resolutionNote"),
    );
    if (financeReconRepo) {
      try {
        await financeReconRepo.saveException(resolved);
      } catch (error) {
        aiCrm.dualWriteFailures += 1;
        app.log.error({ error }, "finance exception dual-write failed");
      }
    }
    return resolved;
  });

  app.get("/api/finance/exceptions", async (request) => {
    const { reconciliation: recon } = requireFinance();
    return recon.openExceptions(workspace(request));
  });

  app.post("/api/finance/daily-gate/days", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const gate = dailyGate(ws);
    const record = gate.recordDay({
      date: text(body, "date"),
      importsCompleted: body.importsCompleted === true,
      entriesBalanced: body.entriesBalanced === true,
      openFinanceExceptions: numberValue(body, "openFinanceExceptions"),
      receivedAt: text(body, "receivedAt"),
      ...(body.backfilled === true ? { backfilled: true } : {}),
    });
    if (dailyGateRepo) {
      try {
        await dailyGateRepo.appendDayRecord(ws, record);
        // Save machine state on EVERY recordDay (streak/lastDateEpoch always
        // change), not just on a tier transition — a missed save between two
        // transitions would otherwise make restoreState() stale by however
        // many days elapsed since the last tier flip.
        await dailyGateRepo.saveDailyGateState(ws, gate.snapshotState());
      } catch (error) {
        aiCrm.dualWriteFailures += 1;
        app.log.error({ error }, "daily-gate dual-write failed");
      }
    }
    return reply.status(201).send(record);
  });

  app.post("/api/finance/daily-gate/activate-risk-tier", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const gate = dailyGate(ws);
    gate.activateRiskTier(numberValue(body, "approvedMatrixVersion"), text(body, "approverPrincipalId"));
    if (dailyGateRepo) {
      try {
        await dailyGateRepo.saveDailyGateState(ws, gate.snapshotState());
      } catch (error) {
        aiCrm.dualWriteFailures += 1;
        app.log.error({ error }, "daily-gate risk-tier-activation dual-write failed");
      }
    }
    return gate.status();
  });

  app.get("/api/finance/daily-gate", async (request) => dailyGate(workspace(request)).status());

  // --- Governance: authorize, approval/checkpoint inbox, notifications, audit ---
  app.post("/api/governance/authorize", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    // PG-FIRST fail-closed (D3, mirrors PG-C1 ledger preview/commit), inside
    // the per-workspace mutex (P6-b G002 / PG-D fix): compute the validated
    // transition into a detached draft, persist its new audit event(s) to PG
    // (audit_events/audit_chain_heads/outbox) BEFORE the in-memory
    // governance state commits — a PG failure throws (5xx) here, before
    // memory diverges. `withWorkspaceMutex` serializes this whole
    // preview->PG-write->commit section per workspace so a concurrent
    // same-workspace request can never preview from a pre-image this
    // request already committed past.
    const result = await withWorkspaceMutex(ws, async () => {
      const preview = governance.previewAuthorize({
        command: text(body, "command"),
        workspaceId: ws,
        resourceId: text(body, "resourceId"),
        resourceVersion: numberValue(body, "resourceVersion"),
        payload: "payload" in body ? body.payload : {},
        requesterPrincipalId: text(body, "requesterPrincipalId"),
      });
      await pgFirstAuditAppend(ws, preview.draft);
      const committed = governance.commitAuthorize(preview);
      await dualWriteGovernance(ws);
      return committed;
    });
    return reply.status(201).send(result);
  });

  // PG-primary scoped read (N-08 / D4): when a govRepo/pool is present,
  // reads bypass the in-memory GovernanceAuthorizationService snapshot
  // entirely and go straight to the RLS-scoped SELECT via
  // getControlsForWorkspace/loadControl. Memory mode (no govRepo) keeps the
  // existing in-memory read — unchanged behavior for every existing test
  // that boots createApp without a pool.
  app.get("/api/governance/controls", async (request) => {
    const ws = workspace(request);
    const status = typeof (request.query as Record<string, unknown>)?.status === "string"
      ? ((request.query as Record<string, string>).status as Parameters<GovernanceAuthorizationService["listControls"]>[1])
      : undefined;
    if (govRepo) {
      const persisted = await govRepo.getControlsForWorkspace(ws);
      const controls = persisted.map(controlFromPersisted);
      return status === undefined ? controls : controls.filter((control) => control.status === status);
    }
    return governance.listControls(ws, status);
  });

  app.get<{ Params: { controlId: string } }>("/api/governance/controls/:controlId", async (request) => {
    const ws = workspace(request);
    if (govRepo) {
      const persisted = await govRepo.loadControl(ws, request.params.controlId);
      if (!persisted) {
        throw new GovernanceError("CONTROL_NOT_FOUND", `control not found: ${request.params.controlId}`);
      }
      return controlFromPersisted(persisted);
    }
    return governance.getControl(ws, request.params.controlId);
  });

  app.post<{ Params: { controlId: string } }>("/api/governance/controls/:controlId/decide", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const decision = text(body, "decision");
    if (decision !== "APPROVE" && decision !== "REJECT") {
      throw new GovernanceError("INVALID_DECISION", "decision must be APPROVE or REJECT");
    }
    // PG-FIRST fail-closed (D3): see /api/governance/authorize doc — same
    // preview/PG-audit-append/commit split for the APPROVE/REJECT decision,
    // inside the per-workspace mutex (P6-b G002 / PG-D fix).
    const result = await withWorkspaceMutex(ws, async () => {
      const preview = governance.previewDecideControl(request.params.controlId, text(body, "principalId"), decision, ws);
      await pgFirstAuditAppend(ws, preview.draft);
      const committed = governance.commitDecideControl(preview);
      await dualWriteGovernance(ws);
      return committed;
    });
    return result;
  });

  app.post<{ Params: { controlId: string } }>("/api/governance/controls/:controlId/consume", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const binding: Binding = {
      workspaceId: ws,
      resourceId: text(body, "resourceId"),
      resourceVersion: numberValue(body, "resourceVersion"),
      payloadHash: text(body, "payloadHash"),
      policyVersion: numberValue(body, "policyVersion"),
    };
    // PG-FIRST fail-closed (D3): see /api/governance/authorize doc — same
    // preview/PG-audit-append/commit split for the consume (control ->
    // intent) transition, inside the per-workspace mutex (P6-b G002 / PG-D
    // fix). Serializing preview+PG-write+commit closes the /consume TOCTOU:
    // without the mutex two concurrent consumes of one APPROVED control can
    // both pass the `control.status === "APPROVED"` preview check before
    // either commits (double CONTROL_CONSUMED); with it, the second
    // request's preview only starts after the first's commit, so it always
    // observes the already-CONSUMED status and fails closed.
    const intent = await withWorkspaceMutex(ws, async () => {
      const preview = governance.previewConsumeControl(
        request.params.controlId,
        binding,
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      );
      await pgFirstAuditAppend(ws, preview.draft);
      const committed = governance.commitConsumeControl(preview);
      await dualWriteGovernance(ws);
      return committed;
    });
    return reply.status(201).send(intent);
  });

  app.get("/api/governance/audit", async (request) => governance.listAuditEvents(workspace(request)));

  app.get("/api/governance/audit/verify", async (request) => ({ valid: governance.verifyAuditChain(workspace(request)) }));

  // --- Notifications lifecycle (AC-12) ---
  app.post("/api/notifications", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const result = governance.createNotification(ws, text(body, "subjectId"));
    await dualWriteAudit(ws);
    return reply.status(201).send(result);
  });

  app.get("/api/notifications", async (request) => {
    const ws = workspace(request);
    const status = typeof (request.query as Record<string, unknown>)?.status === "string"
      ? ((request.query as Record<string, string>).status as Parameters<GovernanceAuthorizationService["listNotifications"]>[1])
      : undefined;
    return governance.listNotifications(ws, status);
  });

  app.post<{ Params: { notificationId: string } }>("/api/notifications/:notificationId/transition", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const next = text(body, "status") as "SENT" | "ACKED" | "ESCALATED" | "DEAD_LETTER";
    const result = governance.transitionNotification(request.params.notificationId, next, ws);
    await dualWriteAudit(ws);
    return result;
  });

  // --- Model gateway (non-effect inference; fail-closed until a provider is injected) ---
  app.post("/api/model/invoke", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const result = await requireModelGateway().invoke({
      workspaceId: ws,
      operationId: text(body, "operationId"),
      principalId: text(body, "principalId"),
      promptVersion: text(body, "promptVersion"),
      modelVersion: text(body, "modelVersion"),
      prompt: text(body, "prompt"),
      outputSchema: objectBody(body.outputSchema) as unknown as StructuredOutputSchema,
      correlationId: text(body, "correlationId"),
      requestedRetention: body.requestedRetention === "retain" ? "retain" : "zero-retention",
    });
    return reply.status(201).send(result);
  });

  app.get("/api/model/invocations", async (request) => requireModelGateway().listInvocations(workspace(request)));

  // --- AI orchestration: execution + independent review + quality gate (AC-03/AC-04/05/06) ---
  app.post("/api/ai/executions", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reply.status(201).send(aiOrchestrator.submitExecution({
      id: text(body, "id"),
      workspaceId: ws,
      projectId: text(body, "projectId"),
      planId: text(body, "planId"),
      taskId: text(body, "taskId"),
      executorPrincipalId: text(body, "executorPrincipalId"),
      summary: text(body, "summary"),
      evidence: (Array.isArray(body.evidence) ? body.evidence : []) as Parameters<AiOrchestrator["submitExecution"]>[0]["evidence"],
      requirementTraces: (Array.isArray(body.requirementTraces) ? body.requirementTraces : []) as Parameters<AiOrchestrator["submitExecution"]>[0]["requirementTraces"],
      submittedAt: text(body, "submittedAt"),
    }));
  });

  app.get<{ Params: { executionId: string } }>("/api/ai/executions/:executionId", async (request) =>
    aiOrchestrator.getExecution(workspace(request), request.params.executionId),
  );

  app.post("/api/ai/reviews", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    const result = aiOrchestrator.review({
      id: text(body, "id"),
      workspaceId: ws,
      executionId: text(body, "executionId"),
      reviewerPrincipalId: text(body, "reviewerPrincipalId"),
      defects: (Array.isArray(body.defects) ? body.defects : []) as Parameters<AiOrchestrator["review"]>[0]["defects"],
      reviewedAt: text(body, "reviewedAt"),
    });

    // Optional agent work-item reopen bridge on REWORK_REQUIRED.
    // Accepts agentJobId+agentWorkItemId or jobId+workItemId (body or query).
    let reopenedWorkItem:
      | ReturnType<OrchestrationService["reopenFromRework"]>
      | ReturnType<OrchestrationService["markFailed"]>
      | undefined;
    if (result.execution.status === "REWORK_REQUIRED") {
      const rawQuery =
        typeof request.query === "object" && request.query !== null && !Array.isArray(request.query)
          ? (request.query as Record<string, unknown>)
          : {};
      const pickId = (...candidates: unknown[]): string | undefined => {
        for (const candidate of candidates) {
          if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
        }
        return undefined;
      };
      const agentJobId = pickId(body.agentJobId, body.jobId, rawQuery.agentJobId, rawQuery.jobId);
      const agentWorkItemId = pickId(
        body.agentWorkItemId,
        body.workItemId,
        rawQuery.agentWorkItemId,
        rawQuery.workItemId,
      );

      if (agentJobId && agentWorkItemId) {
        const snap = orchestration.getJob(ws, agentJobId);
        const item = snap.workItems.find((entry) => entry.id === agentWorkItemId);
        if (!item) {
          throw new OrchestrationError(
            "NOT_FOUND",
            `work item not found on job: ${agentWorkItemId}`,
          );
        }
        if (item.status === "done" || item.status === "failed") {
          reopenedWorkItem = orchestration.reopenFromRework(ws, agentWorkItemId);
        } else if (item.status === "running") {
          // Still in flight — fail closed with REWORK_REQUIRED rather than inventing a mid-run reopen.
          reopenedWorkItem = orchestration.markFailed(ws, agentWorkItemId, "REWORK_REQUIRED");
        } else {
          throw new OrchestrationError(
            "INVALID_WORK_ITEM_TRANSITION",
            `cannot bridge REWORK_REQUIRED from work item status ${item.status}`,
          );
        }
        await dualWriteAgentState(ws, agentJobId);
        // Live fanout parity: the AI-review REWORK bridge mutates agent job
        // state, so publish so any open ?live=1 subscriber sees the reopen/fail
        // frame. Durable history is already in orch_job_events.
        eventHub.publish({ workspaceId: ws, jobId: agentJobId, kind: "work_item.reopened" });
      }
    }

    return reply.status(201).send({
      ...result,
      ...(reopenedWorkItem ? { reopenedWorkItem } : {}),
    });
  });

  // --- Final reports (AC-13) + approve/reject/follow-up (AC-14) ---
  app.post("/api/reports", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reply.status(201).send(reports.submitReport({
      id: text(body, "id"),
      workspaceId: ws,
      projectId: text(body, "projectId"),
      submittedByPrincipalId: text(body, "submittedByPrincipalId"),
      submittedAt: text(body, "submittedAt"),
      snapshot: objectBody(body.snapshot) as unknown as FinalReportSnapshot,
    }));
  });

  app.get("/api/reports", async (request) => reports.listReports(workspace(request)));

  app.get<{ Params: { reportId: string } }>("/api/reports/:reportId", async (request) =>
    reports.getReport(workspace(request), request.params.reportId),
  );

  app.get<{ Params: { reportId: string } }>("/api/reports/:reportId/immutable", async (request) => ({
    immutable: reports.verifyImmutable(workspace(request), request.params.reportId),
  }));

  app.post<{ Params: { reportId: string } }>("/api/reports/:reportId/approve", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reports.approveReport(ws, request.params.reportId, text(body, "principalId"), text(body, "decidedAt"));
  });

  app.post<{ Params: { reportId: string } }>("/api/reports/:reportId/reject", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reports.rejectReport(ws, request.params.reportId, text(body, "principalId"), text(body, "decidedAt"), text(body, "reason"));
  });

  app.post<{ Params: { reportId: string } }>("/api/reports/:reportId/follow-ups", async (request, reply) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reply.status(201).send(reports.addFollowUp({
      id: text(body, "id"),
      workspaceId: ws,
      reportId: request.params.reportId,
      title: text(body, "title"),
      description: text(body, "description"),
      createdByPrincipalId: text(body, "createdByPrincipalId"),
      createdAt: text(body, "createdAt"),
    }));
  });

  app.get<{ Params: { reportId: string } }>("/api/reports/:reportId/follow-ups", async (request) =>
    reports.followUpsFor(workspace(request), request.params.reportId),
  );

  app.post<{ Params: { followUpId: string } }>("/api/follow-ups/:followUpId/complete", async (request) => {
    const ws = workspace(request);
    const body = objectBody(request.body);
    return reports.completeFollowUp(ws, request.params.followUpId, text(body, "principalId"), text(body, "at"));
  });

  // --- Natural-language agent commands (S0) ---
  // Registered under both `/api/agent` and the versioned `/v1/agent` alias
  // (N-10) via this single helper so the two prefixes can never drift apart:
  // one implementation, shared by both route trees. Auth parity for `/v1` is
  // enforced upstream by isApiPath/isAgentPath (see their doc comments) —
  // this helper does not (and must not) need to know about auth at all.
  function registerAgentRoutes(prefix: string): void {
    app.post(`${prefix}/commands`, async (request, reply) => {
      const ws = workspace(request);
      const operatorPrincipalId = principal(request);
      const body = objectBody(request.body);
      const headerKey = headerText(request, "idempotency-key");
      const bodyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : undefined;
      if (headerKey && bodyKey && headerKey !== bodyKey) {
        throw new NaturalCommandError("IDEMPOTENCY_MISMATCH", "Idempotency-Key header and body.idempotencyKey must match");
      }
      const idempotencyKey = headerKey ?? bodyKey;
      if (!idempotencyKey) {
        throw new NaturalCommandError(
          "IDEMPOTENCY_REQUIRED",
          "Idempotency-Key header or body.idempotencyKey is required",
        );
      }
      const rawBinding = body.resourceBinding;
      let resourceBinding: { resourceType: string; resourceId: string } | undefined;
      if (rawBinding !== undefined && rawBinding !== null) {
        if (typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
          throw new NaturalCommandError(
            "INVALID_RESOURCE_BINDING",
            "resourceBinding must be an object with resourceType and resourceId",
          );
        }
        const binding = rawBinding as Record<string, unknown>;
        const resourceType = typeof binding.resourceType === "string" ? binding.resourceType : "";
        const resourceId = typeof binding.resourceId === "string" ? binding.resourceId : "";
        if (!resourceType.trim() || !resourceId.trim()) {
          throw new NaturalCommandError(
            "INVALID_RESOURCE_BINDING",
            "resourceBinding.resourceType and resourceBinding.resourceId are required together",
          );
        }
        resourceBinding = { resourceType: resourceType.trim(), resourceId: resourceId.trim() };
      }
      const result = await naturalCommands.execute({
        workspaceId: ws,
        operatorPrincipalId,
        text: text(body, "text"),
        idempotencyKey,
        ...(resourceBinding ? { resourceBinding } : {}),
      });
      await dualWriteAgentState(ws, result.jobId);
      eventHub.publish({ workspaceId: ws, jobId: result.jobId, kind: "command.executed" });
      // Idempotency-Key echo + pilot-grade rate-limit headers (N-10). The
      // limiter is advisory (in-process, per-workspace, non-blocking) — see
      // the doc comment on noteAgentCommandRateLimit above.
      const rateLimit = noteAgentCommandRateLimit(ws);
      reply.header("Idempotency-Key", idempotencyKey);
      reply.header("X-RateLimit-Limit", String(rateLimit.limit));
      reply.header("X-RateLimit-Remaining", String(rateLimit.remaining));
      return reply.status(202).send(result);
    });

    app.get<{ Params: { id: string } }>(`${prefix}/jobs/:id`, async (request) => {
      const ws = workspace(request);
      return naturalCommands.getJob(ws, request.params.id);
    });

    app.get<{ Params: { id: string }; Querystring: { stream?: string; live?: string } }>(
      `${prefix}/jobs/:id/events`,
      async (request, reply) => {
        const ws = workspace(request);
        // Authz: same as job GET — workspace header + job must exist.
        const snap = naturalCommands.getJob(ws, request.params.id);
        const accept = String(request.headers.accept ?? "");
        const streamQuery = request.query?.stream;
        const wantsStream =
          accept.includes("text/event-stream") || streamQuery === "1" || streamQuery === "true";

        if (!wantsStream) {
          return reply.status(200).send({ jobId: request.params.id, events: snap.events });
        }

        // Live keep-open mode is opt-in via ?live=1|true. Without it the handler
        // preserves the original burst-then-close contract (see
        // s0-natural-command.integration.test.ts "SSE stream mode emits event
        // frames for job snapshot", which relies on `inject()` receiving a
        // completed response body rather than an indefinitely-open connection).
        const liveQuery = request.query?.live;
        const wantsLive = liveQuery === "1" || liveQuery === "true";

        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });

        const writeEvent = (event: string, data: unknown) => {
          reply.raw.write(`event: ${event}\n`);
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        const emitJobSnapshot = (current: ReturnType<typeof naturalCommands.getJob>) => {
          writeEvent("job.updated", {
            id: current.job.id,
            workspaceId: current.job.workspaceId,
            status: current.job.status,
            source: current.job.source,
            updatedAt: current.job.updatedAt,
          });
          for (const item of current.workItems) {
            writeEvent("work_item.updated", {
              id: item.id,
              jobId: item.jobId,
              status: item.status,
              sequence: item.sequence,
              title: item.title,
              ...(item.controlId ? { controlId: item.controlId } : {}),
              ...(item.intentId ? { intentId: item.intentId } : {}),
              ...(item.errorCode ? { errorCode: item.errorCode } : {}),
            });
            if (item.controlId) {
              writeEvent("control.updated", { id: item.controlId, workItemId: item.id, jobId: item.jobId });
            }
          }
        };

        emitJobSnapshot(snap);

        if (!wantsLive) {
          writeEvent("stream.end", { jobId: snap.job.id });
          reply.raw.end();
          return reply;
        }

        // Live mode: keep the connection open and subscribe to the in-process
        // EventHub for this (workspaceId, jobId). Any subsequent agent mutation
        // on this job during the process lifecycle (command/cancel/complete)
        // re-reads the snapshot and pushes a follow-up frame. No durable replay
        // here — orch_job_events remains the durable log (docs/ops/eventing.md).
        let closed = false;
        // Idle timeout: the live stream auto-closes after this many ms with no
        // further mutation. The timer is reset on every delivered frame, so an
        // actively-updating job stays open (bounded-idle, not a hard cap).
        const idleTimeoutMs = options.sseLiveTimeoutMs ?? 30_000;
        let timeout: ReturnType<typeof setTimeout>;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timeout);
          unsubscribe();
        };

        const closeIdle = () => {
          if (closed) return;
          writeEvent("stream.end", { jobId: request.params.id });
          reply.raw.end();
          cleanup();
        };

        const armIdleTimer = () => {
          clearTimeout(timeout);
          timeout = setTimeout(closeIdle, idleTimeoutMs);
        };

        const unsubscribe = eventHub.subscribe(ws, request.params.id, () => {
          if (closed) return;
          try {
            const latest = naturalCommands.getJob(ws, request.params.id);
            emitJobSnapshot(latest);
            armIdleTimer(); // reset idle window on activity
          } catch {
            // Job vanished from the in-memory SoR mid-stream (should not happen
            // in practice); close rather than crash the server.
            closeIdle();
          }
        });

        reply.raw.on("close", cleanup);
        armIdleTimer();

        return reply;
      },
    );

    app.post<{ Params: { id: string } }>(`${prefix}/jobs/:id/cancel`, async (request, reply) => {
      const ws = workspace(request);
      principal(request);
      const result = naturalCommands.cancelJob(ws, request.params.id);
      await dualWriteAgentState(ws, result.jobId);
      eventHub.publish({ workspaceId: ws, jobId: result.jobId, kind: "job.cancelled" });
      return reply.status(200).send(result);
    });

    app.post<{ Params: { id: string; workItemId: string } }>(
      `${prefix}/jobs/:id/work-items/:workItemId/complete`,
      async (request, reply) => {
        const ws = workspace(request);
        const operatorPrincipalId = principal(request);
        const body = objectBody(request.body);
        try {
          const result = naturalCommands.completeWorkItem({
            workspaceId: ws,
            jobId: request.params.id,
            workItemId: request.params.workItemId,
            intentId: text(body, "intentId"),
            operatorPrincipalId,
          });
          await dualWriteAgentState(ws, result.jobId);
          eventHub.publish({ workspaceId: ws, jobId: result.jobId, kind: "work_item.completed" });
          return reply.status(200).send(result);
        } catch (error) {
          // markFailed may have already mutated the snapshot; mirror best-effort.
          await dualWriteAgentState(ws, request.params.id);
          eventHub.publish({ workspaceId: ws, jobId: request.params.id, kind: "work_item.failed" });
          throw error;
        }
      },
    );
  }

  registerAgentRoutes("/api/agent");
  // Versioned alias (N-10): identical handlers, reached only through the
  // generalized isApiPath/isAgentPath auth gate above — no bypass.
  registerAgentRoutes("/v1/agent");

  // --- Machine-readable OpenAPI 3.x document (N-10 D8) ---
  // Built strictly from the live route table (registeredRoutes, populated by
  // the onRoute hook above) so it cannot hand-drift from the real routes; see
  // openapi.ts and apps/api/test/openapi-contract.test.ts.
  app.get("/api/agent/openapi.json", async () => buildOpenApiDocument(registeredRoutes));

  return app;
}
