import { randomBytes } from "node:crypto";
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
  constructor(readonly code: string, readonly statusCode: 401 | 403 | 429) {
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
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 300_000) {
      throw new Error("[OPERATOR_AUTH_TTL_INVALID] proof must expire within five minutes");
    }
  }

  /** Synchronous store/hash/write keeps TOTP consumption atomic within its owning process. */
  authenticate(input: unknown, ip: string): { cookie: string; csrf: string; expiresAt: string } {
    const now = this.now();
    const record = this.options.store.read();
    const rate = record.rate ?? { lockoutUntil: 0, failures: 0, globalHits: [], perIp: {} };
    const globalHits = rate.globalHits.filter(time => time > now - 900_000);
    const peerHits = (rate.perIp[ip] ?? []).filter(time => time > now - 900_000);
    if (rate.lockoutUntil > now || globalHits.length >= 10 || peerHits.length >= 10) {
      throw new OperatorStepUpError("OPERATOR_RATE_LIMITED", 429);
    }
    const perIp: Record<string, number[]> = {};
    for (const [peer, hits] of Object.entries(rate.perIp)) {
      const recent = hits.filter(time => time > now - 900_000);
      if (recent.length > 0) perIp[peer] = recent;
    }
    perIp[ip] = [...peerHits, now];
    const currentRate = { ...rate, globalHits: [...globalHits, now], perIp };
    this.options.store.write({ ...record, rate: currentRate });
    const parsed = credentialsSchema.safeParse(input);
    const fail = (code: string): never => {
      const failures = currentRate.failures + 1;
      this.options.store.write({
        ...record, rate: {
          ...currentRate, failures,
          lockoutUntil: failures >= 10 ? now + 900_000 : currentRate.lockoutUntil,
        },
      });
      throw new OperatorStepUpError(code, 401);
    };
    if (!parsed.success) return fail("OPERATOR_UNAUTHENTICATED");
    const passwordAccepted = verifyOperatorPassword(parsed.data.password, record.passwordHash);
    const step = acceptedOperatorTotpStep(record.totpSecret, parsed.data.totp, now);
    if (!passwordAccepted || step === undefined) {
      return fail("OPERATOR_UNAUTHENTICATED");
    }
    if (record.lastTotpStep !== undefined && step <= record.lastTotpStep) return fail("OPERATOR_TOTP_REPLAY");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now + this.ttlMs;
    const generation = record.generation + 1;
    this.options.store.write({
      ...record, generation, lastTotpStep: step, rate: { ...currentRate, failures: 0 },
    });
    const payload = Buffer.from(JSON.stringify({
      workspaceId: this.workspaceId, principalId: this.principalId,
      generation, authenticatedAt: now, expiresAt, csrf,
    })).toString("base64url");
    const token = `v1.${payload}.${operatorProofSignature(payload, this.options.sessionSecret)}`;
    const secure = this.options.cookieSecure !== false ? "; Secure" : "";
    return {
      cookie: `${COOKIE}=${token}; Path=/api/cwos/v2; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.ttlMs / 1000)}${secure}`,
      csrf, expiresAt: new Date(expiresAt).toISOString(),
    };
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
