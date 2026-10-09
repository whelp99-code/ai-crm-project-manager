import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createApp } from "../../api/src/app.js";
import { InMemoryCwosV2StateStore } from "../../api/src/customer-work-os-v2-runtime.js";
import { operatorPasswordHash } from "../../api/src/operator-auth-crypto.js";
import type { OperatorAuthRecord } from "../../api/src/operator-auth-store.js";
import { OperatorStepUpService } from "../../api/src/operator-step-up.js";
import { logoutSelfEntry, selfEntryConfiguration, submitSelfEntry, verifySelfEntry } from "../app/self-entry-server";
import { middleware } from "../middleware";
import { GET as sessionDetails } from "../app/api/self-entry/route";

const password = "synthetic-web-login-password";
const passwordHash = operatorPasswordHash(password);
const webOrigin = "https://crm.example.test";
const key = "synthetic-api-key-at-least-32-characters";
const workspaceId = "login-workspace";
const principalId = "login-owner";
const proxySecret = "synthetic-authenticated-proxy-key-at-least-32-characters";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture() {
  let now = 59_000;
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordHash,
    totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  };
  const auth = new OperatorStepUpService({
    workspaceId, principalId, sessionSecret: "synthetic-web-session-secret-at-least-32-characters",
    store: { read: () => structuredClone(record), write: next => { record = structuredClone(next); } },
    now: () => now, cookieSecure: false,
    proxySecret,
  });
  const app = createApp({
    authApiKey: key, customerWorkOsV2Profile: "production",
    customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
    customerWorkOsV2OperatorStepUp: auth,
  });
  cleanups.push(() => app.close());
  const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = {
    API_BASE_URL: apiOrigin, CRM_WEB_ORIGIN: webOrigin, WORKSPACE_ID: workspaceId,
    OPERATOR_PRINCIPAL_ID: principalId, AUTH_API_KEY: key, NODE_ENV: "test",
    CWOS_V2_OPERATOR_PROXY_SECRET: proxySecret,
  };
  for (const [name, value] of Object.entries(source)) vi.stubEnv(name, value);
  const config = selfEntryConfiguration(source);
  const request = (factors: unknown, origin = webOrigin) => new Request(`${webOrigin}/api/self-entry`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(factors),
  });
  const cookieOf = (response: Response) => response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  return { config, request, cookieOf, app, advance: () => { now += 30_000; },
    state: () => structuredClone(record) };
}

