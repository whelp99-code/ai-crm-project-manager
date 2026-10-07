import { createHmac, scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../api/src/app.js";
import { InMemoryCwosV2StateStore } from "../../api/src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../../api/src/operator-step-up.js";
import type { OperatorAuthRecord } from "../../api/src/operator-auth-store.js";
import { selfEntryConfiguration, submitSelfEntry, verifySelfEntry } from "../app/self-entry-server";

const password = "self-entry-synthetic-password";
const apiKey = "self-entry-synthetic-api-key-at-least-32";
const webOrigin = "https://self-entry-test.invalid";

function fixture() {
  let now = 59_000;
  const salt = Buffer.alloc(16, 3).toString("base64url");
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordSalt: salt,
    passwordHash: scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 }).toString("base64url"),
    totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  };
  const auth = new OperatorStepUpService({
    workspaceId: "self-entry-fixture", principalId: "self-entry-human-fixture",
    sessionSecret: "self-entry-synthetic-signing-secret-at-least-32",
    store: { read: () => structuredClone(record), write: next => { record = structuredClone(next); } },
    now: () => now,
  });
  const app = createApp({
    authApiKey: apiKey, customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: new InMemoryCwosV2StateStore(), customerWorkOsV2OperatorStepUp: auth,
    customerWorkOsV2ActorBinding: { workspaceId: auth.workspaceId, principalId: auth.principalId, kind: "human", stepUpVerified: false },
  });
  const configuration = selfEntryConfiguration({
    NODE_ENV: "production", CRM_SELF_ENTRY_API_ORIGIN: "https://api-self-entry-test.invalid",
    CRM_SELF_ENTRY_WEB_ORIGIN: webOrigin, CRM_SELF_ENTRY_WORKSPACE_ID: auth.workspaceId,
    CRM_SELF_ENTRY_PRINCIPAL_ID: auth.principalId, CRM_SELF_ENTRY_API_KEY: apiKey,
    CRM_SELF_ENTRY_SESSION_MAX_AGE_SECONDS: "300",
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const result = await app.inject({
      method: init?.method === "POST" ? "POST" : "GET", url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    return new Response(result.body, { status: result.statusCode, headers: {
      "content-type": "application/json",
      ...(typeof result.headers["set-cookie"] === "string" ? { "set-cookie": result.headers["set-cookie"] } : {}),
    } });
  };
  const otp = () => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
    const digest = createHmac("sha1", Buffer.from("12345678901234567890")).update(counter).digest();
    const last = digest.at(-1);
    if (last === undefined) throw new RangeError("test digest missing");
    return ((digest.readUInt32BE(last & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  };
  return { app, configuration, transport, otp, advance: (ms: number) => { now += ms; } };
}

function request(inputPassword: string, totp: string, origin = webOrigin) {
  return new Request(`${webOrigin}/api/self-entry`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: inputPassword, totp }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("self-entry transport using the real maintained authentication service", () => {
  it("issues the existing HttpOnly scoped proof and admits protected verification", async () => {
    const f = fixture();
    try {
      const result = await submitSelfEntry(request(password, f.otp()), f.configuration, f.transport);
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ authenticated: true });
      const cookie = result.headers.get("set-cookie");
      expect(cookie).toContain("Path=/; HttpOnly; SameSite=Strict; Max-Age=300; Secure");
      expect(result.headers.get("cache-control")).toBe("no-store");
      const protectedResult = await verifySelfEntry(cookie ?? "", f.configuration, f.transport);
      expect(protectedResult.status).toBe(200);
      expect(await protectedResult.json()).toEqual({ authenticated: true });
    } finally { await f.app.close(); }
  });

  it.each(["password", "otp"])("rejects an incorrect %s without issuing a session", async kind => {
    const f = fixture();
    try {
      const result = await submitSelfEntry(request(kind === "password" ? "wrong-synthetic-password" : password,
        kind === "otp" ? "000000" : f.otp()), f.configuration, f.transport);
      expect(result.status).toBe(401);
      expect(await result.json()).toEqual({ error: "OPERATOR_UNAUTHENTICATED" });
      expect(result.headers.get("set-cookie")).toBeNull();
    } finally { await f.app.close(); }
  });

  it("rejects a reused OTP using the existing consumption policy", async () => {
    const f = fixture();
    try {
      expect((await submitSelfEntry(request(password, f.otp()), f.configuration, f.transport)).status).toBe(200);
      const repeated = await submitSelfEntry(request(password, f.otp()), f.configuration, f.transport);
      expect(repeated.status).toBe(401);
      expect(await repeated.json()).toEqual({ error: "OPERATOR_TOTP_REPLAY" });
      expect(repeated.headers.get("set-cookie")).toBeNull();
    } finally { await f.app.close(); }
  });

  it("preserves lockout without sleeps or a new authentication policy", async () => {
    const f = fixture();
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect((await submitSelfEntry(request("wrong-synthetic-password", f.otp()), f.configuration, f.transport)).status).toBe(401);
      }
      const locked = await submitSelfEntry(request(password, f.otp()), f.configuration, f.transport);
      expect(locked.status).toBe(429);
      expect(await locked.json()).toEqual({ error: "OPERATOR_RATE_LIMITED" });
    } finally { await f.app.close(); }
  });

  it("refuses protected access at the exact proof expiry", async () => {
    const f = fixture();
    try {
      const login = await submitSelfEntry(request(password, f.otp()), f.configuration, f.transport);
      f.advance(300_000);
      const expired = await verifySelfEntry(login.headers.get("set-cookie") ?? "", f.configuration, f.transport);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toEqual({ error: "OPERATOR_PROOF_EXPIRED" });
    } finally { await f.app.close(); }
  });

  it("blocks unconfigured, malformed configuration and untrusted origins before transport", async () => {
    const transport = vi.fn<typeof fetch>();
    const missing = selfEntryConfiguration({});
    expect(missing.ready).toBe(false);
    expect((await submitSelfEntry(request(password, "000000"), missing, transport)).status).toBe(503);
    expect((await verifySelfEntry("", missing, transport)).status).toBe(503);
    expect(selfEntryConfiguration({
      NODE_ENV: "production", CRM_SELF_ENTRY_API_ORIGIN: "http://127.0.0.1:1",
      CRM_SELF_ENTRY_WEB_ORIGIN: webOrigin, CRM_SELF_ENTRY_WORKSPACE_ID: "fixture",
      CRM_SELF_ENTRY_PRINCIPAL_ID: "fixture", CRM_SELF_ENTRY_API_KEY: apiKey,
      CRM_SELF_ENTRY_SESSION_MAX_AGE_SECONDS: "300",
    }).ready).toBe(false);
    const f = fixture();
    try {
      expect((await submitSelfEntry(request(password, "000000", "https://untrusted-test.invalid"), f.configuration, transport)).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    } finally { await f.app.close(); }
  });

  it("keeps credential sentinels out of denial responses and logs, even for hostile upstream bodies/errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    try {
      const hostile: typeof fetch = async () => Response.json({ error: password, password, totp: "000000" }, { status: 401 });
      const denied = await submitSelfEntry(request(password, "000000"), f.configuration, hostile);
      expect(await denied.json()).toEqual({ error: "AUTHENTICATION_FAILED" });
      const failing: typeof fetch = async () => { throw new Error(password + "000000" + apiKey); };
      const unavailable = await submitSelfEntry(request(password, "000000"), f.configuration, failing);
      expect(await unavailable.json()).toEqual({ error: "AUTHENTICATION_UNAVAILABLE" });
      const logs = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
      expect(logs).not.toContain(password);
      expect(logs).not.toContain("000000");
      expect(logs).not.toContain(apiKey);
    } finally { await f.app.close(); }
  });

  it("does not follow redirects or return attacker cookies", async () => {
    const f = fixture();
    try {
      let policy: RequestRedirect | undefined;
      const transport: typeof fetch = async (_input, init) => {
        policy = init?.redirect;
        return new Response(null, { status: 302, headers: {
          location: "https://untrusted-test.invalid/", "set-cookie": "attacker=value",
        } });
      };
      const denied = await submitSelfEntry(request(password, f.otp()), f.configuration, transport);
      expect(policy).toBe("manual");
      expect(denied.status).toBe(502);
      expect(denied.headers.get("set-cookie")).toBeNull();
    } finally { await f.app.close(); }
  });
});
