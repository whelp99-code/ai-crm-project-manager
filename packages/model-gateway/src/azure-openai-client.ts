/**
 * @ai-crm/model-gateway — Azure OpenAI (chat-completions) `ModelClient`.
 *
 * This is the ONLY concrete provider adapter allowed to exist, and it lives
 * inside the model-gateway boundary (ADR-010): it holds the real HTTP client
 * and the model credential, and it is never constructed or imported outside
 * this package. `createApp()` in @ai-crm/api never wires this in by default —
 * every offline/CI test path keeps using an injected/mocked ModelClient, and
 * only an explicit, gated live test (`LIVE_MODEL_TEST=1`) or an explicit
 * `MODEL_PROVIDER` env value ever constructs and invokes this class.
 *
 * Credentials are read from process.env ONLY. They are never logged, never
 * embedded in error messages, and never returned to a caller.
 *
 * Supported deployments:
 *  - A real Azure OpenAI resource
 *    (`https://<resource>.openai.azure.com`), using the
 *    `/openai/deployments/<deployment>/chat/completions?api-version=...`
 *    shape and the `api-key` header (`AZURE_OPENAI_AUTH_MODE=api-key`, the
 *    Azure default).
 *  - Any OpenAI-compatible chat-completions gateway (`AZURE_OPENAI_ENDPOINT`
 *    already includes its own version segment, e.g. `.../v1`), using
 *    `POST {endpoint}/chat/completions` and an `Authorization: Bearer`
 *    header (`AZURE_OPENAI_AUTH_MODE=openai_compatible`).
 *
 * The client asks the model for exactly the JSON shape the natural-command
 * plan pipeline (`apps/api/src/services/natural-command.ts`,
 * `NATURAL_COMMAND_PLAN_SCHEMA`) already validates — a `{ steps: [...] }`
 * object whose `suggestedCommand` values are drawn from the S0 COMMAND_MAP
 * allowlist. The gateway itself has no knowledge of the schema shape (it only
 * sees `ModelClientResponse.structuredOutput: unknown`); this client encodes
 * that contract in its own system prompt because it is the only piece of
 * code allowed to talk to the model.
 *
 * Resilience (D7 gap-closer PG-E):
 *  - Per-request timeout via `AbortController` (`AZURE_OPENAI_TIMEOUT_MS`).
 *  - Retry with exponential backoff + jitter on transient failures only —
 *    network errors, timeouts, and HTTP 429/500/502/503/504
 *    (`AZURE_OPENAI_MAX_RETRIES`, `AZURE_OPENAI_RETRY_BASE_DELAY_MS`). Client
 *    errors (4xx other than 429) are never retried.
 *  - An in-process, per-client circuit breaker: after
 *    `AZURE_OPENAI_CIRCUIT_BREAKER_THRESHOLD` consecutive whole-invocation
 *    failures it opens and fails fast with `MODEL_CIRCUIT_OPEN` for
 *    `AZURE_OPENAI_CIRCUIT_BREAKER_COOLDOWN_MS`, then half-opens for a single
 *    probe request before closing again on success.
 *  - Optional streaming (`AZURE_OPENAI_STREAM=1`): sends `stream: true` and
 *    accumulates the SSE `delta.content` chunks before parsing the
 *    structured JSON plan once the stream completes (the plan is a single
 *    JSON object; it cannot be validated until it is fully assembled, so
 *    streaming here only removes the "wait for the whole response before any
 *    bytes arrive" latency — it does not stream partial structured output to
 *    callers). This is an honest, thin streaming path, not partial-JSON
 *    incremental parsing.
 */
import type { ModelClient, ModelClientRequest, ModelClientResponse } from "./index.js";

export class AzureOpenAiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AzureOpenAiClientError";
  }
}

export type AzureOpenAiAuthMode = "api-key" | "openai_compatible" | "azure_ad";

export interface AzureOpenAiClientConfig {
  /** e.g. `https://<resource>.openai.azure.com` or an OpenAI-compatible base URL ending in `/v1`. */
  endpoint: string;
  apiKey: string;
  authMode: AzureOpenAiAuthMode;
  /** Azure deployment name, or the model id for an OpenAI-compatible gateway. */
  deployment: string;
  /** Only used for the real Azure `.openai.azure.com` REST shape. */
  apiVersion: string;
  /** Best-effort: only true when the deployment is contractually known to honor zero-retention out of band. */
  assumeZeroRetention: boolean;
  fetchImpl: typeof fetch;
  /** Max retry attempts (in addition to the first attempt) on transient failures. 0 disables retry. */
  maxRetries: number;
  /** Base delay (ms) for exponential backoff between retries; jitter is added on top. */
  retryBaseDelayMs: number;
  /** Per-request timeout (ms) enforced via AbortController. */
  timeoutMs: number;
  /** Consecutive whole-invocation failures before the circuit breaker opens. */
  circuitBreakerThreshold: number;
  /** How long (ms) the breaker stays open before allowing a single half-open probe. */
  circuitBreakerCooldownMs: number;
  /** When true, requests the chat-completions stream and accumulates SSE deltas before parsing. */
  stream: boolean;
}

