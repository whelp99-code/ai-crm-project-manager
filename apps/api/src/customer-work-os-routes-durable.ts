import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CustomerWorkOsError,
  customerWorkOsPayloadHash,
  type Account,
  type Activity,
  type ApprovalReceipt,
  type ChangeRequest,
  type Commitment,
  type Contract,
  type CustomerWorkOsService,
  type DeliveryProject,
  type DeliveryWorkItem,
  type Engagement,
  type EngagementParty,
  type FinancialItem,
  type Product,
  type PurchaseOrder,
  type Quote,
  type Settlement,
} from "@ai-crm/domain/customer-work-os";
import {
  CustomerWorkOsRuntimeManager,
  InMemoryCustomerWorkOsSnapshotStore,
  createPgCustomerWorkOsInfrastructureFromEnvironment,
  type CustomerWorkOsSnapshotStore,
  type GovernanceApprovalResolver,
} from "./customer-work-os-runtime.js";
import {
  createPgCustomerWorkOsIdentityResolverFromEnvironment,
  type CustomerWorkOsIdentity,
  type CustomerWorkOsIdentityResolver,
} from "./customer-work-os-identity.js";

export interface DurableCustomerWorkOsRouteOptions {
  store?: CustomerWorkOsSnapshotStore;
  approvals?: GovernanceApprovalResolver;
  identityResolver?: CustomerWorkOsIdentityResolver;
  now?: () => string;
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) throw new CustomerWorkOsError("HEADER_REQUIRED", `${name} header is required`);
  return value.trim();
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new CustomerWorkOsError("INVALID_INPUT", "request body must be an object");
  }
  return request.body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) throw new CustomerWorkOsError("INVALID_INPUT", `${name} must be a non-empty string`);
  return value.trim();
}

function numberField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CustomerWorkOsError("INVALID_INPUT", `${name} must be a finite number`);
  return value;
}

function arrayField(body: Record<string, unknown>, name: string): unknown[] {
  const value = body[name];
  if (!Array.isArray(value)) throw new CustomerWorkOsError("INVALID_INPUT", `${name} must be an array`);
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new CustomerWorkOsError("INVALID_INPUT", `${name} must be a string`);
  return value.trim() || undefined;
}

function withoutKeys(body: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const next = { ...body };
  for (const key of keys) delete next[key];
  return next;
}

function status(error: CustomerWorkOsError): number {
  if (error.code === "NOT_FOUND" || error.code === "APPROVAL_NOT_FOUND") return 404;
  if (error.code === "CROSS_WORKSPACE" || error.code === "CROSS_WORKSPACE_STATE") return 403;
  if (error.code === "APPROVAL_INFRASTRUCTURE_REQUIRED") return 503;
  if ([
    "DUPLICATE_ID",
    "DUPLICATE_ACCOUNT",
    "DUPLICATE_PROJECT_KEY",
    "DUPLICATE_SKU",
    "REPLAYED_APPROVAL",
    "STALE_VERSION",
    "STALE_APPROVAL",
    "IDEMPOTENCY_KEY_CONFLICT",
    "CONCURRENT_MODIFICATION",
  ].includes(error.code)) return 409;
  return 400;
}

function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof CustomerWorkOsError) {
    reply.code(status(error)).send({ error: error.code, message: error.message });
    return;
  }
  throw error;
}

function approvalId(body: Record<string, unknown>): string {
  return stringField(body, "approvalId");
}

