import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp } from "../src/app.js";
import { InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";

/**
 * G-05: production-mode fail-closed auth posture.
 *
 * Non-prod default (existing behavior, see authn.integration.test.ts) must
 * stay untouched: createApp() without an API key keeps working for local/dev
 * and existing test suites that call createApp() with no auth. This file
 * only adds prod-framing assertions layered on top of that contract.
 */

let app: FastifyInstance | undefined;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.AUTH_API_KEY;
  delete process.env.API_AUTH_TOKEN;
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

const WS = "ws-prod-auth";
const OPERATOR = "operator-prod-auth";
const KEY = "test-api-key-prod";

function planClient(): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand: "internal.update",
              title: "note",
              resourceType: "",
              resourceId: "",
              resourceVersion: 1,
              payloadJson: "{}",
            },
          ],
        },
        modelVersion: "prod-auth-test",
        retentionHonored: true,
      };
    },
  };
}

async function ready(options: Parameters<typeof createApp>[0] = {}): Promise<FastifyInstance> {
  const hasApiKey = Boolean(options.authApiKey || process.env.AUTH_API_KEY || process.env.API_AUTH_TOKEN);
  const productionFixture = process.env.NODE_ENV === "production"
    ? {
        customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
        ...(hasApiKey ? {
          customerWorkOsV2OperatorStepUp: new OperatorStepUpService({
            workspaceId: WS, principalId: OPERATOR,
            sessionSecret: "production-auth-fixture-session-secret",
            store: {
              read: () => ({
                generation: 1, enrolled: true, totpPending: false,
                passwordSalt: Buffer.alloc(16, 1).toString("base64url"),
                passwordHash: Buffer.alloc(32, 2).toString("base64url"),
                totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
              }),
              write: () => { throw new Error("legacy auth regression must not authenticate a native owner"); },
            },
          }),
          customerWorkOsV2ActorBinding: {
            workspaceId: WS,
            principalId: OPERATOR,
            kind: "human" as const,
            stepUpVerified: false,
          },
        } : {}),
      }
    : {};
  const instance = createApp({ ...productionFixture, ...options });
  app = instance;
  await instance.ready();
  return instance;
}

describe("G-05 prod-mode fail-closed auth", () => {
  it("prod-framed: authApiKey configured → mutating /api/agent/commands without key → 401, authMode is 'apikey'", async () => {
    process.env.NODE_ENV = "production";
    const api = await ready({ authApiKey: KEY, modelClient: planClient() });
    expect((api as FastifyInstance & { aiCrm?: { authMode: string } }).aiCrm?.authMode).toBe("apikey");

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "idempotency-key": "prod-auth-no-key",
      },
      payload: { text: "do work" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "UNAUTHENTICATED" });

    const ok = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        "x-workspace-id": WS,
        "x-principal-id": OPERATOR,
        "x-api-key": KEY,
        "idempotency-key": "prod-auth-ok",
      },
      payload: { text: "do work" },
    });
    expect(ok.statusCode).toBe(202);
  });

  it("prod-framed with no key configured: createApp is fail-closed and throws [AUTH_REQUIRED_IN_PROD]", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_API_KEY;
    delete process.env.API_AUTH_TOKEN;
    delete process.env.ALLOW_INSECURE_PROD;
    // Production + no configured key must refuse to start (no silent unauthenticated boot).
    expect(() => createApp()).toThrow(/AUTH_REQUIRED_IN_PROD/);
  });

  it("prod-framed native composition refuses unauthenticated bring-up even with the legacy escape hatch", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_API_KEY;
    delete process.env.API_AUTH_TOKEN;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(ready({ allowInsecureProd: true })).rejects.toThrow(/AUTH_REQUIRED_IN_PROD/);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("[AUTH_DISABLED_IN_PROD]"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prod-framed: no [AUTH_DISABLED_IN_PROD] warning when a key IS configured", async () => {
    process.env.NODE_ENV = "production";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ready({ authApiKey: KEY });
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("[AUTH_DISABLED_IN_PROD]"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prod-framed: no [AUTH_DISABLED_IN_PROD] warning outside production even with no key", async () => {
    delete process.env.NODE_ENV;
    delete process.env.AUTH_API_KEY;
    delete process.env.API_AUTH_TOKEN;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const api = await ready();
      expect((api as FastifyInstance & { aiCrm?: { authMode: string } }).aiCrm?.authMode).toBe("dev");
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("[AUTH_DISABLED_IN_PROD]"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prod-framed: unsigned finance pack refused — no financePack + no allowUnsignedFinancePack → finance routes stay 503 FINANCE_PACK_UNSET", async () => {
    process.env.NODE_ENV = "production";
    const api = await ready({ authApiKey: KEY });
    const res = await api.inject({
      method: "GET",
      url: "/api/finance/balances",
      headers: { "x-workspace-id": WS, "x-api-key": KEY },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "FINANCE_PACK_UNSET" });
  });
});
