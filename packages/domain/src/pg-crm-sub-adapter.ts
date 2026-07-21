/**
 * PostgreSQL adapter for CRM sub-aggregate persistence — contracts,
 * communications, next actions, operational exceptions (PG-A — CRM
 * sub-aggregates PG proof, P6-b G001).
 *
 * Mirrors `pg-crm-adapter.ts` exactly: a stable repository port, pure row
 * <-> domain mappers, an in-memory implementation for unit/restart tests
 * without PostgreSQL, and `createPgCrmSubRepository(pool)` for createApp
 * injection. Backed by the four sidecar tables from
 * 0007_crm_subaggregates.sql.
 */

import type { Communication, CustomerContract, NextAction, OperationalException } from "./crm.js";
import type { PgQueryable } from "./pg-crm-adapter.js";

export type { PgQueryable, PgQueryResult } from "./pg-crm-adapter.js";

const KRW_INTEGER = /^\d+$/;

export interface CrmContractRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  title: string;
  scope: string;
  effective_from: string;
  effective_to: string | null;
  value_krw: string | null;
  version: number;
}

export interface CrmCommunicationRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  channel: string;
  summary: string;
  occurred_at: string;
  version: number;
}

export interface CrmNextActionRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  title: string;
  priority: number;
  due_at: string;
  status: string;
  version: number;
}

export interface CrmOperationalExceptionRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  title: string;
  severity: string;
  priority: number;
  occurred_at: string;
  status: string;
  resolved_at: string | null;
  version: number;
}

export interface CrmSubRepository {
  saveContract(contract: CustomerContract): Promise<void>;
  getContractsForWorkspace(workspaceId: string): Promise<CustomerContract[]>;
  listAllContracts(): Promise<CustomerContract[]>;

  saveCommunication(communication: Communication): Promise<void>;
  getCommunicationsForWorkspace(workspaceId: string): Promise<Communication[]>;
  listAllCommunications(): Promise<Communication[]>;

  saveNextAction(action: NextAction): Promise<void>;
  getNextActionsForWorkspace(workspaceId: string): Promise<NextAction[]>;
  listAllNextActions(): Promise<NextAction[]>;

  saveException(exception: OperationalException): Promise<void>;
  getExceptionsForWorkspace(workspaceId: string): Promise<OperationalException[]>;
  listAllExceptions(): Promise<OperationalException[]>;
}

/**
 * Integer-KRW mapper for `value_krw`: emits a clean integer string and
 * SKIPS any regex assertion when the column is NULL (contract has no
 * value). Never coerces NULL to "0" — round-trips as `undefined`.
 */
export function mapValueKrw(value: string | null): string | undefined {
  if (value === null) return undefined;
  // numeric text output round-trips exactly for integer-valued inputs; a
  // defensive assertion keeps a malformed row (e.g. fractional garbage)
  // from silently leaking a non-integer-KRW string to callers.
  if (!KRW_INTEGER.test(value)) {
    throw new Error(`crm_contracts.value_krw is not an integer-KRW string: ${value}`);
  }
  return value;
}
function mapNonNullValueKrw(value: string): string {
  if (!KRW_INTEGER.test(value)) {
    throw new Error(`crm_contracts.value_krw is not an integer-KRW string: ${value}`);
  }
  return value;
}

export function mapContractRow(row: CrmContractRow): CustomerContract {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    title: row.title,
    scope: row.scope,
    effectiveFrom: row.effective_from,
    ...(row.effective_to !== null ? { effectiveTo: row.effective_to } : {}),
    ...(row.value_krw !== null ? { valueKrw: mapNonNullValueKrw(row.value_krw) } : {}),
  };
}

export function mapCommunicationRow(row: CrmCommunicationRow): Communication {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    channel: row.channel as Communication["channel"],
    summary: row.summary,
    occurredAt: row.occurred_at,
  };
}

