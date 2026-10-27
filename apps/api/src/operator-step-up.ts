import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  acceptedOperatorTotpStep, equalAuthValue, verifyOperatorPassword, operatorProofSignature,
} from "./operator-auth-crypto.js";
import type { OperatorAuthStore } from "./operator-auth-store.js";

const COOKIE = "cwos_operator_stepup";
const credentialsSchema = z.object({
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/),
}).strict();
const proofSchema = z.object({
  workspaceId: z.string().min(1), principalId: z.string().min(1),
  generation: z.number().int().positive(), authenticatedAt: z.number().finite(),
  expiresAt: z.number().finite(), csrf: z.string().min(1),
}).strict();

export class OperatorStepUpError extends Error {
  constructor(readonly code: string, readonly statusCode: 401 | 403 | 429, readonly retryAfterMs?: number) {
    super(code);
    this.name = "OperatorStepUpError";
  }
}

export class OperatorStepUpService {
  readonly workspaceId: string;
  readonly principalId: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionSecret: string;
    readonly proxySecret?: string;
    readonly store: OperatorAuthStore;
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly cookieSecure?: boolean;
  }) {
    if (!options.workspaceId.trim() || !options.principalId.trim() || options.sessionSecret.length < 32) {
      throw new Error("[OPERATOR_AUTH_CONFIG_REQUIRED] admitted human scope and private session secret required");
    }
    this.workspaceId = options.workspaceId.trim();
    this.principalId = options.principalId.trim();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
    if (options.proxySecret !== undefined && options.proxySecret.length < 32) {
      throw new Error("Operator proxy key must contain at least 32 characters");
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 300_000) {
      throw new Error("[OPERATOR_AUTH_TTL_INVALID] proof must expire within five minutes");
    }
  }

  /** Forwarded addresses require an explicit authenticated ingress, never raw XFF. */
  clientAddress(headers: Readonly<Record<string, string | string[] | undefined>>): string {
    const address = headers["x-cwos-client-ip"];
    const token = headers["x-cwos-client-token"];
    const expected = this.options.proxySecret;
    return expected && typeof address === "string" && isIP(address) !== 0
      && typeof token === "string" && equalAuthValue(token, expected) ? address : "unknown";
  }

  /** The sole enrollment is the account bucket; client penalties never gate valid factors. */
  authenticate(input: unknown, ip: string): { cookie: string; csrf: string; expiresAt: string } {
    const now = this.now();
    const record = this.options.store.read();
    if (!record.enrolled || record.totpPending) throw new OperatorStepUpError("OPERATOR_UNAUTHENTICATED", 401);
    const rate = record.rate ?? { lockoutUntil: 0, failures: 0, globalHits: [], perIp: {} };
    const perIp: Record<string, number[]> = {};
    for (const [peer, hits] of Object.entries(rate.perIp)) {
      const recent = hits.filter(time => time > now - 60_000);
      if (recent.length) perIp[peer] = recent;
    }
    const accountHits = rate.globalHits.filter(time => time > now - 60_000);
    const peerHits = perIp[ip] ?? [];
    const delay = (failures: number) => Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
    const fail = (code: string): never => {
      const lastFailure = peerHits.at(-1);
      const cooling = lastFailure !== undefined && lastFailure + delay(peerHits.length) > now;
      if (cooling) {
        // Rejected retries cannot renew the short lock indefinitely or keep writing the auth file.
        throw new OperatorStepUpError(code === "OPERATOR_TOTP_REPLAY" ? code : "OPERATOR_RATE_LIMITED",
          429, lastFailure + delay(peerHits.length) - now);
      }
      const peers = Object.entries(perIp).filter(([peer]) => peer !== ip).slice(-127);
      this.options.store.write({ ...record, rate: {
        lockoutUntil: now + delay(accountHits.length + 1), failures: accountHits.length + 1,
        globalHits: [...accountHits, now].slice(-128),
        perIp: Object.fromEntries([...peers, [ip, [...peerHits, now].slice(-128)]]),
      } });
      throw new OperatorStepUpError(code, 401, delay(accountHits.length + 1));
    };
    const parsed = credentialsSchema.safeParse(input);
    if (!parsed.success) return fail("OPERATOR_UNAUTHENTICATED");
    // A random OTP costs only HMAC, including retries during a client penalty.
    const step = acceptedOperatorTotpStep(record.totpSecret, parsed.data.totp, now);
    if (step === undefined) return fail("OPERATOR_UNAUTHENTICATED");
    if (record.lastTotpStep !== undefined && step <= record.lastTotpStep) return fail("OPERATOR_TOTP_REPLAY");
    if (!verifyOperatorPassword(parsed.data.password, record.passwordHash)) return fail("OPERATOR_UNAUTHENTICATED");
    const generation = record.generation + 1;
    delete perIp[ip];
    this.options.store.write({ ...record, generation, lastTotpStep: step,
      rate: { lockoutUntil: 0, failures: 0, globalHits: [], perIp } });
    const expiresAt = now + this.ttlMs;
    const proof = { workspaceId: this.workspaceId, principalId: this.principalId,
      generation, authenticatedAt: now, expiresAt, csrf: randomBytes(24).toString("base64url") };
    const encoded = Buffer.from(JSON.stringify(proof)).toString("base64url");
    const token = "v1." + encoded + "." + operatorProofSignature(encoded, this.options.sessionSecret);
    const cookie = COOKIE + "=" + token + "; Path=/api/cwos/v2; HttpOnly; SameSite=Strict; Max-Age=" + Math.floor(this.ttlMs / 1000)
      + ((this.options.cookieSecure ?? true) ? "; Secure" : "");
    return { cookie, csrf: proof.csrf, expiresAt: new Date(expiresAt).toISOString() };
  }

  logout(input: { cookieHeader: string | undefined; csrfHeader: string | undefined }): string {
    this.authorize({ ...input, method: "POST" });
    const record = this.options.store.read();
    this.options.store.write({ ...record, generation: record.generation + 1 });
    return COOKIE + "=; Path=/api/cwos/v2; HttpOnly; SameSite=Strict; Max-Age=0"
      + ((this.options.cookieSecure ?? true) ? "; Secure" : "");
  }

  authorize(input: {
    readonly cookieHeader: string | undefined;
    readonly csrfHeader: string | undefined;
    readonly method: string;
  }): true {
    const cookies = (input.cookieHeader ?? "").split(";").map(part => part.trim());
    const cookie = cookies.find(part => part.startsWith(`${COOKIE}=`));
    const parts = cookie?.slice(COOKIE.length + 1).split(".");
    if (!parts || parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
      throw new OperatorStepUpError("STEP_UP_REQUIRED", 403);
    }
    const payload = parts[1];
    if (!equalAuthValue(parts[2], operatorProofSignature(payload, this.options.sessionSecret))) {
      throw new OperatorStepUpError("OPERATOR_PROOF_INVALID", 401);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new OperatorStepUpError("OPERATOR_PROOF_INVALID", 401);
      throw error;
    }
    const parsed = proofSchema.safeParse(raw);
    if (!parsed.success) throw new OperatorStepUpError("OPERATOR_PROOF_INVALID", 401);
    const proof = parsed.data;
    if (proof.workspaceId !== this.workspaceId || proof.principalId !== this.principalId) {
      throw new OperatorStepUpError("OPERATOR_PROOF_SCOPE", 403);
    }
    const now = this.now();
    if (proof.authenticatedAt > now || proof.expiresAt <= now
      || proof.expiresAt - proof.authenticatedAt > this.ttlMs
      || proof.generation !== this.options.store.read().generation) {
      throw new OperatorStepUpError("OPERATOR_PROOF_EXPIRED", 401);
    }
    if (input.method !== "GET" && input.method !== "HEAD"
      && (!input.csrfHeader || !equalAuthValue(input.csrfHeader, proof.csrf))) {
      throw new OperatorStepUpError("OPERATOR_CSRF", 403);
    }
    return true;
  }
}
