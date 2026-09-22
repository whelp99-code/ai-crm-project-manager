import type { FastifyInstance } from "fastify";
import {
  createApp as createBaseApp,
  type CreateAppOptions,
} from "./app-base.js";
import { registerCustomerWorkOsV2Routes } from "./customer-work-os-v2-routes.js";
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
};

export function createApp(options: CustomerWorkOsV2AppOptions = {}): FastifyInstance {
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
    },
  );
  return app;
}
