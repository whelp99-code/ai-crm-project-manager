# 07 — Data Contracts

## Reused canonical data

`CONFIRMED` v3 reads and mutates existing canonical tables through existing repositories: `cwos_accounts`, `cwos_engagements`, `cwos_activities`, `cwos_commitments`, `cwos_quotes`, `cwos_contracts`, `cwos_delivery_projects`, `cwos_change_requests`, `cwos_purchase_orders`, `cwos_financial_items`, `cwos_settlements`, governance controls/events, AI suggestions/events, Notion import plans/events, and audit/outbox tables.

Direct SQL from HTTP handlers is forbidden. Route handlers call repository/service interfaces.

## Migration `0020_customer_work_os_v3_operations.sql`

### `cwos_v3_action_items`

| Column | Type and rule |
|---|---|
| `id` | `uuid primary key` |
| `workspace_id` | `uuid not null references workspaces(id)` |
| `source_kind` | `text not null check` in `COMMITMENT`, `INBOX`, `DELIVERY`, `FINANCE`, `APPROVAL`, `RENEWAL`, `REMEDIATION` |
| `source_id` | `text not null` |
| `engagement_id` | `uuid null references cwos_engagements(id)` with `ON DELETE RESTRICT` |
| `title` | `text not null`, length 1..240 checked in service |
| `priority` | `smallint not null check (priority between 1 and 5)` |
| `due_at` | `timestamptz null` |
| `status` | `text not null check` in `OPEN`, `DONE`, `DISMISSED` |
| `evidence_refs` | `jsonb not null default '[]'` |
| `version` | `bigint not null default 0 check (version >= 0)` |
| timestamps | `created_at`, `updated_at` as `timestamptz not null` |

Unique: `(workspace_id, source_kind, source_id)`. Indexes: `(workspace_id, status, priority, due_at)` and `(workspace_id, engagement_id)`. RLS: enabled and forced, `workspace_id = app_current_workspace_id()` for select/insert/update. Delete grant: denied to runtime role. Retention: action rows retained for the workspace retention period; completed evidence is not hard-deleted by application code.

### `cwos_v3_pilot_runs`

| Column | Type and rule |
|---|---|
| `id` | `uuid primary key` |
| `workspace_id` | `uuid not null references workspaces(id)` |
| `scenario_key` | `text not null` |
| `commit_sha` | `text not null check (length(commit_sha)=40)` |
| `status` | `text not null check` in `RUNNING`, `PASSED`, `FAILED`, `BLOCKED` |
| `evidence_refs` | `jsonb not null default '[]'` |
| `metrics` | `jsonb not null default '{}'` |
| `gate_results` | `jsonb not null default '{}'`; keys exactly `V0`..`V9`, values follow `CwosV3GateResult` |
| `open_critical_high` | `integer not null default 0 check (open_critical_high >= 0)` |
| `version` | `bigint not null default 0` |
| timestamps | `started_at not null`, `completed_at null`, `created_at not null`, `updated_at not null` |

Unique: `(workspace_id, scenario_key, commit_sha)`. Index: `(workspace_id, status, started_at desc)`. RLS and delete denial match action items. `PASSED` requires `completed_at`, at least one evidence ref, `open_critical_high=0`, and required gates V0..V9 each recorded as PASS. V10 is produced by pilot acceptance; V11 is a separate manual production gate.

### Gate results

`CwosV3GateResult = {gateId:'V0'|'V1'|'V2'|'V3'|'V4'|'V5'|'V6'|'V7'|'V8'|'V9'; status:'PASS'|'FAIL'|'BLOCKED'|'NOT_RUN'; evidenceRefs:string[]; observedAt:string; commandOrSurface:string}`.

Pilot status mapping is deterministic: any FAIL produces FAILED; otherwise any BLOCKED, NOT_RUN, or missing V0..V9 produces BLOCKED; all V0..V9 PASS and zero open CRITICAL/HIGH produces PASSED.

### `cwos_v3_reconciliation_reports`

