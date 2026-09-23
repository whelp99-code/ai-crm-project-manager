# CRM company-memory donor

Status: CRM-side publisher implemented in-process. Worker tick is env-gated and off by default. No live company-memory writes.

This repository publishes toward the Second Brain `sb-company` contract
(`second-brain-app/docs/core5/COMPANY-MEMORY-DONOR-CONTRACT.md`). The donor
builds one canonical `{authority, arguments}` receive envelope, signs it with
operator-injected Ed25519 material, and marks a CWOS mail-outbox row `EMITTED`
only after `sb-company` exit 0 and a matching workspace, request digest,
operation, candidate ID, and resulting state (`candidate` for receive).

Timeout, non-zero exit, malformed stdout, or receipt mismatch leave the row
`PENDING`. Replay of an already-emitted row is a no-op.

## CRM-only outbox interface

Source events are the additive CWOS mail outbox from migration
`0023_cwos_mail_work_inbox_outbox` (`WORK_LINKED`, `INBOX_RECEIVED`,
`WORK_LINK_CORRECTED`). The publisher derives workspace, provider, mailbox,
source locator, and source event from an authenticated CRM source record
supplied by the caller. Company names are not identity. Outbox payloads stay
keys-only; content is not copied from the outbox row.

Entry points:

- `publishCompanyMemoryDonor` — one tick over pending CRM outbox rows
- `createCrmMailOutboxDonorPort` — adapter over `UnifiedInboxService`
- `createMailProductDonorPort` — not implemented (see below)

The publisher never calls `sb remember`, `/api/remember`, `sb_remember`,
personal search, or a personal vault. Transport is an injected
`CompanyMemoryCliTransport` (`sb-company` stdin/stdout shape only).

Worker bind (`apps/worker/src/company-memory-donor-bind.ts`) is explicit-env
only: `COMPANY_MEMORY_SB_COMPANY`, `COMPANY_MEMORY_SB_COMPANY_CONFIG`,
`COMPANY_MEMORY_SIGNING_KEY_FILE`, `COMPANY_MEMORY_AUTHORITY_FILE`. Absent =
skipped. Incomplete, unknown, or missing files fail closed at worker boot.
The command must be an absolute `sb-company` path; personal `sb` is rejected.
When `DATABASE_URL` is set, the worker binds `cwos_v2_mail_outbox` from the
governance/CWOS Postgres pool (`runtime.outboxNotifier`) and fails closed if
that schema or queryable is unavailable. Empty outbox is used only when
`DATABASE_URL` is unset. Tests may still inject a synthetic outbox.

`mail.inbox.receive` (POST `/api/cwos/v2/commands`) is the existing CWOS v2
write path. PostgreSQL CAS projects keys-only `cwos_v2_mail_inbox_receipts`
and `cwos_v2_mail_outbox` rows in the same transaction. Missing schema or
insert failure rolls the command back. Existing outbox rows are not updated
(`ON CONFLICT DO NOTHING`) so a worker `EMITTED` ack is not clobbered.

## Mail adapter

The Mail product adapter (`CwosWorkSystemAdapter` / mail-intelligence) is
**not implemented** in this repository. `createMailProductDonorPort()` fails
closed with `MAIL_ADAPTER_NOT_IMPLEMENTED`. Mail remains a later sequential
task and must not be substituted by this CRM publisher.

## Authority / key ownership

CRM does not ship or invent a shared signing key with Second Brain.

- CRM signs with an operator-injected `CompanyMemoryDonorSigner` (key id +
  Ed25519 signature over the company-memory authority domain).
- Second Brain verifies with operator-configured `trusted_keys` on the
  `sb-company` config.
- Matching those two sides is an operator/JARVIS provisioning decision, not
  a value this package may mint.

Tests generate ephemeral keypairs. No production key, secret, or company
database path is read by this increment.
