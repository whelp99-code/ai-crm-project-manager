import type { FastifyInstance } from "fastify";
import {
  createApp as createBaseApp,
  type CreateAppOptions,
} from "./app-base.js";
import { registerCustomerWorkOsV2Routes } from "./customer-work-os-v2-routes.js";
import { registerCustomerWorkOsV25Routes } from "./customer-work-os-v25-routes.js";

export * from "./app-base.js";

/**
 * Customer Work OS composition root.
 *
 * The stable application remains in app-base.ts. This wrapper adds the v2
 * governed runtime and the v2.1-v2.5 AI-managed input layer before Fastify is
 * readied, preserving a single API server and mutation boundary.
 */
export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = createBaseApp(options);
  const configuredDatabaseUrl =
    typeof options.databaseUrl === "string" && options.databaseUrl.trim()
      ? options.databaseUrl.trim()
      : typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim()
        ? process.env.DATABASE_URL.trim()
        : undefined;
  const databaseOptions = configuredDatabaseUrl ? { databaseUrl: configuredDatabaseUrl } : {};
  registerCustomerWorkOsV2Routes(app, databaseOptions);
  registerCustomerWorkOsV25Routes(app, databaseOptions);
  return app;
}
