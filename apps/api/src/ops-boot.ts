import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { FileOperatorAuthStore, type OperatorAuthStore } from "./operator-auth-store.js";
import { OperatorStepUpService } from "./operator-step-up.js";
import { registerReadonlyListRoutes } from "./readonly-list-routes.js";

export interface OperatingEnv {
  readonly CORE5_API_MODE?: string;
  readonly DATABASE_URL?: string;
  readonly ADMIN_DATABASE_URL?: string;
  readonly MODEL_GATEWAY_DATABASE_URL?: string;
  readonly CORE5_API_PORT?: string;
  readonly WORKSPACE_ID?: string;
  readonly AUTH_API_KEY?: string;
  readonly API_AUTH_TOKEN?: string;
  readonly CWOS_V2_OPERATOR_WORKSPACE_ID?: string;
  readonly CWOS_V2_OPERATOR_PRINCIPAL_ID?: string;
  readonly CWOS_V2_OPERATOR_AUTH_STATE_PATH?: string;
  readonly CWOS_V2_OPERATOR_SESSION_SECRET_FILE?: string;
  readonly CWOS_V2_OPERATOR_STEP_UP_VERIFIED?: string;
  readonly CWOS_V2_MAIL_READER_PRINCIPAL_ID?: string;
  readonly CWOS_V2_MAIL_READER_KEY_FILE?: string;
  readonly [key: string]: string | undefined;
}

export interface OperatingConfig {
  readonly mode: "human" | "mail-reader";
  readonly databaseUrl: string;
  readonly adminDatabaseUrl: string;
  readonly modelGatewayDatabaseUrl: string;
  readonly port: number;
  readonly workspaceId: string;
  readonly apiKey: string;
  readonly principalId: string;
  readonly authStatePath?: string;
  readonly sessionSecret?: string;
}

function required(env: OperatingEnv, name: keyof OperatingEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`[OPS_BOOT_CONFIG_REQUIRED] ${String(name)} is required`);
  return value;
}

function privateFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`[OPS_BOOT_PRIVATE_FILE_INVALID] ${label} path must be absolute`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`[OPS_BOOT_PRIVATE_FILE_INVALID] ${label} must be a regular, non-symlink private file`);
    }
  } finally {
    closeSync(fd);
  }
}

function privateTextFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`[OPS_BOOT_PRIVATE_FILE_INVALID] ${label} path must be absolute`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`[OPS_BOOT_PRIVATE_FILE_INVALID] ${label} must be a regular, non-symlink private file`);
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!value) throw new Error(`[OPS_BOOT_PRIVATE_FILE_INVALID] ${label} file is empty`);
    return value;
  } finally {
    closeSync(fd);
  }
}

function rejectInheritedOperatorIdentity(env: OperatingEnv): void {
  const forbidden = Object.keys(env).filter((name) => (
    name === "AUTH_API_KEY" ||
    name === "API_AUTH_TOKEN" ||
    name.startsWith("CWOS_V2_OPERATOR_")
  ));
  const inherited = forbidden.filter((name) => env[name]?.trim());
  if (inherited.length) {
    throw new Error(`[OPS_BOOT_READER_OPERATOR_ENV_FORBIDDEN] unset operator environment: ${inherited.join(", ")}`);
  }
}

