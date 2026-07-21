/**
 * PostgreSQL adapter for CRM `Customer` persistence (N-12 / D2 — first CRM
 * domain PG proof).
 *
 * Mirrors the `pg-governance-adapter.ts` / `pg-store.ts` pattern: a stable
 * repository port, pure row <-> domain mappers, an in-memory implementation
 * for unit/restart tests without PostgreSQL, and `createPgCrmRepository(pool)`
 * for createApp injection. Scoped to CUSTOMERS ONLY for this slice —
 * contracts/communications/nextActions/exceptions stay in-memory-only
 * (documented residual, see docs/ops/sor-persistence.md).
 */

import type { Customer } from "./crm.js";

export interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  /**
   * Optional: run `fn` against a single checked-out connection/transaction
   * with `app.workspace_id` set via a SET LOCAL-equivalent
   * (`set_config('app.workspace_id', ..., true)`), so FORCE RLS policies on
   * `crm_customers` (0005) are enforced for the duration of `fn`. See
   * `pg-governance-adapter.ts`'s `PgQueryable.withWorkspaceScope` doc for the
   * full rationale — same contract here.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

export interface CrmCustomerRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CrmRepository {
  saveCustomer(customer: Customer): Promise<void>;
  /**
   * PG-primary scoped read (mirrors governance's `getControlsForWorkspace`
   * / `getIntentsForWorkspace`): every persisted customer for one
   * workspace, run through `withWorkspaceScope` so FORCE RLS enforces the
   * workspace boundary.
   */
  getCustomersForWorkspace(workspaceId: string): Promise<Customer[]>;
  /**
   * List every persisted customer across all workspaces. Used for
   * hydrate-on-boot restart-consistency; hydrate runs as the service/owner
   * role so cross-workspace RLS is expected to be bypassed intentionally
   * (mirrors `listAllControls`/`listAllIntents`/`listJobSnapshots`).
   */
  listAllCustomers(): Promise<Customer[]>;
}

export function mapCustomerRow(row: CrmCustomerRow): Customer {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status as Customer["status"],
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * In-memory CRM repository for unit/restart tests without PostgreSQL.
 * Round-trips the Customer shape.
 */
export class InMemoryCrmRepository implements CrmRepository {
  private readonly customers = new Map<string, Customer>();

  async saveCustomer(customer: Customer): Promise<void> {
    this.customers.set(`${customer.workspaceId}\0${customer.id}`, structuredClone(customer));
  }

  async getCustomersForWorkspace(workspaceId: string): Promise<Customer[]> {
    return [...this.customers.values()]
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => structuredClone(c));
  }

  async listAllCustomers(): Promise<Customer[]> {
    return [...this.customers.values()].map((c) => structuredClone(c));
  }
}

export function createPgCrmRepository(pool: PgQueryable): CrmRepository {
  return new PgCrmRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against the `crm_customers` sidecar table from
 * 0005_crm_customers.sql (mirrors `PgGovernanceRepository`).
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * `listAllCustomers` is the hydrate-on-boot admin path: it reads across
 * every workspace and is expected to run under an admin/superuser
 * connection — production must scope hydrate to a dedicated admin role
 * instead of the bootstrap superuser. See docs/ops/sor-persistence.md.
 */
class PgCrmRepository implements CrmRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveCustomer(customer: Customer): Promise<void> {
    await this.scoped(customer.workspaceId, (db) =>
      db.query(
        `INSERT INTO crm_customers (id, workspace_id, name, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at`,
        [
          customer.id,
          customer.workspaceId,
          customer.name,
          customer.status,
          customer.version,
          customer.createdAt,
          customer.updatedAt,
        ],
      ),
    );
  }

  async getCustomersForWorkspace(workspaceId: string): Promise<Customer[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<CrmCustomerRow>(
        `SELECT * FROM crm_customers WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapCustomerRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllCustomers(): Promise<Customer[]> {
    const result = await this.db.query<CrmCustomerRow>(
      `SELECT * FROM crm_customers ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapCustomerRow(row));
  }
}