| Column | Type and rule |
|---|---|
| `id` | `uuid primary key` |
| `workspace_id` | `uuid not null references workspaces(id)` |
| `plan_id` | `text not null`; composite FK to `cwos_notion_import_plans(workspace_id,id)` |
| `report_hash` | `text not null check (btrim(report_hash) <> '')` |
| `source_manifest_hash` | `text not null check (btrim(source_manifest_hash) <> '')` |
| `report` | `jsonb not null check (jsonb_typeof(report)='object')`; exact `CwosV3ReconciliationReport` payload |
| `matched` | `boolean not null` |
| `created_by_principal_id` | `text not null` |
| `created_at` | `timestamptz not null default now()` |

Unique: `(workspace_id, plan_id, report_hash)`. Index: `(workspace_id, plan_id, created_at desc)`. RLS is enabled and forced. Runtime roles have SELECT/INSERT only; UPDATE/DELETE are revoked and an append-only trigger rejects both. This table belongs to migration 0020 and removes any dependency on `cwos_artifacts` artifact types or import-event columns.

### `cwos_v3_projection_outbox`

| Column | Type and rule |
|---|---|
| `id` | `uuid primary key default gen_random_uuid()` |
| `workspace_id` | `uuid not null references workspaces(id)` |
| `runtime_event_id` | `uuid not null`; composite FK with workspace to `cwos_runtime_events(workspace_id,id)` |
| `event_type` | `text not null check` in `FINANCIAL_ITEM_CHANGED`, `SETTLEMENT_RECORDED` |
| `partition_key` | `text not null`; `engagement:{engagementId}` when linked, otherwise `account:{accountId}` |
| `payload` | `jsonb not null`; allow-listed IDs, direction, integer-text money, source version, and evidence refs only |
| `payload_hash` | `text not null` computed from canonical payload JSON |
| `status` | `text not null default 'PENDING' check` in `PENDING`, `PUBLISHED`, `FAILED` |
| `attempts` | `integer not null default 0 check (attempts >= 0)` |
| timestamps | `created_at not null`, `published_at null` |

Migration 0020 first adds a unique constraint/index on `cwos_runtime_events(workspace_id,id)`, then adds the composite FK. Unique: `(workspace_id, runtime_event_id, event_type)`. Index: `(status, created_at, id)` and `(workspace_id, partition_key)`. The API role has INSERT/SELECT; the worker role has SELECT/UPDATE; DELETE is revoked. FORCE RLS applies. `PgCustomerWorkOsSnapshotStore.compareAndSwap` inserts the row after the runtime audit event inside the same transaction when `CustomerWorkOsRuntimeManager.mutate` receives a typed projection event. The durable financial-item and settlement routes are the owned producers. Worker tick claims PENDING rows, applies one action upsert, and marks PUBLISHED; replay is deduplicated by source event and action unique keys.

`CwosV3ProjectionEvent = {eventType:'FINANCIAL_ITEM_CHANGED'|'SETTLEMENT_RECORDED', workspaceId:string, engagementId:string|null, accountId:string, sourceId:string, sourceVersion:number|null, direction:'RECEIVABLE'|'PAYABLE', amountMinor:string, evidenceRefs:string[]}`. Route code derives this payload from validated canonical input/result, never raw request extras.

Mapping is exact:

- Financial item: `sourceId=item.id`, `sourceVersion=item.revision`, `engagementId=item.engagementId`, `accountId=item.accountId`, `direction=IN→RECEIVABLE|OUT→PAYABLE`, `amountMinor=item.grossAmountKrw`, `evidenceRefs=item.evidenceRef ? [item.evidenceRef] : []`.
- Settlement: `sourceId=settlement.id`, `sourceVersion=null` because canonical Settlement has no version, `engagementId=linkedItem.engagementId`, `accountId=linkedItem.accountId`, `direction=IN→RECEIVABLE|OUT→PAYABLE`, `amountMinor=settlement.amountKrw`, `evidenceRefs=[settlement.evidenceRef]`.
- Partition: non-null engagement uses `engagement:{id}`; null engagement uses required canonical `account:{accountId}`. Dedup/order use `runtime_event_id` and outbox uniqueness, not `sourceVersion`.

`CustomerWorkOsMutationAudit` carries the projection event as an optional field; in-memory stores retain it for tests and PostgreSQL stores insert it atomically into the projection outbox.

