import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createApp } from "../../api/src/app.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore, type V2PgQueryable } from "../../api/src/customer-work-os-v2-runtime.js";
import { operatorPasswordHash, operatorTotpCode } from "../../api/src/operator-auth-crypto.js";
import type { OperatorAuthRecord } from "../../api/src/operator-auth-store.js";
import { OperatorStepUpService } from "../../api/src/operator-step-up.js";

const fixturePassword = "synthetic-playwright-password";
type FixtureApp = ReturnType<typeof createApp>;
const workspaceId = "playwright-login-workspace";
const principalId = "playwright-login-owner";
const apiKey = "playwright-auth-api-key-for-isolated-tests-only";
const sessionSecret = "playwright-session-secret-for-isolated-tests-only";
const controlSecret = randomBytes(32).toString("base64url");
let now = 1_800_000_000_000;
let record: OperatorAuthRecord;

function secret(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function enroll(previousGeneration = 0): OperatorAuthRecord {
  const totpSecret = secret();
  return {
    generation: previousGeneration + 1,
    enrolled: true,
    totpPending: false,
    passwordHash: operatorPasswordHash(fixturePassword),
    totpSecret,
  };
}

export async function startNativeAuthFixture(
  directory: string,
  options: { readonly mailCandidates?: boolean } = {},
): Promise<{
  app: FixtureApp;
  origin: string;
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const controlPath = `${directory}/auth-control.json`;
  let resetCode = "";
  const auth = new OperatorStepUpService({
    workspaceId,
    principalId,
    sessionSecret,
    store: {
      read: () => structuredClone(record),
      write: next => { record = structuredClone(next); },
    },
    now: () => now,
    cookieSecure: false,
  });
  const state = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(state, () => "2026-10-13T00:00:00.000Z");
  const accountId = "synthetic-review-account";
  // Only the normalized account projection is synthetic; list and decisions use
  // the production routes, authorization, domain commands and versioned store.
  const accounts: V2PgQueryable = {
    async query<T>() { return { rows: [] as T[], rowCount: 0 }; },
    async withWorkspaceScope<T>(scope: string, fn: (db: V2PgQueryable) => Promise<T>) {
      if (scope !== workspaceId) throw new Error("unexpected synthetic workspace");
      return fn({ async query<T2>(text: string, values?: readonly unknown[]) {
        if (!text.includes("FROM cwos_accounts") || values?.[0] !== workspaceId) {
          throw new Error("unexpected synthetic account query");
        }
        const rows = text.includes("AND id=$2") && values[1] !== accountId
          ? [] : [{ id: accountId, name: "Synthetic account" }];
        return { rows: rows as T2[], rowCount: rows.length };
      } });
    },
  };
  if (options.mailCandidates) {
    const owner = { workspaceId, principalId, kind: "human", stepUpVerified: true } as const;
    for (const [command, payload] of [
      ["identity.registerPrincipal", { id: principalId, kind: "human", displayName: "Synthetic owner", active: true }],
      ["identity.addMembership", { id: "review-owner-membership", principalId }],
      ["identity.registerPrincipal", { id: "review-writer", kind: "service", displayName: "Synthetic writer", active: true }],
      ["identity.addMembership", { id: "review-writer-membership", principalId: "review-writer" }],
    ] as const) {
      const current = await runtime.read(workspaceId);
      await runtime.command({ workspaceId, actor: owner, expectedVersion: current.version,
        idempotencyKey: payload.id, command, payload });
    }
    for (let index = 1; index <= 5; index++) {
      const current = await runtime.read(workspaceId);
      await runtime.command({
        workspaceId, actor: { workspaceId, principalId: "review-writer", kind: "service", stepUpVerified: false },
        expectedVersion: current.version, idempotencyKey: `review-candidate-${index}`,
        command: "mail.candidate.create",
        payload: { id: `review-candidate-${index}`, provider: "GMAIL", mailbox: "fixture@example.test",
          sourceLocator: `gmail://synthetic/${index}`, providerEventId: `synthetic-${index}`,
          subject: `Synthetic candidate ${index}`, summary: `Synthetic candidate ${index}`,
          bodyDigest: "a".repeat(64), senderCompany: "Synthetic company",
          receivedAt: "2026-10-13T00:00:00.000Z", evidenceUrl: `https://example.test/evidence/${index}` },
      });
    }
  }
  const app = createApp({
    authApiKey: apiKey,
    customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: state,
    ...(options.mailCandidates ? { customerWorkOsV2NormalizedProjectionPool: accounts } : {}),
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
    customerWorkOsV2OperatorStepUp: auth,
  });
  let apiOrigin: string | undefined;
  app.post("/__playwright/auth/reset", async (request, reply) => {
    if (request.headers["x-playwright-reset-token"] !== controlSecret) {
      return reply.status(403).send({ error: "FIXTURE_CONTROL_DENIED" });
    }
    now += 30_000;
    record = enroll(record.generation);
    resetCode = operatorTotpCode(record.totpSecret, Math.floor(now / 30_000));
    if (!apiOrigin) return reply.status(503).send({ error: "FIXTURE_NOT_READY" });
    await writeFile(controlPath, JSON.stringify({
      origin: apiOrigin,
      controlSecret,
      password: fixturePassword,
      totp: resetCode,
    }), { mode: 0o600 });
    return reply.status(200).send({ ready: true });
  });
  record = enroll();
  resetCode = operatorTotpCode(record.totpSecret, Math.floor(now / 30_000));
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string" || isIP(address.address) !== 4
      || address.address !== "127.0.0.1") {
      throw new Error("native auth fixture did not bind to IPv4 loopback");
    }
    apiOrigin = `http://127.0.0.1:${address.port}`;
    await writeFile(controlPath, JSON.stringify({
      origin: apiOrigin, controlSecret, password: fixturePassword, totp: resetCode,
    }), { mode: 0o600 });
    return { app, origin: apiOrigin };
  } catch (error) {
    try {
      await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
