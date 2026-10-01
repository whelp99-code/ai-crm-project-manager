import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const OWNER_COOKIE = "core5_owner";
export const CSRF_COOKIE = "core5_csrf";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const ENROLL_TTL_MS = 15 * 60 * 1000;

export type OwnerRecord = {
  generation: number;
  passwordSalt?: string;
  passwordHash?: string;
  totpSecret?: string;
  enrolled: boolean;
  pendingCodeHash?: string;
  pendingCodeExp?: number;
  totpPending: boolean;
};

export interface OwnerStore {
  read(): OwnerRecord;
  write(next: OwnerRecord): void;
}

export function emptyRecord(): OwnerRecord {
  return { generation: 1, enrolled: false, totpPending: false };
}

export class MemoryOwnerStore implements OwnerStore {
  constructor(private record: OwnerRecord = emptyRecord()) {}
  read(): OwnerRecord {
    return { ...this.record };
  }
  write(next: OwnerRecord): void {
    this.record = { ...next };
  }
}

export class LoginRateLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Records an attempt. Returns false when the window is already full. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    const prev = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (prev.length >= this.limit) {
      const oldest = prev[0] ?? now;
      this.hits.set(key, prev);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000)) };
    }
    prev.push(now);
    this.hits.set(key, prev);
    return { ok: true };
  }
}

export type SessionClaims = { exp: number; csrf: string; gen: number };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `v1.${payload}.${sig}`;
}

export function verifySessionToken(token: string, secret: string, nowMs: number): SessionClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return undefined;
  const expected = b64url(createHmac("sha256", secret).update(parts[1]).digest());
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.exp !== "number" || typeof rec.csrf !== "string" || typeof rec.gen !== "number") return undefined;
  if (rec.exp <= nowMs) return undefined;
  if (!rec.csrf) return undefined;
  return { exp: rec.exp, csrf: rec.csrf, gen: rec.gen };
}

export function cookieFlags(input: { secure: boolean; httpOnly: boolean; maxAgeSec: number }): string {
  const parts = ["Path=/", "SameSite=Strict", `Max-Age=${input.maxAgeSec}`];
  if (input.httpOnly) parts.push("HttpOnly");
  if (input.secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionCookieHeader(token: string, secure: boolean, maxAgeSec: number): string {
  return `${OWNER_COOKIE}=${token}; ${cookieFlags({ secure, httpOnly: true, maxAgeSec })}`;
}

export function csrfCookieHeader(csrf: string, secure: boolean, maxAgeSec: number): string {
  return `${CSRF_COOKIE}=${csrf}; ${cookieFlags({ secure, httpOnly: false, maxAgeSec })}`;
}

export function clearCookieHeaders(secure: boolean): string[] {
  return [
    `${OWNER_COOKIE}=; ${cookieFlags({ secure, httpOnly: true, maxAgeSec: 0 })}`,
    `${CSRF_COOKIE}=; ${cookieFlags({ secure, httpOnly: false, maxAgeSec: 0 })}`,
  ];
}

const SCRYPT_KEYLEN = 32;

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 });
}

export function passwordAcceptable(password: string): boolean {
  return password.length >= 12 && password.length <= 200;
}

