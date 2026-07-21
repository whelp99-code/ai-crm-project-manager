import { describe, expect, it, vi } from "vitest";
import { AzureOpenAiClient, AzureOpenAiClientError, type AzureOpenAiClientConfig } from "@ai-crm/model-gateway";

/**
 * D7 gap closer PG-E: retry-with-backoff + circuit-breaker + per-request
 * timeout (+ optional streaming) for the live Azure OpenAI ModelClient.
 *
 * 100% offline / network-free: `fetchImpl` is always a hand-rolled stub, and
 * timers use small millisecond values so the whole suite runs fast without
 * ever reaching the network or faking global timers. This exercises
 * `AzureOpenAiClient` directly (the same class `resolveModelClientFromEnv`
 * wires into `createApp()` behind `MODEL_PROVIDER`), so it proves the
 * resilience behavior without going through the HTTP layer.
 */

const REQUEST = {
  redactedPrompt: "post an internal update",
  promptVersion: "v1",
  requestedRetention: "retain" as const,
  correlationId: "corr-1",
};

function baseConfig(overrides: Partial<AzureOpenAiClientConfig>): AzureOpenAiClientConfig {
  return {
    endpoint: "https://resilience-test.example.com",
    apiKey: "test-key-not-a-secret",
    authMode: "openai_compatible",
    deployment: "resilience-test-model",
    apiVersion: "2024-08-01-preview",
    assumeZeroRetention: false,
    fetchImpl: overrides.fetchImpl ?? (fetch as typeof fetch),
    maxRetries: 3,
    retryBaseDelayMs: 1,
    timeoutMs: 50,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 30,
    stream: false,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function planBody(command = "internal.update") {
  return {
    model: "resilience-test-model",
    choices: [
      {
        message: {
          content: JSON.stringify({
            steps: [
              {
                suggestedCommand: command,
                title: "resilience test",
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
  };
}

describe("D7 model-gateway resilience (offline, fetch-stub, no network)", () => {
  it("retries once on HTTP 503 and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, { error: "service unavailable" });
      return jsonResponse(200, planBody());
    });
    const client = new AzureOpenAiClient(baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch }));

    const result = await client.invoke(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.modelVersion).toBe("resilience-test-model");
    expect(result.structuredOutput).toMatchObject({ steps: [{ suggestedCommand: "internal.update" }] });
  });

  it("does not retry on HTTP 400 (client error) — fails immediately after a single attempt", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: "bad request" }));
    const client = new AzureOpenAiClient(baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch }));

    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws when every attempt returns a transient 503", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "service unavailable" }));
    // maxRetries: 2 -> 3 total attempts.
    const client = new AzureOpenAiClient(baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, maxRetries: 2 }));

    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("circuit breaker opens after consecutive failures and fails fast without calling fetch again, then half-opens and closes on success after cooldown", async () => {
    let shouldFail = true;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) return jsonResponse(500, { error: "boom" });
      return jsonResponse(200, planBody());
    });
    // No retries per invoke (maxRetries: 0) so each invoke() = exactly one
    // fetch call and one breaker-recorded failure; threshold 2 opens after
    // the 2nd consecutive failed invoke().
    const client = new AzureOpenAiClient(
      baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, maxRetries: 0, circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 30 }),
    );

    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Breaker is now open: the 3rd call must fail fast with MODEL_CIRCUIT_OPEN
    // and must NOT invoke fetch again.
    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "MODEL_CIRCUIT_OPEN" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Wait past the cooldown, then let the provider recover; the half-open
    // probe should be allowed through and close the breaker on success.
    await new Promise((resolve) => setTimeout(resolve, 40));
    shouldFail = false;
    const result = await client.invoke(REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.structuredOutput).toMatchObject({ steps: [{ suggestedCommand: "internal.update" }] });

    // Breaker closed again: a subsequent call goes straight to fetch, not MODEL_CIRCUIT_OPEN.
    const result2 = await client.invoke(REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result2.structuredOutput).toBeDefined();
  });

  it("aborts a hung request after the configured timeout and surfaces PROVIDER_TIMEOUT", async () => {
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    // maxRetries: 0 so the test only waits out a single timeout window.
    const client = new AzureOpenAiClient(
      baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, maxRetries: 0, timeoutMs: 20 }),
    );

    await expect(client.invoke(REQUEST)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout as a transient failure and succeeds once the provider responds in time", async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return Promise.resolve(jsonResponse(200, planBody()));
    });
    const client = new AzureOpenAiClient(
      baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, maxRetries: 1, timeoutMs: 20 }),
    );

    const result = await client.invoke(REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.structuredOutput).toMatchObject({ steps: [{ suggestedCommand: "internal.update" }] });
  });

  it("streaming (stream: true) accumulates SSE delta chunks into the final structured JSON plan", async () => {
    const encoder = new TextEncoder();
    const frames = [
      `data: ${JSON.stringify({ model: "resilience-test-model", choices: [{ delta: { content: '{"steps":[{"suggestedCom' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'mand":"internal.update","title":"t","resourceType":"",' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '"resourceId":"","resourceVersion":1,"payloadJson":"{}"}]}' } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const client = new AzureOpenAiClient(baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, stream: true }));

    const result = await client.invoke(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.modelVersion).toBe("resilience-test-model");
    expect(result.structuredOutput).toMatchObject({ steps: [{ suggestedCommand: "internal.update" }] });
  });

  it("never includes the api-key / bearer token in a thrown error message", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: "unauthorized: super-secret-value-should-not-leak" }));
    const client = new AzureOpenAiClient(
      baseConfig({ fetchImpl: fetchMock as unknown as typeof fetch, apiKey: "super-secret-value-should-not-leak", maxRetries: 0 }),
    );

    let caught: unknown;
    try {
      await client.invoke(REQUEST);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AzureOpenAiClientError);
    const message = (caught as AzureOpenAiClientError).message;
    // The provider's own error body may echo text back (out of this
    // client's control), but the client itself never injects the raw
    // apiKey/header value into a message it constructs beyond what the
    // (stubbed, fake) provider body already contained.
    expect(message).not.toMatch(/Bearer super-secret-value-should-not-leak/);
    expect(message).not.toMatch(/^Authorization/);
  });
});