describe("CRM-owned web authentication against the real API", () => {
  it("admits a new HttpOnly session to protected CRM pages and returns no credentials", async () => {
    const f = await fixture();
    const login = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ authenticated: true });
    const setCookie = login.headers.getSetCookie()[0] ?? "";
    expect(setCookie).toContain("Path=/; HttpOnly; SameSite=Strict; Max-Age=300");
    expect(setCookie).not.toContain(password);
    expect(setCookie).not.toContain(f.state().totpSecret);
    const admitted = await middleware(new NextRequest(`${webOrigin}/v2/mail-candidate-review`,
      { headers: { cookie: f.cookieOf(login) } }));
    expect(admitted.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects an anonymous CRM page and denies an anonymous web API", async () => {
    await fixture();
    const page = await middleware(new NextRequest(`${webOrigin}/work`));
    const api = await middleware(new NextRequest(`${webOrigin}/api/cwos/v2/mail-candidate-review`));
    expect(page.headers.get("location")).toContain("/login");
    expect(page.headers.get("location")).not.toContain("state=expired");
    expect(api.status).toBe(401);
  });

  it.each([
    { name: "wrong password", factors: { password: "incorrect", totp: "287082" } },
    { name: "wrong OTP", factors: { password, totp: "000000" } },
  ])("rejects $name without a browser session", async ({ factors }) => {
    const f = await fixture();
    const denied = await submitSelfEntry(f.request(factors), f.config);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(await denied.json()).toEqual({ error: "OPERATOR_UNAUTHENTICATED" });
  });

  it("rejects cross-origin login before consuming a valid code", async () => {
    const f = await fixture();
    const denied = await submitSelfEntry(f.request({ password, totp: "287082" }, "https://evil.example.test"), f.config);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(f.state().generation).toBe(1);
  });

  it("rejects simultaneous reuse of an accepted code", async () => {
    const f = await fixture();
    const attempts = await Promise.all([1, 2].map(() =>
      submitSelfEntry(f.request({ password, totp: "287082" }), f.config)));
    expect(attempts.map(response => response.status).sort()).toEqual([200, 401]);
    expect(attempts.filter(response => response.headers.has("set-cookie"))).toHaveLength(1);
  });

  it("replaces the old generation and removes an imported narrow-path cookie", async () => {
    const f = await fixture();
    const first = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    f.advance();
    const second = await submitSelfEntry(f.request({ password, totp: "359152" }), f.config);
    expect(second.status).toBe(200);
    expect(second.headers.getSetCookie()[1]).toContain("Path=/api/cwos/v2");
    expect(second.headers.getSetCookie()[1]).toContain("Max-Age=0");
    expect((await verifySelfEntry(f.cookieOf(first), f.config)).status).toBe(401);
    expect((await verifySelfEntry(f.cookieOf(second), f.config)).status).toBe(200);
  });

  it("returns CSRF only after real signature verification without exposing the proof", async () => {
    const f = await fixture();
    const login = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    const result = await sessionDetails(new Request(`${webOrigin}/api/self-entry`,
      { headers: { cookie: f.cookieOf(login) } }));
    const body: unknown = await result.json();
    expect(result.status).toBe(200);
    expect(body).toMatchObject({ csrf: expect.any(String), expiresAt: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain(f.cookieOf(login));
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a valid owner login available after hostile web attempts", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await submitSelfEntry(f.request({ password: "incorrect", totp: "287082" }), f.config)).status).toBe(401);
    }
    const blocked = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get("set-cookie")).not.toBeNull();
  });

  it("accepts only authenticated gateway addresses across the Next proxy", async () => {
    const f = await fixture();
    for (const address of ["192.0.2.1", "192.0.2.2"]) {
      const request = f.request({ password: "incorrect", totp: "287082" });
      request.headers.set("x-cwos-client-ip", address);
      request.headers.set("x-cwos-client-token", proxySecret);
      expect((await submitSelfEntry(request, f.config)).status).toBe(401);
    }
    const forged = f.request({ password: "incorrect", totp: "287082" });
    forged.headers.set("x-forwarded-for", "192.0.2.3");
    forged.headers.set("x-cwos-client-ip", "192.0.2.3");
    forged.headers.set("x-cwos-client-token", "forged");
    expect((await submitSelfEntry(forged, f.config)).status).toBe(401);
    expect(Object.keys(f.state().rate?.perIp ?? {}).sort())
      .toEqual(["192.0.2.1", "192.0.2.2", "unknown"]);
  });

  it("denies a missing Origin and revokes logout cookies without accepting stale proof", async () => {
    const f = await fixture();
    const noOrigin = f.request({ password, totp: "287082" });
    noOrigin.headers.delete("origin");
    expect((await submitSelfEntry(noOrigin, f.config)).status).toBe(403);
    const login = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    const cookie = f.cookieOf(login);
    const details = await sessionDetails(new Request(`${webOrigin}/api/self-entry`, { headers: { cookie } }));
    const body: unknown = await details.json();
    if (body === null || typeof body !== "object" || !("csrf" in body) || typeof body.csrf !== "string") {
      throw new TypeError("session details must expose the authenticated CSRF token");
    }
    const generation = f.state().generation;
    const denied = await logoutSelfEntry(new Request(`${webOrigin}/api/self-entry/logout`, {
      method: "POST", headers: { cookie, "x-csrf-token": body.csrf },
    }), f.config);
    expect(denied.status).toBe(403);
    expect(f.state().generation).toBe(generation);
    const logout = await logoutSelfEntry(new Request(`${webOrigin}/api/self-entry/logout`, {
      method: "POST", headers: { origin: webOrigin, cookie, "x-csrf-token": body.csrf },
    }), f.config);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.state().generation).toBe(generation + 1);
    expect((await verifySelfEntry(cookie, f.config)).status).toBe(401);
  });

  it("rejects spoofed session scope with a valid signature", async () => {
    const f = await fixture();
    const login = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config);
    const result = await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session",
      headers: { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": "spoof",
        "x-principal-kind": "human", cookie: f.cookieOf(login) } });
    expect(result.statusCode).toBe(403);
  });

  it("fails closed when configuration is missing or production origin is insecure", () => {
    expect(selfEntryConfiguration({}).ready).toBe(false);
    expect(selfEntryConfiguration({
      API_BASE_URL: "http://127.0.0.1:1", CRM_WEB_ORIGIN: webOrigin,
      WORKSPACE_ID: workspaceId, OPERATOR_PRINCIPAL_ID: principalId, AUTH_API_KEY: key,
      NODE_ENV: "production",
    }).ready).toBe(false);
  });

  it("returns only a fixed denial for a transport error containing synthetic credentials", async () => {
    const f = await fixture();
    const failure: typeof fetch = async () => { throw new TypeError(password); };
    const result = await submitSelfEntry(f.request({ password, totp: "287082" }), f.config, failure);
    expect(await result.json()).toEqual({ error: "AUTHENTICATION_UNAVAILABLE" });
    expect(result.headers.get("set-cookie")).toBeNull();
  });
});
