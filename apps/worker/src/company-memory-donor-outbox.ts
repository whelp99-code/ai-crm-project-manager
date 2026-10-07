/**
 * CWOS mail-outbox bind for the company-memory donor tick.
 *
 * Injected outbox wins. No DATABASE_URL → empty outbox. DATABASE_URL set →
 * read/ack `cwos_v2_mail_outbox` through the caller-supplied queryable and
 * fail closed if that schema is missing or unreadable. This module does not
 * open its own pool or log connection strings.
 */
import type {
  CompanyMemoryDonorOutbox,
  CompanyMemoryDonorPending,
  CompanyMemoryDonorSourceRecord,
  MailOutboxEvent,
} from "@ai-crm/domain/customer-work-os-v2";

const MAIL_KINDS = new Set<MailOutboxEvent["kind"]>([
  "WORK_LINKED",
  "INBOX_RECEIVED",
  "WORK_LINK_CORRECTED",
]);

const LIST_PENDING_WITH_SOURCE = `
SELECT
  o.id,
  o.workspace_id::text AS workspace_id,
  o.kind,
  o.work_item_id,
  o.source_event_id,
  o.link_id,
  o.status,
  o.created_at,
  o.version,
  COALESCE(r.provider, l.provider) AS provider,
  COALESCE(r.mailbox, l.mailbox) AS mailbox,
  COALESCE(r.source_locator, l.source_locator) AS source_locator,
  COALESCE(o.source_event_id, l.source_event_id, r.provider_event_id) AS resolved_source_event_id
FROM cwos_v2_mail_outbox o
LEFT JOIN cwos_v2_mail_inbox_receipts r
  ON r.workspace_id = o.workspace_id
 AND o.kind = 'INBOX_RECEIVED'
 AND r.id = CASE
   WHEN o.id LIKE 'outbox-inbox-%' THEN substr(o.id, 14)
   ELSE NULL
 END
LEFT JOIN cwos_v2_mail_work_links l
  ON l.workspace_id = o.workspace_id
 AND l.id = o.link_id
WHERE o.status = 'PENDING'
  AND o.workspace_id = $1::uuid
ORDER BY o.created_at ASC, o.id ASC
`;

const LIST_PENDING_KEYS_ONLY = `
SELECT
  id,
  workspace_id::text AS workspace_id,
  kind,
  work_item_id,
  source_event_id,
  link_id,
  status,
  created_at,
  version,
  NULL::text AS provider,
  NULL::text AS mailbox,
  NULL::text AS source_locator,
  source_event_id AS resolved_source_event_id
FROM cwos_v2_mail_outbox
WHERE status = 'PENDING'
  AND workspace_id = $1::uuid
ORDER BY created_at ASC, id ASC
`;

const MARK_EMITTED = `
UPDATE cwos_v2_mail_outbox
SET status = 'EMITTED',
    version = version + 1
WHERE workspace_id = $1::uuid
  AND id = $2
  AND status = 'PENDING'
`;

export interface CompanyMemoryDonorPgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect?: () => Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    release(): void;
  }>;
}

export interface ResolvedCompanyMemoryDonorOutbox {
  outbox: CompanyMemoryDonorOutbox;
  persistEmitted(): Promise<void>;
}

export function companyMemoryOutboxUnavailable(detail: string): Error {
  return new Error(`COMPANY_MEMORY_OUTBOX_UNAVAILABLE: ${detail}`);
}

export function emptyOutbox(): CompanyMemoryDonorOutbox {
  return {
    listPending() {
      return [];
    },
    markEmitted(workspaceId: string, id: string) {
      void workspaceId;
      void id;
    },
  };
}

export async function resolveCompanyMemoryDonorOutbox(input: {
  databaseUrl?: string | undefined;
  queryable?: CompanyMemoryDonorPgQueryable | undefined;
  outbox?: CompanyMemoryDonorOutbox | undefined;
  workspaceId: string;
}): Promise<ResolvedCompanyMemoryDonorOutbox> {
  if (input.outbox) {
    return { outbox: input.outbox, persistEmitted: async () => {} };
  }
  if (!input.databaseUrl) {
    return { outbox: emptyOutbox(), persistEmitted: async () => {} };
  }
  if (!input.queryable) {
    throw companyMemoryOutboxUnavailable("DATABASE_URL is set but no CWOS queryable was bound");
  }
  return loadPgCwosMailDonorOutbox(input.queryable, input.workspaceId);
}

