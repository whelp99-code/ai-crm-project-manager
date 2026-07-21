/**
 * @ai-crm/model-gateway — Azure OpenAI (chat-completions) `ModelClient`.
 *
 * This is the ONLY concrete provider adapter allowed to exist, and it lives
 * inside the model-gateway boundary (ADR-010): it holds the real HTTP client
 * and the model credential, and it is never constructed or imported outside
 * this package. `createApp()` in @ai-crm/api never wires this in by default —
 * every offline/CI test path keeps using an injected/mocked ModelClient, and
 * only an explicit, gated live test (`LIVE_MODEL_TEST=1`) ever constructs and
 * invokes this class.
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

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * Real Azure OpenAI (or OpenAI-compatible) chat-completions ModelClient.
 * Constructed ONLY inside this package; never exported to callers directly
 * for construction outside a `createApp({ modelClient })` wiring point.
 */
export class AzureOpenAiClient implements ModelClient {
  constructor(private readonly config: AzureOpenAiClientConfig) {}

  async invoke(request: ModelClientRequest): Promise<ModelClientResponse> {
    const body = {
      model: this.config.deployment,
      temperature: 0,
      stream: false,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: request.redactedPrompt },
      ],
    };

    const res = await this.config.fetchImpl(requestUrl(this.config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(this.config),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Never include the api-key header or its value in the thrown error.
      const text = await res.text().catch(() => "");
      throw new AzureOpenAiClientError(
        "PROVIDER_HTTP_ERROR",
        `Azure OpenAI request failed: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ""}`,
      );
    }

    const payload = (await res.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AzureOpenAiClientError("EMPTY_MODEL_OUTPUT", "Azure OpenAI response had no message content");
    }

    const structuredOutput = extractJsonObject(content);
    const modelVersion = payload.model?.trim() || this.config.deployment;

    return {
      structuredOutput,
      modelVersion,
      // Best-effort only: this REST call cannot itself prove the provider
      // discarded the prompt/response server-side. We only ever claim
      // zero-retention was honored when the deployment is documented (out of
      // band, via AZURE_OPENAI_ASSUME_ZERO_RETENTION=1) to be under a
      // zero-data-retention agreement; otherwise we honestly report false so
      // ModelGateway records the true retention mode ("retain").
      retentionHonored: request.requestedRetention === "zero-retention" && this.config.assumeZeroRetention,
    };
  }
}

/** Convenience factory: builds the client from process.env AZURE_OPENAI_* vars. */
export function createAzureOpenAiClient(overrides: Partial<AzureOpenAiClientConfig> = {}): AzureOpenAiClient {
  return new AzureOpenAiClient(resolveAzureOpenAiConfigFromEnv(overrides));
}
