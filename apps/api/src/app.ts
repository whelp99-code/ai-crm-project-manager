import type { FastifyInstance } from "fastify";
import {
  createApp as createBaseApp,
  type CreateAppOptions,
} from "./app-base.js";
import {
  registerCustomerWorkOsV2Routes,
  type CustomerWorkOsV2ActorBinding,
} from "./customer-work-os-v2-routes.js";
import type { CwosV2StateStore, V2PgQueryable } from "./customer-work-os-v2-runtime.js";
import type { OperatorStepUpService } from "./operator-step-up.js";

export * from "./app-base.js";

/**
 * Customer Work OS v2 composition root.
 *
 * The stable v1 application remains byte-identical in app-base.ts. This
 * wrapper adds the v2 routes before Fastify is readied, preserving the v1
 * auth/onRoute/onClose hooks while avoiding a second API server or mutation
 * gateway.
 */
export type CustomerWorkOsV2AppOptions = CreateAppOptions & {
  customerWorkOsV2Store?: CwosV2StateStore;
  customerWorkOsV2Profile?: "test" | "development" | "production";
  /** Server-authenticated API-key operator; request headers must match and cannot assert step-up. */
  customerWorkOsV2ActorBinding?: CustomerWorkOsV2ActorBinding;
  /** Production human authority is derived per request from fresh password/TOTP proof. */
  customerWorkOsV2OperatorStepUp?: OperatorStepUpService;
  /** Dedicated machine identity; never inherits human operator step-up. */
  customerWorkOsV2MachineBinding?: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly kind: "ai" | "service";
    /** Reader-only credential: reject all non-read HTTP methods before command dispatch. */
    readonly readOnly?: boolean;
    /** Explicitly admitted Mail reader may GET its bound workspace's account master. */
    readonly mailAccountMasterRead?: true;
    /** Separate service credential: only the Mail candidate-create route is admitted. */
    readonly mailCandidateCreateOnly?: true;
    /** Separate JARVIS credential: only candidate list/count GETs are admitted. */
    readonly mailCandidateReadOnly?: true;
  };
  customerWorkOsV2NormalizedProjectionPool?: V2PgQueryable;
};

function configuredActorBinding(options: CustomerWorkOsV2AppOptions): CustomerWorkOsV2ActorBinding | undefined {
  if (options.customerWorkOsV2ActorBinding) {
    const workspaceId = options.customerWorkOsV2ActorBinding.workspaceId.trim();
    const principalId = options.customerWorkOsV2ActorBinding.principalId.trim();
    if (!workspaceId || !principalId || options.customerWorkOsV2ActorBinding.kind !== "human") {
      throw new Error("[CWOS_V2_ACTOR_BINDING_INVALID] workspace, principal, and human kind are required");
    }
    return { ...options.customerWorkOsV2ActorBinding, workspaceId, principalId };
  }
  const workspaceId = process.env.CWOS_V2_OPERATOR_WORKSPACE_ID?.trim();
  const principalId = process.env.CWOS_V2_OPERATOR_PRINCIPAL_ID?.trim();
  const stepUp = process.env.CWOS_V2_OPERATOR_STEP_UP_VERIFIED?.trim();
  if (!workspaceId && !principalId && !stepUp) return undefined;
  if (!workspaceId || !principalId || (stepUp !== "0" && stepUp !== "1")) {
    throw new Error(
      "[CWOS_V2_ACTOR_BINDING_INCOMPLETE] set CWOS_V2_OPERATOR_WORKSPACE_ID, " +
        "CWOS_V2_OPERATOR_PRINCIPAL_ID, and CWOS_V2_OPERATOR_STEP_UP_VERIFIED=0|1 together",
    );
  }
  return { workspaceId, principalId, kind: "human", stepUpVerified: stepUp === "1" };
}

function hasConfiguredApiKey(options: CustomerWorkOsV2AppOptions): boolean {
  return Boolean(
    options.authApiKey?.trim() ||
    process.env.AUTH_API_KEY?.trim() ||
    process.env.API_AUTH_TOKEN?.trim(),
  );
}

