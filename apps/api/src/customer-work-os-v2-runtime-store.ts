import {
  CustomerWorkOsV2Error,
  CustomerWorkOsV2Platform,
  customerWorkOsV2StateHash,
  type CustomerWorkOsV2State,
  type InboxState,
} from "@ai-crm/domain/customer-work-os-v2";
import {
  UUID_PATTERN,
  validateAuditInput,
  validateEnvelope,
  v2Hash,
  type CwosV2StateStore,
  type V2AuditEvent,
  type V2IdempotencyRecord,
  type V2PgQueryable,
  type V2RuntimeEnvelope,
} from "./customer-work-os-v2-runtime-core.js";

export class InMemoryCwosV2StateStore implements CwosV2StateStore {
  private readonly rows = new Map<string, V2RuntimeEnvelope>();
  private readonly events = new Map<string, V2AuditEvent[]>();

  async load(workspaceId: string): Promise<V2RuntimeEnvelope | undefined> {
    const row = this.rows.get(workspaceId);
    return row ? structuredClone(row) : undefined;
  }

  async compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<V2RuntimeEnvelope, "version">,
    audit: Omit<V2AuditEvent, "sequence" | "previousEventHash" | "eventHash">,
  ): Promise<V2RuntimeEnvelope> {
    validateAuditInput(workspaceId, audit);
    const current = this.rows.get(workspaceId);
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "runtime version changed");
    }

    const stored: V2RuntimeEnvelope = { ...structuredClone(next), version: expectedVersion + 1 };
    validateEnvelope(stored);

    const history = this.events.get(workspaceId) ?? [];
    const previous = history.at(-1);
    const emptyHash = customerWorkOsV2StateHash(new CustomerWorkOsV2Platform(workspaceId).exportState());
    if (audit.beforeStateHash !== (current?.stateHash ?? emptyHash) || audit.afterStateHash !== stored.stateHash) {
      throw new CustomerWorkOsV2Error("AUDIT_CHAIN_MISMATCH", "audit state hash binding failed");
    }

    const core = {
      ...structuredClone(audit),
      sequence: history.length + 1,
      previousEventHash: previous?.eventHash ?? null,
    };
    const event: V2AuditEvent = { ...core, eventHash: v2Hash(core) };
    this.rows.set(workspaceId, stored);
    this.events.set(workspaceId, [...history, event]);
    return structuredClone(stored);
  }

  auditLog(workspaceId: string): V2AuditEvent[] {
    return structuredClone(this.events.get(workspaceId) ?? []);
  }
}

export class PgCwosV2StateStore implements CwosV2StateStore {
  constructor(private readonly pool: V2PgQueryable) {}