export async function registerDurableCustomerWorkOsRoutes(
  app: FastifyInstance,
  options: DurableCustomerWorkOsRouteOptions = {},
): Promise<CustomerWorkOsRuntimeManager> {
  const infrastructure = options.store ? undefined : await createPgCustomerWorkOsInfrastructureFromEnvironment();
  const store = options.store ?? infrastructure?.store ?? new InMemoryCustomerWorkOsSnapshotStore();
  const approvals = options.approvals ?? infrastructure?.approvals;
  const environmentIdentity = options.identityResolver || !infrastructure
    ? undefined
    : await createPgCustomerWorkOsIdentityResolverFromEnvironment();
  const identityResolver = options.identityResolver ?? environmentIdentity;
  const manager = new CustomerWorkOsRuntimeManager(store);
  const now = options.now ?? (() => new Date().toISOString());

  if (infrastructure) app.addHook("onClose", async () => infrastructure.close());
  else if (store.close) app.addHook("onClose", async () => store.close?.());
  if (environmentIdentity?.close) app.addHook("onClose", async () => environmentIdentity.close?.());

  async function verifyIdentity(workspaceId: string, principalId: string, humanAuthority: boolean): Promise<CustomerWorkOsIdentity> {
    const identity = identityResolver
      ? await identityResolver.resolve(workspaceId, principalId)
      : { workspaceId, principalId, kind: "HUMAN" as const, role: "legacy", active: true };
    if (!identity.active || identity.workspaceId !== workspaceId || identity.principalId !== principalId) {
      throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "principal is inactive or not bound to the requested workspace");
    }
    if (humanAuthority && identity.kind !== "HUMAN") {
      throw new CustomerWorkOsError("HUMAN_AUTHORITY_REQUIRED", "final business mutations require an active human principal");
    }
    return identity;
  }

  async function mutate<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    routeKey: string,
    operation: (service: CustomerWorkOsService, workspaceId: string, principalId: string, body: Record<string, unknown>) => T | Promise<T>,
  ): Promise<void> {
    try {
      const workspaceId = header(request, "x-workspace-id");
      const principalId = header(request, "x-principal-id");
      await verifyIdentity(workspaceId, principalId, true);
      const idempotencyKey = header(request, "idempotency-key");
      const body = bodyObject(request);
      const requestHash = customerWorkOsPayloadHash({ routeKey, workspaceId, principalId, body });
      const result = await manager.mutate({
        workspaceId,
        principalId,
        idempotencyKey,
        requestHash,
        operationId: routeKey,
        operation: (service) => operation(service, workspaceId, principalId, body),
        now: now(),
      });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false");
      reply.code(result.statusCode).send(result.payload);
    } catch (error) {
      sendError(reply, error);
    }
  }

  async function resolveApproval(input: Parameters<GovernanceApprovalResolver["resolve"]>[0]): Promise<ApprovalReceipt> {
    if (!approvals) throw new CustomerWorkOsError("APPROVAL_INFRASTRUCTURE_REQUIRED", "approval resolver is required for this action");
    return approvals.resolve(input);
  }

  async function mutationContext(request: FastifyRequest): Promise<{
    workspaceId: string;
    principalId: string;
    idempotencyKey: string;
    body: Record<string, unknown>;
  }> {
    const workspaceId = header(request, "x-workspace-id");
    const principalId = header(request, "x-principal-id");
    await verifyIdentity(workspaceId, principalId, true);
    return {
      workspaceId,
      principalId,
      idempotencyKey: header(request, "idempotency-key"),
      body: bodyObject(request),
    };
  }

  app.post("/api/cwos/accounts", async (request, reply) => {
    await mutate(request, reply, "account.create", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "name"); arrayField(body, "kinds"); stringField(body, "status");
      return service.createAccount({ ...(body as unknown as Omit<Account, "workspaceId" | "normalizedName" | "version">), workspaceId });
    });
  });

  app.post("/api/cwos/engagements", async (request, reply) => {
    await mutate(request, reply, "engagement.create", (service, workspaceId, principalId, body) => {
      stringField(body, "id"); stringField(body, "projectKey"); stringField(body, "name"); stringField(body, "type"); stringField(body, "stage"); stringField(body, "health");
      return service.createEngagement({ ...(body as unknown as Omit<Engagement, "workspaceId" | "ownerPrincipalId" | "version">), workspaceId, ownerPrincipalId: principalId });
    });
  });

  app.post("/api/cwos/parties", async (request, reply) => {
    await mutate(request, reply, "party.assign", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "accountId"); stringField(body, "role");
      return service.assignParty({ ...(body as unknown as Omit<EngagementParty, "workspaceId">), workspaceId });
    });
  });

  app.post("/api/cwos/activities", async (request, reply) => {
    await mutate(request, reply, "activity.record", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "type"); stringField(body, "occurredAt"); stringField(body, "summary");
      return service.recordActivity({ ...(body as unknown as Omit<Activity, "workspaceId">), workspaceId });
    });
  });

  app.post("/api/cwos/commitments", async (request, reply) => {
    await mutate(request, reply, "commitment.create", (service, workspaceId, principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "description"); stringField(body, "dueAt"); stringField(body, "status"); numberField(body, "priority");
      return service.addCommitment({ ...(body as unknown as Omit<Commitment, "workspaceId" | "ownerPrincipalId" | "version">), workspaceId, ownerPrincipalId: principalId });
    });
  });

  app.post("/api/cwos/products", async (request, reply) => {
    await mutate(request, reply, "product.create", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "sku"); stringField(body, "name"); stringField(body, "kind");
      return service.addProduct({ ...(body as unknown as Omit<Product, "workspaceId" | "version">), workspaceId });
    });
  });

  app.post("/api/cwos/quotes", async (request, reply) => {
    await mutate(request, reply, "quote.create", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "versionLabel"); stringField(body, "status"); stringField(body, "validUntil"); stringField(body, "scope"); arrayField(body, "bomLines"); arrayField(body, "exclusions");
      return service.createQuote({ ...(body as unknown as Omit<Quote, "workspaceId" | "totalCostKrw" | "totalPriceKrw" | "grossProfitKrw" | "marginBps" | "version">), workspaceId });
    });
  });

  app.post<{ Params: { quoteId: string } }>("/api/cwos/quotes/:quoteId/approve", async (request, reply) => {
    try {
      const { workspaceId, principalId, idempotencyKey, body } = await mutationContext(request);
      const engagementId = stringField(body, "engagementId");
      const expectedVersion = numberField(body, "expectedVersion");
      const minimumMarginBps = numberField(body, "minimumMarginBps");
      const quote = await manager.read(workspaceId, (service) => service.getEngagementSnapshot(workspaceId, engagementId).quotes.find((item) => item.id === request.params.quoteId));
      if (!quote) throw new CustomerWorkOsError("NOT_FOUND", `quote not found: ${request.params.quoteId}`);
      const payload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
      const receipt = await resolveApproval({ workspaceId, approvalId: approvalId(body), resourceType: "quote", resourceId: quote.id, resourceVersion: expectedVersion, action: "QUOTE_APPROVE", payloadHash: customerWorkOsPayloadHash(payload) });
      const requestHash = customerWorkOsPayloadHash({ route: "quote.approve", workspaceId, principalId, quoteId: quote.id, body });
      const result = await manager.mutate({ workspaceId, principalId, idempotencyKey, requestHash, operationId: "quote.approve", operation: (service) => service.approveQuote(workspaceId, quote.id, expectedVersion, receipt, minimumMarginBps), now: now() });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false").code(result.statusCode).send(result.payload);
    } catch (error) { sendError(reply, error); }
  });

  app.post("/api/cwos/contracts/from-quote", async (request, reply) => {
    await mutate(request, reply, "contract.from_quote", (service, workspaceId, _principalId, body) => {
      const quoteExpectedVersion = numberField(body, "quoteExpectedVersion");
      const contract = body.contract;
      if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new CustomerWorkOsError("INVALID_INPUT", "contract object is required");
      const contractBody = contract as Record<string, unknown>;
      stringField(contractBody, "id"); stringField(contractBody, "engagementId"); stringField(contractBody, "quoteId"); stringField(contractBody, "title"); stringField(contractBody, "scope"); stringField(contractBody, "contractValueKrw"); stringField(contractBody, "effectiveFrom"); arrayField(contractBody, "exclusions"); arrayField(contractBody, "billingMilestones");
      return service.acceptQuoteAsContract({ ...(contractBody as unknown as Omit<Contract, "workspaceId" | "version" | "status">), workspaceId }, quoteExpectedVersion);
    });
  });

  app.post("/api/cwos/delivery-projects/handover", async (request, reply) => {
    await mutate(request, reply, "delivery.handover", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "contractId"); stringField(body, "projectKey"); stringField(body, "scopeBaseline"); stringField(body, "scheduleStart"); stringField(body, "scheduleEnd"); arrayField(body, "requirementIds"); arrayField(body, "deliverables");
      return service.handoverToDelivery({ ...(body as unknown as Omit<DeliveryProject, "workspaceId" | "status" | "workItems" | "version">), workspaceId });
    });
  });

  app.post<{ Params: { projectId: string } }>("/api/cwos/delivery-projects/:projectId/work-items", async (request, reply) => {
    await mutate(request, reply, "delivery.work_item.add", (service, workspaceId, _principalId, body) => {
      const expectedVersion = numberField(body, "expectedVersion");
      const item = body.workItem;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new CustomerWorkOsError("INVALID_INPUT", "workItem object is required");
      return service.addDeliveryWorkItem(workspaceId, request.params.projectId, expectedVersion, item as unknown as DeliveryWorkItem);
    });
  });

  app.post("/api/cwos/change-requests", async (request, reply) => {
    await mutate(request, reply, "change.propose", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "deliveryProjectId"); stringField(body, "description"); stringField(body, "scopeImpact"); numberField(body, "scheduleImpactDays"); stringField(body, "costImpactKrw"); stringField(body, "priceImpactKrw");
      return service.proposeChangeRequest({ ...(body as unknown as Omit<ChangeRequest, "workspaceId" | "status" | "version">), workspaceId });
    });
  });

  app.post<{ Params: { requestId: string } }>("/api/cwos/change-requests/:requestId/approve", async (request, reply) => {
    try {
      const { workspaceId, principalId, idempotencyKey, body } = await mutationContext(request);
      const engagementId = stringField(body, "engagementId");
      const expectedVersion = numberField(body, "expectedVersion");
      const disposition = stringField(body, "disposition") as NonNullable<ChangeRequest["disposition"]>;
      const change = await manager.read(workspaceId, (service) => service.getEngagementSnapshot(workspaceId, engagementId).changes.find((item) => item.id === request.params.requestId));
      if (!change) throw new CustomerWorkOsError("NOT_FOUND", `change request not found: ${request.params.requestId}`);
      const payload = { disposition, scopeImpact: change.scopeImpact, scheduleImpactDays: change.scheduleImpactDays, costImpactKrw: change.costImpactKrw, priceImpactKrw: change.priceImpactKrw };
      const receipt = await resolveApproval({ workspaceId, approvalId: approvalId(body), resourceType: "change_request", resourceId: change.id, resourceVersion: expectedVersion, action: "CHANGE_REQUEST_APPROVE", payloadHash: customerWorkOsPayloadHash(payload) });
      const requestHash = customerWorkOsPayloadHash({ route: "change.approve", workspaceId, principalId, requestId: change.id, body });
      const result = await manager.mutate({ workspaceId, principalId, idempotencyKey, requestHash, operationId: "change.approve", operation: (service) => service.approveChangeRequest(workspaceId, change.id, expectedVersion, disposition, receipt), now: now() });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false").code(result.statusCode).send(result.payload);
    } catch (error) { sendError(reply, error); }
  });

  app.post<{ Params: { requestId: string } }>("/api/cwos/change-requests/:requestId/apply", async (request, reply) => {
    await mutate(request, reply, "change.apply", (service, workspaceId, _principalId, body) => service.applyChangeRequest(workspaceId, request.params.requestId, numberField(body, "expectedVersion")));
  });

  app.post("/api/cwos/purchase-orders", async (request, reply) => {
    await mutate(request, reply, "purchase_order.create", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "vendorAccountId"); arrayField(body, "lines");
      return service.createPurchaseOrder({ ...(body as unknown as Omit<PurchaseOrder, "workspaceId" | "status" | "version">), workspaceId });
    });
  });

  app.post<{ Params: { orderId: string } }>("/api/cwos/purchase-orders/:orderId/approve", async (request, reply) => {
    try {
      const { workspaceId, principalId, idempotencyKey, body } = await mutationContext(request);
      const engagementId = stringField(body, "engagementId");
      const expectedVersion = numberField(body, "expectedVersion");
      const order = await manager.read(workspaceId, (service) => service.getEngagementSnapshot(workspaceId, engagementId).purchaseOrders.find((item) => item.id === request.params.orderId));
      if (!order) throw new CustomerWorkOsError("NOT_FOUND", `purchase order not found: ${request.params.orderId}`);
      const total = order.lines.reduce((sum, line) => sum + BigInt(line.unitCostKrw) * BigInt(line.quantity), 0n).toString();
      const payload = { vendorAccountId: order.vendorAccountId, totalCostKrw: total, lines: order.lines };
      const receipt = await resolveApproval({ workspaceId, approvalId: approvalId(body), resourceType: "purchase_order", resourceId: order.id, resourceVersion: expectedVersion, action: "PURCHASE_ORDER_APPROVE", payloadHash: customerWorkOsPayloadHash(payload) });
      const requestHash = customerWorkOsPayloadHash({ route: "po.approve", workspaceId, principalId, orderId: order.id, body });
      const result = await manager.mutate({ workspaceId, principalId, idempotencyKey, requestHash, operationId: "purchase_order.approve", operation: (service) => service.approvePurchaseOrder(workspaceId, order.id, expectedVersion, receipt), now: now() });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false").code(result.statusCode).send(result.payload);
    } catch (error) { sendError(reply, error); }
  });

  app.post<{ Params: { orderId: string } }>("/api/cwos/purchase-orders/:orderId/ordered", async (request, reply) => {
    await mutate(request, reply, "purchase_order.ordered", (service, workspaceId, _principalId, body) => service.markPurchaseOrderOrdered(workspaceId, request.params.orderId, numberField(body, "expectedVersion")));
  });

  app.post<{ Params: { orderId: string } }>("/api/cwos/purchase-orders/:orderId/receive", async (request, reply) => {
    await mutate(request, reply, "purchase_order.receive", (service, workspaceId, _principalId, body) => service.receivePurchaseOrderLine(workspaceId, request.params.orderId, numberField(body, "expectedVersion"), stringField(body, "lineId"), numberField(body, "quantity")));
  });

  app.post("/api/cwos/assets", async (request, reply) => {
    await mutate(request, reply, "asset.register", (service, workspaceId, _principalId, body) => {
      stringField(body, "id"); stringField(body, "engagementId"); stringField(body, "customerAccountId"); stringField(body, "productId"); stringField(body, "purchaseOrderId"); stringField(body, "serialOrLicenseKey"); stringField(body, "status");
      return service.registerAsset({ ...(body as unknown as Omit<Parameters<typeof service.registerAsset>[0], "workspaceId" | "version">), workspaceId });
    });
  });

  app.post("/api/cwos/financial-items", async (request, reply) => {
    try {
      const { workspaceId, principalId, idempotencyKey, body } = await mutationContext(request);
      stringField(body, "id"); stringField(body, "accountId"); stringField(body, "direction"); stringField(body, "category"); stringField(body, "lifecycle"); stringField(body, "netAmountKrw"); stringField(body, "vatAmountKrw"); stringField(body, "grossAmountKrw"); stringField(body, "expectedDate");
      const domainBody = withoutKeys(body, "approvalId");
      const input = { ...(domainBody as unknown as Omit<FinancialItem, "workspaceId">), workspaceId };
      if (input.lifecycle !== "PLANNED") {
        const payloadHash = customerWorkOsPayloadHash(input);
        await resolveApproval({ workspaceId, approvalId: approvalId(body), resourceType: "financial_item", resourceId: input.id, resourceVersion: input.revision, action: "FINANCIAL_ITEM_CREATE", payloadHash });
      }
      const requestHash = customerWorkOsPayloadHash({ route: "finance.item.create", workspaceId, principalId, body });
      const result = await manager.mutate({ workspaceId, principalId, idempotencyKey, requestHash, operationId: "finance.item.create", operation: (service) => service.addFinancialItem(input), now: now() });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false").code(result.statusCode).send(result.payload);
    } catch (error) { sendError(reply, error); }
  });

  app.post("/api/cwos/settlements", async (request, reply) => {
    try {
      const { workspaceId, principalId, idempotencyKey, body } = await mutationContext(request);
      const engagementId = stringField(body, "engagementId"); stringField(body, "id"); stringField(body, "financialItemId"); stringField(body, "direction"); stringField(body, "amountKrw"); stringField(body, "settledAt"); stringField(body, "accountOrCard"); stringField(body, "evidenceRef");
      const domainBody = withoutKeys(body, "approvalId", "engagementId");
      const settlement = { ...(domainBody as unknown as Omit<Settlement, "workspaceId">), workspaceId };
      const item = await manager.read(workspaceId, (service) => service.getEngagementSnapshot(workspaceId, engagementId).financialItems.find((current) => current.id === settlement.financialItemId));
      if (!item) throw new CustomerWorkOsError("NOT_FOUND", `financial item not found: ${settlement.financialItemId}`);
      const payloadHash = customerWorkOsPayloadHash(settlement);
      await resolveApproval({ workspaceId, approvalId: approvalId(body), resourceType: "financial_item", resourceId: item.id, resourceVersion: item.revision, action: "FINANCE_SETTLEMENT_RECORD", payloadHash });
      const requestHash = customerWorkOsPayloadHash({ route: "finance.settlement.record", workspaceId, principalId, body });
      const result = await manager.mutate({ workspaceId, principalId, idempotencyKey, requestHash, operationId: "finance.settlement.record", operation: (service) => service.recordSettlement(settlement), now: now() });
      reply.header("x-idempotent-replay", result.replayed ? "true" : "false").code(result.statusCode).send(result.payload);
    } catch (error) { sendError(reply, error); }
  });

  app.post<{ Params: { engagementId: string } }>("/api/cwos/engagements/:engagementId/transition", async (request, reply) => {
    await mutate(request, reply, "engagement.transition", (service, workspaceId, _principalId, body) => service.transitionEngagement(workspaceId, request.params.engagementId, numberField(body, "expectedVersion"), stringField(body, "nextStage") as Engagement["stage"], optionalString(body, "reason")));
  });

  app.get("/api/cwos/cockpit", async (request, reply) => {
    try {
      const workspaceId = header(request, "x-workspace-id");
      const principalId = header(request, "x-principal-id");
      await verifyIdentity(workspaceId, principalId, false);
      return await manager.read(workspaceId, (service) => {
        const state = service.exportState();
        const terminal = new Set(["CLOSED", "LOST", "CANCELLED"]);
        const activeEngagements = state.engagements.filter((engagement) => !terminal.has(engagement.stage));
        const openCommitments = state.commitments.filter((commitment) => !["DONE", "CANCELLED"].includes(commitment.status));
        return {
          workspaceId,
          activeEngagementCount: activeEngagements.length,
          criticalEngagementCount: activeEngagements.filter((engagement) => engagement.health === "critical").length,
          openCommitmentCount: openCommitments.length,
          overdueCommitmentCount: openCommitments.filter((commitment) => commitment.dueAt < now()).length,
          pendingQuoteCount: state.quotes.filter((quote) => ["DRAFT", "REVIEW", "SENT"].includes(quote.status)).length,
          generatedAt: now(),
        };
      });
    } catch (error) { sendError(reply, error); return undefined; }
  });

  app.get<{ Params: { engagementId: string } }>("/api/cwos/engagements/:engagementId", async (request, reply) => {
    try {
      const workspaceId = header(request, "x-workspace-id");
      const principalId = header(request, "x-principal-id");
      await verifyIdentity(workspaceId, principalId, false);
      return await manager.read(workspaceId, (service) => service.getEngagementSnapshot(workspaceId, request.params.engagementId));
    } catch (error) { sendError(reply, error); return undefined; }
  });

  app.get<{ Params: { engagementId: string } }>("/api/cwos/engagements/:engagementId/finance", async (request, reply) => {
    try {
      const workspaceId = header(request, "x-workspace-id");
      const principalId = header(request, "x-principal-id");
      await verifyIdentity(workspaceId, principalId, false);
      return await manager.read(workspaceId, (service) => service.financeSummary(workspaceId, request.params.engagementId));
    } catch (error) { sendError(reply, error); return undefined; }
  });

  return manager;
}
