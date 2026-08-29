import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CustomerWorkOsV25Error,
  type AutomationActor,
} from "@ai-crm/domain/customer-work-os-v2.5";
import {
  CustomerWorkOsV25RuntimeManager,
  InMemoryV25StateStore,
  PgV25StateStore,
  type V25PgQueryable,
  type V25StateStore,
} from "./customer-work-os-v25-runtime.js";

export interface CustomerWorkOsV25RouteOptions {
  store?: V25StateStore;
  databaseUrl?: string;
  now?: () => string;
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
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new CustomerWorkOsV25Error("INVALID_HEADER", `${name} header is required`);
  }
  return candidate.trim();
}

function actor(request: FastifyRequest): AutomationActor {
  const kind = String(request.headers["x-principal-kind"] ?? "human");
  if (!["human", "ai", "service"].includes(kind)) {
    throw new CustomerWorkOsV25Error("INVALID_HEADER", "x-principal-kind is invalid");
  }
  return {
    principalId: header(request, "x-principal-id"),
    workspaceId: header(request, "x-workspace-id"),
    kind: kind as AutomationActor["kind"],
    stepUpVerified: String(request.headers["x-step-up"] ?? "").toLowerCase() === "true",
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerWorkOsV25Error("INVALID_INPUT", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function expectedVersion(input: Record<string, unknown>): number {
  const value = input.expectedVersion;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CustomerWorkOsV25Error("INVALID_INPUT", "non-negative expectedVersion is required");
  }
  return value;
}

function status(error: CustomerWorkOsV25Error): number {
  if (["CROSS_WORKSPACE", "HUMAN_REQUIRED", "STEP_UP_REQUIRED", "AUTOMATION_PRINCIPAL_FORBIDDEN"].includes(error.code)) return 403;
  if (["CONCURRENT_MODIFICATION", "IDEMPOTENCY_CONFLICT", "DUPLICATE_PLAN", "DUPLICATE_CONNECTOR"].includes(error.code)) return 409;
  if (error.code.endsWith("NOT_FOUND")) return 404;
  if (["STATE_HASH_MISMATCH", "INVALID_STATE", "UNSUPPORTED_STATE", "PG_SCOPE_REQUIRED"].includes(error.code)) return 503;
  return 400;
}

function sendError(reply: { status(code: number): { send(payload: unknown): unknown } }, error: unknown): unknown {
  if (error instanceof CustomerWorkOsV25Error) {
    return reply.status(status(error)).send({ error: error.code, message: error.message });
  }
  throw error;
}

function scopedPool(pool: RawPool): V25PgQueryable {
  return {
    async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      return (await pool.query(text, values)) as { rows: T[]; rowCount: number | null };
    },
    async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: V25PgQueryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
        const scoped: V25PgQueryable = {
          async query<T2 = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            return (await client.query(text, values)) as { rows: T2[]; rowCount: number | null };
          },
        };
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function registerCustomerWorkOsV25Routes(
  app: FastifyInstance,
  options: CustomerWorkOsV25RouteOptions = {},
): CustomerWorkOsV25RuntimeManager {
  let runtime = new CustomerWorkOsV25RuntimeManager(options.store ?? new InMemoryV25StateStore(), options.now);
  let rawPool: RawPool | undefined;
  const databaseUrl = options.databaseUrl?.trim();

  if (!options.store && databaseUrl) {
    app.addHook("onReady", async () => {
      const pg = await import("pg");
      rawPool = new pg.Pool({ connectionString: databaseUrl }) as unknown as RawPool;
      await rawPool.query("SELECT 1");
      runtime = new CustomerWorkOsV25RuntimeManager(new PgV25StateStore(scopedPool(rawPool)), options.now);
    });
  }

  app.addHook("onClose", async () => {
    await runtime.close();
    if (rawPool) await rawPool.end();
  });

  const runCommand = async (
    request: FastifyRequest,
    reply: { header(name: string, value: string): unknown; status(code: number): { send(payload: unknown): unknown } },
    command: string,
    payload: unknown,
    version: number,
  ): Promise<unknown> => {
    const authenticatedActor = actor(request);
    const idempotencyKey = header(request, "idempotency-key");
    const result = await runtime.command({
      workspaceId: authenticatedActor.workspaceId,
      actor: authenticatedActor,
      expectedVersion: version,
      idempotencyKey,
      command,
      payload,
    });
    reply.header("Idempotency-Key", idempotencyKey);
    return reply.status(result.statusCode).send({
      result: result.result,
      runtimeVersion: result.envelope.version,
      stateHash: result.envelope.stateHash,
    });
  };

  app.get("/api/cwos/v2.5/state", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
      if (authenticatedActor.kind === "ai") throw new CustomerWorkOsV25Error("AUTOMATION_PRINCIPAL_FORBIDDEN", "AI principals cannot read the owner automation state directly");
      const envelope = await runtime.read(authenticatedActor.workspaceId);
      return reply.status(200).send(envelope);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/cwos/v2.5/review", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
      if (authenticatedActor.kind === "ai") throw new CustomerWorkOsV25Error("AUTOMATION_PRINCIPAL_FORBIDDEN", "AI principals cannot read the owner review queue directly");
      const envelope = await runtime.read(authenticatedActor.workspaceId);
      const platform = new (await import("@ai-crm/domain/customer-work-os-v2.5")).CustomerWorkOsV25Platform(authenticatedActor.workspaceId);
      platform.hydrateState(envelope.state);
      return reply.status(200).send({
        runtimeVersion: envelope.version,
        stateHash: envelope.stateHash,
        review: platform.reviewQueue(),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/cwos/v2.5/briefing", async (request, reply) => {
    try {
      const authenticatedActor = actor(request);
      if (authenticatedActor.kind === "ai") throw new CustomerWorkOsV25Error("AUTOMATION_PRINCIPAL_FORBIDDEN", "AI principals cannot read the owner briefing directly");
      const envelope = await runtime.read(authenticatedActor.workspaceId);
      const platform = new (await import("@ai-crm/domain/customer-work-os-v2.5")).CustomerWorkOsV25Platform(authenticatedActor.workspaceId);
      platform.hydrateState(envelope.state);
      return reply.status(200).send({
        runtimeVersion: envelope.version,
        briefing: platform.manager.latestBrief(authenticatedActor.workspaceId),
        findings: platform.manager.openFindings(authenticatedActor.workspaceId),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/cwos/v2.5/commands", async (request, reply) => {
    try {
      const input = object(request.body);
      const command = input.command;
      if (typeof command !== "string" || !command.trim()) throw new CustomerWorkOsV25Error("INVALID_INPUT", "command is required");
      return await runCommand(request, reply, command.trim(), input.payload, expectedVersion(input));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/cwos/v2.5/capture", async (request, reply) => {
    try {
      const input = object(request.body);
      return await runCommand(request, reply, "capture.submit", {
        capture: input.capture,
        context: input.context,
      }, expectedVersion(input));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/cwos/v2.5/baseline", async (request, reply) => {
    try {
      const input = object(request.body);
      return await runCommand(request, reply, "baseline.build", input.payload, expectedVersion(input));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { questionId: string } }>("/api/cwos/v2.5/clarifications/:questionId/answer", async (request, reply) => {
    try {
      const input = object(request.body);
      return await runCommand(request, reply, "capture.answer", {
        questionId: request.params.questionId,
        answer: input.answer,
      }, expectedVersion(input));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/api/cwos/v2.5/manager/run", async (request, reply) => {
    try {
      const input = object(request.body);
      return await runCommand(request, reply, "manager.run", {
        snapshot: input.snapshot,
        thresholds: input.thresholds,
      }, expectedVersion(input));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  return runtime;
}