/**
 * The S0 command allowlist the model must choose from — mirrors
 * `apps/api/src/command-map.ts` `COMMAND_MAP` exactly (kept in sync there;
 * model-gateway cannot import from apps/api, so this is a literal copy for
 * prompt-construction purposes only, never used for authorization).
 */
const ALLOWED_COMMANDS = ["pm.task_assign", "pm.plan_revise", "pm.target_set", "pm.plan_create", "internal.update"] as const;

const SYSTEM_PROMPT = `You are the plan-inference step of a governed command pipeline.
Given a short natural-language instruction, respond with STRICT JSON ONLY —
no markdown code fences, no prose before or after — matching exactly this shape:

{"steps":[{"suggestedCommand":"<one of: ${ALLOWED_COMMANDS.join(", ")}>","title":"<short title>","resourceType":"","resourceId":"","resourceVersion":1,"payloadJson":"<JSON-encoded string of a small object>"}]}

Rules:
- "steps" must be a non-empty array.
- "suggestedCommand" MUST be exactly one of the allowed values listed above; if
  none clearly applies, use "internal.update".
- "resourceType"/"resourceId" MAY be left as empty strings when no specific
  resource applies; if you set one you MUST set the other.
- "payloadJson" MUST be a string containing valid JSON (use "{}" if there is
  nothing to encode).
- Output ONLY the JSON object. Do not wrap it in \`\`\` fences.`;

function readEnv(name: string): string | undefined {
  const value = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return value && value.trim() ? value.trim() : undefined;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeAuthMode(raw: string | undefined): AzureOpenAiAuthMode {
  if (raw === "openai_compatible" || raw === "azure_ad") return raw;
  return "api-key";
}

/** Reads AZURE_OPENAI_* from process.env; throws a clear, secret-free error if required vars are missing. */
export function resolveAzureOpenAiConfigFromEnv(overrides: Partial<AzureOpenAiClientConfig> = {}): AzureOpenAiClientConfig {
  const endpoint = overrides.endpoint ?? readEnv("AZURE_OPENAI_ENDPOINT");
  const apiKey = overrides.apiKey ?? readEnv("AZURE_OPENAI_API_KEY");
  if (!endpoint) {
    throw new AzureOpenAiClientError("MISSING_ENDPOINT", "AZURE_OPENAI_ENDPOINT is not set");
  }
  if (!apiKey) {
    throw new AzureOpenAiClientError("MISSING_API_KEY", "AZURE_OPENAI_API_KEY is not set");
  }
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    authMode: overrides.authMode ?? normalizeAuthMode(readEnv("AZURE_OPENAI_AUTH_MODE")),
    deployment: overrides.deployment ?? readEnv("AZURE_OPENAI_DEPLOYMENT") ?? readEnv("AZURE_OPENAI_MODEL") ?? "kr/claude-haiku-4.5",
    apiVersion: overrides.apiVersion ?? readEnv("AZURE_OPENAI_API_VERSION") ?? "2024-08-01-preview",
    assumeZeroRetention: overrides.assumeZeroRetention ?? readEnv("AZURE_OPENAI_ASSUME_ZERO_RETENTION") === "1",
    fetchImpl: overrides.fetchImpl ?? fetch,
    maxRetries: overrides.maxRetries ?? readIntEnv("AZURE_OPENAI_MAX_RETRIES", 3),
    retryBaseDelayMs: overrides.retryBaseDelayMs ?? readIntEnv("AZURE_OPENAI_RETRY_BASE_DELAY_MS", 300),
    timeoutMs: overrides.timeoutMs ?? readIntEnv("AZURE_OPENAI_TIMEOUT_MS", 30_000),
    circuitBreakerThreshold: overrides.circuitBreakerThreshold ?? readIntEnv("AZURE_OPENAI_CIRCUIT_BREAKER_THRESHOLD", 5),
    circuitBreakerCooldownMs: overrides.circuitBreakerCooldownMs ?? readIntEnv("AZURE_OPENAI_CIRCUIT_BREAKER_COOLDOWN_MS", 30_000),
    stream: overrides.stream ?? readEnv("AZURE_OPENAI_STREAM") === "1",
  };
}

function requestUrl(config: AzureOpenAiClientConfig): string {
  if (config.authMode === "openai_compatible") {
    return `${config.endpoint}/chat/completions`;
  }
  // Real Azure OpenAI REST shape.
  return `${config.endpoint}/openai/deployments/${encodeURIComponent(config.deployment)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion)}`;
}

