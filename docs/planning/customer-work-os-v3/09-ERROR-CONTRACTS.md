# 09 — Error Contracts

## Envelope

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The resource changed. Reload and retry.",
    "requestId": "request-id",
    "details": {"resourceId": "safe-id", "currentVersion": 3}
  }
}
```

`message` is user-safe. Stack trace, SQL, environment values, tokens, provider payloads, raw email/document content, and another workspace's identifiers are forbidden.

## Mapping

| HTTP | Code | Use |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | malformed JSON or primitive type failure |
| 401 | `UNAUTHORIZED` | no valid principal |
| 403 | `FORBIDDEN` | authenticated but role/capability denied |
| 404 | `NOT_FOUND` | absent or cross-workspace resource; same response for both |
| 409 | `VERSION_CONFLICT` | stale expected version |
| 409 | `IDEMPOTENCY_CONFLICT` | key reused with different input |
| 409 | `NEXT_ACTION_REQUIRED` | active engagement has no open action |
| 409 | `RELEASE_GATE_INCOMPLETE` | pilot requested PASSED without complete evidence |
| 422 | `EVIDENCE_REQUIRED` | proposal/action lacks allow-listed evidence |
| 422 | `RECONCILIATION_MISMATCH` | counts, sums, hash, or required fields differ |
| 429 | `BUDGET_EXCEEDED` | model/cost/rate policy denies work |
| 503 | `SOURCE_UNAVAILABLE` | canonical repository unavailable; UI must fail closed |
| 500 | `INTERNAL_ERROR` | unexpected error with request ID only |

## Retry contract

- Reads: client may retry 503 with exponential backoff and jitter, maximum 3 attempts.
- Mutations: retry only with the same idempotency key and identical body.
- 401/403/404/409/422 are not automatically retried.
- Adapter effect execution is never automatically retried unless the existing adapter proves idempotency with a provider-side key.
