import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type Account,
  type Activity,
  type Commitment,
  type Engagement,
  type EngagementParty,
  type FinancialItem,
  type Product,
  type Settlement,
} from "@ai-crm/domain/customer-work-os";

export interface CustomerWorkOsRouteOptions {
  service?: CustomerWorkOsService;
}

interface ReplayRecord {
  requestHash: string;
  statusCode: number;
  payload: unknown;
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomerWorkOsError("HEADER_REQUIRED", `${name} header is required`);
  }
  return value.trim();
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new CustomerWorkOsError("INVALID_INPUT", "request body must be an object");
  }
  return request.body as Record<string, unknown>;
}

function errorStatus(error: CustomerWorkOsError): number {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "CROSS_WORKSPACE") return 403;
  if (["DUPLICATE_ID", "DUPLICATE_ACCOUNT", "DUPLICATE_PROJECT_KEY", "DUPLICATE_SKU", "REPLAYED_APPROVAL", "STALE_VERSION", "STALE_APPROVAL"].includes(error.code)) return 409;
  return 400;
}

function sendDomainError(reply: FastifyReply, error: unknown): void {
  if (error instanceof CustomerWorkOsError) {
    reply.code(errorStatus(error)).send({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

export async function registerCustomerWorkOsRoutes(
  app: FastifyInstance,
  options: CustomerWorkOsRouteOptions = {},
): Promise<CustomerWorkOsService> {
  const service = options.service ?? new CustomerWorkOsService();
  const replay = new Map<string, ReplayRecord>();

  async function mutate(
    request: FastifyRequest,
    reply: FastifyReply,
    routeKey: string,
    operation: (workspaceId: string, principalId: string, body: Record<string, unknown>) => unknown,
  ): Promise<void> {
    try {
      const workspaceId = requiredHeader(request, "x-workspace-id");
      const principalId = requiredHeader(request, "x-principal-id");
      const idempotencyKey = requiredHeader(request, "idempotency-key");
      const body = objectBody(request);
      const requestHash = customerWorkOsPayloadHash({ routeKey, workspaceId, principalId, body });
      const replayKey = `${workspaceId}\u0000${idempotencyKey}`;
      const existing = replay.get(replayKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          reply.code(409).send({ error: "IDEMPOTENCY_KEY_CONFLICT", message: "idempotency key was already used with a different request" });
          return;
        }
        reply.code(existing.statusCode).send(existing.payload);
        return;
      }
      const payload = operation(workspaceId, principalId, body);
      replay.set(replayKey, { requestHash, statusCode: 201, payload });
      reply.code(201).send(payload);
    } catch (error) {
      sendDomainError(reply, error);
    }
  }

  app.post("/api/cwos/accounts", async (request, reply) => {
    await mutate(request, reply, "accounts.create", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<Account, "workspaceId" | "normalizedName" | "version">;
      return service.createAccount({ ...input, workspaceId });
    });
  });

  app.post("/api/cwos/engagements", async (request, reply) => {
    await mutate(request, reply, "engagements.create", (workspaceId, principalId, body) => {
      const input = body as unknown as Omit<Engagement, "workspaceId" | "ownerPrincipalId" | "version">;
      return service.createEngagement({ ...input, workspaceId, ownerPrincipalId: principalId });
    });
  });

  app.post("/api/cwos/parties", async (request, reply) => {
    await mutate(request, reply, "parties.assign", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<EngagementParty, "workspaceId">;
      return service.assignParty({ ...input, workspaceId });
    });
  });

  app.post("/api/cwos/activities", async (request, reply) => {
    await mutate(request, reply, "activities.record", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<Activity, "workspaceId">;
      return service.recordActivity({ ...input, workspaceId });
    });
  });

  app.post("/api/cwos/commitments", async (request, reply) => {
    await mutate(request, reply, "commitments.create", (workspaceId, principalId, body) => {
      const input = body as unknown as Omit<Commitment, "workspaceId" | "ownerPrincipalId" | "version">;
      return service.addCommitment({ ...input, workspaceId, ownerPrincipalId: principalId });
    });
  });

  app.post("/api/cwos/products", async (request, reply) => {
    await mutate(request, reply, "products.create", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<Product, "workspaceId" | "version">;
      return service.addProduct({ ...input, workspaceId });
    });
  });

  app.post("/api/cwos/financial-items", async (request, reply) => {
    await mutate(request, reply, "finance.item.create", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<FinancialItem, "workspaceId">;
      return service.addFinancialItem({ ...input, workspaceId });
    });
  });

  app.post("/api/cwos/settlements", async (request, reply) => {
    await mutate(request, reply, "finance.settlement.record", (workspaceId, _principalId, body) => {
      const input = body as unknown as Omit<Settlement, "workspaceId">;
      return service.recordSettlement({ ...input, workspaceId });
    });
  });

  app.get<{ Params: { engagementId: string } }>("/api/cwos/engagements/:engagementId", async (request, reply) => {
    try {
      const workspaceId = requiredHeader(request, "x-workspace-id");
      requiredHeader(request, "x-principal-id");
      return service.getEngagementSnapshot(workspaceId, request.params.engagementId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  app.get<{ Params: { engagementId: string } }>("/api/cwos/engagements/:engagementId/finance", async (request, reply) => {
    try {
      const workspaceId = requiredHeader(request, "x-workspace-id");
      requiredHeader(request, "x-principal-id");
      return service.financeSummary(workspaceId, request.params.engagementId);
    } catch (error) {
      sendDomainError(reply, error);
      return undefined;
    }
  });

  return service;
}