function authHeaders(config: AzureOpenAiClientConfig): Record<string, string> {
  if (config.authMode === "openai_compatible" || config.authMode === "azure_ad") {
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  return { "api-key": config.apiKey };
}

/** Strips ```json fences (some models add them despite instructions) and extracts the first balanced JSON object. */
function extractJsonObject(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to a bracket-matching scan for the first balanced object.
  }
  const start = stripped.indexOf("{");
  if (start === -1) {
    throw new AzureOpenAiClientError("INVALID_MODEL_OUTPUT", "model response contained no JSON object");
  }
  let depth = 0;
  for (let i = start; i < stripped.length; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          throw new AzureOpenAiClientError("INVALID_MODEL_OUTPUT", "model response was not valid JSON");
        }
      }
    }
  }
  throw new AzureOpenAiClientError("INVALID_MODEL_OUTPUT", "model response had an unbalanced JSON object");
}

/** Wraps `extractJsonObject`, converting its thrown error into a non-retryable `AttemptFailure`. */
function extractJsonObjectOrFail(raw: string): unknown {
  try {
    return extractJsonObject(raw);
  } catch (err) {
    if (err instanceof AzureOpenAiClientError) throw new AttemptFailure(false, err);
    throw err;
  }
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface ChatCompletionStreamChunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null } }>;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with full jitter: base * 2^attempt, plus up to one more base's worth of jitter. */
function backoffDelayMs(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  return baseMs * 2 ** attempt + Math.random() * baseMs;
}

/** Internal marker distinguishing retryable transient failures from terminal ones. Never exported. */
class AttemptFailure extends Error {
  constructor(
    readonly retryable: boolean,
    readonly clientError: AzureOpenAiClientError,
  ) {
    super(clientError.message);
    this.name = "AttemptFailure";
  }
}

function toClientError(err: unknown): AzureOpenAiClientError {
  if (err instanceof AzureOpenAiClientError) return err;
  return new AzureOpenAiClientError("UNEXPECTED_ERROR", errorMessage(err));
}

type BreakerState = "closed" | "open" | "half-open";

/**
 * In-process, per-client circuit breaker. Counts consecutive
 * whole-invocation failures (after retries are exhausted); once the
 * threshold is reached it opens and fails fast until the cooldown elapses,
 * then allows exactly one half-open probe before closing (on success) or
 * re-opening (on failure).
 */
class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a request may be attempted right now. Transitions open -> half-open when the cooldown has elapsed. */
  canRequest(): boolean {
    if (this.failureThreshold <= 0) return true; // breaker disabled
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }
    if (this.state === "half-open") {
      // Gate half-open to exactly one in-flight probe: concurrent invoke()
      // calls during the cooldown-elapsed window must not all hit the
      // provider. The first caller through flips probeInFlight; it is
      // cleared again by recordSuccess/recordFailure once that probe
      // resolves.
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
    this.probeInFlight = false;
  }
}

/**
 * Real Azure OpenAI (or OpenAI-compatible) chat-completions ModelClient.
 * Constructed ONLY inside this package; never exported to callers directly
 * for construction outside a `createApp({ modelClient })` wiring point.
 */
