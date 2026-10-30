import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CustomerWorkOsV2Error,
  buildCompanyOverview,
  compareW05ContractDraft,
  assertStepUp,
  type PrincipalKind,
  type V2Actor,
  type W05ContractSource,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
  PgCwosV2StateStore,
  type CwosV2StateStore,
  type V2PgQueryable,
  v2Hash,
} from "./customer-work-os-v2-runtime.js";
import { readNormalizedBusinessProjection } from "./customer-work-os-v2-normalized-projection.js";
import { OperatorStepUpError, type OperatorStepUpService } from "./operator-step-up.js";
import { loginDisabledLoopbackRead } from "./login-disabled.js";
import { contractTermsSchema, renewalDraftRequestSchema } from "./customer-work-os-v2-document-schemas.js";

export interface CustomerWorkOsV2ActorBinding {
  workspaceId: string;
  principalId: string;
  kind: "human";
  stepUpVerified: boolean;
}

export interface CustomerWorkOsV2RouteOptions {
  store?: CwosV2StateStore;
  now?: () => string;
  /** Trusted server-side identity associated with the configured API key. */
  actorBinding?: V2Actor;
  operatorStepUp?: OperatorStepUpService;
  /** Explicit only: route registration never reads DATABASE_URL on its own. */
  databaseUrl?: string;
  /** Runtime profile controls whether the in-memory store is an allowed fallback. */
  profile?: "test" | "development" | "production";
  /** Existing workspace-scoped business producer, injectable for isolated PG verification. */
  normalizedProjectionPool?: V2PgQueryable;
  readonly mailCandidateWriter?: true;
  readonly mailCandidateReader?: true;
}

const mailCandidateRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  workspaceId: z.string().trim().min(1).optional(),
  provider: z.enum(["GMAIL", "OUTLOOK"]),
  mailbox: z.string().trim().email().max(254),
  sourceLocator: z.string().trim().min(1).max(1000),
  providerEventId: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(500),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  senderCompany: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
  receivedAt: z.string().datetime().optional(),
  evidenceUrl: z.string().url().max(2000).refine(value => {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  }).optional(),
}).strict();

const reviewRequestSchema = z.discriminatedUnion("action", [
  z.object({ expectedVersion: z.number().int().nonnegative(), candidateId: z.string().trim().min(1), action: z.literal("LINK"), accountId: z.string().trim().min(1) }).strict(),
  z.object({ expectedVersion: z.number().int().nonnegative(), candidateId: z.string().trim().min(1), action: z.literal("NEW_ACCOUNT"), companyName: z.string().trim().min(1).max(300) }).strict(),
  z.object({ expectedVersion: z.number().int().nonnegative(), candidateId: z.string().trim().min(1), action: z.literal("DISCARD"), reason: z.enum(["NOT_RELEVANT", "DUPLICATE", "SPAM", "OTHER"]) }).strict(),
  z.object({ expectedVersion: z.number().int().nonnegative(), candidateId: z.string().trim().min(1), action: z.literal("UNDO"), reviewId: z.string().trim().min(1) }).strict(),
]);

const draftMoneySchema = z.string().regex(/^\d+$/).max(30);
const quoteDraftRequestSchema = z.object({
  action: z.literal("QUOTE"),
  expectedVersion: z.number().int().nonnegative(),
  input: z.object({
    engagement: z.object({ id: z.string().trim().min(1), version: z.number().int().positive() }).strict(),
    versionLabel: z.string().trim().min(1).max(200),
    validUntil: z.string().date(),
    scope: z.string().trim().min(1).max(5000),
    lines: z.array(z.object({
      id: z.string().trim().min(1), sourceId: z.string().trim().min(1),
      productId: z.string().trim().min(1), description: z.string().trim().min(1).max(2000),
      quantity: z.number().int().positive().max(1_000_000),
      unitCostKrw: draftMoneySchema, unitPriceKrw: draftMoneySchema,
      vendorAccountId: z.string().trim().min(1).optional(),
    }).strict()).min(1).max(100),
    options: z.array(z.string().trim().min(1).max(2000)).max(100),
    templateRef: z.string().trim().min(1).max(1000),
    vat: z.object({
      netAmountKrw: draftMoneySchema, vatAmountKrw: draftMoneySchema, grossAmountKrw: draftMoneySchema,
    }).strict(),
    po: z.object({ customerPoId: z.string().trim().min(1), supplierPoId: z.string().trim().min(1) }).strict(),
  }).strict(),
}).strict();

