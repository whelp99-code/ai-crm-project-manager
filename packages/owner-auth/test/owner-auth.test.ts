import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LoginRateLimit,
  MemoryOwnerStore,
  OwnerAuthService,
  clientIp,
  cookieFlags,
  webLoginPeer,
  pageAllows,
  signSession,
  totpCode,
} from "../src/index.js";
import { pageAllowsEdge, sessionTokenActive } from "../src/page-gate.js";
import { pageSessionAllows } from "../src/page-session.js";

const SECRET = "test-session-secret-32chars-minimum";

function enrolled(now: number) {
  let clock = now - 30_000;
  const store = new MemoryOwnerStore();
  const limit = new LoginRateLimit(3, 60_000, () => clock);
  const service = new OwnerAuthService(store, {
    sessionSecret: SECRET,
    now: () => clock,
    sessionTtlMs: 5_000,
    cookieSecure: true,
    rateLimit: limit,
  });
  const issued = service.issueEnrollmentCode();
  const enrolledResult = service.enroll(issued.code, "correct horse battery", "10.0.0.1");
  if (!enrolledResult.ok) throw new Error(enrolledResult.error);
  const secret = new URL(enrolledResult.otpauth).searchParams.get("secret");
  if (!secret) throw new Error("missing totp");
  const confirmed = service.confirmTotp(totpCode(secret, clock), "10.0.0.1");
  if (!confirmed.ok) throw new Error(confirmed.error);
  clock = now;
  return {
    service,
    secret,
    store,
    setNow(next: number) {
      clock = next;
    },
  };
}