export function mapNextActionRow(row: CrmNextActionRow): NextAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    title: row.title,
    priority: row.priority,
    dueAt: row.due_at,
    status: row.status as NextAction["status"],
  };
}

export function mapExceptionRow(row: CrmOperationalExceptionRow): OperationalException {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    title: row.title,
    severity: row.severity as OperationalException["severity"],
    priority: row.priority,
    occurredAt: row.occurred_at,
    status: row.status as OperationalException["status"],
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  };
}

/**
 * In-memory CRM sub-aggregate repository for unit/restart tests without
 * PostgreSQL. Round-trips each aggregate shape.
 */
export class InMemoryCrmSubRepository implements CrmSubRepository {
  private readonly contracts = new Map<string, CustomerContract>();
  private readonly communications = new Map<string, Communication>();
  private readonly nextActions = new Map<string, NextAction>();
  private readonly exceptions = new Map<string, OperationalException>();

  async saveContract(contract: CustomerContract): Promise<void> {
    this.contracts.set(`${contract.workspaceId}\0${contract.id}`, structuredClone(contract));
  }

  async getContractsForWorkspace(workspaceId: string): Promise<CustomerContract[]> {
    return [...this.contracts.values()].filter((c) => c.workspaceId === workspaceId).map((c) => structuredClone(c));
  }

  async listAllContracts(): Promise<CustomerContract[]> {
    return [...this.contracts.values()].map((c) => structuredClone(c));
  }

  async saveCommunication(communication: Communication): Promise<void> {
    this.communications.set(`${communication.workspaceId}\0${communication.id}`, structuredClone(communication));
  }

  async getCommunicationsForWorkspace(workspaceId: string): Promise<Communication[]> {
    return [...this.communications.values()].filter((c) => c.workspaceId === workspaceId).map((c) => structuredClone(c));
  }

  async listAllCommunications(): Promise<Communication[]> {
    return [...this.communications.values()].map((c) => structuredClone(c));
  }

  async saveNextAction(action: NextAction): Promise<void> {
    this.nextActions.set(`${action.workspaceId}\0${action.id}`, structuredClone(action));
  }

  async getNextActionsForWorkspace(workspaceId: string): Promise<NextAction[]> {
    return [...this.nextActions.values()].filter((a) => a.workspaceId === workspaceId).map((a) => structuredClone(a));
  }

  async listAllNextActions(): Promise<NextAction[]> {
    return [...this.nextActions.values()].map((a) => structuredClone(a));
  }

  async saveException(exception: OperationalException): Promise<void> {
    this.exceptions.set(`${exception.workspaceId}\0${exception.id}`, structuredClone(exception));
  }

  async getExceptionsForWorkspace(workspaceId: string): Promise<OperationalException[]> {
    return [...this.exceptions.values()].filter((e) => e.workspaceId === workspaceId).map((e) => structuredClone(e));
  }

  async listAllExceptions(): Promise<OperationalException[]> {
    return [...this.exceptions.values()].map((e) => structuredClone(e));
  }
}

