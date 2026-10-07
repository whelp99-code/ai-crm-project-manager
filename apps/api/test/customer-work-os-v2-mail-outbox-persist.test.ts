import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  PgCwosV2StateStore,
  type V2PgQueryable,
  type V2RuntimeEnvelope,
} from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "b1111111-1111-4111-8111-111111111111";
const owner: V2Actor = {
  principalId: "human-owner",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

const K04_DRAFT_ID = "98e52d8a-6f49-496f-b375-661330c245c5";
const RECEIPT_ID = "receipt-k04-sent";
const receivePayload = {
  id: RECEIPT_ID,
  provider: "outlook",
  mailbox: "me",
  sourceLocator: `mail-send-draft:${K04_DRAFT_ID}`,
  providerEventId: K04_DRAFT_ID,
  receivedAt: "2026-09-23T01:01:40.000Z",
};

interface MailReceiptRow {
  id: string;
  workspace_id: string;
  provider: string;
  mailbox: string;
  source_locator: string;
  provider_event_id: string;
  received_at: string;
  version: number;
}

interface MailOutboxRow {
  id: string;
  workspace_id: string;
  kind: string;
  work_item_id: string | null;
  source_event_id: string | null;
  link_id: string | null;
  status: string;
  created_at: string;
  version: number;
}

function permissionDenied(relation: string): Error & { code: string } {
  const error = new Error(`permission denied for table ${relation}`) as Error & { code: string };
  error.code = "42501";
  return error;
}

function mailQueryable(options: { schemaReady?: boolean; denyMailInsert?: boolean } = {}) {
  const schemaReady = options.schemaReady ?? true;
  const denyMailInsert = options.denyMailInsert ?? false;
  let snapshot:
    | {
        workspace_id: string;
        version: number;
        state: V2RuntimeEnvelope["state"];
        idempotency: V2RuntimeEnvelope["idempotency"];
        state_hash: string;
        updated_by_principal_id: string;
        updated_at: string;
      }
    | undefined;
  let events: Array<{ sequence: number; event_hash: string }> = [];
  let receipts: MailReceiptRow[] = [];
  let outbox: MailOutboxRow[] = [];

  const queryable: V2PgQueryable & { receipts: MailReceiptRow[]; outbox: MailOutboxRow[] } = {
    get receipts() {
      return receipts;
    },
    get outbox() {
      return outbox;
    },
    async query() {
      throw new Error("unscoped query() is forbidden");
    },
    async withWorkspaceScope<T>(scopedWorkspaceId: string, fn: (scoped: V2PgQueryable) => Promise<T>) {
      const backup = {
        snapshot: snapshot ? structuredClone(snapshot) : undefined,
        events: structuredClone(events),
        receipts: structuredClone(receipts),
        outbox: structuredClone(outbox),
      };
      let guc: string | undefined;
      const scoped: V2PgQueryable = {
        async query<T2 = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("SELECT set_config('app.workspace_id'")) {
            guc = String(values[0] ?? "");
            return { rows: [{ set_config: guc }] as T2[], rowCount: 1 };
          }
          if (sql.startsWith("SELECT pg_advisory_xact_lock(")) {
            return { rows: [{}] as T2[], rowCount: 1 };
          }
          if (sql.includes("to_regclass") && sql.includes("cwos_v2_mail_outbox")) {
            return {
              rows: [
                {
                  receipts_reg: schemaReady ? "cwos_v2_mail_inbox_receipts" : null,
                  outbox_reg: schemaReady ? "cwos_v2_mail_outbox" : null,
                },
              ] as T2[],
              rowCount: 1,
            };
          }
          if (sql.includes("FROM cwos_v2_audit_events")) {
            const prior = events.at(-1);
            return { rows: (prior ? [prior] : []) as T2[], rowCount: prior ? 1 : 0 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_audit_events")) {
            events.push({ sequence: Number(values[1]), event_hash: String(values[11]) });
            return { rows: [] as T2[], rowCount: 1 };
          }
          if (sql.includes("FROM cwos_v2_runtime_snapshots")) {
            if (guc !== scopedWorkspaceId) return { rows: [] as T2[], rowCount: 0 };
            if (!snapshot) return { rows: [] as T2[], rowCount: 0 };
            return {
              rows: [
                {
                  workspace_id: snapshot.workspace_id,
                  version: snapshot.version,
                  state: snapshot.state,
                  idempotency: snapshot.idempotency,
                  state_hash: snapshot.state_hash,
                  updated_by_principal_id: snapshot.updated_by_principal_id,
                  updated_at: snapshot.updated_at,
                },
              ] as T2[],
              rowCount: 1,
            };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_runtime_snapshots")) {
            snapshot = {
              workspace_id: scopedWorkspaceId,
              version: 1,
              state: JSON.parse(String(values[1])) as V2RuntimeEnvelope["state"],
              idempotency: JSON.parse(String(values[2])) as V2RuntimeEnvelope["idempotency"],
              state_hash: String(values[3]),
              updated_by_principal_id: String(values[4]),
              updated_at: String(values[5]),
            };
            return { rows: [] as T2[], rowCount: 1 };
          }
          if (sql.startsWith("UPDATE cwos_v2_runtime_snapshots")) {
            if (!snapshot) return { rows: [] as T2[], rowCount: 0 };
            snapshot = {
              ...snapshot,
              version: snapshot.version + 1,
              state: JSON.parse(String(values[1])) as V2RuntimeEnvelope["state"],
              idempotency: JSON.parse(String(values[2])) as V2RuntimeEnvelope["idempotency"],
              state_hash: String(values[3]),
              updated_by_principal_id: String(values[4]),
              updated_at: String(values[5]),
            };
            return { rows: [] as T2[], rowCount: 1 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_mail_inbox_receipts")) {
            if (denyMailInsert) throw permissionDenied("cwos_v2_mail_inbox_receipts");
            const row: MailReceiptRow = {
              id: String(values[0]),
              workspace_id: String(values[1]),
              provider: String(values[2]),
              mailbox: String(values[3]),
              source_locator: String(values[4]),
              provider_event_id: String(values[5]),
              received_at: String(values[6]),
              version: Number(values[7]),
            };
            const duplicate = receipts.some(
              (item) =>
                item.workspace_id === row.workspace_id &&
                item.provider === row.provider &&
                item.mailbox === row.mailbox &&
                item.source_locator === row.source_locator &&
                item.provider_event_id === row.provider_event_id,
            );
            if (!duplicate) receipts.push(row);
            return { rows: [] as T2[], rowCount: duplicate ? 0 : 1 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_mail_outbox")) {
            if (denyMailInsert) throw permissionDenied("cwos_v2_mail_outbox");
            const row: MailOutboxRow = {
              id: String(values[0]),
              workspace_id: String(values[1]),
              kind: String(values[2]),
              work_item_id: values[3] == null ? null : String(values[3]),
              source_event_id: values[4] == null ? null : String(values[4]),
              link_id: values[5] == null ? null : String(values[5]),
              status: String(values[6]),
              created_at: String(values[7]),
              version: Number(values[8]),
            };
            const duplicate = outbox.some((item) => item.id === row.id);
            if (!duplicate) outbox.push(row);
            return { rows: [] as T2[], rowCount: duplicate ? 0 : 1 };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      try {
        return await fn(scoped);
      } catch (error) {
        snapshot = backup.snapshot;
        events = backup.events;
        receipts = backup.receipts;
        outbox = backup.outbox;
        throw error;
      }
    },
  };
  return queryable;
}

async function bootstrap(runtime: CustomerWorkOsV2RuntimeManager): Promise<void> {
  await runtime.command({
    workspaceId,
    actor: owner,
    expectedVersion: 0,
    idempotencyKey: "bootstrap-human",
    command: "identity.registerPrincipal",
    payload: {
      id: owner.principalId,
      kind: "human",
      displayName: "JM Park",
      active: true,
    },
  });
  await runtime.command({
    workspaceId,
    actor: owner,
    expectedVersion: 1,
    idempotencyKey: "bootstrap-membership",
    command: "identity.addMembership",
    payload: {
      id: "membership-owner",
      principalId: owner.principalId,
    },
  });
}

describe("PgCwosV2StateStore mail inbox receipt projection", () => {
  it("records a keys-only inbox receipt and PENDING INBOX_RECEIVED outbox row", async () => {
    const db = mailQueryable();
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(db),
      () => "2026-09-23T01:01:40.000Z",
    );
    await bootstrap(runtime);

    const result = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "k04-sent-receipt",
      command: "mail.inbox.receive",
      payload: receivePayload,
    });

    expect(result.statusCode).toBe(200);
    expect(result.envelope.state.inbox.mailInboxReceipts).toEqual([
      expect.objectContaining({
        id: RECEIPT_ID,
        provider: "outlook",
        mailbox: "me",
        sourceLocator: `mail-send-draft:${K04_DRAFT_ID}`,
        providerEventId: K04_DRAFT_ID,
      }),
    ]);
    expect(JSON.stringify(db.receipts)).not.toMatch(/body|subject/i);
    expect(db.receipts).toEqual([
      {
        id: RECEIPT_ID,
        workspace_id: workspaceId,
        provider: "outlook",
        mailbox: "me",
        source_locator: `mail-send-draft:${K04_DRAFT_ID}`,
        provider_event_id: K04_DRAFT_ID,
        received_at: "2026-09-23T01:01:40.000Z",
        version: 1,
      },
    ]);
    expect(db.outbox).toEqual([
      {
        id: `outbox-inbox-${RECEIPT_ID}`,
        workspace_id: workspaceId,
        kind: "INBOX_RECEIVED",
        work_item_id: null,
        source_event_id: null,
        link_id: null,
        status: "PENDING",
        created_at: "2026-09-23T01:01:40.000Z",
        version: 1,
      },
    ]);
  });

  it("does not clobber an already EMITTED outbox row on replay", async () => {
    const db = mailQueryable();
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(db),
      () => "2026-09-23T01:01:40.000Z",
    );
    await bootstrap(runtime);
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "k04-sent-receipt",
      command: "mail.inbox.receive",
      payload: receivePayload,
    });
    db.outbox[0]!.status = "EMITTED";
    db.outbox[0]!.version = 2;

    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 3,
      idempotencyKey: "k04-sent-receipt-replay",
      command: "mail.inbox.receive",
      payload: receivePayload,
    });

    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0]).toMatchObject({ id: `outbox-inbox-${RECEIPT_ID}`, status: "EMITTED", version: 2 });
    expect(db.receipts).toHaveLength(1);
  });

  it("fails closed when the mail outbox schema is missing", async () => {
    const db = mailQueryable({ schemaReady: false });
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(db),
      () => "2026-09-23T01:01:40.000Z",
    );
    await bootstrap(runtime);

    await expect(
      runtime.command({
        workspaceId,
        actor: owner,
        expectedVersion: 2,
        idempotencyKey: "k04-sent-receipt",
        command: "mail.inbox.receive",
        payload: receivePayload,
      }),
    ).rejects.toMatchObject({ code: "MAIL_SCHEMA_NOT_READY" });

    const loaded = await new PgCwosV2StateStore(db).load(workspaceId);
    expect(loaded?.version).toBe(2);
    expect(db.receipts).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });

  it("fails closed when mail table insert is denied", async () => {
    const db = mailQueryable({ denyMailInsert: true });
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(db),
      () => "2026-09-23T01:01:40.000Z",
    );
    await bootstrap(runtime);

    await expect(
      runtime.command({
        workspaceId,
        actor: owner,
        expectedVersion: 2,
        idempotencyKey: "k04-sent-receipt",
        command: "mail.inbox.receive",
        payload: receivePayload,
      }),
    ).rejects.toMatchObject({ code: "MAIL_OUTBOX_PERSIST_FAILED" });

    const loaded = await new PgCwosV2StateStore(db).load(workspaceId);
    expect(loaded?.version).toBe(2);
    expect(db.receipts).toHaveLength(0);
    expect(db.outbox).toHaveLength(0);
  });
});
