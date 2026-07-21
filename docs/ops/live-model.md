# Live model call (D7): real Azure OpenAI ModelClient

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

## Running the offline `MODEL_PROVIDER` wiring test

```
pnpm --filter @ai-crm/api exec vitest run test/model-provider-wiring.integration.test.ts
```

Runs unconditionally, network-free, in every `pnpm --filter @ai-crm/api
test`. Stubs `global.fetch` for the `MODEL_PROVIDER=azure` /
`openai_compatible` cases so the flag-logic wiring is proven without ever
reaching the network.

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

## Honest scope / what this is NOT

- This is a single deterministic (`temperature: 0`) request/response call,
  not a production wiring. There is no retry policy, no streaming, no
  circuit breaker, and no rate-limit/backoff handling — a transient HTTP
  failure surfaces as a thrown `AzureOpenAiClientError` and fails the whole
  `POST /api/agent/commands` call. Production hardening (retries, timeouts,
  streaming, circuit-breaking, provider fallback) is further work.
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
- Setting `MODEL_PROVIDER=azure` in production wires in the single-call, no
  retry/no streaming client described above — treat it as a pilot-grade
  default, not a hardened production model-serving integration.