const documentDraftRequestSchema = z.discriminatedUnion("action", [quoteDraftRequestSchema, renewalDraftRequestSchema]);
const comparisonQuerySchema = z.object({
  renewalId: z.string().trim().min(1).max(200),
  revisionId: z.string().trim().min(1).max(200),
}).strict();
const contractRowSchema = z.object({
  id: z.string(), version: z.number().int().positive(),
  valueKrw: z.string(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  scope: z.string(), exclusions: z.array(z.unknown()), billingMilestones: z.array(z.unknown()).min(1), items: z.unknown(),
});

async function readContractSources(pool: V2PgQueryable, workspaceId: string, id?: string): Promise<W05ContractSource[]> {
  if (!pool.withWorkspaceScope) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "scoped contract storage is required");
  const result = await pool.withWorkspaceScope(workspaceId, db => db.query(
    `SELECT c.id,c.version,c.contract_value_krw::text AS "valueKrw",
      c.effective_from::text AS "startDate",c.effective_to::text AS "endDate",
      c.scope,c.exclusions,c.billing_milestones AS "billingMilestones",q.bom_lines AS items
     FROM cwos_contracts c LEFT JOIN cwos_quotes q
       ON q.workspace_id=c.workspace_id AND q.id=c.quote_id
     WHERE c.workspace_id=$1::uuid${id === undefined ? "" : " AND c.id=$2"} ORDER BY c.id`,
    id === undefined ? [workspaceId] : [workspaceId, id],
  ));
  return result.rows.map(value => {
    const row = contractRowSchema.safeParse(value);
    if (!row.success) throw new CustomerWorkOsV2Error("INVALID_STATE", "stored contract is not readable");
    const source = row.data;
    const items = z.array(contractTermsSchema.shape.items.unwrap().element.strip()
      .extend({ unitPriceKrw: z.string().regex(/^\d+$/).nullable().default(null) }))
      .nullable().safeParse(source.items);
    const billing = source.billingMilestones;
    const conditions = [source.scope,
      ...source.exclusions.map(value => typeof value === "string" ? value : JSON.stringify(value)),
      JSON.stringify(billing)].filter(Boolean);
    const terms = contractTermsSchema.safeParse({
      startDate: source.startDate, endDate: source.endDate, valueKrw: source.valueKrw,
      items: items.success ? items.data : null,
      conditions: conditions.length > 0 ? conditions : null,
    });
    if (!terms.success) throw new CustomerWorkOsV2Error("INVALID_STATE", "stored contract terms are not readable");
    return { kind: "NORMALIZED", id: source.id, version: source.version,
      reference: `cwos_contracts:${source.id}@${source.version}`, terms: terms.data };
  });
}

interface RawConnection {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

interface RawPool {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<RawConnection>;
  end(): Promise<void>;
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !text.trim()) {
    throw new CustomerWorkOsV2Error("INVALID_HEADER", `${name} header is required`);
  }
  return text.trim();
}

function optionalHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string" || !text.trim()) return undefined;
  return text.trim();
}

function peerAddress(request: FastifyRequest): string | undefined {
  const socketAddress = request.socket?.remoteAddress;
  return typeof socketAddress === "string" && socketAddress.length > 0 ? socketAddress : request.ip;
}

function loginDisabledRead(request: FastifyRequest, binding?: V2Actor): boolean {
  return loginDisabledLoopbackRead({
    flag: process.env.CWOS_LOGIN_DISABLED,
    method: request.method,
    peerAddress: peerAddress(request),
    binding,
  });
}

function requireHumanRead(request: FastifyRequest, actor: V2Actor, binding: V2Actor | undefined, stepUp?: OperatorStepUpService): void {
  if (loginDisabledRead(request, binding)) {
    if (actor.kind !== "human") throw new CustomerWorkOsV2Error("HUMAN_REQUIRED", "a human principal is required");
    return;
  }
  if (actor.kind !== "human" || !actor.stepUpVerified || !stepUp) {
    throw new CustomerWorkOsV2Error("STEP_UP_REQUIRED", "fresh admitted operator proof is required");
  }
}

