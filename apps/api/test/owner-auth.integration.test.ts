import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { LoginRateLimit, MemoryOwnerStore, totpCode } from "@ai-crm/owner-auth";
import { createApp } from "../src/app.js";

const SECRET = "integration-session-secret-32chars";
let app: FastifyInstance | undefined;
let now = 1_700_000_000_000;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(): Promise<{ api: FastifyInstance; store: MemoryOwnerStore }> {
  const store = new MemoryOwnerStore();
  const api = createApp({
    ownerAuth: {
      enabled: true,
      store,
      sessionSecret: SECRET,
      now: () => now,
      sessionTtlMs: 5_000,
      cookieSecure: true,
    },
  });
  app = api;
  await api.ready();
  return { api, store };
}

describe("owner session gate", () => {
  it("allows /health and rejects other routes without a session", async () => {
    const { api } = await boot();
    expect((await api.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const denied = await api.inject({ method: "GET", url: "/api/customers" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ error: "UNAUTHENTICATED" });
  });

  it("enrolls once, then enforces CSRF, expiry, and login rate limit", async () => {
    now = 1_700_000_000_000;
    const store = new MemoryOwnerStore();
    const rateLimit = new LoginRateLimit(2, 60_000, () => now);
    const { OwnerAuthService } = await import("@ai-crm/owner-auth");
    const service = new OwnerAuthService(store, {
      sessionSecret: SECRET,
      now: () => now,
      sessionTtlMs: 5_000,
      cookieSecure: true,
      rateLimit,
    });
    const api = createApp({ ownerAuth: { enabled: true, service, cookieSecure: true } });
    app = api;
    await api.ready();

    const issued = service.issueEnrollmentCode();
    const enroll = await api.inject({
      method: "POST",
      url: "/api/auth/enroll",
      payload: { code: issued.code, password: "correct horse battery" },
    });
    expect(enroll.statusCode).toBe(200);
    const secret = new URL(enroll.json().otpauth).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const confirm = await api.inject({
      method: "POST",
      url: "/api/auth/enroll/confirm",
      payload: { totp: totpCode(secret!, now) },
    });
    expect(confirm.statusCode).toBe(200);
    now += 30_000;

    const login = await api.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "correct horse battery", totp: totpCode(secret!, now) },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const joined = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie);
    expect(joined).toContain("HttpOnly");
    expect(joined).toContain("SameSite=Strict");
    expect(joined).toContain("Secure");
    const token = /core5_owner=([^;]+)/.exec(joined)?.[1];
    const csrf = /core5_csrf=([^;]+)/.exec(joined)?.[1];

    const noCsrf = await api.inject({
      method: "POST",
      url: "/api/customers",
      headers: { cookie: `core5_owner=${token}` },
      payload: { id: "c1", name: "A", status: "active", createdAt: "2026-01-01T00:00:00Z" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: "CSRF" });

    const withCsrf = await api.inject({
      method: "GET",
      url: "/api/customers",
      headers: { cookie: `core5_owner=${token}`, "x-csrf-token": csrf ?? "", "x-workspace-id": "ws-owner" },
    });
    expect(withCsrf.statusCode).not.toBe(401);
    expect(withCsrf.statusCode).not.toBe(403);

    now += 5_000;
    const expired = await api.inject({
      method: "GET",
      url: "/api/customers",
      headers: { cookie: `core5_owner=${token}` },
    });
    expect(expired.statusCode).toBe(401);

    now = 1_700_000_000_000;
    expect((await api.inject({ method: "POST", url: "/api/auth/login", payload: { password: "wrong-password-xx", totp: "000000" } })).statusCode).toBe(401);
    const limited = await api.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "wrong-password-xx", totp: "000000" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "RATE_LIMITED" });
  });
});
