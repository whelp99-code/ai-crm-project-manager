import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CustomerWorkOsV2Error,
  buildCompanyOverview,
  assertStepUp,
  type PrincipalKind,
  type V2Actor,
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
}).strict();

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
    return stepUp ? {
      ...binding,
      stepUpVerified: stepUp.authorize({
        cookieHeader: optionalHeader(request, "cookie"),
        csrfHeader: optionalHeader(request, "x-csrf-token"), method: request.method,
      }),
    } : { ...binding };
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
  const storageMode: "memory" | "postgres" = databaseUrl && !explicitStore ? "postgres" : "memory";
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
        const proof = operatorStepUp.authenticate(request.body, request.ip);
        reply.header("set-cookie", proof.cookie);
        return reply.status(200).send({ csrf: proof.csrf, expiresAt: proof.expiresAt });
      } catch (error) {
        return sendKnownError(reply, error);
      }
    });
    app.get("/api/cwos/v2/operator-session", async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        actor(request, options.actorBinding, operatorStepUp);
        return reply.status(200).send({ authenticated: true });
      } catch (error) {
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
          },
        });
        return reply.status(201).send({ candidate: result.result, runtimeVersion: result.envelope.version });
      } catch (error) {
        return sendKnownError(reply, error);
      }
    });
  }

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
