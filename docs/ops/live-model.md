# Live model call (D7): real Azure OpenAI ModelClient

See `docs/ops/pilot-runbook.md` section (d) for the pilot secret-management
checklist (env-only, never commit, rotate) that applies these vars.

Closes the "zero live model calls, mock only" gap. Every existing test in
this repo (offline default) still injects a deterministic mock `ModelClient`
into `createApp({ modelClient })`, or sets no client/provider at all — this
doc adds a **real**, network-calling `ModelClient` implementation, a gated
integration test that actually calls it, and (D7 gap-closer) first-class
default wiring behind `MODEL_PROVIDER` so the real client is no longer only
ever constructed inside a gated test. The offline default is unchanged: with
no `modelClient` injected and no `MODEL_PROVIDER` set, `createApp()` still
never constructs a live client and inference still fails closed with
`MODEL_UNAVAILABLE`, byte-for-byte as before this change.

## Default wiring: `MODEL_PROVIDER` (D7 gap-closer)

`createApp()` resolves the model client in this order:

1. `options.modelClient` — if a caller/test injects one, it always wins
   (unchanged; every existing test keeps doing exactly this).
2. Otherwise, `MODEL_PROVIDER` from `process.env`:
   - unset, `mock`, or `none` → **no** live client is constructed; inference
     stays disabled fail-closed (`MODEL_UNAVAILABLE`) — today's offline
     default, unchanged.
   - `azure` or `openai_compatible` → constructs a real
     `createAzureOpenAiClient()` from the `AZURE_OPENAI_*` vars below.
   - any other value → `createApp()` throws immediately
     (`ModelGatewayError("MODEL_PROVIDER_UNSUPPORTED", ...)`) rather than
     silently falling back to offline — a typo in `MODEL_PROVIDER` must be
     loud, not silently ignored.

