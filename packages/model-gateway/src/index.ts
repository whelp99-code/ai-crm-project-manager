/**
 * @ai-crm/model-gateway — the single allowlisted non-effect LLM inference
 * boundary (ADR-010).
 *
 * This is the ONLY package permitted to hold a model client / provider egress.
 * It has NO effect capability: it cannot create/lease/dispatch execution
 * intents, it never imports `@ai-crm/connectors` or any dispatcher module, and
 * it writes nothing but its own `model_invocations` audit records. Every
 * invocation is registry-mapped to the non-effect `MODEL_INVOKE` action,
 * redacted before egress, requested in zero-retention mode where available,
 * and its free-text response is discarded — only schema-validated structured
 * output mapped to a registered operation may leave this boundary.
 *
 * The real provider SDK adapter is injected as a `ModelClient`. No other
 * package may construct one; capability confinement is asserted by the
 * boundary negative-test suite.
 */
import { createAzureOpenAiClient } from "./azure-openai-client.js";
import { createHash } from "node:crypto";
import type { ActionType } from "@ai-crm/contracts";

export class ModelGatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** The registry action every gateway invocation maps to. Effect is `none`. */
export const MODEL_GATEWAY_ACTION: ActionType = "MODEL_INVOKE";

export type RetentionMode = "zero-retention" | "retain";

/** Structured-output field validation. Free text is never accepted as output. */
export type OutputFieldSchema =
  | { kind: "string"; maxLength?: number }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "array"; of: OutputFieldSchema }
  | { kind: "object"; fields: Readonly<Record<string, OutputFieldSchema>> };

export interface StructuredOutputSchema {
  schemaVersion: string;
  root: { kind: "object"; fields: Readonly<Record<string, OutputFieldSchema>> };
}

export interface ModelInvocationRequest {
  workspaceId: string;
  /** Registry operation id; must resolve to MODEL_INVOKE via the injected resolver. */
  operationId: string;
  /** Model-gateway service principal; must be the dedicated gateway identity. */
  principalId: string;
  promptVersion: string;
  modelVersion: string;
  /** Free-text prompt; redacted before it can leave this boundary. */
  prompt: string;
  outputSchema: StructuredOutputSchema;
  correlationId: string;
  /** Requested retention mode; provider zero-retention is honored where available. */
  requestedRetention: RetentionMode;
}

export interface ModelInvocationRecord {
  id: string;
  workspaceId: string;
  operationId: string;
  actionType: ActionType;
  principalId: string;
  promptVersion: string;
  modelVersion: string;
  outputSchemaVersion: string;
  /** SHA-256 digests only; no raw prompt/response is ever persisted. */
  redactedPromptDigest: string;
  responseDigest: string;
  retentionMode: RetentionMode;
  latencyMs: number;
  correlationId: string;
  createdAt: string;
}

export interface ModelInvocationResult<T = Record<string, unknown>> {
  invocation: ModelInvocationRecord;
  /** Validated structured output only; free-text is discarded at the boundary. */
  structuredOutput: T;
}

/** Raw provider response before validation. `text` is intentionally discarded. */
export interface ModelClientResponse {
  structuredOutput: unknown;
  modelVersion: string;
  /** Whether the provider honored the zero-retention request for this call. */
  retentionHonored: boolean;
}

export interface ModelClientRequest {
  redactedPrompt: string;
  promptVersion: string;
  requestedRetention: RetentionMode;
  correlationId: string;
}

/**
 * Injected provider adapter. The concrete implementation (holding the real
 * SDK / HTTP client and the model credential) may ONLY be constructed inside
 * the model-gateway runtime. Callers of the gateway never see it.
 */
export interface ModelClient {
  invoke(request: ModelClientRequest): Promise<ModelClientResponse>;
}

/** Resolves a registry operation id to its ActionType; must yield MODEL_INVOKE. */
export type OperationResolver = (operationId: string) => ActionType;

/** Redaction rule: default scrubs emails, long digit runs, and RRNs. */
export type Redactor = (prompt: string) => string;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const LONG_DIGITS_RE = /\d{6,}/g;
const KRRN_RE = /\d{6}-\d{7}/g;

