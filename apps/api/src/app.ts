import type { FastifyInstance } from "fastify";
import {
  createApp as createBaseApp,
  type CreateAppOptions,
} from "./app-base.js";
import {
  registerCustomerWorkOsV2Routes,
  type CustomerWorkOsV2ActorBinding,
} from "./customer-work-os-v2-routes.js";
import type { CwosV2StateStore } from "./customer-work-os-v2-runtime.js";

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
  const actorBinding = configuredActorBinding(options);
  const apiKeyConfigured = hasConfiguredApiKey(options);
  const profile = options.customerWorkOsV2Profile ?? (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development");
  if (profile === "production" && apiKeyConfigured && !actorBinding) {
    throw new Error("[CWOS_V2_ACTOR_BINDING_REQUIRED_IN_PROD] production API-key mode requires a trusted CWOS v2 operator binding");
  }
  if (actorBinding && !apiKeyConfigured) {
    throw new Error("[CWOS_V2_ACTOR_BINDING_REQUIRES_API_KEY] trusted operator binding requires AUTH_API_KEY/API_AUTH_TOKEN");
  }
  const app = createBaseApp(options);
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
    },
  );
  return app;
}