  private scope<T>(workspaceId: string, fn: (queryable: V2PgQueryable) => Promise<T>): Promise<T> {
    if (!UUID_PATTERN.test(workspaceId)) {
      throw new CustomerWorkOsV2Error(
        "INVALID_WORKSPACE_ID",
        "PostgreSQL-backed Customer Work OS workspaces must use UUID identifiers",
      );
    }
    if (!this.pool.withWorkspaceScope) {
      throw new CustomerWorkOsV2Error(
        "PG_SCOPE_REQUIRED",
        "PostgreSQL v2 state access requires a transaction-scoped workspace context",
      );
    }
    return this.pool.withWorkspaceScope(workspaceId, async (db) => {
      await db.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceId]);
      return fn(db);
    });
  }

  async load(workspaceId: string): Promise<V2RuntimeEnvelope | undefined> {
    return this.scope(workspaceId, async (db) => {
      const result = await db.query<{
        workspace_id: string;
        version: string | number;
        state: CustomerWorkOsV2State;
        idempotency: V2IdempotencyRecord[];
        state_hash: string;
        updated_by_principal_id: string;
        updated_at: string;
      }>(
        "SELECT workspace_id, version, state, idempotency, state_hash, updated_by_principal_id, updated_at FROM cwos_v2_runtime_snapshots WHERE workspace_id=$1",
        [workspaceId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const envelope: V2RuntimeEnvelope = {
        schemaVersion: 1,
        workspaceId: row.workspace_id,
        version: Number(row.version),
        state: row.state,
        idempotency: row.idempotency,
        stateHash: row.state_hash,
        updatedByPrincipalId: row.updated_by_principal_id,
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      validateEnvelope(envelope);
      return envelope;
    });
  }

  async compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<V2RuntimeEnvelope, "version">,
    audit: Omit<V2AuditEvent, "sequence" | "previousEventHash" | "eventHash">,
  ): Promise<V2RuntimeEnvelope> {
    validateAuditInput(workspaceId, audit);
    const prospective: V2RuntimeEnvelope = { ...structuredClone(next), version: expectedVersion + 1 };
    validateEnvelope(prospective);
    return this.scope(workspaceId, async (db) => {
      // SELECT ... FOR UPDATE cannot lock a missing first snapshot. The transaction-level
      // advisory lock serializes the first insert as well as subsequent CAS updates.
      // Append-only audit is SELECT/INSERT for the runtime role; FOR UPDATE needs UPDATE.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [workspaceId]);

      const current = await db.query<{ version: string | number; state_hash: string }>(
        "SELECT version,state_hash FROM cwos_v2_runtime_snapshots WHERE workspace_id=$1 FOR UPDATE",
        [workspaceId],
      );
      const row = current.rows[0];
      const actual = row ? Number(row.version) : 0;
      if (actual !== expectedVersion) {
        throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", `expected ${expectedVersion}, found ${actual}`);
      }

      const emptyHash = customerWorkOsV2StateHash(new CustomerWorkOsV2Platform(workspaceId).exportState());
      const expectedBefore = row?.state_hash ?? emptyHash;
      if (expectedBefore !== audit.beforeStateHash || next.stateHash !== audit.afterStateHash) {
        throw new CustomerWorkOsV2Error("AUDIT_CHAIN_MISMATCH", "runtime audit hash binding failed");
      }

      const previous = await db.query<{ sequence: string | number; event_hash: string }>(
        "SELECT sequence,event_hash FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1",
        [workspaceId],
      );
      const prior = previous.rows[0];
      const sequence = prior ? Number(prior.sequence) + 1 : 1;
      const core = { ...audit, sequence, previousEventHash: prior?.event_hash ?? null };
      const eventHash = v2Hash(core);

      if (row) {
        const updated = await db.query(
          "UPDATE cwos_v2_runtime_snapshots SET version=version+1,state=$2::jsonb,idempotency=$3::jsonb,state_hash=$4,updated_by_principal_id=$5,updated_at=$6 WHERE workspace_id=$1 AND version=$7",
          [
            workspaceId,
            JSON.stringify(next.state),
            JSON.stringify(next.idempotency),
            next.stateHash,
            next.updatedByPrincipalId,
            next.updatedAt,
            expectedVersion,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new CustomerWorkOsV2Error("CONCURRENT_MODIFICATION", "runtime compare-and-swap lost");
        }
      } else {
        await db.query(
          "INSERT INTO cwos_v2_runtime_snapshots(workspace_id,version,schema_version,state,idempotency,state_hash,updated_by_principal_id,updated_at) VALUES($1,1,1,$2::jsonb,$3::jsonb,$4,$5,$6)",
          [
            workspaceId,
            JSON.stringify(next.state),
            JSON.stringify(next.idempotency),
            next.stateHash,
            next.updatedByPrincipalId,
            next.updatedAt,
          ],
        );
      }

      await db.query(
        "INSERT INTO cwos_v2_audit_events(workspace_id,sequence,operation_id,principal_id,command,idempotency_key,request_hash,before_state_hash,after_state_hash,result_hash,previous_event_hash,event_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          workspaceId,
          sequence,
          audit.operationId,
          audit.principalId,
          audit.command,
          audit.idempotencyKey,
          audit.requestHash,
          audit.beforeStateHash,
          audit.afterStateHash,
          audit.resultHash,
          prior?.event_hash ?? null,
          eventHash,
          audit.createdAt,
        ],
      );

      await projectCwosMailTables(db, workspaceId, next.state.inbox);
      return prospective;
    });
  }
}

async function projectCwosMailTables(
  db: V2PgQueryable,
  workspaceId: string,
  inbox: InboxState,
): Promise<void> {
  const receipts = inbox.mailInboxReceipts ?? [];
  const outbox = inbox.mailOutbox ?? [];
  if (receipts.length === 0 && outbox.length === 0) return;

  await assertCwosMailSchema(db);
  try {
    for (const receipt of receipts) {
      if (receipt.workspaceId !== workspaceId) {
        throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "mail inbox receipt workspace mismatch");
      }
      await db.query(
        "INSERT INTO cwos_v2_mail_inbox_receipts(id,workspace_id,provider,mailbox,source_locator,provider_event_id,received_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (workspace_id, provider, mailbox, source_locator, provider_event_id) DO NOTHING",
        [
          receipt.id,
          receipt.workspaceId,
          receipt.provider,
          receipt.mailbox,
          receipt.sourceLocator,
          receipt.providerEventId,
          receipt.receivedAt,
          receipt.version,
        ],
      );
    }
    for (const event of outbox) {
      if (event.workspaceId !== workspaceId) {
        throw new CustomerWorkOsV2Error("CROSS_WORKSPACE", "mail outbox workspace mismatch");
      }
      await db.query(
        "INSERT INTO cwos_v2_mail_outbox(id,workspace_id,kind,work_item_id,source_event_id,link_id,status,created_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
        [
          event.id,
          event.workspaceId,
          event.kind,
          event.workItemId,
          event.sourceEventId,
          event.linkId,
          event.status,
          event.createdAt,
          event.version,
        ],
      );
    }
  } catch (error) {
    if (error instanceof CustomerWorkOsV2Error) throw error;
    throw new CustomerWorkOsV2Error("MAIL_OUTBOX_PERSIST_FAILED", "failed to persist cwos mail outbox");
  }
}

async function assertCwosMailSchema(db: V2PgQueryable): Promise<void> {
  let result: { rows: Array<{ receipts_reg?: unknown; outbox_reg?: unknown }> };
  try {
    result = await db.query(
      "SELECT to_regclass('public.cwos_v2_mail_inbox_receipts') AS receipts_reg, to_regclass('public.cwos_v2_mail_outbox') AS outbox_reg",
    );
  } catch {
    throw new CustomerWorkOsV2Error("MAIL_SCHEMA_NOT_READY", "cwos mail outbox schema is unavailable");
  }
  const row = result.rows[0];
  const receiptsReg = typeof row?.receipts_reg === "string" ? row.receipts_reg.trim() : "";
  const outboxReg = typeof row?.outbox_reg === "string" ? row.outbox_reg.trim() : "";
  if (!receiptsReg || !outboxReg) {
    throw new CustomerWorkOsV2Error("MAIL_SCHEMA_NOT_READY", "cwos mail outbox schema is unavailable");
  }
}
