import { CustomerWorkOsError } from "@ai-crm/domain/customer-work-os";

export interface CustomerWorkOsIdentity {
  workspaceId: string;
  principalId: string;
  kind: "HUMAN" | "AI" | "SERVICE";
  role: string;
  active: boolean;
}

export interface CustomerWorkOsIdentityResolver {
  resolve(workspaceId: string, principalId: string): Promise<CustomerWorkOsIdentity>;
  close?(): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class StaticCustomerWorkOsIdentityResolver implements CustomerWorkOsIdentityResolver {
  constructor(private readonly identities: ReadonlyMap<string, CustomerWorkOsIdentity>) {}

  async resolve(workspaceId: string, principalId: string): Promise<CustomerWorkOsIdentity> {
    const identity = this.identities.get(`${workspaceId}\u0000${principalId}`);
    if (!identity || !identity.active) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "principal is inactive or missing in the workspace");
    return copy(identity);
  }
}

interface QueryResult<T> { rows: T[]; rowCount?: number | null }
interface SqlConnection {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}
interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

export class PgCustomerWorkOsIdentityResolver implements CustomerWorkOsIdentityResolver {
  constructor(private readonly pool: SqlPool) {}

  async resolve(workspaceId: string, principalId: string): Promise<CustomerWorkOsIdentity> {
    const connection = await this.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const result = await connection.query<{
        workspace_id: string;
        id: string;
        kind: CustomerWorkOsIdentity["kind"];
        role: string;
        is_active: boolean;
      }>(
        `SELECT workspace_id::text AS workspace_id, id::text AS id, kind, role, is_active
           FROM principals
          WHERE workspace_id = $1::uuid AND id::text = $2`,
        [workspaceId, principalId],
      );
      await connection.query("COMMIT");
      const row = result.rows[0];
      if (!row || !row.is_active) throw new CustomerWorkOsError("PRINCIPAL_NOT_FOUND", "principal is inactive or missing in the workspace");
      return { workspaceId: row.workspace_id, principalId: row.id, kind: row.kind, role: row.role, active: row.is_active };
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function createPgCustomerWorkOsIdentityResolverFromEnvironment(): Promise<PgCustomerWorkOsIdentityResolver | undefined> {
  const connectionString = process.env.CWOS_DATABASE_URL ?? process.env.AI_CRM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const module = await dynamicImport("pg");
  const Pool = module.Pool as new (options: { connectionString: string; max: number; application_name: string }) => SqlPool;
  if (!Pool) throw new CustomerWorkOsError("PG_DRIVER_UNAVAILABLE", "pg Pool export is unavailable");
  const max = Number(process.env.CWOS_IDENTITY_PG_POOL_MAX ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new CustomerWorkOsError("INVALID_CONFIG", "CWOS_IDENTITY_PG_POOL_MAX must be 1..10");
  return new PgCustomerWorkOsIdentityResolver(new Pool({ connectionString, max, application_name: "ai-crm-cwos-identity" }));
}
