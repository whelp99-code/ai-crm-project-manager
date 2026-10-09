import { createHmac, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { createApp } from "../src/app.js";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord, OperatorAuthStore } from "../src/operator-auth-store.js";

const workspaceId = process.env.W07_REVIEW_PG_TEST_WORKSPACE ?? "b1111111-1111-4111-8111-111111111111";
const principalId = "review-owner";
const key = "isolated-review-api-key-at-least-32-chars";
const password = "isolated-review-password";
const accountId = process.env.W07_REVIEW_PG_TEST_ACCOUNT ?? "account-dc84a964";
const accountName = process.env.W07_REVIEW_PG_TEST_ACCOUNT_NAME ?? "Acme";
const salt = Buffer.alloc(16, 7).toString("base64url");
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function codeAt(now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const last = hmac.at(-1);
  if (last === undefined) throw new RangeError("invalid test digest");
  return ((hmac.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

async function fixture() {
  const now = 59_000;
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordSalt: salt,
    passwordHash: scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 }).toString("base64url"),
    totpSecret: secret,
  };
  const authStore: OperatorAuthStore = { read: () => structuredClone(record), write: next => { record = structuredClone(next); } };
  const auth = new OperatorStepUpService({ workspaceId, principalId, sessionSecret: "isolated-review-session-secret-at-least-32-chars",
    store: authStore, now: () => now, cookieSecure: false });
  const store = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
  const owner: V2Actor = { workspaceId, principalId, kind: "human", stepUpVerified: true };
  for (const [command, payload] of [
    ["identity.registerPrincipal", { id: principalId, kind: "human", displayName: "Owner", active: true }],
    ["identity.addMembership", { id: "owner-membership", principalId }],
    ["identity.registerPrincipal", { id: "candidate-writer", kind: "service", displayName: "Writer", active: true }],
    ["identity.addMembership", { id: "writer-membership", principalId: "candidate-writer" }],
    ["mail.candidate.create", { id: "candidate-1", provider: "GMAIL", mailbox: "mail@example.test",
      sourceLocator: "gmail://thread/1", providerEventId: "message-1", subject: "Proposal",
      bodyDigest: "a".repeat(64), senderCompany: "Acme", summary: "Quote received",
      receivedAt: "2026-10-08T00:00:00.000Z", evidenceUrl: "https://example.test/evidence" }],
  ] as const) {
    const current = await runtime.read(workspaceId);
    await runtime.command({ workspaceId, actor: command === "mail.candidate.create"
      ? { workspaceId, principalId: "candidate-writer", kind: "service", stepUpVerified: false } : owner,
      expectedVersion: current.version,
      idempotencyKey: command + payload.id, command, payload });
  }
  const realPool = process.env.W07_REVIEW_PG_TEST_URL
    ? new Pool({ connectionString: process.env.W07_REVIEW_PG_TEST_URL, max: 1 }) : undefined;
  const pool: V2PgQueryable = realPool ? {
    async query<T>(text: string, values?: readonly unknown[]) {
      const result = await realPool.query(text, values === undefined ? undefined : [...values]);
      const rows: unknown[] = result.rows;
      return { rows: rows as T[], rowCount: result.rowCount };
    },
    async withWorkspaceScope<T>(scope: string, fn: (db: V2PgQueryable) => Promise<T>) {
      const client = await realPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope]);
        const result = await fn({
          async query<T2>(text: string, values?: readonly unknown[]) {
            const result = await client.query(text, values === undefined ? undefined : [...values]);
            const rows: unknown[] = result.rows;
            return { rows: rows as T2[], rowCount: result.rowCount };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  } : {
    async query<T>() { return { rows: [] as T[], rowCount: 0 }; },
    async withWorkspaceScope<T>(scope: string, fn: (db: V2PgQueryable) => Promise<T>) {
      if (scope !== workspaceId) throw new Error("unexpected workspace scope");
      return fn({ async query<T>(text: string, values?: readonly unknown[]) {
        const rows = text.includes("AND id=$2") && values?.[1] !== accountId ? [] : [{ id: accountId, name: accountName }];
        return { rows: rows as T[], rowCount: rows.length };
      } });
    },
  };
  const app = createApp({ authApiKey: key, customerWorkOsV2Profile: "production", customerWorkOsV2Store: store,
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
    customerWorkOsV2OperatorStepUp: auth, customerWorkOsV2NormalizedProjectionPool: pool });
  if (realPool) app.addHook("onClose", () => realPool.end());
  await app.ready();
  const headers = { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": principalId, "x-principal-kind": "human" };
  const stepUp = await app.inject({ method: "POST", url: "/api/cwos/v2/operator-step-up", headers,
    payload: { password, totp: codeAt(now) } });
  const token = stepUp.headers["set-cookie"];
  if (typeof token !== "string") throw new TypeError("operator proof cookie is required");
  const csrf = stepUp.json<{ csrf: string }>().csrf;
  return { app, runtime, store, auth, pool, headers: { ...headers, cookie: token.split(";")[0] ?? "", "x-csrf-token": csrf } };
}

describe("W07 Mail candidate review API", () => {
  it("fails closed without an admitted owner binding even when headers claim step-up", async () => {
    const f = await fixture();
    const unbound = createStandaloneCustomerWorkOsV2App({
      profile: "test", store: f.store, normalizedProjectionPool: f.pool,
    });
    try {
      await unbound.ready();
      const headers = { "x-workspace-id": workspaceId, "x-principal-id": principalId,
        "x-principal-kind": "human", "x-step-up": "true", "idempotency-key": "forged-unbound-review" };
      for (const method of ["GET", "POST"] as const) {
        const response = await unbound.inject({ method, url: "/api/cwos/v2/mail-candidate-review", headers,
          ...(method === "POST" ? { payload: { expectedVersion: 5, candidateId: "candidate-1", action: "DISCARD", reason: "SPAM" } } : {}) });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: "STEP_UP_REQUIRED" });
      }
      expect((await f.runtime.read(workspaceId)).version).toBe(5);
    } finally { await unbound.close(); await f.app.close(); }
  });
  it("lists source provenance and metadata, then appends undoable review history", async () => {
    const f = await fixture();
    try {
      const listed = await f.app.inject({ method: "GET", url: "/api/cwos/v2/mail-candidate-review", headers: f.headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ workspaceId, runtimeVersion: 5,
        candidates: [{ id: "candidate-1", senderCompany: "Acme", summary: "Quote received",
          receivedAt: "2026-10-08T00:00:00.000Z", sourceLocator: "gmail://thread/1", review: null, history: [] }] });
      expect(listed.json().accounts).toContainEqual({ id: accountId, name: accountName });
      const actionHeaders = { ...f.headers, "idempotency-key": "review-link" };
      const linked = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: actionHeaders, payload: { expectedVersion: 5, candidateId: "candidate-1", action: "LINK", accountId } });
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toMatchObject({ runtimeVersion: 6, review: { outcome: "LINKED", accountId } });
      const undo = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: { ...f.headers, "idempotency-key": "review-undo" },
        payload: { expectedVersion: 6, candidateId: "candidate-1", action: "UNDO", reviewId: linked.json().review.id } });
      expect(undo.json()).toMatchObject({ runtimeVersion: 7, review: { outcome: "UNDONE" } });
      const reread = await f.app.inject({ method: "GET", url: "/api/cwos/v2/mail-candidate-review", headers: f.headers });
      expect(reread.json().candidates[0]).toMatchObject({ review: { outcome: "UNDONE", version: 2 } });
      expect(reread.json().candidates[0].history.map((item: { version: number }) => item.version)).toEqual([1, 2]);
      expect((await f.runtime.read(workspaceId)).state.inbox.mailCandidates?.[0]).toMatchObject({ status: "CANDIDATE", confirmed: false });
    } finally { await f.app.close(); }
  });

  it("rejects missing proof, CSRF, unsafe URLs, foreign account IDs, stale and raw commands", async () => {
    const f = await fixture();
    try {
      const plainHeaders = { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": principalId, "x-principal-kind": "human" };
      expect((await f.app.inject({ method: "GET", url: "/api/cwos/v2/mail-candidate-review", headers: plainHeaders })).statusCode).toBe(403);
      const noCsrfHeaders = { "x-api-key": key, "x-workspace-id": workspaceId,
        "x-principal-id": principalId, "x-principal-kind": "human", cookie: f.headers.cookie };
      expect((await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: { ...noCsrfHeaders, "idempotency-key": "csrf-missing" },
        payload: { expectedVersion: 5, candidateId: "candidate-1", action: "DISCARD", reason: "SPAM" } })).statusCode).toBe(403);
      expect((await f.app.inject({ method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...f.headers, "idempotency-key": "raw-review" },
        payload: { command: "mail.candidate.review", expectedVersion: 3,
          payload: { id: "forged", candidateId: "candidate-1", outcome: "DISCARDED" } } })).statusCode).toBe(400);
      expect((await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: { ...f.headers, "idempotency-key": "invalid-url" },
        payload: { expectedVersion: 5, candidateId: "candidate-1", action: "DELETE" } })).statusCode).toBe(400);
      const wrongAccount = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: { ...f.headers, "idempotency-key": "foreign-account" },
        payload: { expectedVersion: 5, candidateId: "candidate-1", action: "LINK", accountId: "d3333333-3333-4333-8333-333333333333" } });
      expect(wrongAccount.statusCode).toBe(404);
      const stale = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
        headers: { ...f.headers, "idempotency-key": "stale-version" },
        payload: { expectedVersion: 4, candidateId: "candidate-1", action: "DISCARD", reason: "SPAM" } });
      expect(stale.statusCode).toBe(409);
      expect((await f.runtime.read(workspaceId)).version).toBe(5);
    } finally { await f.app.close(); }
  });

  it("uses the original subject without inventing company or receipt metadata for legacy candidates", async () => {
    const f = await fixture();
    try {
      await f.runtime.command({
        workspaceId,
        actor: { workspaceId, principalId: "candidate-writer", kind: "service", stepUpVerified: false },
        expectedVersion: 5, idempotencyKey: "legacy-candidate", command: "mail.candidate.create",
        payload: { id: "legacy-candidate", provider: "GMAIL", mailbox: "mail@example.test",
          sourceLocator: "gmail://legacy", providerEventId: "legacy", subject: "Original legacy subject",
          bodyDigest: "b".repeat(64) },
      });
      const response = await f.app.inject({ method: "GET", url: "/api/cwos/v2/mail-candidate-review", headers: f.headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().candidates.find((item: { id: string }) => item.id === "legacy-candidate"))
        .toMatchObject({ summary: "Original legacy subject", senderCompany: null, receivedAt: null, evidenceUrl: null });
    } finally { await f.app.close(); }
  });
});
