import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * D7 default-wiring gap closer: `createApp()` resolves a live `ModelClient`
 * from `MODEL_PROVIDER` (+ `AZURE_OPENAI_*`) when no `modelClient` is
 * injected, instead of only ever being wired inside a gated live test.
 *
 * This suite is 100% offline / network-free — it runs in the normal CI
 * suite alongside every other apps/api test:
 *  - The default-path case asserts today's fail-closed offline behavior is
 *    byte-for-byte unchanged (no MODEL_PROVIDER, no injected modelClient ->
 *    MODEL_UNAVAILABLE, exactly as before this change).
 *  - The MODEL_PROVIDER=azure case stubs `global.fetch` so the "live"
 *    client's one HTTP call never leaves the process; it asserts the
 *    provider path was actually taken (fetch invoked with the
 *    AZURE_OPENAI_ENDPOINT-derived URL/auth headers) and that the response
 *    flows all the way through the effect path — proof the wiring is real,
 *    without a real network call. The genuine network call is covered
 *    separately by `live-model.integration.test.ts` under LIVE_MODEL_TEST=1.
 */

const WS = "ws-provider-wiring";
const OPERATOR = "operator-provider-wiring";

function headers(extra: Record<string, string> = {}) {
  return {
    "x-workspace-id": WS,
    "x-principal-id": OPERATOR,
    ...extra,
  };
}

let app: FastifyInstance | undefined;

const ENV_KEYS = [
  "MODEL_PROVIDER",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_AUTH_MODE",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
  vi.unstubAllGlobals();
});

function stashEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

describe("D7 MODEL_PROVIDER default wiring (offline, no network)", () => {
  it("no MODEL_PROVIDER + no injected modelClient fails closed with MODEL_UNAVAILABLE — unchanged offline default", async () => {
    stashEnv();
    const api = await ready();

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "wiring-default-1" }),
      payload: { text: "post an internal update noting the pilot rollout is on track" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "MODEL_UNAVAILABLE" });
  });

  it("MODEL_PROVIDER=mock / none behave identically to unset (still fail closed)", async () => {
    stashEnv();
    for (const value of ["mock", "none"]) {
      process.env.MODEL_PROVIDER = value;
      const api = await ready();
      const res = await api.inject({
        method: "POST",
        url: "/api/agent/commands",
        headers: headers({ "idempotency-key": `wiring-${value}` }),
        payload: { text: "post an internal update" },
      });
      expect(res.statusCode).toBe(503);
      await api.close();
      app = undefined;
    }
  });

  it("MODEL_PROVIDER=azure constructs a live client and the provider path is actually taken (fetch stubbed, no real network)", async () => {
    stashEnv();
    process.env.MODEL_PROVIDER = "azure";
    process.env.AZURE_OPENAI_ENDPOINT = "https://wiring-test.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "test-key-not-a-secret";
    process.env.AZURE_OPENAI_AUTH_MODE = "api-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "wiring-test-deployment";

    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          model: "wiring-test-deployment",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  steps: [
                    {
                      suggestedCommand: "internal.update",
                      title: "wiring test",
                      resourceType: "",
                      resourceId: "",
                      resourceVersion: 1,
                      payloadJson: "{}",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = await ready();

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "wiring-azure-1" }),
      payload: { text: "post an internal update noting the pilot rollout is on track" },
    });

    // Never MODEL_UNAVAILABLE: the live client was actually wired in.
    expect(res.statusCode).not.toBe(503);
    expect(res.statusCode).toBe(202);

    // Proof the Azure provider path — not a mock/offline default — handled
    // the request: exactly one stubbed HTTP call, to the deployment URL
    // derived from AZURE_OPENAI_ENDPOINT, carrying the api-key auth header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://wiring-test.openai.azure.com/openai/deployments/wiring-test-deployment/chat/completions?api-version=2024-08-01-preview",
    );
    const requestHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(requestHeaders["api-key"]).toBe("test-key-not-a-secret");
  });

  it("MODEL_PROVIDER=openai_compatible is also wired to the live client (Bearer auth path, fetch stubbed)", async () => {
    stashEnv();
    process.env.MODEL_PROVIDER = "openai_compatible";
    process.env.AZURE_OPENAI_ENDPOINT = "https://wiring-test-gateway.example.com/v1";
    process.env.AZURE_OPENAI_API_KEY = "test-key-not-a-secret";
    process.env.AZURE_OPENAI_AUTH_MODE = "openai_compatible";
    process.env.AZURE_OPENAI_DEPLOYMENT = "wiring-test-model";

    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return new Response(
        JSON.stringify({
          model: "wiring-test-model",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  steps: [
                    {
                      suggestedCommand: "internal.update",
                      title: "wiring test",
                      resourceType: "",
                      resourceId: "",
                      resourceVersion: 1,
                      payloadJson: "{}",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = await ready();
    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "wiring-openai-compatible-1" }),
      payload: { text: "post an internal update" },
    });

    expect(res.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://wiring-test-gateway.example.com/v1/chat/completions");
    const requestHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(requestHeaders.Authorization).toBe("Bearer test-key-not-a-secret");
  });

  it("an explicitly injected modelClient always wins over MODEL_PROVIDER (no network, no fetch stub needed)", async () => {
    stashEnv();
    process.env.MODEL_PROVIDER = "azure";
    process.env.AZURE_OPENAI_ENDPOINT = "https://should-not-be-used.example.com";
    process.env.AZURE_OPENAI_API_KEY = "unused";

    let invoked = false;
    const api = await ready({
      modelClient: {
        async invoke() {
          invoked = true;
          return {
            structuredOutput: {
              steps: [
                {
                  suggestedCommand: "internal.update",
                  title: "injected client",
                  resourceType: "",
                  resourceId: "",
                  resourceVersion: 1,
                  payloadJson: "{}",
                },
              ],
            },
            modelVersion: "injected-v1",
            retentionHonored: true,
          };
        },
      },
    });

    const res = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "wiring-injected-1" }),
      payload: { text: "post an internal update" },
    });

    expect(res.statusCode).toBe(202);
    expect(invoked).toBe(true);
  });

  it("an unrecognized MODEL_PROVIDER value fails fast at createApp() instead of silently falling back to offline", () => {
    stashEnv();
    process.env.MODEL_PROVIDER = "totally-unsupported-provider";
    expect(() => createApp()).toThrow(/MODEL_PROVIDER/);
  });
});
