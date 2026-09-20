import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  CustomerWorkOsV2Error,
  type PrincipalKind,
  type V2Actor,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
  PgCwosV2StateStore,
  type CwosV2StateStore,
  type V2PgQueryable,
} from "./customer-work-os-v2-runtime.js";

export interface CustomerWorkOsV2RouteOptions {
  store?: CwosV2StateStore;
  now?: () => string;
  /** Explicit only: route registration never reads DATABASE_URL on its own. */
  databaseUrl?: string;
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

/** Bind the CWOS actor from explicit headers. Kind is never defaulted to human. */
function actor(request: FastifyRequest): V2Actor {
  const kind = header(request, "x-principal-kind") as PrincipalKind;
  if (!["human", "ai", "service"].includes(kind)) {
    throw new CustomerWorkOsV2Error("INVALID_HEADER", "x-principal-kind is invalid");
  }
  const botId = optionalHeader(request, "x-bot-id");
  if (botId && kind === "human") {
    throw new CustomerWorkOsV2Error(
      "HUMAN_SPOOF",
      "bot clients cannot bind a human principal",
    );
  }
  return {
    principalId: header(request, "x-principal-id"),
    workspaceId: header(request, "x-workspace-id"),
    kind,
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
    ].includes(error.code)
  ) {
    return 503;
  }
  return 400;
}

function sendKnownError(reply: { status(code: number): { send(payload: unknown): unknown } }, error: unknown): unknown {
  if (error instanceof CustomerWorkOsV2Error) {
    return reply.status(status(error)).send({ error: error.code, message: error.message });
  }
  throw error;
}

export function registerCustomerWorkOsV2Routes(
  app: FastifyInstance,
  options: CustomerWorkOsV2RouteOptions = {},
): CustomerWorkOsV2RuntimeManager {
  let runtime = new CustomerWorkOsV2RuntimeManager(options.store ?? new InMemoryCwosV2StateStore(), options.now);
  let rawPool: RawPool | undefined;
  const databaseUrl = options.databaseUrl?.trim();

  if (!options.store && databaseUrl) {
    app.addHook("onReady", async () => {
      const pg = await import("pg");
      rawPool = new pg.Pool({ connectionString: databaseUrl }) as unknown as RawPool;
      await rawPool.query("SELECT 1");
      runtime = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scopedPool(rawPool)), options.now);
    });
  }

  app.addHook("onClose", async () => {
    await runtime.close();
    if (rawPool) await rawPool.end();
  });

  app.get("/api/cwos/v2/state", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      return reply.status(200).send(envelope);
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/api/cwos/v2/readiness", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
      const envelope = await runtime.readAuthorized(authenticatedActor);
      const openFindings = envelope.state.findings.filter((item) => item.status === "OPEN").length;
      const milestones = envelope.state.milestones
        .filter((item) => item.status === "COMPLETE")
        .map((item) => item.version);
      return reply.status(200).send({
        workspaceId: authenticatedActor.workspaceId,
        runtimeVersion: envelope.version,
        stateHash: envelope.stateHash,
        openFindings,
        completedMilestones: milestones,
        releaseManifests: envelope.state.releaseManifests.length,
        ready: envelope.state.releaseManifests.length > 0 && openFindings === 0,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/api/cwos/v2/commands", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
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
      const result = await runtime.command({
        workspaceId: authenticatedActor.workspaceId,
        actor: authenticatedActor,
        expectedVersion,
        idempotencyKey,
        command: command.trim(),
        payload,
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
