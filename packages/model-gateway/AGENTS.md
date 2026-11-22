> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# packages/model-gateway

Sole allowlisted LLM egress (ADR-010). Score 8: distinct inference boundary, 23 main-tree import sites. No effect capability.

## OVERVIEW
`@ai-crm/model-gateway` exports `./src/index.ts`. Subpath `./pg-model-invocation-adapter` is not on the barrel. The only concrete provider adapter is `src/azure-openai-client.ts`.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Invoke / redact / validate | `src/index.ts` | `ModelGateway`, `MODEL_GATEWAY_ACTION` = `MODEL_INVOKE` |
| Azure or compatible HTTP | `src/azure-openai-client.ts` | constructed only inside this package |
| Invocation rows | `src/pg-model-invocation-adapter.ts` | own `model_invocations` audit only |
| Live model tests | api `live-model.integration.test.ts` | gated by `LIVE_MODEL_TEST`, not `LIVE_PG_TEST` |

## CONVENTIONS (this dir)
- Callers inject `ModelClient`. `createApp` does not wire Azure by default.
- Prompts are redacted before egress. Stored material is a SHA-256 digest, not the prompt text.
- Free text is not an output. Only schema-validated structured fields may leave (`validateOutput`).
- Credentials come from `process.env` only. Never log them, embed them in errors, or return them.
- `RetentionMode` prefers `zero-retention` where the provider supports it.
- Every invocation maps to the non-effect action `MODEL_INVOKE`. This package does not create, lease, or dispatch execution intents, and it does not import `@ai-crm/connectors`.

## ANTI-PATTERNS (THIS DIR)
- Do not import `azure-openai-client.ts` or construct `AzureOpenAiClient` from another package.
- Do not accept free-text model output as a domain mutation.
- Do not write anything except this package's own `model_invocations` records.

## COMMANDS
```bash
pnpm --filter @ai-crm/model-gateway typecheck
pnpm --filter @ai-crm/model-gateway test
```