export async function loadPgCwosMailDonorOutbox(
  queryable: CompanyMemoryDonorPgQueryable,
  workspaceId: string,
): Promise<ResolvedCompanyMemoryDonorOutbox> {
  await assertOutboxSchema(queryable);
  const rows = await listPendingRows(queryable, workspaceId);
  const pending = rows.map((row) => parsePending(row, workspaceId));
  const emitted = new Set<string>();
  const toPersist: Array<{ workspaceId: string; id: string }> = [];

  return {
    outbox: {
      listPending() {
        return pending.filter((row) => !emitted.has(row.event.id));
      },
      markEmitted(eventWorkspaceId: string, id: string) {
        emitted.add(id);
        toPersist.push({ workspaceId: eventWorkspaceId, id });
      },
    },
    async persistEmitted() {
      for (const item of toPersist) {
        let result: { rowCount: number | null };
        try {
          result = await scopedQuery(queryable, item.workspaceId, MARK_EMITTED, [
            item.workspaceId,
            item.id,
          ]);
        } catch {
          throw companyMemoryOutboxUnavailable("failed to mark cwos mail outbox emitted");
        }
        if (!result.rowCount) {
          throw companyMemoryOutboxUnavailable("failed to mark cwos mail outbox emitted");
        }
      }
    },
  };
}

async function assertOutboxSchema(queryable: CompanyMemoryDonorPgQueryable): Promise<void> {
  let result: { rows: unknown[] };
  try {
    result = await queryable.query("SELECT to_regclass('public.cwos_v2_mail_outbox') AS outbox_reg");
  } catch {
    throw companyMemoryOutboxUnavailable("cwos mail outbox schema is unavailable");
  }
  const row = result.rows[0];
  const reg =
    row && typeof row === "object" ? (row as { outbox_reg?: unknown }).outbox_reg : undefined;
  if (typeof reg !== "string" || !reg.trim()) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox schema is unavailable");
  }
}

async function listPendingRows(
  queryable: CompanyMemoryDonorPgQueryable,
  workspaceId: string,
): Promise<unknown[]> {
  try {
    return (await scopedQuery(queryable, workspaceId, LIST_PENDING_WITH_SOURCE, [workspaceId])).rows;
  } catch {
    try {
      return (await scopedQuery(queryable, workspaceId, LIST_PENDING_KEYS_ONLY, [workspaceId])).rows;
    } catch {
      throw companyMemoryOutboxUnavailable("cwos mail outbox query failed");
    }
  }
}

async function scopedQuery(
  queryable: CompanyMemoryDonorPgQueryable,
  workspaceId: string,
  text: string,
  params?: unknown[],
): Promise<{ rows: unknown[]; rowCount: number | null }> {
  if (!queryable.connect) {
    return queryable.query(text, params);
  }
  const client = await queryable.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // original error matters
    }
    throw error;
  } finally {
    client.release();
  }
}

function parsePending(raw: unknown, expectedWorkspaceId: string): CompanyMemoryDonorPending {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox row is unreadable");
  }
  const row = raw as Record<string, unknown>;
  const kind = readText(row.kind);
  if (!kind || !MAIL_KINDS.has(kind as MailOutboxEvent["kind"])) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox row has an invalid kind");
  }
  const event: MailOutboxEvent = {
    id: requiredText(row.id, "id"),
    workspaceId: requiredText(row.workspace_id, "workspace_id"),
    kind: kind as MailOutboxEvent["kind"],
    workItemId: readText(row.work_item_id),
    sourceEventId: readText(row.source_event_id),
    linkId: readText(row.link_id),
    status: "PENDING",
    createdAt: readInstant(row.created_at),
    version: readVersion(row.version),
  };
  if (event.workspaceId !== expectedWorkspaceId) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox row workspace mismatch");
  }
  return { event, source: sourceFromRow(row, event) };
}

function sourceFromRow(
  row: Record<string, unknown>,
  event: MailOutboxEvent,
): CompanyMemoryDonorSourceRecord | null {
  const provider = readText(row.provider);
  const mailbox = readText(row.mailbox);
  const sourceLocator = readText(row.source_locator);
  const sourceEventId = readText(row.resolved_source_event_id) ?? event.sourceEventId;
  if (!provider || !mailbox || !sourceLocator || !sourceEventId) return null;
  return {
    workspaceId: event.workspaceId,
    provider,
    mailbox,
    sourceLocator,
    sourceEventId,
    content: `crm:mail-outbox:${event.kind}:${provider}:${mailbox}:${sourceLocator}:${sourceEventId}`,
    parserVersion: "crm:mail-outbox:1",
    locator: {
      kind: event.kind === "INBOX_RECEIVED" ? "mail_inbox" : "mail_work",
      outbox_id: event.id,
    },
  };
}

function requiredText(value: unknown, field: string): string {
  const text = readText(value);
  if (!text) {
    throw companyMemoryOutboxUnavailable(`cwos mail outbox row ${field} is required`);
  }
  return text;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFC").trim();
  return trimmed ? trimmed : null;
}

function readInstant(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const text = readText(value);
  if (!text) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox row created_at is required");
  }
  return text;
}

function readVersion(value: unknown): number {
  const version = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(version) || version < 1) {
    throw companyMemoryOutboxUnavailable("cwos mail outbox row version is invalid");
  }
  return version;
}