function base32Encode(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("bad base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return (bin % 1_000_000).toString().padStart(6, "0");
}

export function totpCode(secretBase32: string, nowMs: number, step = 30): string {
  const counter = Math.floor(nowMs / 1000 / step);
  return hotp(base32Decode(secretBase32), counter);
}

export function totpMatches(secretBase32: string, code: string, nowMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const skew of [-1, 0, 1]) {
    const counter = Math.floor(nowMs / 1000 / 30) + skew;
    const expected = hotp(base32Decode(secretBase32), counter);
    const a = Buffer.from(code);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function sha256(value: string): string {
  return createHmac("sha256", "owner-enroll").update(value).digest("hex");
}

export type AuthFailure = { ok: false; status: 401 | 403 | 429; error: string; retryAfterSec?: number };

export class OwnerAuthService {
  constructor(
    private readonly store: OwnerStore,
    private readonly opts: {
      sessionSecret: string;
      now?: () => number;
      sessionTtlMs?: number;
      cookieSecure?: boolean;
      rateLimit?: LoginRateLimit;
    },
  ) {
    if (opts.sessionSecret.length < 32) throw new Error("OWNER_SESSION_SECRET must be at least 32 characters");
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private limiter(): LoginRateLimit {
    return this.opts.rateLimit ?? new LoginRateLimit(10, 15 * 60_000, () => this.now());
  }

  issueEnrollmentCode(): { code: string; expiresAt: string } {
    const rec = this.store.read();
    if (rec.enrolled) throw new Error("ALREADY_ENROLLED");
    const code = randomBytes(16).toString("base64url");
    const exp = this.now() + ENROLL_TTL_MS;
    this.store.write({
      generation: rec.generation,
      enrolled: false,
      totpPending: false,
      pendingCodeHash: sha256(code),
      pendingCodeExp: exp,
    });
    return { code, expiresAt: new Date(exp).toISOString() };
  }

  enroll(code: string, password: string, ip: string): { ok: true; otpauth: string } | AuthFailure {
    const limited = this.limiter().take(`enroll:${ip}`);
    if (!limited.ok) return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSec: limited.retryAfterSec };
    if (!passwordAcceptable(password)) return { ok: false, status: 401, error: "PASSWORD_REJECTED" };
    const rec = this.store.read();
    if (rec.enrolled) return { ok: false, status: 401, error: "ALREADY_ENROLLED" };
    if (!rec.pendingCodeHash || rec.pendingCodeExp === undefined || rec.pendingCodeExp <= this.now()) {
      return { ok: false, status: 401, error: "ENROLL_CODE_INVALID" };
    }
    const presented = Buffer.from(sha256(code));
    const expected = Buffer.from(rec.pendingCodeHash);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, status: 401, error: "ENROLL_CODE_INVALID" };
    }
    const salt = randomBytes(16);
    const totpSecret = base32Encode(randomBytes(20));
    this.store.write({
      generation: rec.generation,
      passwordSalt: salt.toString("base64url"),
      passwordHash: hashPassword(password, salt).toString("base64url"),
      totpSecret,
      enrolled: false,
      totpPending: true,
    });
    return { ok: true, otpauth: `otpauth://totp/core5:owner?secret=${totpSecret}&issuer=core5&digits=6&period=30` };
  }

  confirmTotp(code: string, ip: string): { ok: true } | AuthFailure {
    const limited = this.limiter().take(`confirm:${ip}`);
    if (!limited.ok) return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSec: limited.retryAfterSec };
    const rec = this.store.read();
    if (!rec.totpPending || !rec.totpSecret) return { ok: false, status: 401, error: "ENROLL_INCOMPLETE" };
    if (!totpMatches(rec.totpSecret, code, this.now())) return { ok: false, status: 401, error: "TOTP_INVALID" };
    this.store.write({ ...rec, totpPending: false, enrolled: true });
    return { ok: true };
  }

  login(password: string, totp: string, ip: string): { ok: true; setCookie: string[]; csrf: string; exp: number } | AuthFailure {
    const limited = this.limiter().take(`login:${ip}`);
    if (!limited.ok) return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSec: limited.retryAfterSec };
    const rec = this.store.read();
    if (!rec.enrolled || !rec.passwordSalt || !rec.passwordHash || !rec.totpSecret) {
      return { ok: false, status: 401, error: "UNAUTHENTICATED" };
    }
    const salt = Buffer.from(rec.passwordSalt, "base64url");
    const actual = hashPassword(password, salt);
    const expected = Buffer.from(rec.passwordHash, "base64url");
    const passwordOk = actual.length === expected.length && timingSafeEqual(actual, expected);
    const totpOk = totpMatches(rec.totpSecret, totp, this.now());
    if (!passwordOk || !totpOk) return { ok: false, status: 401, error: "UNAUTHENTICATED" };
    const exp = this.now() + (this.opts.sessionTtlMs ?? SESSION_TTL_MS);
    const csrf = randomBytes(18).toString("base64url");
    const token = signSession({ exp, csrf, gen: rec.generation }, this.opts.sessionSecret);
    const maxAge = Math.max(1, Math.floor((exp - this.now()) / 1000));
    const secure = this.opts.cookieSecure === true;
    return {
      ok: true,
      csrf,
      exp,
      setCookie: [sessionCookieHeader(token, secure, maxAge), csrfCookieHeader(csrf, secure, maxAge)],
    };
  }

  logout(): { setCookie: string[] } {
    const rec = this.store.read();
    this.store.write({ ...rec, generation: rec.generation + 1 });
    return { setCookie: clearCookieHeaders(this.opts.cookieSecure === true) };
  }

  authorize(input: { cookieHeader: string | undefined; method: string; csrfHeader: string | undefined }): { ok: true; csrf: string } | AuthFailure {
    const token = readCookie(input.cookieHeader, OWNER_COOKIE);
    if (!token) return { ok: false, status: 401, error: "UNAUTHENTICATED" };
    const claims = verifySessionToken(token, this.opts.sessionSecret, this.now());
    if (!claims) return { ok: false, status: 401, error: "UNAUTHENTICATED" };
    const rec = this.store.read();
    if (!rec.enrolled || claims.gen !== rec.generation) return { ok: false, status: 401, error: "UNAUTHENTICATED" };
    if (isMutating(input.method)) {
      if (!input.csrfHeader || input.csrfHeader !== claims.csrf) return { ok: false, status: 403, error: "CSRF" };
    }
    return { ok: true, csrf: claims.csrf };
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function isMutating(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export function isOwnerPublicPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/auth/login" ||
    path === "/api/auth/enroll" ||
    path === "/api/auth/enroll/confirm" ||
    path === "/login" ||
    path.startsWith("/api/owner/")
  );
}

/** Page gate used by Next middleware. Expired or bad signatures are denied. */
export function pageAllows(input: {
  enabled: boolean;
  pathname: string;
  token: string | undefined;
  secret: string | undefined;
  nowMs: number;
}): boolean {
  if (!input.enabled) return true;
  if (input.pathname === "/login" || input.pathname === "/health" || input.pathname.startsWith("/api/owner/")) return true;
  if (!input.token || !input.secret) return false;
  return verifySessionToken(input.token, input.secret, input.nowMs) !== undefined;
}