export const defaultRedactor: Redactor = (prompt) =>
  prompt
    .replace(KRRN_RE, "[REDACTED_RRN]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(LONG_DIGITS_RE, "[REDACTED_NUM]");

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validateOutput(value: unknown, schema: OutputFieldSchema, path: string): void {
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be a string`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} exceeds maxLength ${schema.maxLength}`);
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be a finite number`);
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be a boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) {
        throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be one of ${schema.values.join("|")}`);
      }
      return;
    case "array":
      if (!Array.isArray(value)) throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be an array`);
      value.forEach((item, index) => validateOutput(item, schema.of, `${path}[${index}]`));
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ModelGatewayError("SCHEMA_VIOLATION", `${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        if (!(key in record)) throw new ModelGatewayError("SCHEMA_VIOLATION", `${path}.${key} is required`);
        validateOutput(record[key], fieldSchema, `${path}.${key}`);
      }
      for (const key of Object.keys(record)) {
        if (!(key in schema.fields)) throw new ModelGatewayError("SCHEMA_VIOLATION", `${path}.${key} is not permitted by the output schema`);
      }
      return;
    }
  }
}

export interface ModelGatewayOptions {
  /** The dedicated gateway service principal; requests from any other principal are refused. */
  servicePrincipalId: string;
  resolveOperation: OperationResolver;
  redactor?: Redactor;
  clock?: () => number;
}

export class ModelGateway {
  private readonly invocations = new Map<string, ModelInvocationRecord>();
  private readonly redactor: Redactor;
  private readonly clock: () => number;
  private counter = 0;

  constructor(
    private readonly client: ModelClient,
    private readonly options: ModelGatewayOptions,
  ) {
    if (!options.servicePrincipalId.trim()) {
      throw new ModelGatewayError("INVALID_PRINCIPAL", "model gateway requires a dedicated service principal id");
    }
    this.redactor = options.redactor ?? defaultRedactor;
    this.clock = options.clock ?? Date.now;
  }
  /**
   * Restart-consistency hydrate-on-boot (Q2 / D2): rebuild the in-memory
   * invocations map wholesale from persisted `ModelInvocationRecord` rows
   * (read back from PG at process start via
   * `ModelInvocationRepository.listAllInvocations`), so a fresh process
   * reflects prior invocations instead of starting empty. Mirrors
   * `CrmService.hydrateCustomers` / `ReportService.hydrateSnapshots`.
   */
  hydrateInvocations(invocations: readonly ModelInvocationRecord[]): void {
    this.invocations.clear();
    for (const invocation of invocations) {
      this.invocations.set(invocation.id, structuredClone(invocation));
    }
  }

  async invoke<T = Record<string, unknown>>(request: ModelInvocationRequest): Promise<ModelInvocationResult<T>> {
    if (request.principalId !== this.options.servicePrincipalId) {
      throw new ModelGatewayError("PRINCIPAL_DENIED", "only the dedicated model-gateway principal may invoke inference");
    }
    const actionType = this.options.resolveOperation(request.operationId);
    if (actionType !== MODEL_GATEWAY_ACTION) {
      throw new ModelGatewayError("NON_MODEL_OPERATION", `operation ${request.operationId} is not a non-effect MODEL_INVOKE`);
    }
    if (!request.prompt.trim()) throw new ModelGatewayError("EMPTY_PROMPT", "prompt is required");

    const redactedPrompt = this.redactor(request.prompt);
    const started = this.clock();
    const response = await this.client.invoke({
      redactedPrompt,
      promptVersion: request.promptVersion,
      requestedRetention: request.requestedRetention,
      correlationId: request.correlationId,
    });
    const latencyMs = Math.max(0, this.clock() - started);

    validateOutput(response.structuredOutput, request.outputSchema.root, "$");

    const retentionMode: RetentionMode =
      request.requestedRetention === "zero-retention" && !response.retentionHonored ? "retain" : request.requestedRetention;
    if (request.requestedRetention === "zero-retention" && !response.retentionHonored) {
      // Provider could not honor zero-retention: record the true mode, never claim zero-retention falsely.
    }

    this.counter += 1;
    const invocation: ModelInvocationRecord = {
      id: `model-invocation-${this.counter.toString().padStart(6, "0")}`,
      workspaceId: request.workspaceId,
      operationId: request.operationId,
      actionType,
      principalId: request.principalId,
      promptVersion: request.promptVersion,
      modelVersion: response.modelVersion || request.modelVersion,
      outputSchemaVersion: request.outputSchema.schemaVersion,
      redactedPromptDigest: sha256(redactedPrompt),
      responseDigest: sha256(JSON.stringify(response.structuredOutput)),
      retentionMode,
      latencyMs,
      correlationId: request.correlationId,
      createdAt: new Date(started).toISOString(),
    };
    this.invocations.set(invocation.id, invocation);
    return { invocation: structuredClone(invocation), structuredOutput: structuredClone(response.structuredOutput) as T };
  }