/** Bind the CWOS actor from headers in dev, or from authenticated server config in API-key mode. */
function actor(request: FastifyRequest, binding?: V2Actor, stepUp?: OperatorStepUpService): V2Actor {
  const claimedKind = header(request, "x-principal-kind") as PrincipalKind;
  if (!["human", "ai", "service"].includes(claimedKind)) {
    throw new CustomerWorkOsV2Error("INVALID_HEADER", "x-principal-kind is invalid");
  }
  const claimedPrincipalId = header(request, "x-principal-id");
  const claimedWorkspaceId = header(request, "x-workspace-id");
  const botId = optionalHeader(request, "x-bot-id");

  if (binding) {
    if (
      claimedPrincipalId !== binding.principalId ||
      claimedWorkspaceId !== binding.workspaceId ||
      claimedKind !== binding.kind
    ) {
      throw new CustomerWorkOsV2Error(
        "ACTOR_BINDING_MISMATCH",
        "request actor does not match the server-bound API-key operator",
      );
    }
    if (optionalHeader(request, "x-step-up")) {
      throw new CustomerWorkOsV2Error(
        "UNTRUSTED_STEP_UP",
        "x-step-up is not accepted when step-up authority is server-bound",
      );
    }
    if (botId && binding.kind === "human") {
      throw new CustomerWorkOsV2Error("HUMAN_SPOOF", "bot clients cannot bind a human principal");
    }
    const readWithoutLogin = loginDisabledRead(request, binding);
    if (stepUp && !readWithoutLogin) {
      return {
        ...binding,
        stepUpVerified: stepUp.authorize({
          cookieHeader: optionalHeader(request, "cookie"),
          csrfHeader: optionalHeader(request, "x-csrf-token"), method: request.method,
        }),
      };
    }
    return readWithoutLogin ? { ...binding, stepUpVerified: false } : { ...binding };
  }

  if (botId && claimedKind === "human") {
    throw new CustomerWorkOsV2Error(
      "HUMAN_SPOOF",
      "bot clients cannot bind a human principal",
    );
  }
  return {
    principalId: claimedPrincipalId,
    workspaceId: claimedWorkspaceId,
    kind: claimedKind,
    stepUpVerified: String(request.headers["x-step-up"] ?? "").toLowerCase() === "true",
  };
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV2Error("INVALID_INPUT", "body must be an object");
  }
  return value as Record<string, unknown>;
}