export function parseOperatingConfig(env: OperatingEnv = process.env): OperatingConfig {
  const mode = required(env, "CORE5_API_MODE");
  if (mode !== "human" && mode !== "mail-reader") {
    throw new Error("[OPS_BOOT_MODE_INVALID] CORE5_API_MODE must be human or mail-reader");
  }
  const databaseUrl = required(env, "DATABASE_URL");
  const adminDatabaseUrl = required(env, "ADMIN_DATABASE_URL");
  const modelGatewayDatabaseUrl = required(env, "MODEL_GATEWAY_DATABASE_URL");
  if (databaseUrl === adminDatabaseUrl || databaseUrl === modelGatewayDatabaseUrl || adminDatabaseUrl === modelGatewayDatabaseUrl) {
    throw new Error("[OPS_BOOT_DATABASE_PROFILES_NOT_DISTINCT] all three PostgreSQL profiles must use distinct DSNs");
  }
  const roles = [databaseUrl, adminDatabaseUrl, modelGatewayDatabaseUrl].map(value => {
    let profile: URL;
    let role: string;
    try {
      profile = new URL(value);
      role = decodeURIComponent(profile.username);
    } catch (error) {
      if (error instanceof TypeError || error instanceof URIError) {
        throw new Error("[OPS_BOOT_DATABASE_PROFILE_INVALID] explicit PostgreSQL role profiles required");
      }
      throw error;
    }
    if ((profile.protocol !== "postgres:" && profile.protocol !== "postgresql:") || !role || !profile.pathname.slice(1)
      || profile.searchParams.has("user") || profile.searchParams.has("username")) {
      throw new Error("[OPS_BOOT_DATABASE_PROFILE_INVALID] explicit PostgreSQL role profiles required");
    }
    return role;
  });
  if (new Set(roles).size !== 3) {
    throw new Error("[OPS_BOOT_DATABASE_ROLES_NOT_DISTINCT] API, admin and model gateway roles must differ");
  }
  const portText = env.CORE5_API_PORT?.trim() || "4312";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("[OPS_BOOT_PORT_INVALID] CORE5_API_PORT must be an integer from 1 to 65535");
  }
  const workspaceId = required(env, "WORKSPACE_ID");

  if (mode === "human") {
    if (env.CWOS_V2_OPERATOR_STEP_UP_VERIFIED?.trim() === "1") {
      throw new Error("[OPS_BOOT_STEP_UP_ENV_FORBIDDEN] production step-up must be proven per request");
    }
    const apiKey = required(env, "AUTH_API_KEY");
    const operatorWorkspaceId = required(env, "CWOS_V2_OPERATOR_WORKSPACE_ID");
    if (operatorWorkspaceId !== workspaceId) {
      throw new Error("[OPS_BOOT_HUMAN_WORKSPACE_MISMATCH] WORKSPACE_ID must match the operator workspace");
    }
    const principalId = required(env, "CWOS_V2_OPERATOR_PRINCIPAL_ID");
    const authStatePath = required(env, "CWOS_V2_OPERATOR_AUTH_STATE_PATH");
    privateFile(authStatePath, "operator auth state");
    const sessionSecretFile = required(env, "CWOS_V2_OPERATOR_SESSION_SECRET_FILE");
    const sessionSecret = privateTextFile(sessionSecretFile, "operator session secret");
    if (sessionSecret.length < 32) {
      throw new Error("[OPS_BOOT_SESSION_SECRET_TOO_SHORT] operator session secret must contain at least 32 characters");
    }
    return {
      mode,
      databaseUrl,
      adminDatabaseUrl,
      modelGatewayDatabaseUrl,
      port,
      workspaceId: operatorWorkspaceId,
      apiKey,
      principalId,
      authStatePath,
      sessionSecret,
    };
  }

  rejectInheritedOperatorIdentity(env);
  const principalId = required(env, "CWOS_V2_MAIL_READER_PRINCIPAL_ID");
  const keyFile = required(env, "CWOS_V2_MAIL_READER_KEY_FILE");
  const apiKey = privateTextFile(keyFile, "mail reader key");
  if (apiKey.length < 32 || /\s/u.test(apiKey)) {
    throw new Error("[OPS_BOOT_READER_KEY_TOO_SHORT] mail-reader key requires at least 32 non-whitespace characters");
  }
  return {
    mode,
    databaseUrl,
    adminDatabaseUrl,
    modelGatewayDatabaseUrl,
    port,
    workspaceId,
    apiKey,
    principalId,
  };
}

export interface OperatingAppSeams {
  readonly store?: OperatorAuthStore;
  readonly now?: () => number;
  readonly readonlyPool?: Pool;
}

export function createOperatingApp(
  config: OperatingConfig,
  seams: OperatingAppSeams = {},
): FastifyInstance {
  const human = config.mode === "human";
  const app = human
    ? createApp({
        databaseUrl: config.databaseUrl,
        adminDatabaseUrl: config.adminDatabaseUrl,
        modelGatewayDatabaseUrl: config.modelGatewayDatabaseUrl,
        authApiKey: config.apiKey,
        customerWorkOsV2Profile: "production",
        customerWorkOsV2OperatorStepUp: new OperatorStepUpService({
        workspaceId: config.workspaceId,
        principalId: config.principalId,
        sessionSecret: config.sessionSecret ?? "",
        store: seams.store ?? new FileOperatorAuthStore(config.authStatePath ?? ""),
        ...(seams.now ? { now: seams.now } : {}),
        }),
        customerWorkOsV2ActorBinding: {
            workspaceId: config.workspaceId,
            principalId: config.principalId,
            kind: "human",
            stepUpVerified: false,
          },
      })
    : createApp({
        databaseUrl: config.databaseUrl,
        adminDatabaseUrl: config.adminDatabaseUrl,
        modelGatewayDatabaseUrl: config.modelGatewayDatabaseUrl,
        authApiKey: config.apiKey,
        customerWorkOsV2Profile: "production",
        customerWorkOsV2MachineBinding: {
            workspaceId: config.workspaceId,
            principalId: config.principalId,
            kind: "service",
            readOnly: true,
          },
      });
  const listPool = seams.readonlyPool ?? new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    application_name: "core5-api-readonly-lists",
  });
  registerReadonlyListRoutes(app, { pool: listPool, workspaceId: config.workspaceId, apiKey: config.apiKey });
  if (!seams.readonlyPool) {
    app.addHook("onClose", async () => {
      await listPool.end();
    });
  }
  return app;
}
