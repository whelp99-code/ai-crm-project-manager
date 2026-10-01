import type { FastifyInstance, FastifyRequest } from "fastify";
import { clientIp as peerIp, isOwnerPublicPath, OwnerAuthService, type OwnerStore } from "@ai-crm/owner-auth";
import { FileOwnerStore } from "@ai-crm/owner-auth/file-store";

export type OwnerAuthOptions = {
  enabled?: boolean;
  service?: OwnerAuthService;
  store?: OwnerStore;
  sessionSecret?: string;
  now?: () => number;
  sessionTtlMs?: number;
  cookieSecure?: boolean;
};

function requestPath(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function clientIp(request: FastifyRequest): string {
  const trusted = (process.env.OWNER_TRUSTED_PROXIES ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const forwarded = request.headers["x-forwarded-for"];
  return peerIp({
    socketIp: request.socket?.remoteAddress,
    forwardedFor: Array.isArray(forwarded) ? forwarded.join(",") : forwarded,
    trustedProxies: trusted,
  });
}

export function registerOwnerAuth(app: FastifyInstance, options: OwnerAuthOptions = {}): OwnerAuthService | undefined {
  const enabled = options.enabled === true || (options.enabled !== false && process.env.OWNER_AUTH === "1");
  if (!enabled && !options.service) return undefined;
  const secret = options.sessionSecret ?? process.env.OWNER_SESSION_SECRET ?? "";
  const store = options.store ?? storeFromEnv();
  if (!options.service && !store) {
    throw new Error("[OWNER_AUTH_STORE_REQUIRED] set OWNER_AUTH_STATE_PATH or pass a store");
  }
  const service =
    options.service ??
    new OwnerAuthService(store as OwnerStore, {
      sessionSecret: secret,
      ...(options.now ? { now: options.now } : {}),
      ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
      cookieSecure: options.cookieSecure === true || process.env.OWNER_COOKIE_SECURE === "1",
    });

  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request.url);
    if (isOwnerPublicPath(path)) return;
    const csrf = request.headers["x-csrf-token"];
    const decision = service.authorize({
      cookieHeader: request.headers.cookie,
      method: request.method,
      csrfHeader: typeof csrf === "string" ? csrf : undefined,
    });
    if (!decision.ok) {
      if (decision.retryAfterSec) reply.header("retry-after", String(decision.retryAfterSec));
      return reply.code(decision.status).send({ error: decision.error });
    }
  });

  app.post("/api/auth/enroll", async (request, reply) => {
    const body = request.body as { code?: unknown; password?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const result = service.enroll(code, password, clientIp(request));
    if (!result.ok) {
      if (result.retryAfterSec) reply.header("retry-after", String(result.retryAfterSec));
      return reply.code(result.status).send({ error: result.error });
    }
    return { otpauth: result.otpauth };
  });

  app.post("/api/auth/enroll/confirm", async (request, reply) => {
    const body = request.body as { totp?: unknown } | null;
    const totp = typeof body?.totp === "string" ? body.totp : "";
    const result = service.confirmTotp(totp, clientIp(request));
    if (!result.ok) {
      if (result.retryAfterSec) reply.header("retry-after", String(result.retryAfterSec));
      return reply.code(result.status).send({ error: result.error });
    }
    return { enrolled: true };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { password?: unknown; totp?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : "";
    const totp = typeof body?.totp === "string" ? body.totp : "";
    const result = service.login(password, totp, clientIp(request));
    if (!result.ok) {
      if (result.retryAfterSec) reply.header("retry-after", String(result.retryAfterSec));
      return reply.code(result.status).send({ error: result.error });
    }
    reply.header("set-cookie", result.setCookie);
    return { expiresAt: new Date(result.exp).toISOString() };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    const cleared = service.logout();
    reply.header("set-cookie", cleared.setCookie);
    return { ok: true };
  });

  return service;
}

function storeFromEnv(): OwnerStore | undefined {
  const path = process.env.OWNER_AUTH_STATE_PATH?.trim();
  return path ? new FileOwnerStore(path) : undefined;
}