function scopedPool(pool: RawPool): V2PgQueryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      return (await pool.query(text, values)) as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: V2PgQueryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        const scoped: V2PgQueryable = {
          async query<T2 = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            return (await client.query(text, values)) as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function status(error: CustomerWorkOsV2Error): number {
  if (
    [
      "CROSS_WORKSPACE",
      "CROSS_WORKSPACE_STATE",
      "HUMAN_REQUIRED",
      "STEP_UP_REQUIRED",
      "SELF_APPROVAL",
      "PORTAL_ACCESS_DENIED",
      "SUPPORT_ACCESS_DENIED",
      "PRINCIPAL_REQUIRED",
      "PRINCIPAL_KIND_MISMATCH",
      "HUMAN_SPOOF",
      "MEMBERSHIP_REQUIRED",
      "BOOTSTRAP_REQUIRED",
      "INVALID_BOOTSTRAP_PRINCIPAL",
      "ACTOR_BINDING_MISMATCH",
      "UNTRUSTED_STEP_UP",
      "MAIL_CANDIDATE_WRITER_REQUIRED",
    ].includes(error.code)
  ) {
    return 403;
  }
  if (
    [
      "CONCURRENT_MODIFICATION",
      "IDEMPOTENCY_CONFLICT",
      "REPLAYED_APPROVAL",
      "STALE_APPROVAL",
      "CANDIDATE_CONFLICT",
    ].includes(error.code)
  ) {
    return 409;
  }
  if (error.code.endsWith("NOT_FOUND")) return 404;
  if (
    [
      "STATE_HASH_MISMATCH",
      "AUDIT_CHAIN_MISMATCH",
      "INVALID_STATE",
      "UNSUPPORTED_STATE",
      "PG_SCOPE_REQUIRED",
      "INVALID_CLOCK",
      "MAIL_SCHEMA_NOT_READY",
      "MAIL_OUTBOX_PERSIST_FAILED",
      "NORMALIZED_STORAGE_REQUIRED",
    ].includes(error.code)
  ) {
    return 503;
  }
  return 400;
}

function sendKnownError(reply: { status(code: number): { send(payload: unknown): unknown } }, error: unknown): unknown {
  if (error instanceof OperatorStepUpError) {
    return reply.status(error.statusCode).send({ error: error.code });
  }
  if (error instanceof CustomerWorkOsV2Error) {
    return reply.status(status(error)).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerCustomerWorkOsV2Routes(
  app: FastifyInstance,
  options: CustomerWorkOsV2RouteOptions = {},
): CustomerWorkOsV2RuntimeManager {
  const profile = options.profile ?? (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development");
  const databaseUrl = options.databaseUrl?.trim();
  const explicitStore = options.store !== undefined;
  if (profile === "production" && !explicitStore && !databaseUrl) {
    throw new Error("[CWOS_STORAGE_REQUIRED_IN_PROD] production Customer Work OS requires databaseUrl or an explicit store; refusing memory mode");
  }
  if (profile === "production" && !options.actorBinding) {
    throw new Error("[CWOS_V2_ACTOR_BINDING_REQUIRED_IN_PROD] production routes require server-bound authority");
  }
  if (options.operatorStepUp && (options.actorBinding?.kind !== "human"
    || options.actorBinding.workspaceId !== options.operatorStepUp.workspaceId
    || options.actorBinding.principalId !== options.operatorStepUp.principalId)) {
    throw new Error("[CWOS_V2_OPERATOR_AUTH_SCOPE] step-up authentication requires its admitted human binding");
  }
  if (options.mailCandidateWriter && options.actorBinding?.kind !== "service") {
    throw new Error("[CWOS_V2_MAIL_CANDIDATE_BINDING_INVALID] candidate writer requires its server-bound service principal");
  }
  if (profile === "production" && options.actorBinding?.kind === "human" && !options.operatorStepUp) {
    throw new Error("[CWOS_V2_OPERATOR_AUTH_REQUIRED] production human actor requires fresh authenticated proof");
  }
  let storageMode: "memory" | "postgres" = databaseUrl && !explicitStore ? "postgres" : "memory";
  let dbProbe: "not_configured" | "ok" | "failed" = storageMode === "postgres" ? "failed" : "not_configured";
  let schemaVersion: string | null = null;
  let recentProcessingState: "unknown" | "idle" | "database_unavailable" = storageMode === "postgres" ? "unknown" : "idle";
  let runtime = new CustomerWorkOsV2RuntimeManager(options.store ?? new InMemoryCwosV2StateStore(), options.now);
  let rawPool: RawPool | undefined;

  if (!options.store && databaseUrl) {
    app.addHook("onReady", async () => {
      const pg = await import("pg");
      rawPool = new pg.Pool({ connectionString: databaseUrl }) as unknown as RawPool;
      await rawPool.query("SELECT 1");
      const migrationRows = (await rawPool.query(
        "SELECT id FROM schema_migrations ORDER BY id DESC",
      )) as { rows: Array<{ id: string }> };
      const applied = new Set(migrationRows.rows.map((row) => row.id));
      const requiredMigration = "0019_customer_work_os_v2_runtime";
      if (!applied.has(requiredMigration)) {
        throw new Error(`[CWOS_SCHEMA_NOT_READY] required migration ${requiredMigration} is not applied`);
      }
      schemaVersion = migrationRows.rows[0]?.id ?? requiredMigration;
      dbProbe = "ok";
      recentProcessingState = "idle";
      runtime = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scopedPool(rawPool)), options.now);
    });
  }

  app.addHook("onClose", async () => {
    await runtime.close();
    if (rawPool) await rawPool.end();
  });

  if (options.operatorStepUp) {
    const operatorStepUp = options.operatorStepUp;
    app.post("/api/cwos/v2/operator-step-up", async (request, reply) => {
      try {
        // Validate server-bound claims without granting step-up or reading/mutating native state.
        actor(request, options.actorBinding);
        const proof = operatorStepUp.authenticate(request.body, operatorStepUp.clientAddress(request.headers));
        reply.header("set-cookie", proof.cookie);
        return reply.status(200).send({ csrf: proof.csrf, expiresAt: proof.expiresAt });
      } catch (error) {
        if (error instanceof OperatorStepUpError) {
          request.log.warn({ reason: error.code }, "Operator authentication rejected");
          if (error.retryAfterMs !== undefined) {
            reply.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
          }
          return reply.status(401).send({ error: "OPERATOR_UNAUTHENTICATED" });
        }
        return sendKnownError(reply, error);
      }
    });
  }

  app.get("/api/cwos/v2/state", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      return reply.status(200).send(envelope);
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  if (options.mailCandidateReader) {
    for (const path of ["/api/cwos/v2/mail-candidates", "/api/cwos/v2/mail-candidates/count"]) {
      app.get(path, async (request, reply) => {
        try {
          const authenticatedActor = actor(request, options.actorBinding);
          const envelope = await runtime.readAuthorized(authenticatedActor);
          const candidates = (envelope.state.inbox.mailCandidates ?? [])
            .filter(candidate => candidate.workspaceId === authenticatedActor.workspaceId)
            .map(candidate => ({
              id: candidate.id, status: candidate.status, confirmed: candidate.confirmed,
              freshness: candidate.freshness, createdAt: candidate.createdAt,
            }));
          return reply.status(200).send({
            workspaceId: authenticatedActor.workspaceId, count: candidates.length,
            ...(path === "/api/cwos/v2/mail-candidates" ? { candidates } : {}),
          });
        } catch (error) {
          return sendKnownError(reply, error);
        }
      });
    }
  }

  if (options.mailCandidateWriter) {
    app.post("/api/cwos/v2/mail-candidates", async (request, reply) => {
      try {
        const authenticatedActor = actor(request, options.actorBinding);
        const parsed = mailCandidateRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new CustomerWorkOsV2Error("INVALID_INPUT", "invalid Mail candidate creation payload");
        }
        const input = parsed.data;
        if (input.workspaceId && input.workspaceId !== authenticatedActor.workspaceId) {
          throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "candidate workspace must match the admitted writer");
        }
        const result = await runtime.command({
          workspaceId: authenticatedActor.workspaceId, actor: authenticatedActor,
          expectedVersion: input.expectedVersion, idempotencyKey: header(request, "idempotency-key"),
          command: "mail.candidate.create",
          payload: {
            id: `mail-candidate-${v2Hash({ workspaceId: authenticatedActor.workspaceId, provider: input.provider,
              mailbox: input.mailbox, providerEventId: input.providerEventId })}`,
            provider: input.provider, mailbox: input.mailbox, sourceLocator: input.sourceLocator,
            providerEventId: input.providerEventId, subject: input.subject, bodyDigest: input.bodyDigest,
            ...(input.senderCompany ? { senderCompany: input.senderCompany } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
            ...(input.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
          },
        });
        return reply.status(201).send({ candidate: result.result, runtimeVersion: result.envelope.version });
      } catch (error) {
        return sendKnownError(reply, error);
      }
    });
  }

  app.get("/api/cwos/v2/mail-candidate-review", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      requireHumanRead(request, authenticatedActor, options.actorBinding, options.operatorStepUp);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
      if (!pool?.withWorkspaceScope) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "workspace-scoped accounts require PostgreSQL");
      const accounts = await pool.withWorkspaceScope(authenticatedActor.workspaceId, async db => {
        const result = await db.query<{ id: string; name: string }>(
          "SELECT id, name FROM cwos_accounts WHERE workspace_id=$1::uuid ORDER BY name", [authenticatedActor.workspaceId],
        );
        return result.rows;
      });
      const candidates = (envelope.state.inbox.mailCandidates ?? [])
        .filter(candidate => candidate.workspaceId === authenticatedActor.workspaceId)
        .map(candidate => {
          const history = (envelope.state.inbox.mailCandidateReviews ?? [])
            .filter(item => item.candidateId === candidate.id)
            .sort((left, right) => left.version - right.version);
          return {
            id: candidate.id, provider: candidate.provider, senderCompany: candidate.senderCompany ?? null,
            summary: candidate.summary ?? candidate.subject, receivedAt: candidate.receivedAt ?? null,
            createdAt: candidate.createdAt, evidenceUrl: candidate.evidenceUrl ?? null,
            sourceLocator: candidate.sourceLocator, review: history.at(-1) ?? null, history,
          };
        });
      return reply.status(200).send({ workspaceId: authenticatedActor.workspaceId, runtimeVersion: envelope.version, accounts, candidates });
    } catch (error) { return sendKnownError(reply, error); }
  });

  app.post("/api/cwos/v2/mail-candidate-review", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      if (authenticatedActor.kind !== "human" || !authenticatedActor.stepUpVerified || !options.operatorStepUp) {
        throw new CustomerWorkOsV2Error("STEP_UP_REQUIRED", "fresh admitted operator proof is required");
      }
      const parsed = reviewRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new CustomerWorkOsV2Error("INVALID_INPUT", "invalid Mail candidate review request");
      const input = parsed.data;
      const key = header(request, "idempotency-key");
      let command: string;
      let payload: Record<string, unknown>;
      if (input.action === "UNDO") {
        command = "mail.candidate.review.undo";
        payload = { id: `mail-review-${v2Hash({ workspaceId: authenticatedActor.workspaceId, candidateId: input.candidateId, reviewId: input.reviewId, key }).slice(0, 32)}`, candidateId: input.candidateId, reviewId: input.reviewId };
      } else {
        let outcome: "LINKED" | "NEW_ACCOUNT_CANDIDATE" | "DISCARDED";
        let accountId: string | undefined;
        let companyName: string | undefined;
        let reason: string | undefined;
        switch (input.action) {
          case "LINK": {
            const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
            if (!pool?.withWorkspaceScope) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "workspace-scoped accounts require PostgreSQL");
            const rows = await pool.withWorkspaceScope(authenticatedActor.workspaceId, db => db.query<{ id: string }>(
              "SELECT id FROM cwos_accounts WHERE workspace_id=$1::uuid AND id=$2", [authenticatedActor.workspaceId, input.accountId],
            ));
            if (!rows.rows[0]) throw new CustomerWorkOsV2Error("ACCOUNT_NOT_FOUND", "account is not available in this workspace");
            outcome = "LINKED"; accountId = rows.rows[0].id; break;
          }
          case "NEW_ACCOUNT": outcome = "NEW_ACCOUNT_CANDIDATE"; companyName = input.companyName; break;
          case "DISCARD": outcome = "DISCARDED"; reason = input.reason; break;
        }
        command = "mail.candidate.review";
        payload = { id: `mail-review-${v2Hash({ workspaceId: authenticatedActor.workspaceId, candidateId: input.candidateId, key }).slice(0, 32)}`, candidateId: input.candidateId, outcome,
          ...(accountId ? { accountId } : {}), ...(companyName ? { companyName } : {}), ...(reason ? { reason } : {}) };
      }
      const result = await runtime.command({ workspaceId: authenticatedActor.workspaceId, actor: authenticatedActor,
        expectedVersion: input.expectedVersion, idempotencyKey: key, command, payload });
      return reply.status(200).send({ review: result.result, runtimeVersion: result.envelope.version });
    } catch (error) { return sendKnownError(reply, error); }
  });

  app.get("/api/cwos/v2/document-drafts", async (request, reply) => {
    try {
      const owner = actor(request, options.actorBinding, options.operatorStepUp);
      requireHumanRead(request, owner, options.actorBinding, options.operatorStepUp);
      const envelope = await runtime.readAuthorized(owner);
      if (Object.keys(body(request.query)).length > 0) {
        const selection = comparisonQuerySchema.safeParse(request.query);
        if (!selection.success) throw new CustomerWorkOsV2Error("INVALID_INPUT", "comparison requires renewalId and revisionId");
        const renewal = envelope.state.renewals?.drafts.find(draft => draft.id === selection.data.renewalId);
        const revision = renewal?.revisions.find(item => item.revisionId === selection.data.revisionId);
        if (!renewal || !revision?.contractDraft) throw new CustomerWorkOsV2Error("RENEWAL_NOT_FOUND", "structured renewal revision is not available");
        return reply.status(200).send({
          workspaceId: owner.workspaceId, runtimeVersion: envelope.version,
          renewalId: renewal.id, revisionId: revision.revisionId,
          source: revision.contractDraft.source, terms: revision.contractDraft.terms,
          comparison: compareW05ContractDraft(revision.contractDraft),
          approvalStatus: "NOT_APPROVED",
        });
      }
      const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
      if (!pool?.withWorkspaceScope) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "workspace-scoped business data requires PostgreSQL");
      const engagements = await pool.withWorkspaceScope(owner.workspaceId, async db =>
        (await db.query<{ id: string; name: string; version: number }>(
          "SELECT id,name,version FROM cwos_engagements WHERE workspace_id=$1::uuid ORDER BY name", [owner.workspaceId],
        )).rows);
      const sources = new Map((await readContractSources(pool, owner.workspaceId)).map(source => [`${source.kind}:${source.id}`, source]));
      for (const revision of [...(envelope.state.renewals?.drafts.flatMap(draft => draft.revisions) ?? [])]
        .sort((left, right) => left.observedAt.localeCompare(right.observedAt))) {
        const source = revision.contractDraft?.source;
        if (source?.kind === "OWNER_INPUT") sources.set(`${source.kind}:${source.id}`, source);
      }
      return reply.status(200).send({
        workspaceId: owner.workspaceId, runtimeVersion: envelope.version, engagements,
        quoteDrafts: envelope.state.quoteDrafts ?? [],
        contracts: [...sources.values()],
        renewalDrafts: envelope.state.renewals?.drafts.filter(draft => draft.revisions.some(revision => revision.contractDraft !== undefined)) ?? [],
      });
    } catch (error) { return sendKnownError(reply, error); }
  });

  app.post("/api/cwos/v2/document-drafts", async (request, reply) => {
    try {
      const owner = actor(request, options.actorBinding, options.operatorStepUp);
      if (owner.kind !== "human" || !owner.stepUpVerified || !options.operatorStepUp) {
        throw new CustomerWorkOsV2Error("STEP_UP_REQUIRED", "fresh admitted operator proof is required");
      }
      await runtime.readAuthorized(owner);
      const parsed = documentDraftRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new CustomerWorkOsV2Error("INVALID_INPUT", "invalid document draft input");
      const input = parsed.data;
      const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
      if (!pool?.withWorkspaceScope) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "workspace-scoped business data requires PostgreSQL");
      if (input.action === "RENEWAL") {
        let source: W05ContractSource;
        if (input.source.kind === "NORMALIZED") {
          const stored = (await readContractSources(pool, owner.workspaceId, input.source.id))[0];
          if (!stored) throw new CustomerWorkOsV2Error("CONTRACT_NOT_FOUND", "contract is not available in this workspace");
          if (stored.version !== input.source.version) throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "source contract changed; refresh before drafting");
          source = stored;
        } else {
          source = { ...input.source, version: null };
        }
        const result = await runtime.command({
          workspaceId: owner.workspaceId, actor: owner, expectedVersion: input.expectedVersion,
          idempotencyKey: header(request, "idempotency-key"), command: "w05.contractDraft",
          payload: { renewalId: input.renewalId, revisionId: input.revisionId,
            revisionLabel: input.revisionLabel, source, terms: input.terms },
        });
        return reply.status(201).send({ draft: result.result, runtimeVersion: result.envelope.version });
      }
      const source = await pool.withWorkspaceScope(owner.workspaceId, db =>
        db.query<{ version: number }>(
          "SELECT version FROM cwos_engagements WHERE workspace_id=$1::uuid AND id=$2",
          [owner.workspaceId, input.input.engagement.id],
        ));
      if (!source.rows[0]) throw new CustomerWorkOsV2Error("ENGAGEMENT_NOT_FOUND", "engagement is not available in this workspace");
      if (source.rows[0].version !== input.input.engagement.version) {
        throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "source engagement changed; refresh before drafting");
      }
      const result = await runtime.command({
        workspaceId: owner.workspaceId, actor: owner, expectedVersion: input.expectedVersion,
        idempotencyKey: header(request, "idempotency-key"), command: "w01.quoteDraft", payload: input.input,
      });
      return reply.status(201).send({ draft: result.result, runtimeVersion: result.envelope.version });
    } catch (error) { return sendKnownError(reply, error); }
  });

  app.get("/api/cwos/v2/company-overview", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      return reply.status(200).send(
        buildCompanyOverview(envelope.state, authenticatedActor.workspaceId, (options.now ?? (() => new Date().toISOString()))()),
      );
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get<{ Params: { planId: string } }>("/api/cwos/v2/normalized-projections/:planId", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      await runtime.readAuthorized(authenticatedActor);
      const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
      if (!pool) {
        throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "normalized projection requires PostgreSQL");
      }
      return reply.status(200).send(await readNormalizedBusinessProjection(
        pool, authenticatedActor.workspaceId, request.params.planId,
      ));
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/api/cwos/v2/readiness", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      const openFindings = envelope.state.findings.filter((item) => item.status === "OPEN").length;
      const milestones = envelope.state.milestones
        .filter((item) => item.status === "COMPLETE")
        .map((item) => item.version);
      return reply.status(200).send({
        workspaceId: authenticatedActor.workspaceId,
        runtimeVersion: envelope.version,
        stateHash: envelope.stateHash,
        storageMode,
        dbProbe,
        schemaVersion,
        recentProcessingState,
        openFindings,
        completedMilestones: milestones,
        releaseManifests: envelope.state.releaseManifests.length,
        ready:
          dbProbe === "ok" || storageMode === "memory"
            ? envelope.state.releaseManifests.length > 0 && openFindings === 0
            : false,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/api/cwos/v2/commands", async (request, reply) => {
    try {
      const authenticatedActor = actor(request, options.actorBinding, options.operatorStepUp);
      const input = body(request.body);
      const command = input.command;
      const expectedVersion = input.expectedVersion;
      const payload = input.payload;
      if (
        typeof command !== "string" ||
        !command.trim() ||
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw new CustomerWorkOsV2Error(
          "INVALID_INPUT",
          "command and non-negative expectedVersion are required",
        );
      }
      if (typeof command === "string" && (command.startsWith("mail.candidate.review") || command === "w05.contractDraft")) {
        throw new CustomerWorkOsV2Error("TRUSTED_REVIEW_ROUTE_REQUIRED", "candidate reviews must use the trusted review route");
      }
      const idempotencyKey = header(request, "idempotency-key");
      let commandPayload = payload;
      if (command.trim() === "business.reconcileNormalized") {
        await runtime.readAuthorized(authenticatedActor);
        assertStepUp(authenticatedActor);
        const pool = options.normalizedProjectionPool ?? (rawPool ? scopedPool(rawPool) : undefined);
        if (!pool) throw new CustomerWorkOsV2Error("NORMALIZED_STORAGE_REQUIRED", "normalized producer requires PostgreSQL");
        const requestedSource = body(payload);
        if (Object.keys(requestedSource).some(key => key !== "planId")) {
          throw new CustomerWorkOsV2Error("INVALID_INPUT", "normalized reconciliation accepts only planId");
        }
        const planId = requestedSource.planId;
        if (typeof planId !== "string" || !planId.trim()) {
          throw new CustomerWorkOsV2Error("INVALID_INPUT", "planId is required");
        }
        const source = await readNormalizedBusinessProjection(pool, authenticatedActor.workspaceId, planId.trim());
        const ids = (rows: readonly Record<string, unknown>[]) => rows.map(row => {
          if (typeof row.id !== "string" || !row.id.trim()) {
            throw new CustomerWorkOsV2Error("INVALID_STATE", "normalized row requires canonical id");
          }
          return row.id;
        });
        commandPayload = {
          planId: source.planId, snapshotHash: source.snapshotHash, planHash: source.planHash, planVersion: source.planVersion,
          sourceDigest: v2Hash(source), sourceObservedAt: source.sourceObservedAt,
          accountIds: ids(source.accounts), engagementIds: ids(source.engagements), financialItemIds: ids(source.financialItems),
        };
      }
      const result = await runtime.command({
        workspaceId: authenticatedActor.workspaceId,
        actor: authenticatedActor,
        expectedVersion,
        idempotencyKey,
        command: command.trim(),
        payload: commandPayload,
      });
      reply.header("Idempotency-Key", idempotencyKey);
      return reply.status(result.statusCode).send({
        result: result.result,
        runtimeVersion: result.envelope.version,
        stateHash: result.envelope.stateHash,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  return runtime;
}

export function createStandaloneCustomerWorkOsV2App(
  options: CustomerWorkOsV2RouteOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerCustomerWorkOsV2Routes(app, options);
  return app;
}