export class AzureOpenAiClient implements ModelClient {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly config: AzureOpenAiClientConfig) {
    this.breaker = new CircuitBreaker(config.circuitBreakerThreshold, config.circuitBreakerCooldownMs);
  }

  async invoke(request: ModelClientRequest): Promise<ModelClientResponse> {
    if (!this.breaker.canRequest()) {
      throw new AzureOpenAiClientError(
        "MODEL_CIRCUIT_OPEN",
        `circuit breaker is open after repeated provider failures; failing fast for up to ${this.config.circuitBreakerCooldownMs}ms instead of calling the provider`,
      );
    }

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let lastClientError: AzureOpenAiClientError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = this.config.stream ? await this.attemptStreaming(request) : await this.attemptOnce(request);
        this.breaker.recordSuccess();
        return response;
      } catch (err) {
        const failure = err instanceof AttemptFailure ? err : new AttemptFailure(false, toClientError(err));
        lastClientError = failure.clientError;
        const isLastAttempt = attempt === maxAttempts - 1;
        if (!failure.retryable || isLastAttempt) {
          this.breaker.recordFailure();
          throw failure.clientError;
        }
        await sleep(backoffDelayMs(attempt, this.config.retryBaseDelayMs));
      }
    }

    // Unreachable (the loop above always returns or throws), but keeps control flow explicit for TS.
    throw lastClientError ?? new AzureOpenAiClientError("PROVIDER_HTTP_ERROR", "Azure OpenAI request failed");
  }

  private buildRequestBody(request: ModelClientRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.config.deployment,
      temperature: 0,
      stream,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: request.redactedPrompt },
      ],
    };
  }

  /**
   * Runs `fn` under a single AbortController/timer that stays armed for the
   * ENTIRE attempt — not just until response headers resolve. `fn` receives
   * the abort signal and is expected to thread it through both the initial
   * fetch and any subsequent body/stream reads (`res.json()`, `res.text()`,
   * `consumeSse`), so a provider that returns 200 headers and then stalls
   * mid-body/mid-stream still gets aborted and surfaced as a retryable
   * PROVIDER_TIMEOUT, instead of hanging indefinitely. The timer is always
   * cleared, on both success and failure, via `finally`.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (err) {
      // Business-logic failures raised deeper in the pipeline (bad HTTP
      // status, empty content, JSON-parse failure) already carry their own
      // retryability classification — pass them through unchanged.
      if (err instanceof AttemptFailure) throw err;
      if (isAbortError(err)) {
        throw new AttemptFailure(
          true,
          new AzureOpenAiClientError("PROVIDER_TIMEOUT", `Azure OpenAI request timed out after ${this.config.timeoutMs}ms`),
        );
      }
      // Any other failure — before headers OR mid-body/mid-stream (e.g. a
      // connection reset while reading the response) — is treated as a
      // retryable network error, for parity with a pre-header network drop.
      // Never include the api-key header or its value in the thrown error.
      throw new AttemptFailure(
        true,
        new AzureOpenAiClientError("NETWORK_ERROR", `Azure OpenAI request failed: ${errorMessage(err)}`),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private doFetch(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return this.config.fetchImpl(requestUrl(this.config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(this.config),
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    // Never include the api-key header or its value in the thrown error.
    const text = await res.text().catch(() => "");
    const message = `Azure OpenAI request failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ""}`;
    throw new AttemptFailure(RETRYABLE_STATUSES.has(res.status), new AzureOpenAiClientError("PROVIDER_HTTP_ERROR", message));
  }

  private toModelClientResponse(content: string, modelVersion: string | undefined, request: ModelClientRequest): ModelClientResponse {
    if (!content.trim()) {
      throw new AttemptFailure(false, new AzureOpenAiClientError("EMPTY_MODEL_OUTPUT", "Azure OpenAI response had no message content"));
    }
    const structuredOutput = extractJsonObjectOrFail(content);
    return {
      structuredOutput,
      modelVersion: modelVersion?.trim() || this.config.deployment,
      // Best-effort only: this REST call cannot itself prove the provider
      // discarded the prompt/response server-side. We only ever claim
      // zero-retention was honored when the deployment is documented (out of
      // band, via AZURE_OPENAI_ASSUME_ZERO_RETENTION=1) to be under a
      // zero-data-retention agreement; otherwise we honestly report false so
      // ModelGateway records the true retention mode ("retain").
      retentionHonored: request.requestedRetention === "zero-retention" && this.config.assumeZeroRetention,
    };
  }

  private async attemptOnce(request: ModelClientRequest): Promise<ModelClientResponse> {
    return this.withTimeout(async (signal) => {
      const res = await this.doFetch(this.buildRequestBody(request, false), signal);
      await this.assertOk(res);
      const payload = (await res.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      return this.toModelClientResponse(typeof content === "string" ? content : "", payload.model, request);
    });
  }

  private async attemptStreaming(request: ModelClientRequest): Promise<ModelClientResponse> {
    return this.withTimeout(async (signal) => {
      const res = await this.doFetch(this.buildRequestBody(request, true), signal);
      await this.assertOk(res);
      if (!res.body) {
        // Gateway/stub did not expose a stream body despite stream:true; fall
        // back to treating the whole response as a single JSON payload rather
        // than failing a resilience feature that is opt-in and best-effort.
        const payload = (await res.json()) as ChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        return this.toModelClientResponse(typeof content === "string" ? content : "", payload.model, request);
      }
      const { content, model } = await this.consumeSse(res.body);
      return this.toModelClientResponse(content, model, request);
    });
  }

  /** Reads an SSE `data: {...}` stream and accumulates `choices[0].delta.content` chunks. Ignores `[DONE]` and malformed frames. */
  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<{ content: string; model: string | undefined }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let model: string | undefined;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice("data:".length).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data) as ChatCompletionStreamChunk;
            if (chunk.model) model = chunk.model;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string") content += delta;
          } catch {
            // Ignore malformed SSE frames; best-effort accumulation.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return { content, model };
  }
}

/** Convenience factory: builds the client from process.env AZURE_OPENAI_* vars. */
export function createAzureOpenAiClient(overrides: Partial<AzureOpenAiClientConfig> = {}): AzureOpenAiClient {
  return new AzureOpenAiClient(resolveAzureOpenAiConfigFromEnv(overrides));
}
