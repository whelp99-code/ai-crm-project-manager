/**
 * Env-gated worker bind for the CRM company-memory donor tick.
 *
 * Absent COMPANY_MEMORY_* → disabled. Incomplete, unknown, or unreadable
 * command/key files → fail closed. Personal `sb` is rejected. DATABASE_URL
 * binds the CWOS mail outbox; missing schema/queryable fails closed. Empty
 * outbox is used only when no DB. This module does not write personal
 * memory, talk to the loopback API, or invent a shared signing key.
 */
import { spawn } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  publishCompanyMemoryDonor,
  type CompanyMemoryCliResult,
  type CompanyMemoryCliTransport,
  type CompanyMemoryDonorOutbox,
  type CompanyMemoryDonorTickResult,
  type CompanyMemoryDonorTrustedContext,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  resolveCompanyMemoryDonorOutbox,
  type CompanyMemoryDonorPgQueryable,
} from "./company-memory-donor-outbox.js";

export type { CompanyMemoryDonorPgQueryable };

const REQUIRED_ENV = [
  "COMPANY_MEMORY_SB_COMPANY",
  "COMPANY_MEMORY_SB_COMPANY_CONFIG",
  "COMPANY_MEMORY_SIGNING_KEY_FILE",
  "COMPANY_MEMORY_AUTHORITY_FILE",
] as const;

const REQUIRED_SET = new Set<string>(REQUIRED_ENV);

export type CompanyMemoryDonorBind =
  | { enabled: false }
  | {
      enabled: true;
      command: string;
      configPath: string;
      signingKeyFile: string;
      authorityFile: string;
    };

export type BoundCompanyMemoryDonorTick =
  | { skipped: true }
  | { skipped: false; result: CompanyMemoryDonorTickResult };

export function loadCompanyMemoryDonorBind(
  env: Record<string, string | undefined>,
): CompanyMemoryDonorBind {
  const companyKeys = Object.keys(env).filter((key) => key.startsWith("COMPANY_MEMORY_"));
  if (companyKeys.length === 0) {
    return { enabled: false };
  }

  const unknown = companyKeys.filter((key) => !REQUIRED_SET.has(key));
  const command = readRequired(env, "COMPANY_MEMORY_SB_COMPANY");
  const configPath = readRequired(env, "COMPANY_MEMORY_SB_COMPANY_CONFIG");
  const signingKeyFile = readRequired(env, "COMPANY_MEMORY_SIGNING_KEY_FILE");
  const authorityFile = readRequired(env, "COMPANY_MEMORY_AUTHORITY_FILE");

  if (unknown.length > 0 || !command || !configPath || !signingKeyFile || !authorityFile) {
    throw incomplete("donor env is incomplete or unknown");
  }

  if (
    !isAbsolute(command) ||
    !isAbsolute(configPath) ||
    !isAbsolute(signingKeyFile) ||
    !isAbsolute(authorityFile) ||
    !existsSync(command) ||
    !existsSync(configPath) ||
    !existsSync(signingKeyFile) ||
    !existsSync(authorityFile)
  ) {
    throw incomplete("donor command or key files are missing");
  }

  if (basename(command) !== "sb-company") {
    throw new Error("COMPANY_MEMORY_COMMAND_INVALID: command must be an absolute sb-company path");
  }

  const authority = loadAuthority(authorityFile);
  loadSigner(signingKeyFile, authority.keyId);

  return {
    enabled: true,
    command,
    configPath,
    signingKeyFile,
    authorityFile,
  };
}

export async function runBoundCompanyMemoryDonorTick(
  env: Record<string, string | undefined>,
  options: {
    now?: Date | undefined;
    outbox?: CompanyMemoryDonorOutbox | undefined;
    queryable?: CompanyMemoryDonorPgQueryable | undefined;
  } = {},
): Promise<BoundCompanyMemoryDonorTick> {
  const bind = loadCompanyMemoryDonorBind(env);
  if (!bind.enabled) {
    return { skipped: true };
  }

  const authority = loadAuthority(bind.authorityFile);
  const signer = loadSigner(bind.signingKeyFile, authority.keyId);
  const transport = createSbCompanyTransport(bind.command, bind.configPath);
  const resolved = await resolveCompanyMemoryDonorOutbox({
    databaseUrl: env.DATABASE_URL?.trim(),
    queryable: options.queryable,
    outbox: options.outbox,
    workspaceId: authority.context.workspaceId,
  });
  const now = options.now ?? new Date();
  const result = await publishCompanyMemoryDonor({
    context: authority.context,
    signer,
    transport,
    outbox: resolved.outbox,
    now,
  });
  await resolved.persistEmitted();
  return { skipped: false, result };
}

function readRequired(
  env: Record<string, string | undefined>,
  key: (typeof REQUIRED_ENV)[number],
): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.normalize("NFC").trim();
  return trimmed ? trimmed : undefined;
}

function incomplete(detail: string): Error {
  return new Error(`COMPANY_MEMORY_ENV_INCOMPLETE: ${detail}`);
}

function loadAuthority(file: string): { keyId: string; context: CompanyMemoryDonorTrustedContext } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw incomplete("authority file is unreadable or not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw incomplete("authority file must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const projects = record.projects;
  if (!Array.isArray(projects) || projects.some((item) => typeof item !== "string")) {
    throw incomplete("authority projects must be strings");
  }
  return {
    keyId: requiredString(record.keyId, "keyId"),
    context: {
      providerInstanceId: requiredString(record.providerInstanceId, "providerInstanceId"),
      workspaceId: requiredString(record.workspaceId, "workspaceId"),
      principalId: requiredString(record.principalId, "principalId"),
      agentId: requiredString(record.agentId, "agentId"),
      sessionId: requiredString(record.sessionId, "sessionId"),
      projects: projects.map((project) => String(project)),
      policyRevision: requiredString(record.policyRevision, "policyRevision"),
      deletionSequence: requiredNumber(record.deletionSequence, "deletionSequence"),
      deletionSetRoot: requiredString(record.deletionSetRoot, "deletionSetRoot"),
    },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.normalize("NFC").trim()) {
    throw incomplete(`${field} is required`);
  }
  return value.normalize("NFC").trim();
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw incomplete(`${field} must be a number`);
  }
  return value;
}

function loadSigner(file: string, keyId: string) {
  let pem: string;
  try {
    pem = readFileSync(file, "utf8");
  } catch {
    throw incomplete("signing key file is unreadable");
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("not ed25519");
    }
    return {
      keyId,
      sign(message: Uint8Array): Uint8Array {
        return sign(null, message, privateKey);
      },
    };
  } catch {
    throw incomplete("signing key file must be an Ed25519 PKCS8 PEM");
  }
}

function createSbCompanyTransport(command: string, configPath: string): CompanyMemoryCliTransport {
  return {
    async invoke(canonicalRequest: Uint8Array): Promise<CompanyMemoryCliResult> {
      return await new Promise((resolve, reject) => {
        const child = spawn(command, ["--config", configPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (!child.stdin || !child.stdout || !child.stderr) {
          child.kill();
          reject(new Error("COMPANY_TRANSPORT_FAILED"));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") reject(error);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
        });
        child.stdin.end(Buffer.from(canonicalRequest));
      });
    },
  };
}