See `packages/model-gateway/src/index.ts` (`resolveModelClientFromEnv`) and
`apps/api/src/app.ts` (`createApp`'s `modelGateway` construction) for the
implementation, and
`apps/api/test/model-provider-wiring.integration.test.ts` for the offline
(no-network) proof: it asserts the unset/`mock`/`none` fail-closed path is
unchanged, that `MODEL_PROVIDER=azure` / `openai_compatible` actually
construct and use the live client (with `fetch` stubbed so no real network
call is made), and that an injected `modelClient` still wins over
`MODEL_PROVIDER`.

## What was added

- `packages/model-gateway/src/azure-openai-client.ts` — `AzureOpenAiClient`,
  a concrete `ModelClient` (the interface `@ai-crm/model-gateway/src/index.ts`
  already defines and injects into `ModelGateway`). It calls the Azure OpenAI
  (or any OpenAI-compatible) chat-completions endpoint over HTTP, asks for a
  strict-JSON plan (`{ steps: [...] }`, the same shape
  `NATURAL_COMMAND_PLAN_SCHEMA` in `apps/api` already validates), and returns
  `{ structuredOutput, modelVersion, retentionHonored }`.
- `packages/model-gateway/src/index.ts` now re-exports
  `AzureOpenAiClient` / `createAzureOpenAiClient` /
  `resolveAzureOpenAiConfigFromEnv`, and exports
  `resolveModelClientFromEnv()` — the D7 default-wiring factory
  `createApp()` calls when no `modelClient` is injected.
- `apps/api/src/app.ts` — `createApp()`'s `modelGateway` construction now
  falls back to `resolveModelClientFromEnv()` (i.e. `MODEL_PROVIDER`) instead
  of only ever using an injected `options.modelClient`.
- `apps/api/test/live-model.integration.test.ts` — gated (`LIVE_MODEL_TEST=1`)
  integration test; the only place in the repo that makes a real network
  call to the provider.
- `apps/api/test/model-provider-wiring.integration.test.ts` — offline,
  network-free test proving the `MODEL_PROVIDER` flag logic itself
  (construction path, fail-closed default, injection precedence,
  unsupported-value rejection).

## Env vars

Read from `process.env` only. Never hardcoded, never logged (the client
never puts the key or bearer token into a log line or a thrown error
message).

| Var | Required | Notes |
|---|---|---|
| `MODEL_PROVIDER` | no (default unset → offline/fail-closed) | `azure` or `openai_compatible` → `createApp()` constructs a real `AzureOpenAiClient` from the vars below when no `modelClient` was injected. `mock` / `none` / unset → no live client; inference stays `MODEL_UNAVAILABLE`. Any other value → `createApp()` throws at boot. |
| `AZURE_OPENAI_ENDPOINT` | only when `MODEL_PROVIDER` is `azure`/`openai_compatible` | Either a real Azure resource base URL (`https://<resource>.openai.azure.com`) or an OpenAI-compatible gateway base URL (e.g. `http://host:port/v1`). Trailing slash is stripped. |
| `AZURE_OPENAI_API_KEY` | only when `MODEL_PROVIDER` is `azure`/`openai_compatible` | Sent as the `api-key` header (Azure REST) or as `Authorization: Bearer` (OpenAI-compatible / `azure_ad`). Never printed. |
| `AZURE_OPENAI_AUTH_MODE` | no (default `api-key`) | `api-key` → Azure `/openai/deployments/<deployment>/chat/completions?api-version=...` + `api-key` header. `openai_compatible` → `POST {endpoint}/chat/completions` + `Authorization: Bearer`. `azure_ad` → same URL shape as `api-key`-off but Bearer auth (token already resolved into `AZURE_OPENAI_API_KEY` by the caller). |
| `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_MODEL` | no | Azure deployment name, or the model id for an OpenAI-compatible gateway. Defaults to `kr/claude-haiku-4.5` (a small/cheap deployment available on the pilot's configured gateway) if unset — set this explicitly for any other environment. |
| `AZURE_OPENAI_API_VERSION` | no | Only used for the real Azure REST shape. Defaults to `2024-08-01-preview`. |
| `AZURE_OPENAI_ASSUME_ZERO_RETENTION` | no | Set to `1` only when the deployment is contractually known (out of band) to honor zero-data-retention. A plain REST chat-completions call cannot itself prove the provider discarded the prompt/response server-side, so absent this flag the client honestly reports `retentionHonored: false` and `ModelGateway` then records the true `retentionMode: "retain"` rather than fabricating a zero-retention claim. |
| `AZURE_OPENAI_MAX_RETRIES` | no (default `3`) | Extra retry attempts (beyond the first) on transient failures only: network errors, per-request timeouts, and HTTP `429`/`500`/`502`/`503`/`504`. Other 4xx responses (e.g. `400`/`401`/`403`) are never retried. `0` disables retry. |
| `AZURE_OPENAI_RETRY_BASE_DELAY_MS` | no (default `300`) | Base delay for exponential backoff between retries (`base * 2^attempt` plus up to one more `base`'s worth of random jitter). |
| `AZURE_OPENAI_TIMEOUT_MS` | no (default `30000`) | Per-request timeout enforced via `AbortController`; covers the ENTIRE attempt (headers + body/SSE-stream consumption), so a gateway that returns headers and then stalls mid-body/mid-stream is aborted just like a hung connection, and treated as a retryable `PROVIDER_TIMEOUT` rather than blocking indefinitely. |
| `AZURE_OPENAI_CIRCUIT_BREAKER_THRESHOLD` | no (default `5`) | Consecutive whole-invocation failures (i.e. after retries for that call are exhausted) before the in-process, per-client circuit breaker opens. |
| `AZURE_OPENAI_CIRCUIT_BREAKER_COOLDOWN_MS` | no (default `30000`) | How long the breaker stays open before allowing a single half-open probe request through; the probe closes the breaker on success or re-opens it on failure. While open, `invoke()` fails fast with `AzureOpenAiClientError("MODEL_CIRCUIT_OPEN", ...)` without calling the provider. |
| `AZURE_OPENAI_STREAM` | no (default unset/`false`) | Set to `1` to request `stream: true` and accumulate the SSE `delta.content` chunks before parsing the structured JSON plan once the stream completes. See "Streaming scope" below — this removes response-buffering latency, it does not stream partial structured output to callers (the plan is one JSON object and cannot be validated before it is complete). |

## Running the offline `MODEL_PROVIDER` wiring test

```
pnpm --filter @ai-crm/api exec vitest run test/model-provider-wiring.integration.test.ts
```

Runs unconditionally, network-free, in every `pnpm --filter @ai-crm/api
test`. Stubs `global.fetch` for the `MODEL_PROVIDER=azure` /
`openai_compatible` cases so the flag-logic wiring is proven without ever
reaching the network.
```
pnpm --filter @ai-crm/api exec vitest run test/model-resilience.integration.test.ts
```

Also runs unconditionally, network-free (fetch is always a hand-rolled
stub), in every `pnpm --filter @ai-crm/api test`. Proves, directly against
`AzureOpenAiClient`: retry-then-succeed on HTTP 503, no-retry on HTTP 400,
retry-exhaustion after `AZURE_OPENAI_MAX_RETRIES`, the circuit breaker
opening after consecutive failures / failing fast with `MODEL_CIRCUIT_OPEN`
/ half-opening and closing again after the cooldown, a hung request being
aborted by `AZURE_OPENAI_TIMEOUT_MS` (and timeouts themselves being retried
as transient failures), the `AZURE_OPENAI_STREAM=1` SSE-accumulation path,
and that no thrown error message ever contains the raw api-key/bearer value.

## Running the live test

```
LIVE_MODEL_TEST=1 pnpm --filter @ai-crm/api exec vitest run test/live-model.integration.test.ts
```

Without `LIVE_MODEL_TEST=1` the test is `describe.skipIf`-skipped — `pnpm
--filter @ai-crm/api test` and `pnpm --filter @ai-crm/model-gateway test`
stay fully offline/mocked and green, exactly as before this change.

The test builds one real `AzureOpenAiClient`, wraps it in a thin
pass-through so the raw `ModelClientResponse` can be asserted on, wires it
into `createApp({ modelClient, modelServicePrincipalId: "principal-model-gateway" })`,
and drives it through `POST /api/agent/commands` with a natural-language
instruction — **one** live network call total. It asserts:

- the model invocation ran as `principalId: "principal-model-gateway"` /
  `actionType: "MODEL_INVOKE"` (via `GET /api/model/invocations`), never as
  the requesting operator;
- `modelVersion` is a non-empty string taken from the live provider response
  (not a fixture string);
- `retentionHonored` on the raw response is a real boolean and
  `retentionMode` on the persisted invocation record is one of
  `"zero-retention" | "retain"`;
- the job/work-item produced by `POST /api/agent/commands` came from the
  live model's own `steps` output (`suggestedCommand` is read back from the
  provider's response, not hardcoded in the test) — either mapped to a real
  effect (`status: "done"`) or fail-closed as `UNMAPPED_COMMAND`
  (`status: "failed"`), both of which are legitimate live outcomes.

### Observed result (this pilot's configured gateway)

Run against the pilot host's `AZURE_OPENAI_ENDPOINT` (an OpenAI-compatible
gateway, `AZURE_OPENAI_AUTH_MODE=openai_compatible`, deployment defaulted to
`kr/claude-haiku-4.5`):

```
✓ test/live-model.integration.test.ts (1 test) ~2.8s
  ✓ D7 live model: real Azure OpenAI call drives the full agent-command
    effect path > POST /api/agent/commands with a real Azure OpenAI plan
    response produces a real job (not a mock)
```

The live call returned `modelVersion: "claude-haiku-4.5"` and a
`{"steps":[{"suggestedCommand":"internal.update", ...}]}` plan that mapped
to `INTERNAL_REVERSIBLE_UPDATE` and completed the work item — a real model
response driving the effect path end to end.

## Resilience (D7 gap closer PG-E: retry / circuit breaker / timeout / streaming)

`AzureOpenAiClient` now wraps every provider call with:

- **Timeout**: an `AbortController` aborts the ENTIRE attempt — headers
  AND body/SSE-stream consumption — after `AZURE_OPENAI_TIMEOUT_MS`; a
  gateway that returns headers and then stalls mid-body/mid-stream is
  aborted just like a hung connection. The abort is surfaced as a
  retryable `PROVIDER_TIMEOUT`.
- **Retry with backoff**: network errors, timeouts, and HTTP
  `429`/`500`/`502`/`503`/`504` are retried up to `AZURE_OPENAI_MAX_RETRIES`
  times with exponential backoff + jitter
  (`AZURE_OPENAI_RETRY_BASE_DELAY_MS`). Other 4xx responses are never
  retried — a bad request stays a bad request.
- **Circuit breaker**: a per-`AzureOpenAiClient`-instance, in-process
  breaker counts consecutive whole-invocation failures (after each
  invocation's own retries are exhausted); once
  `AZURE_OPENAI_CIRCUIT_BREAKER_THRESHOLD` is reached it opens and every
  `invoke()` fails immediately with
  `AzureOpenAiClientError("MODEL_CIRCUIT_OPEN", ...)` — no provider call is
  made — until `AZURE_OPENAI_CIRCUIT_BREAKER_COOLDOWN_MS` elapses, at which
  point a single half-open probe request is allowed through: success closes
  the breaker, failure re-opens it.
- **Streaming (opt-in, `AZURE_OPENAI_STREAM=1`)**: sends `stream: true` and
  reads the SSE body, accumulating `choices[0].delta.content` chunks as they
  arrive, then parses the fully-assembled text as the structured JSON plan
  once the stream ends. This is an honest, thin streaming path: the natural-
  command plan is a single JSON object and cannot be validated before it is
  complete, so streaming here only avoids buffering the entire HTTP response
  before any bytes are read — it does **not** stream partial structured
  output to `ModelGateway`/callers, and it is not a general-purpose
  token-streaming API. If a gateway's `stream: true` response has no
  readable body, the client transparently falls back to parsing the whole
  response as a single JSON payload rather than failing the (opt-in,
  best-effort) streaming path.

All four knobs are read from `process.env` (`AZURE_OPENAI_MAX_RETRIES`,
`AZURE_OPENAI_RETRY_BASE_DELAY_MS`, `AZURE_OPENAI_TIMEOUT_MS`,
`AZURE_OPENAI_CIRCUIT_BREAKER_THRESHOLD`,
`AZURE_OPENAI_CIRCUIT_BREAKER_COOLDOWN_MS`, `AZURE_OPENAI_STREAM`; see the
table above for defaults) and never logged. This resilience layer only
exists on the real `AzureOpenAiClient` path — the offline/mock default
(`MODEL_PROVIDER` unset/`mock`/`none`, no injected `modelClient`) is
byte-for-byte unchanged, proven by
`test/model-provider-wiring.integration.test.ts`'s first two cases and every
other existing test file in the repo that never touches `MODEL_PROVIDER`.

Proven offline (no network) by
`test/model-resilience.integration.test.ts`, exercising `AzureOpenAiClient`
directly with a stubbed `fetchImpl` for every case above (retry-then-succeed,
no-retry-on-4xx, retry-exhaustion, breaker open/half-open/close, timeout
abort (both before headers and after headers during body/SSE-stream
stall), a retryable mid-stream network reset, streaming SSE accumulation,
and secret-free error messages).

## Honest scope / what this is NOT

- This client still makes a single deterministic (`temperature: 0`)
  request/response call per attempt; the resilience layer only governs how
  many times and how it retries/backs off/gives up, not the model's
  sampling behavior.
- Streaming is opt-in and thin (see above): it reduces response-buffering
  latency for the one call this client makes, it does not turn the
  natural-command pipeline into a token-by-token streaming API, and there is
  still no provider fallback (only one provider adapter exists by design,
  ADR-010).
- The circuit breaker is in-process and per-`AzureOpenAiClient` instance —
  it resets on process restart and does not coordinate across multiple API
  process instances/replicas. That is an acceptable pilot-grade scope; a
  shared/distributed breaker (e.g. backed by Redis) is further work if this
  ever runs multi-replica.
- `retentionHonored` is best-effort and explicit: a bare REST call cannot
  verify server-side data handling. Treat `AZURE_OPENAI_ASSUME_ZERO_RETENTION`
  as a documentation flag for an out-of-band contractual guarantee, not
  something this code verifies.
- `createApp()` still never wires a live client in unless `MODEL_PROVIDER`
  is explicitly set to `azure` / `openai_compatible` (or a caller injects
  `modelClient` directly, e.g. `createApp({ modelClient: createAzureOpenAiClient() })`).
  With no `MODEL_PROVIDER` and no injected `modelClient`, behavior is
  unchanged: every other test file in the repo, and any deployment that
  leaves `MODEL_PROVIDER` unset, stays fully offline/fail-closed.
- Setting `MODEL_PROVIDER=azure` in production now wires in the
  retry/timeout/circuit-breaker-hardened client described above (streaming
  still opt-in via `AZURE_OPENAI_STREAM=1`) — still a single provider
  adapter with no cross-provider fallback, but no longer a bare
  single-shot call with zero resilience.