## Overview contract

`CwosV3Overview` has these exact fields:

- `schemaVersion:3`, `generatedAt:ISO-8601`, `workspaceId:uuid`.
- `stages:CwosV3Stage[]`, ordered `INQUIRY`, `QUALIFICATION`, `QUOTE`, `CONTRACT`, `DELIVERY`, `FINANCE`, `RENEWAL`.
- `CwosV3Stage = {key, status:'NOT_STARTED'|'ACTIVE'|'BLOCKED'|'COMPLETE', recordIds:string[], blockerCodes:string[], nextActionId:string|null}`. Arrays are lexically sorted.
- `actionSummary = {open:number, overdue:number, waitingApproval:number, risk:number, topActionIds:string[]}`; top actions use list ordering and max length 20.
- `financeSummary = {currency:'KRW', receivableMinor:string, payableMinor:string, recognizedRevenueMinor:string, committedCostMinor:string, projectedMarginMinor:string, cashRisk30dMinor:string, asOf:string, evidenceRefs:string[]}`. Money is base-10 integer text to avoid JSON precision loss.
- `pendingApprovals = {count:number, controlIds:string[]}` with sorted internal IDs.
- `evidenceHealth = {status:'COMPLETE'|'GAPS'|'UNAVAILABLE', missingRefs:string[], quarantinedCount:number, lastAuditHash:string|null}`.
- `sourceVersions:{source:'CWOS'|'FINANCE'|'GOVERNANCE'|'AI'|'ACTIONS', version:string, updatedAt:string}[]`, ordered by source enum.

When a canonical source is unavailable, the API returns 503 `SOURCE_UNAVAILABLE`; it never returns a zero-valued overview. Pagination applies to action-list resources, not this fixed summary.

## Cutover reconciliation contract

The canonical aggregate remains `cwos_notion_import_plans` with `PLANNED→APPROVED→APPLIED`. The immutable report is stored in `cwos_v3_reconciliation_reports`, linked by `(workspace_id, plan_id)`. Existing import-plan events remain append-only state-transition evidence and do not need an artifact-reference column; apply verifies the latest matching report row by `report_hash`.

`CwosV3ReconciliationReport = {planId, sourceManifestHash, sourceCounts:Record<string,number>, targetCounts:Record<string,number>, sourceMoneyMinor:Record<string,string>, targetMoneyMinor:Record<string,string>, requiredFieldFailures:{rowRef,field,code}[], rejectedRows:{rowRef,code}[], matched:boolean, generatedAt, reportHash}`. Map keys are sorted; money is integer text; `matched` is true only when counts and per-currency money match and both failure arrays are empty.

`reportHash` is SHA-256 lowercase hex over UTF-8 canonical JSON of `{planId, sourceManifestHash, sourceCounts, targetCounts, sourceMoneyMinor, targetMoneyMinor, requiredFieldFailures, rejectedRows, matched}`. Object keys are recursively sorted; arrays retain the contract-defined order; `generatedAt` and `reportHash` are excluded from the digest. The server recomputes and compares the hash on insert, replay, and apply.

## Money and reconciliation invariants

- Monetary values remain integer KRW minor units or the existing canonical money type; floating-point storage is forbidden.
- Settlement total cannot exceed the linked financial item amount unless the existing domain contract explicitly models credit/overpayment.
- Cutover acceptance requires source and target counts, per-currency sums, and immutable source hash equality.
- Projection rows do not change canonical balances.

## Events

| Event | Producer | Consumer | Delivery and dedup |
|---|---|---|---|
| `cwos.v3.action.upserted.v1` | v3 action repository | web/event consumers | outbox at-least-once; dedup by event ID and action version |
| `cwos.v3.action.completed.v1` | v3 action service | reports/pilot metrics | ordered per action ID |
| `cwos.v3.pilot.completed.v1` | pilot service | release evidence | single event per run version |
| `cwos.v3.finance.source-changed.v1` | canonical durable route/runtime store | v3 projection worker | same transaction as snapshot/audit; dedup by runtime event ID and type |

DLQ: existing worker/outbox failure path. Payloads contain IDs and hashes, not raw email bodies, secrets, or full documents.
