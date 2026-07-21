# Finance pack pilot (unsigned injection gate)

Pilot / local-dev guidance for injecting an accounting-pack configuration into
`createApp` before certified review signs the real pack
(`docs/finance/accounting-standard-pack.md`).

## Fail-closed default

- When `CreateAppOptions.financePack` is **omitted**, all `/api/finance/*`
  routes return **503** with `error: "FINANCE_PACK_UNSET"`.
- Customer 360 finance projection stays honest **`{ status: "pending" }`**
  until a pack is configured **and** at least one bank statement row is
  successfully imported.
- No production bootstrap path may silently invent pack field values for any
  `BLOCKING — unset` row in the accounting standard pack.

## Unsigned pack injection (dev / tests only)

| Mechanism | When allowed | Notes |
|---|---|---|
| `createApp({ financePack })` in unit/integration tests | Always (explicit test fixture) | Tests own the fixture; this is not a signed pack. |
| Pilot/local bootstrap with unsigned pack | Only when **`DEV_UNSIGNED_FINANCE_PACK=1`** **and** **`NODE_ENV !== 'production'`** | Documented gate for human pilot boots. Production builds must **not** enable unsigned pack by default. |
| `CreateAppOptions.allowUnsignedFinancePack` | Non-prod bootstrap only | Optional explicit flag for a future bootstrap loader; tests may keep passing `financePack` directly without this flag. |

**Production:** never set `DEV_UNSIGNED_FINANCE_PACK`, never default-inject an
unsigned pack, and never treat a pilot fixture as certified review sign-off.

See also ADR-003 (`docs/adr/003-accounting-environment.md`) and the pack
sign-off table in `docs/finance/accounting-standard-pack.md` §6.

## Money actions vs natural-command map

| Surface | Money keys (`finance.ledger_post`, `finance.invoice_issue`, `finance.payment_execute`) |
|---|---|
| `COMMAND_MAP` (S0 natural-command whitelist) | **Absent** — `mapCommand` returns `null`; agent work items fail `UNMAPPED_COMMAND`. Finance report / model paths must **not** auto-`LEDGER_POST`. |
| `GOVERNANCE_COMMANDS` | **Present** — authorize → independent approve → consume yields a single-use intent. |
| Policy engine | Permanent `REQUIRE_APPROVAL` via `PROTECTED_ACTION_TYPES` (`LEDGER_POST`, `INVOICE_ISSUE`, `PAYMENT_EXECUTE`). |
| HTTP execute | **`LEDGER_POST` only** today (`POST /api/finance/journal-entries/:entryId/post` + `consumeGovernedIntent`). `INVOICE_ISSUE` / `PAYMENT_EXECUTE` are governance-registered; invoice/payment API execute surfaces are **deferred**. |

## Related tests

- `apps/api/test/s3-finance.integration.test.ts` — S3-I-01…S3-I-04
- `apps/api/test/api.integration.test.ts` — pack-unset 503 + evidence-backed round trip
- `apps/api/test/command-map.test.ts` — five-key whitelist, money keys null
