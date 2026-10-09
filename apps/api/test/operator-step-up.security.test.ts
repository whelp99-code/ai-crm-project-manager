import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord, OperatorAuthStore } from "../src/operator-auth-store.js";
import { operatorPasswordHash } from "../src/operator-auth-crypto.js";

const workspaceId = "workspace-step-up-fixture";
const principalId = "human-step-up-fixture";
const key = "isolated-human-api-key-at-least-32-chars";
const password = "isolated-human-password";
const passwordHash = operatorPasswordHash(password);
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const sessionSecret = "isolated-session-signature-secret-at-least-32-chars";

/** Independent RFC6238 test oracle, not the production code generator. */
function codeAt(now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const last = hmac.at(-1);
  if (last === undefined) throw new RangeError("invalid test digest");
  return ((hmac.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function fixture(scope = workspaceId) {
  let now = 59_000;
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordHash,
    totpSecret: secret,
  };
  const authStore: OperatorAuthStore = {
    read: () => structuredClone(record),
    write: next => { record = structuredClone(next); },
  };
  const auth = new OperatorStepUpService({
    workspaceId: scope, principalId, sessionSecret, store: authStore,
    now: () => now, cookieSecure: false,
  });
  const store = new InMemoryCwosV2StateStore();
  const headers = {
    "x-api-key": key, "x-workspace-id": scope,
    "x-principal-id": principalId, "x-principal-kind": "human",
  };
  const app = createApp({
    authApiKey: key, customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: store, customerWorkOsV2OperatorStepUp: auth,
    customerWorkOsV2ActorBinding: { workspaceId: scope, principalId, kind: "human", stepUpVerified: false },
  });
  return {
    app, auth, store, authStore, headers,
    time: () => now, advance: (milliseconds: number) => { now += milliseconds; },
  };
}

async function stepUp(f: ReturnType<typeof fixture>) {
  const response = await f.app.inject({
    method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
    payload: { password, totp: codeAt(f.time()) },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  expect(typeof setCookie).toBe("string");
  if (typeof setCookie !== "string") throw new TypeError("test requires one scoped cookie");
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new TypeError("test requires a proof token");
  const body: { csrf: string; expiresAt: string } = response.json();
  return { headers: { ...f.headers, cookie, "x-csrf-token": body.csrf }, setCookie };
}

function bootstrapPayload() {
  return {
    command: "identity.registerPrincipal", expectedVersion: 0,
    payload: { id: principalId, kind: "human", displayName: "Isolated owner", active: true },
  };
}

describe("production human password/TOTP step-up", () => {
  it.each([
    { name: "wrong password", password: "wrong-password", totp: "287082" },
    { name: "wrong OTP", password, totp: "000000" },
  ])("refuses $name without native mutation", async ({ password, totp }) => {
    const f = fixture();
    try {
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers, payload: { password, totp },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "OPERATOR_UNAUTHENTICATED" });
      expect(denied.headers["set-cookie"]).toBeUndefined();
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("issues a scoped HttpOnly cookie from a real RFC password/TOTP verification", async () => {
    const f = fixture();
    try {
      const proof = await stepUp(f);
      expect(proof.setCookie).toContain("HttpOnly");
      expect(proof.setCookie).toContain("SameSite=Strict");
      expect(f.authStore.read()).toMatchObject({ generation: 2, lastTotpStep: 1 });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("derives step-up from the request proof rather than a false server flag", async () => {
    const f = fixture();
    try {
      const proof = await stepUp(f);
      const response = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof.headers, "idempotency-key": "auth-bootstrap" }, payload: bootstrapPayload(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ runtimeVersion: 1 });
    } finally { await f.app.close(); }
  });

  it("refuses repeated TOTP without changing native state or issuing another cookie", async () => {
    const f = fixture();
    try {
      await stepUp(f);
      const response = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
        payload: { password, totp: codeAt(f.time()) },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "OPERATOR_TOTP_REPLAY" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("revokes an old proof generation after fresh human authentication", async () => {
    const f = fixture();
    try {
      const first = await stepUp(f);
      f.advance(30_000);
      await stepUp(f);
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...first.headers, "idempotency-key": "old-proof" }, payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "OPERATOR_PROOF_EXPIRED" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("refuses proof at its exact expiry without a timing sleep", async () => {
    const f = fixture();
    try {
      const proof = await stepUp(f);
      f.advance(300_000);
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof.headers, "idempotency-key": "expired-proof" }, payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "OPERATOR_PROOF_EXPIRED" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it.each(["", "wrong-csrf"])("refuses mutation with invalid CSRF: %s", async csrf => {
    const f = fixture();
    try {
      const proof = await stepUp(f);
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof.headers, "x-csrf-token": csrf, "idempotency-key": "csrf-denial" },
        payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "OPERATOR_CSRF" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("refuses a validly signed proof from another native workspace", async () => {
    const f = fixture();
    const peer = fixture("another-workspace");
    try {
      const proof = await stepUp(peer);
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof.headers, ...f.headers, "idempotency-key": "cross-scope" }, payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "OPERATOR_PROOF_SCOPE" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await peer.app.close(); await f.app.close(); }
  });

  it("does not turn a configured global true flag into production authority", async () => {
    const f = fixture();
    const app = createApp({
      authApiKey: key, customerWorkOsV2Profile: "production", customerWorkOsV2Store: f.store,
      customerWorkOsV2OperatorStepUp: f.auth,
      customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: true },
    });
    try {
      const denied = await app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...f.headers, "idempotency-key": "global-flag" }, payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "STEP_UP_REQUIRED" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await app.close(); await f.app.close(); }
  });

  it("refuses production human boot without the authentication mechanism", () => {
    expect(() => createApp({
      authApiKey: key, customerWorkOsV2Profile: "production",
      customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
      customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: true },
    })).toThrowError(/CWOS_V2_OPERATOR_AUTH_REQUIRED/);
  });

  it("never gives a machine composition the human step-up endpoint", async () => {
    const app = createApp({
      authApiKey: key, customerWorkOsV2Profile: "production",
      customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
      customerWorkOsV2MachineBinding: { workspaceId, principalId: "reader", kind: "service", readOnly: true },
    });
    try {
      const denied = await app.inject({
        method: "POST", url: "/api/cwos/v2/operator-step-up",
        headers: { "x-api-key": key, "x-workspace-id": workspaceId,
          "x-principal-id": "reader", "x-principal-kind": "service" },
        payload: { password, totp: "287082" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "MACHINE_READ_ONLY" });
    } finally { await app.close(); }
  });

  it("rejects a tampered signed cookie before native mutation", async () => {
    const f = fixture();
    try {
      const proof = await stepUp(f);
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof.headers, cookie: `${proof.headers.cookie}x`, "idempotency-key": "tampered-proof" },
        payload: bootstrapPayload(),
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: "OPERATOR_PROOF_INVALID" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("persists rate lockout and refuses the next valid credential attempt", async () => {
    const f = fixture();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const denied = await f.app.inject({
          method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
          payload: { password: "wrong-password", totp: codeAt(f.time()) },
        });
        expect(denied.statusCode).toBe(401);
      }
      expect(f.authStore.read().rate).toMatchObject({ failures: 10, lockoutUntil: f.time() + 900_000 });
      const denied = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
        payload: { password, totp: codeAt(f.time()) },
      });
      expect(denied.statusCode).toBe(429);
      expect(denied.json()).toEqual({ error: "OPERATOR_RATE_LIMITED" });
      expect(await f.store.load(workspaceId)).toBeUndefined();
    } finally { await f.app.close(); }
  });

  it("retains consumed TOTP and proof revocation across a new service instance", () => {
    const f = fixture();
    const proof = f.auth.authenticate({ password, totp: codeAt(f.time()) }, "127.0.0.1");
    const second = new OperatorStepUpService({
      workspaceId, principalId, sessionSecret, store: f.authStore, now: f.time, cookieSecure: false,
    });
    expect(() => second.authenticate({ password, totp: codeAt(f.time()) }, "127.0.0.1"))
      .toThrowError("OPERATOR_TOTP_REPLAY");
    expect(second.authorize({
      cookieHeader: proof.cookie.split(";")[0], csrfHeader: proof.csrf, method: "POST",
    })).toBe(true);
    return f.app.close();
  });
});