export function createApp(options: CustomerWorkOsV2AppOptions = {}): FastifyInstance {
  const operatorBinding = configuredActorBinding(options);
  const machineBinding = options.customerWorkOsV2MachineBinding;
  const operatorStepUp = options.customerWorkOsV2OperatorStepUp;
  if (operatorBinding && machineBinding) {
    throw new Error("[CWOS_V2_BINDING_CONFLICT] human operator and machine bindings are mutually exclusive");
  }
  if (operatorStepUp && (!operatorBinding || machineBinding
    || operatorStepUp.workspaceId !== operatorBinding.workspaceId
    || operatorStepUp.principalId !== operatorBinding.principalId)) {
    throw new Error("[CWOS_V2_OPERATOR_AUTH_SCOPE] authentication must match the human server binding");
  }
  if (machineBinding && (
    !machineBinding.workspaceId.trim() ||
    !machineBinding.principalId.trim() ||
    (machineBinding.kind !== "ai" && machineBinding.kind !== "service")
  )) {
    throw new Error("[CWOS_V2_MACHINE_BINDING_INVALID] workspace, principal, and machine kind are required");
  }
  if (machineBinding?.mailAccountMasterRead && (machineBinding.kind !== "service" || !machineBinding.readOnly)) {
    throw new Error("[CWOS_V2_MAIL_ACCOUNT_MASTER_BINDING_INVALID] account master requires a read-only service binding");
  }
  if (machineBinding?.mailCandidateCreateOnly && (machineBinding.kind !== "service"
    || machineBinding.readOnly || machineBinding.mailAccountMasterRead || machineBinding.mailCandidateReadOnly)) {
    throw new Error("[CWOS_V2_MAIL_CANDIDATE_BINDING_INVALID] candidate writer requires a separate create-only service binding");
  }
  if (machineBinding?.mailCandidateReadOnly && (machineBinding.kind !== "service" || !machineBinding.readOnly
    || machineBinding.mailAccountMasterRead || machineBinding.mailCandidateCreateOnly)) {
    throw new Error("[CWOS_V2_CANDIDATE_READER_BINDING_INVALID] candidate reader requires a separate read-only service binding");
  }
  const actorBinding = machineBinding ? {
    workspaceId: machineBinding.workspaceId.trim(),
    principalId: machineBinding.principalId.trim(),
    kind: machineBinding.kind,
    stepUpVerified: false,
  } : operatorBinding;
  const apiKeyConfigured = hasConfiguredApiKey(options);
  const profile = options.customerWorkOsV2Profile ?? (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development");
  if (profile === "production" && !apiKeyConfigured) {
    throw new Error("[AUTH_REQUIRED_IN_PROD] production CWOS requires authenticated API composition");
  }
  if (profile === "production" && apiKeyConfigured && !actorBinding) {
    throw new Error("[CWOS_V2_ACTOR_BINDING_REQUIRED_IN_PROD] production API-key mode requires a trusted CWOS v2 operator binding");
  }
  if (profile === "production" && operatorBinding && !operatorStepUp) {
    throw new Error("[CWOS_V2_OPERATOR_AUTH_REQUIRED] production human authority requires password/TOTP authentication");
  }
  if (actorBinding && !apiKeyConfigured) {
    throw new Error("[CWOS_V2_ACTOR_BINDING_REQUIRES_API_KEY] trusted operator binding requires AUTH_API_KEY/API_AUTH_TOKEN");
  }
  const app = createBaseApp(options);
  if (machineBinding) {
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0];
      if (machineBinding.mailCandidateReadOnly) {
        if (request.method === "GET" && (path === "/api/cwos/v2/mail-candidates"
          || path === "/api/cwos/v2/mail-candidates/count" || path === "/health")) return;
        return reply.status(403).send({ error: "MAIL_CANDIDATE_READ_ONLY" });
      }
      if (machineBinding.mailCandidateCreateOnly) {
        if ((request.method === "POST" && path === "/api/cwos/v2/mail-candidates")
          || (request.method === "GET" && path === "/health")) return;
        return reply.status(403).send({ error: "MAIL_CANDIDATE_CREATE_ONLY" });
      }
      const mailAccountMaster = machineBinding.mailAccountMasterRead && request.method === "GET"
        && path === "/api/cwos/accounts";
      if (!path?.startsWith("/api/cwos/v2/") && !mailAccountMaster) {
        return reply.status(403).send({ error: "MACHINE_ROUTE_DENIED" });
      }
      if (mailAccountMaster) {
        if (request.headers["x-workspace-id"] !== machineBinding.workspaceId
          || request.headers["x-principal-id"] !== machineBinding.principalId
          || request.headers["x-principal-kind"] !== "service") {
          return reply.status(403).send({ error: "ACTOR_BINDING_MISMATCH" });
        }
        if (request.headers["x-step-up"]) {
          return reply.status(403).send({ error: "UNTRUSTED_STEP_UP" });
        }
      }
      if (machineBinding.readOnly && request.method !== "GET" && request.method !== "HEAD") {
        return reply.status(403).send({ error: "MACHINE_READ_ONLY" });
      }
    });
  }
  const configuredDatabaseUrl =
    typeof options.databaseUrl === "string" && options.databaseUrl.trim()
      ? options.databaseUrl.trim()
      : typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()
        ? process.env.DATABASE_URL.trim()
        : undefined;
  registerCustomerWorkOsV2Routes(
    app,
    {
      ...(configuredDatabaseUrl ? { databaseUrl: configuredDatabaseUrl } : {}),
      ...(options.customerWorkOsV2Store ? { store: options.customerWorkOsV2Store } : {}),
      ...(options.customerWorkOsV2Profile ? { profile: options.customerWorkOsV2Profile } : {}),
      ...(actorBinding ? { actorBinding } : {}),
      ...(operatorStepUp ? { operatorStepUp } : {}),
      ...(machineBinding?.mailCandidateCreateOnly ? { mailCandidateWriter: true } : {}),
      ...(machineBinding?.mailCandidateReadOnly ? { mailCandidateReader: true } : {}),
      ...(options.customerWorkOsV2NormalizedProjectionPool
        ? { normalizedProjectionPool: options.customerWorkOsV2NormalizedProjectionPool } : {}),
    },
  );
  return app;
}
