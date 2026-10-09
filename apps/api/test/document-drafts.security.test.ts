import { createHmac, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord } from "../src/operator-auth-store.js";

const workspaceId = "b1111111-1111-4111-8111-111111111111";
const principalId = "document-fixture-owner";
const password = "isolated-document-fixture-password";
const key = "isolated-document-fixture-api-key-at-least-32-chars";
const quoteInput = {
  engagement: { id: "engagement-fixture", version: 1 }, versionLabel: "fixture-v1",
  validUntil: "2026-10-31", scope: "Fixture maintenance",
  lines: [{ id: "line-1", sourceId: "fixture-source", productId: "fixture-product",
    description: "Fixture maintenance", quantity: 1, unitCostKrw: "60000000", unitPriceKrw: "100000000" }],
  options: [], templateRef: "fixture-template-unverified",
  vat: { netAmountKrw: "100000000", vatAmountKrw: "10000000", grossAmountKrw: "110000000" },
  po: { customerPoId: "fixture-customer-po", supplierPoId: "fixture-supplier-po" },
};

async function fixture() {
  const salt = Buffer.alloc(16, 7).toString("base64url");
  let authRecord: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordSalt: salt,
    passwordHash: scryptSync(password, Buffer.from(salt, "base64url"), 32).toString("base64url"),
    totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  };
  const auth = new OperatorStepUpService({
    workspaceId, principalId, sessionSecret: "isolated-document-session-secret-at-least-32-chars",
    store: { read: () => structuredClone(authRecord), write: next => { authRecord = structuredClone(next); } },
    now: () => 59_000, cookieSecure: false,
  });
  const store = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
  const owner = { workspaceId, principalId, kind: "human", stepUpVerified: true } as const;
  await runtime.command({ workspaceId, actor: owner, expectedVersion: 0, idempotencyKey: "principal",
    command: "identity.registerPrincipal", payload: { id: principalId, kind: "human", displayName: "Fixture Owner", active: true } });
  await runtime.command({ workspaceId, actor: owner, expectedVersion: 1, idempotencyKey: "membership",
    command: "identity.addMembership", payload: { id: "fixture-membership", principalId } });
  const pool: V2PgQueryable = {
    async query<T>() { return { rows: [] as T[], rowCount: 0 }; },
    async withWorkspaceScope<T>(scope: string, fn: (db: V2PgQueryable) => Promise<T>) {
      if (scope !== workspaceId) throw new Error("unexpected fixture scope");
      return fn({
        async query<T>(text: string, values?: readonly unknown[]) {
          const rows = text.includes("AND id=$2") && values?.[1] !== "engagement-fixture"
            ? [] : [{ id: "engagement-fixture", name: "Fixture Project", version: 1 }];
          return { rows: rows as T[], rowCount: rows.length };
        },
      });
    },
  };
  const app = createApp({ authApiKey: key, customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: store, customerWorkOsV2NormalizedProjectionPool: pool,
    customerWorkOsV2ActorBinding: { ...owner, stepUpVerified: false }, customerWorkOsV2OperatorStepUp: auth });
  await app.ready();
  const baseHeaders = { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": principalId, "x-principal-kind": "human" };
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(1n);
  const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const last = digest.at(-1);
  if (last === undefined) throw new Error("fixture digest required");
  const totp = ((digest.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  const stepUp = await app.inject({ method: "POST", url: "/api/cwos/v2/operator-step-up",
    headers: baseHeaders, payload: { password, totp } });
  const cookie = stepUp.headers["set-cookie"];
  if (typeof cookie !== "string") throw new Error("fixture proof required");
  return { app, runtime, baseHeaders,
    headers: { ...baseHeaders, cookie: cookie.split(";")[0] ?? "", "x-csrf-token": stepUp.json<{ csrf: string }>().csrf } };
}

describe("owner document drafts", () => {
  it("creates and lists a durable unapproved quote with exact quote and PO amounts", async () => {
    const f = await fixture();
    try {
      const created = await f.app.inject({ method: "POST", url: "/api/cwos/v2/document-drafts",
        headers: { ...f.headers, "idempotency-key": "quote" },
        payload: { action: "QUOTE", expectedVersion: 2, input: quoteInput } });
      expect(created.statusCode).toBe(201);
      const listed = await f.app.inject({ method: "GET", url: "/api/cwos/v2/document-drafts", headers: f.headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().quoteDrafts).toMatchObject([{
        quote: { status: "DRAFT", totalPriceKrw: "100000000", totalCostKrw: "60000000" },
        vat: quoteInput.vat, po: quoteInput.po, templatePreview: { accepted: false },
      }]);
      expect(listed.json().runtimeVersion).toBe(3);
      expect((await f.runtime.read(workspaceId)).state.quoteDrafts).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("rejects unauthenticated, malformed, foreign and stale input without adding drafts", async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: "GET", url: "/api/cwos/v2/document-drafts", headers: f.baseHeaders })).statusCode).toBe(403);
      for (const [name, input, version, status] of [
        ["negative-money", { ...quoteInput, vat: { ...quoteInput.vat, vatAmountKrw: "-1" } }, 2, 400],
        ["VAT-mismatch", { ...quoteInput, vat: { ...quoteInput.vat, grossAmountKrw: "1" } }, 2, 400],
        ["foreign-engagement", { ...quoteInput, engagement: { id: "foreign", version: 1 } }, 2, 404],
        ["stale-source", { ...quoteInput, engagement: { id: "engagement-fixture", version: 2 } }, 2, 409],
        ["stale-CAS", quoteInput, 1, 409],
      ] as const) {
        const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/document-drafts",
          headers: { ...f.headers, "idempotency-key": name },
          payload: { action: "QUOTE", expectedVersion: version, input } });
        expect(response.statusCode).toBe(status);
      }
      expect((await f.runtime.read(workspaceId)).state.quoteDrafts).toEqual([]);
      expect((await f.runtime.read(workspaceId)).version).toBe(2);
    } finally { await f.app.close(); }
  });
});