export function createPgCrmSubRepository(pool: PgQueryable): CrmSubRepository {
  return new PgCrmSubRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against the crm_contracts / crm_communications /
 * crm_next_actions / crm_operational_exceptions sidecar tables from
 * 0007_crm_subaggregates.sql (mirrors `PgCrmRepository`).
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * The `listAll*` methods are the hydrate-on-boot admin path: they read
 * across every workspace and are expected to run under an admin/superuser
 * connection — production must scope hydrate to a dedicated admin role
 * instead of the bootstrap superuser. See docs/ops/sor-persistence.md.
 */
class PgCrmSubRepository implements CrmSubRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveContract(contract: CustomerContract): Promise<void> {
    await this.scoped(contract.workspaceId, (db) =>
      db.query(
        `INSERT INTO crm_contracts (id, workspace_id, customer_id, title, scope, effective_from, effective_to, value_krw, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           scope = EXCLUDED.scope,
           effective_from = EXCLUDED.effective_from,
           effective_to = EXCLUDED.effective_to,
           value_krw = EXCLUDED.value_krw,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          contract.id,
          contract.workspaceId,
          contract.customerId,
          contract.title,
          contract.scope,
          contract.effectiveFrom,
          contract.effectiveTo ?? null,
          contract.valueKrw ?? null,
          1,
        ],
      ),
    );
  }

  async getContractsForWorkspace(workspaceId: string): Promise<CustomerContract[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<CrmContractRow>(
        `SELECT * FROM crm_contracts WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapContractRow(row));
  }

  async listAllContracts(): Promise<CustomerContract[]> {
    const result = await this.db.query<CrmContractRow>(
      `SELECT * FROM crm_contracts ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapContractRow(row));
  }

  async saveCommunication(communication: Communication): Promise<void> {
    await this.scoped(communication.workspaceId, (db) =>
      db.query(
        `INSERT INTO crm_communications (id, workspace_id, customer_id, channel, summary, occurred_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           channel = EXCLUDED.channel,
           summary = EXCLUDED.summary,
           occurred_at = EXCLUDED.occurred_at,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          communication.id,
          communication.workspaceId,
          communication.customerId,
          communication.channel,
          communication.summary,
          communication.occurredAt,
          1,
        ],
      ),
    );
  }

  async getCommunicationsForWorkspace(workspaceId: string): Promise<Communication[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<CrmCommunicationRow>(
        `SELECT * FROM crm_communications WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapCommunicationRow(row));
  }

  async listAllCommunications(): Promise<Communication[]> {
    const result = await this.db.query<CrmCommunicationRow>(
      `SELECT * FROM crm_communications ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapCommunicationRow(row));
  }

  async saveNextAction(action: NextAction): Promise<void> {
    await this.scoped(action.workspaceId, (db) =>
      db.query(
        `INSERT INTO crm_next_actions (id, workspace_id, customer_id, title, priority, due_at, status, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           priority = EXCLUDED.priority,
           due_at = EXCLUDED.due_at,
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          action.id,
          action.workspaceId,
          action.customerId,
          action.title,
          action.priority,
          action.dueAt,
          action.status,
          1,
        ],
      ),
    );
  }

  async getNextActionsForWorkspace(workspaceId: string): Promise<NextAction[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<CrmNextActionRow>(
        `SELECT * FROM crm_next_actions WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapNextActionRow(row));
  }

  async listAllNextActions(): Promise<NextAction[]> {
    const result = await this.db.query<CrmNextActionRow>(
      `SELECT * FROM crm_next_actions ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapNextActionRow(row));
  }

  async saveException(exception: OperationalException): Promise<void> {
    await this.scoped(exception.workspaceId, (db) =>
      db.query(
        `INSERT INTO crm_operational_exceptions (id, workspace_id, customer_id, title, severity, priority, occurred_at, status, resolved_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           severity = EXCLUDED.severity,
           priority = EXCLUDED.priority,
           occurred_at = EXCLUDED.occurred_at,
           status = EXCLUDED.status,
           resolved_at = EXCLUDED.resolved_at,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          exception.id,
          exception.workspaceId,
          exception.customerId,
          exception.title,
          exception.severity,
          exception.priority,
          exception.occurredAt,
          exception.status,
          exception.resolvedAt ?? null,
          1,
        ],
      ),
    );
  }

  async getExceptionsForWorkspace(workspaceId: string): Promise<OperationalException[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<CrmOperationalExceptionRow>(
        `SELECT * FROM crm_operational_exceptions WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapExceptionRow(row));
  }

  async listAllExceptions(): Promise<OperationalException[]> {
    const result = await this.db.query<CrmOperationalExceptionRow>(
      `SELECT * FROM crm_operational_exceptions ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapExceptionRow(row));
  }
}
