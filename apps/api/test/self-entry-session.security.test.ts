import { createHmac, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord, OperatorAuthStore } from "../src/operator-auth-store.js";

const workspaceId = "session-workspace-fixture";
const principalId = "session-human-fixture";
const apiKey = "synthetic-session-api-key-at-least-32";
const password = "synthetic-session-password";
const passwordSalt = Buffer.alloc(16, 11).toString("base64url");
const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const sessionSecret = "synthetic-session-signature-secret-at-least-32";

function totpAt(now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function fixture() {
  let now = 59_000;
  let record: OperatorAuthRecord = {
    generation: 1,
    enrolled: true,
    totpPending: false,
    passwordSalt,
    passwordHash: scryptSync(password, Buffer.from(passwordSalt, "base64url"), 32, {
      N: 16384, r: 8, p: 1,
    }).toString("base64url"),
    totpSecret,
  };
  const authStore: OperatorAuthStore = {
    read: () => structuredClone(record),
    write: next => { record = structuredClone(next); },
  };
  const auth = new OperatorStepUpService({
    workspaceId,
    principalId,
    sessionSecret,
    store: authStore,
    now: () => now,
    cookieSecure: false,
  });
  const stateStore = new InMemoryCwosV2StateStore();
  const headers = {
    "x-api-key": apiKey,
    "x-workspace-id": workspaceId,
    "x-principal-id": principalId,
    "x-principal-kind": "human",
  };
  const app = createApp({
    authApiKey: apiKey,
    customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: stateStore,
    customerWorkOsV2OperatorStepUp: auth,
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
  });
  return {
    app, authStore, stateStore, headers,
    now: () => now,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

async function proofHeaders(f: ReturnType<typeof fixture>) {
  const issued = await f.app.inject({
    method: "POST",
    url: "/api/cwos/v2/operator-step-up",
    headers: f.headers,
    payload: { password, totp: totpAt(f.now()) },
  });
  expect(issued.statusCode).toBe(200);
  const cookie = issued.headers["set-cookie"];
  if (typeof cookie !== "string") throw new TypeError("test requires issued scoped proof");
  const csrf: unknown = issued.json().csrf;
  if (typeof csrf !== "string") throw new TypeError("test requires issued CSRF value");
  return { ...f.headers, cookie: cookie.split(";")[0] ?? "", "x-csrf-token": csrf };
}

describe("operator session verification", () => {
  it("denies missing proof with a non-cacheable typed response", async () => {
    const f = fixture();
    try {
      const response = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/operator-session", headers: f.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "STEP_UP_REQUIRED" });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("returns only authenticated for a valid scoped proof without store mutation or leaks", async () => {
    const f = fixture();
    try {
      const headers = await proofHeaders(f);
      const stateBefore = await f.stateStore.load(workspaceId);
      const authBefore = f.authStore.read();
      const response = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/operator-session", headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.json()).toEqual({ authenticated: true });
      expect(response.body).not.toContain(headers.cookie);
      expect(response.body).not.toContain(headers["x-csrf-token"]);
      expect(response.body).not.toContain(password);
      expect(response.body).not.toContain(totpSecret);
      expect(await f.stateStore.load(workspaceId)).toEqual(stateBefore);
      expect(f.authStore.read()).toEqual(authBefore);
      expect(response.body).not.toContain(apiKey);
    } finally { await f.app.close(); }
  });

  it("denies expired proof without mutating either store", async () => {
    const f = fixture();
    try {
      const headers = await proofHeaders(f);
      f.advance(300_000);
      const stateBefore = await f.stateStore.load(workspaceId);
      const authBefore = f.authStore.read();
      const response = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/operator-session", headers,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "OPERATOR_PROOF_EXPIRED" });
      expect(await f.stateStore.load(workspaceId)).toEqual(stateBefore);
      expect(f.authStore.read()).toEqual(authBefore);
    } finally { await f.app.close(); }
  });

  it("denies valid proof from another scope and forged actor binding", async () => {
    const f = fixture();
    const otherAuth = new OperatorStepUpService({
      workspaceId: "session-other-workspace-fixture",
      principalId,
      sessionSecret,
      store: {
        read: () => ({
          generation: 1,
          enrolled: true,
          totpPending: false,
          passwordSalt,
          passwordHash: scryptSync(password, Buffer.from(passwordSalt, "base64url"), 32, {
            N: 16384, r: 8, p: 1,
          }).toString("base64url"),
          totpSecret,
        }),
        write: () => undefined,
      },
      now: f.now,
      cookieSecure: false,
    });
    const otherProof = otherAuth.authenticate({ password, totp: totpAt(f.now()) }, "127.0.0.1");
    try {
      const crossScope = await f.app.inject({
        method: "GET",
        url: "/api/cwos/v2/operator-session",
        headers: {
          ...f.headers,
          cookie: otherProof.cookie.split(";")[0] ?? "",
          "x-csrf-token": otherProof.csrf,
        },
      });
      expect(crossScope.statusCode).toBe(403);
      expect(crossScope.json()).toEqual({ error: "OPERATOR_PROOF_SCOPE" });

      const forged = await f.app.inject({
        method: "GET",
        url: "/api/cwos/v2/operator-session",
        headers: { ...f.headers, "x-principal-id": "forged-human-fixture" },
      });
      expect(forged.statusCode).toBe(403);
      expect(forged.json().error).toBe("ACTOR_BINDING_MISMATCH");
      expect(forged.body).not.toContain("forged-human-fixture");
    } finally { await f.app.close(); }
  });

  it("does not register the route without operator authentication or in machine mode", async () => {
    const humanUnconfigured = createApp({
      authApiKey: apiKey,
      customerWorkOsV2Profile: "test",
      customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
    });
    const machine = createApp({
      authApiKey: apiKey,
      customerWorkOsV2Profile: "production",
      customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
      customerWorkOsV2MachineBinding: {
        workspaceId, principalId: "session-machine-fixture", kind: "service", readOnly: true,
      },
    });
    try {
      for (const app of [humanUnconfigured, machine]) {
        const response = await app.inject({
          method: "GET",
          url: "/api/cwos/v2/operator-session",
          headers: { "x-api-key": apiKey },
        });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await machine.close();
      await humanUnconfigured.close();
    }
  });
});