describe("owner auth", () => {
  it("rejects api use without a session and allows /health path policy", () => {
    expect(pageAllows({ enabled: true, pathname: "/health", token: undefined, secret: SECRET, nowMs: 1 })).toBe(true);
    expect(pageAllows({ enabled: true, pathname: "/accounts", token: undefined, secret: SECRET, nowMs: 1 })).toBe(false);
    expect(pageAllows({ enabled: false, pathname: "/accounts", token: undefined, secret: undefined, nowMs: 1 })).toBe(true);
  });

  it("sets HttpOnly SameSite=Strict Secure cookies and expires the session", async () => {
    const start = 1_700_000_000_000;
    const ctx = enrolled(start);
    const login = ctx.service.login("correct horse battery", totpCode(ctx.secret, start), "10.0.0.2");
    if (!login.ok) throw new Error(login.error);
    expect(login.setCookie[0]).toContain("HttpOnly");
    expect(login.setCookie[0]).toContain("SameSite=Strict");
    expect(login.setCookie[0]).toContain("Secure");
    expect(login.setCookie[1]).toContain("SameSite=Strict");
    expect(login.setCookie[1]).not.toContain("HttpOnly");
    const token = login.setCookie[0]?.split(";")[0]?.split("=")[1];
    const ok = ctx.service.authorize({ cookieHeader: `core5_owner=${token}`, method: "GET", csrfHeader: undefined });
    expect(ok.ok).toBe(true);
    ctx.setNow(start + 5_000);
    const expired = ctx.service.authorize({ cookieHeader: `core5_owner=${token}`, method: "GET", csrfHeader: undefined });
    expect(expired).toMatchObject({ ok: false, status: 401 });
    expect(pageAllows({ enabled: true, pathname: "/accounts", token, secret: SECRET, nowMs: start + 5_000 })).toBe(false);
    expect(await sessionTokenActive(token ?? "", SECRET, start, 2)).toBe(true);
    expect(await sessionTokenActive(token ?? "", SECRET, start + 5_000, 2)).toBe(false);
  });

  it("requires CSRF on mutations and rate-limits login", () => {
    const start = 1_700_000_000_000;
    const ctx = enrolled(start);
    const login = ctx.service.login("correct horse battery", totpCode(ctx.secret, start), "10.0.0.3");
    if (!login.ok) throw new Error(login.error);
    const token = login.setCookie[0]?.split(";")[0]?.split("=")[1];
    const missing = ctx.service.authorize({ cookieHeader: `core5_owner=${token}`, method: "POST", csrfHeader: undefined });
    expect(missing).toMatchObject({ ok: false, status: 403, error: "CSRF" });
    const wrong = ctx.service.authorize({ cookieHeader: `core5_owner=${token}`, method: "POST", csrfHeader: "nope" });
    expect(wrong).toMatchObject({ status: 403 });
    const ok = ctx.service.authorize({ cookieHeader: `core5_owner=${token}`, method: "POST", csrfHeader: login.csrf });
    expect(ok.ok).toBe(true);

    expect(ctx.service.login("nope", "000000", "10.1.0.9")).toMatchObject({ status: 401 });
    expect(ctx.service.login("nope", "000000", "10.1.0.9")).toMatchObject({ status: 401 });
    expect(ctx.service.login("nope", "000000", "10.1.0.9")).toMatchObject({ status: 401 });
    expect(ctx.service.login("nope", "000000", "10.1.0.9")).toMatchObject({ status: 429, error: "RATE_LIMITED" });
  });

  it("does not accept a default password and burns the enrollment code", () => {
    const store = new MemoryOwnerStore();
    const service = new OwnerAuthService(store, { sessionSecret: SECRET, now: () => 10 });
    const issued = service.issueEnrollmentCode();
    expect(service.enroll(issued.code, "short", "1")).toMatchObject({ error: "PASSWORD_REJECTED" });
    const first = service.enroll(issued.code, "long-enough-password", "1");
    expect(first.ok).toBe(true);
    expect(service.enroll(issued.code, "long-enough-password", "1")).toMatchObject({ error: "ENROLL_CODE_INVALID" });
    expect(cookieFlags({ secure: false, httpOnly: true, maxAgeSec: 1 })).not.toContain("Secure");
    expect(signSession({ exp: 1, csrf: "c", gen: 1 }, SECRET).startsWith("v1.")).toBe(true);
  });

  it("rejects a replayed TOTP step", () => {
    const start = 1_700_000_000_000;
    const ctx = enrolled(start);
    const code = totpCode(ctx.secret, start);
    expect(ctx.service.login("correct horse battery", code, "10.9.0.1").ok).toBe(true);
    expect(ctx.service.login("correct horse battery", code, "10.9.0.2")).toMatchObject({ error: "TOTP_REPLAY" });
  });

  it("does not let a spoofed X-Forwarded-For rotate the bucket, and lockout survives a new service", () => {
    const globalStore = new MemoryOwnerStore();
    const globalSvc = new OwnerAuthService(globalStore, {
      sessionSecret: SECRET,
      now: () => 5_000,
      windowLimit: 2,
      windowMs: 60_000,
      lockoutFailures: 100,
      lockoutMs: 15 * 60_000,
    });
    expect(globalSvc.login("x", "000000", "1.1.1.1")).toMatchObject({ status: 401 });
    expect(globalSvc.login("x", "000000", "2.2.2.2")).toMatchObject({ status: 401 });
    expect(globalSvc.login("x", "000000", "3.3.3.3")).toMatchObject({ status: 429 });
    const spoofed = new Headers({ "x-owner-socket-ip": "1.2.3.4", "x-forwarded-for": "8.8.8.8" });
    expect(webLoginPeer(spoofed)).toBe("unknown");
    expect(webLoginPeer(spoofed, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientIp({ socketIp: "127.0.0.1", forwardedFor: "1.2.3.4", trustedProxies: [] })).toBe("127.0.0.1");
    expect(clientIp({ socketIp: "10.0.0.8", forwardedFor: "1.2.3.4", trustedProxies: ["10.0.0.8"] })).toBe("1.2.3.4");
    const store = new MemoryOwnerStore();
    const opts = {
      sessionSecret: SECRET,
      now: () => 5_000,
      windowLimit: 3,
      windowMs: 60_000,
      lockoutFailures: 2,
      lockoutMs: 15 * 60_000,
    };
    const first = new OwnerAuthService(store, opts);
    expect(first.login("x", "000000", "10.0.0.1")).toMatchObject({ status: 401 });
    expect(first.login("x", "000000", "10.0.0.2")).toMatchObject({ status: 401 });
    expect(first.login("x", "000000", "10.0.0.3")).toMatchObject({ status: 429 });
    const restarted = new OwnerAuthService(store, opts);
    expect(restarted.login("x", "000000", "10.0.0.4")).toMatchObject({ status: 429, error: "RATE_LIMITED" });
  });

  it("rejects a logged-out cookie on the page gate", async () => {
    const start = 1_700_000_000_000;
    const ctx = enrolled(start);
    const login = ctx.service.login("correct horse battery", totpCode(ctx.secret, start), "10.8.0.1");
    if (!login.ok) throw new Error(login.error);
    const token = login.setCookie[0]?.split(";")[0]?.split("=")[1] ?? "";
    ctx.service.logout();
    const generation = ctx.store.read().generation;
    expect(await pageAllowsEdge({
      enabled: true,
      pathname: "/accounts",
      token,
      secret: SECRET,
      nowMs: start,
      generation,
    })).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "owner-auth-"));
    const statePath = join(dir, "owner-auth.json");
    writeFileSync(statePath, JSON.stringify({ generation }));
    expect(await pageSessionAllows({
      enabled: true,
      pathname: "/accounts",
      token,
      secret: SECRET,
      nowMs: start,
      statePath,
    })).toBe(false);
  });
});
