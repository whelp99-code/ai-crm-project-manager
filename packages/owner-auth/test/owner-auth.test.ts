import { describe, expect, it } from "vitest";
import {
  LoginRateLimit,
  MemoryOwnerStore,
  OwnerAuthService,
  cookieFlags,
  pageAllows,
  signSession,
  totpCode,
} from "../src/index.js";
import { sessionTokenActive } from "../src/page-gate.js";

const SECRET = "test-session-secret-32chars-minimum";

function enrolled(now: number) {
  let clock = now;
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
    expect(await sessionTokenActive(token ?? "", SECRET, start)).toBe(true);
    expect(await sessionTokenActive(token ?? "", SECRET, start + 5_000)).toBe(false);
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
});
