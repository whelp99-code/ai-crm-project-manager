import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";
import { loginDisabledLoopbackRead } from "../src/login-disabled.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import type { OperatorAuthRecord, OperatorAuthStore } from "../src/operator-auth-store.js";
import { operatorPasswordHash } from "../src/operator-auth-crypto.js";

const workspaceId = "workspace-login-disabled";
const principalId = "human-login-disabled";
const key = "isolated-login-disabled-api-key-32-chars";
const password = "isolated-login-disabled-password";
const passwordHash = operatorPasswordHash(password);
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const sessionSecret = "isolated-login-disabled-session-secret-32";

function codeAt(now: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
  const last = hmac.at(-1);
  if (last === undefined) throw new RangeError("invalid test digest");
  return ((hmac.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function fixture() {
  const now = 59_000;
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordHash, totpSecret: secret,
  };
  const authStore: OperatorAuthStore = {
    read: () => structuredClone(record),
    write: next => { record = structuredClone(next); },
  };
  const auth = new OperatorStepUpService({
    workspaceId, principalId, sessionSecret, store: authStore, now: () => now, cookieSecure: false,
  });
  const app = createApp({
    authApiKey: key, customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: new InMemoryCwosV2StateStore(), customerWorkOsV2OperatorStepUp: auth,
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
  });
  const headers = {
    "x-api-key": key, "x-workspace-id": workspaceId,
    "x-principal-id": principalId, "x-principal-kind": "human",
  };
  return { app, auth, headers, now };
}

async function admit(f: ReturnType<typeof fixture>) {
  const login = await f.app.inject({
    method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
    payload: { password, totp: codeAt(f.now) },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  if (typeof setCookie !== "string") throw new TypeError("fixture proof required");
  const csrf = login.json<{ csrf: string }>().csrf;
  return { ...f.headers, cookie: setCookie.split(";")[0] ?? "", "x-csrf-token": csrf };
}

describe("login-disabled loopback reads", () => {
  const previous = process.env.CWOS_LOGIN_DISABLED;
  afterEach(() => {
    if (previous === undefined) delete process.env.CWOS_LOGIN_DISABLED;
    else process.env.CWOS_LOGIN_DISABLED = previous;
  });

  it("does not invent an owner or treat a forwarded address as loopback", () => {
    expect(loginDisabledLoopbackRead({
      flag: "1", method: "GET", peerAddress: "127.0.0.1", binding: undefined,
    })).toBe(false);
    expect(loginDisabledLoopbackRead({
      flag: "1", method: "GET", peerAddress: "203.0.113.9",
      binding: { workspaceId, principalId, kind: "human" },
    })).toBe(false);
    expect(loginDisabledLoopbackRead({
      flag: "0", method: "GET", peerAddress: "127.0.0.1",
      binding: { workspaceId, principalId, kind: "human" },
    })).toBe(false);
  });

  it("allows a bound loopback read and still rejects spoofed principals, mutations, and public peers", async () => {
    process.env.CWOS_LOGIN_DISABLED = "1";
    const f = fixture();
    try {
      const proof = await admit(f);
      const joined = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof, "idempotency-key": "login-disabled-membership" },
        payload: {
          command: "identity.registerPrincipal", expectedVersion: 0,
          payload: { id: principalId, kind: "human", displayName: "Bound owner", active: true },
        },
      });
      expect(joined.statusCode).toBe(200);
      const member = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...proof, "idempotency-key": "login-disabled-member" },
        payload: {
          command: "identity.addMembership", expectedVersion: 1,
          payload: { id: "owner-membership", principalId },
        },
      });
      expect(member.statusCode).toBe(200);

      const read = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/company-overview", headers: f.headers,
      });
      expect(read.statusCode).toBe(200);
      expect(JSON.stringify(read.json())).not.toContain(password);

      const spoof = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/company-overview",
        headers: { ...f.headers, "x-principal-id": "spoof" },
      });
      expect(spoof.statusCode).toBe(403);
      expect(spoof.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });

      const mutate = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/commands", headers: { ...f.headers, "idempotency-key": "login-disabled-write" },
        payload: { command: "identity.registerPrincipal", expectedVersion: 2, payload: { id: "other", kind: "human", displayName: "Other", active: true } },
      });
      expect(mutate.statusCode).toBe(403);
      expect(mutate.json()).toEqual({ error: "STEP_UP_REQUIRED" });

      const amount = await f.app.inject({
        method: "POST", url: "/api/cwos/v2/document-drafts",
        headers: { ...f.headers, "idempotency-key": "login-disabled-amount" },
        payload: { action: "QUOTE", expectedVersion: 2, input: { unitPriceKrw: "1" } },
      });
      expect(amount.statusCode).toBe(403);
      expect(amount.json()).toEqual({ error: "STEP_UP_REQUIRED" });

      const approval = await f.app.inject({
        method: "POST", url: "/api/governance/controls/missing/decide",
        headers: { ...f.headers, "x-workspace-id": workspaceId },
        payload: { decision: "APPROVE", principalId },
      });
      expect(approval.statusCode).toBeGreaterThanOrEqual(400);

      const remote = await f.app.inject({
        method: "GET", url: "/api/cwos/v2/company-overview", headers: {
          ...f.headers, "x-forwarded-for": "127.0.0.1",
        }, remoteAddress: "203.0.113.9",
      });
      expect(remote.statusCode).toBe(403);
      expect(remote.json()).toEqual({ error: "STEP_UP_REQUIRED" });
    } finally {
      await f.app.close();
    }
  });

  it("keeps password proof required when the flag is unset", async () => {
    delete process.env.CWOS_LOGIN_DISABLED;
    const f = fixture();
    try {
      const denied = await f.app.inject({ method: "GET", url: "/api/cwos/v2/company-overview", headers: f.headers });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "STEP_UP_REQUIRED" });
    } finally {
      await f.app.close();
    }
  });
});