  getInvocation(workspaceId: string, invocationId: string): ModelInvocationRecord {
    const record = this.invocations.get(invocationId);
    if (!record) throw new ModelGatewayError("NOT_FOUND", `invocation not found: ${invocationId}`);
    if (record.workspaceId !== workspaceId) throw new ModelGatewayError("CROSS_WORKSPACE", "invocation belongs to another workspace");
    return structuredClone(record);
  }

  listInvocations(workspaceId: string): ModelInvocationRecord[] {
    return [...this.invocations.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map((record) => structuredClone(record));
  }
}

/**
 * D7 default-wiring factory: resolves a live {@link ModelClient} from
 * `MODEL_PROVIDER` + `AZURE_OPENAI_*` process.env vars, or returns
 * `undefined` when no live provider should be constructed.
 *
 * - Unset / `mock` / `none` -> `undefined` (today's offline default,
 *   byte-for-byte unchanged: callers keep failing closed with
 *   `MODEL_UNAVAILABLE` unless they inject a `modelClient` themselves).
 * - `azure` / `openai_compatible` -> constructs a real
 *   {@link AzureOpenAiClient} from `AZURE_OPENAI_*` env vars (throws a
 *   secret-free {@link AzureOpenAiClientError} if required vars are missing).
 * - Any other value -> throws {@link ModelGatewayError} so a typo in
 *   `MODEL_PROVIDER` never silently falls back to the offline path.
 *
 * This function performs no network I/O; it only constructs the client.
 */
export function resolveModelClientFromEnv(): ModelClient | undefined {
  const raw = typeof process !== "undefined" ? process.env?.MODEL_PROVIDER : undefined;
  const provider = raw && raw.trim() ? raw.trim().toLowerCase() : undefined;
  if (!provider || provider === "mock" || provider === "none") return undefined;
  if (provider === "azure" || provider === "openai_compatible") {
    // openai_compatible provider implies the openai_compatible auth/URL shape
    // (Bearer + {endpoint}/chat/completions) unless AZURE_OPENAI_AUTH_MODE is set
    // explicitly — keeps the two knobs from silently diverging (an azure api-key
    // request shape against an openai-compatible endpoint would fail at first use).
    const authModeEnv =
      typeof process !== "undefined" ? process.env?.AZURE_OPENAI_AUTH_MODE : undefined;
    if (provider === "openai_compatible" && !(authModeEnv && authModeEnv.trim())) {
      return createAzureOpenAiClient({ authMode: "openai_compatible" });
    }
    return createAzureOpenAiClient();
  }
  throw new ModelGatewayError("MODEL_PROVIDER_UNSUPPORTED", `unsupported MODEL_PROVIDER: ${provider}`);
}
export {
  AzureOpenAiClient,
  AzureOpenAiClientError,
  createAzureOpenAiClient,
  resolveAzureOpenAiConfigFromEnv,
  type AzureOpenAiAuthMode,
  type AzureOpenAiClientConfig,
} from "./azure-openai-client.js";
