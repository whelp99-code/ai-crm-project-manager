import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  customerWorkOsPayloadHash,
  type ApprovalReceipt,
  type CustomerWorkOsState,
} from "@ai-crm/domain/customer-work-os";

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  statusCode: number;
  payload: unknown;
  createdAt: string;
}

export interface CustomerWorkOsRuntimeEnvelope {
  schemaVersion: 1;
  workspaceId: string;
  version: number;
  domain: CustomerWorkOsState;
  idempotency: IdempotencyRecord[];
  stateHash: string;
  updatedByPrincipalId: string;
  updatedAt: string;
}

export interface CustomerWorkOsSnapshotStore {
  load(workspaceId: string): Promise<CustomerWorkOsRuntimeEnvelope | undefined>;
  compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<CustomerWorkOsRuntimeEnvelope, "version">,
  ): Promise<CustomerWorkOsRuntimeEnvelope>;
  close?(): Promise<void>;
}

export interface GovernanceApprovalResolver {
  resolve(input: {
    workspaceId: string;
    approvalId: string;
    resourceType: ApprovalReceipt["resourceType"];
    resourceId: string;
    resourceVersion: number;
    action: string;
    payloadHash: string;
  }): Promise<ApprovalReceipt>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(): CustomerWorkOsState {
  return new CustomerWorkOsService().exportState();
}

function validateEnvelope(envelope: CustomerWorkOsRuntimeEnvelope): void {
  if (envelope.schemaVersion !== 1 || envelope.domain.schemaVersion !== 1) {
    throw new CustomerWorkOsError("UNSUPPORTED_STATE", "unsupported Customer Work OS state schema");
  }
  if (!envelope.workspaceId.trim() || envelope.version < 1 || !Number.isSafeInteger(envelope.version)) {
    throw new CustomerWorkOsError("INVALID_STATE", "invalid runtime envelope identity or version");
  }
  const calculated = customerWorkOsPayloadHash({
    schemaVersion: envelope.schemaVersion,
    workspaceId: envelope.workspaceId,
    domain: envelope.domain,
    idempotency: envelope.idempotency,
    updatedByPrincipalId: envelope.updatedByPrincipalId,
    updatedAt: envelope.updatedAt,
  });
  if (calculated !== envelope.stateHash) throw new CustomerWorkOsError("STATE_HASH_MISMATCH", "runtime state hash does not match payload");
}

export class InMemoryCustomerWorkOsSnapshotStore implements CustomerWorkOsSnapshotStore {
  private readonly rows = new Map<string, CustomerWorkOsRuntimeEnvelope>();

  async load(workspaceId: string): Promise<CustomerWorkOsRuntimeEnvelope | undefined> {
    const value = this.rows.get(workspaceId);
    return value ? copy(value) : undefined;
  }

  async compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<CustomerWorkOsRuntimeEnvelope, "version">,
  ): Promise<CustomerWorkOsRuntimeEnvelope> {
    const current = this.rows.get(workspaceId);
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== expectedVersion) {
      throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", `expected runtime version ${expectedVersion}, found ${actualVersion}`);
    }
    const stored: CustomerWorkOsRuntimeEnvelope = { ...copy(next), version: expectedVersion + 1 };
    validateEnvelope(stored);
    this.rows.set(workspaceId, stored);
    return copy(stored);
  }
}

interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

interface SqlConnection {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

interface SqlPool {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

interface SnapshotRow {
  workspace_id: string;
  version: string | number | bigint;
  schema_version: number;
  state: CustomerWorkOsState;
  idempotency: IdempotencyRecord[];
  state_hash: string;
  updated_by_principal_id: string;
  updated_at: Date | string;
}

async function withWorkspace<T>(pool: SqlPool, workspaceId: string, operation: (connection: SqlConnection) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function fromRow(row: SnapshotRow): CustomerWorkOsRuntimeEnvelope {
  const envelope: CustomerWorkOsRuntimeEnvelope = {
    schemaVersion: 1,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    domain: copy(row.state),
    idempotency: copy(row.idempotency),
    stateHash: row.state_hash,
    updatedByPrincipalId: row.updated_by_principal_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
  validateEnvelope(envelope);
  return envelope;
}

export class PgCustomerWorkOsSnapshotStore implements CustomerWorkOsSnapshotStore {
  constructor(private readonly pool: SqlPool) {}

  async load(workspaceId: string): Promise<CustomerWorkOsRuntimeEnvelope | undefined> {
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = await connection.query<SnapshotRow>(
        `SELECT workspace_id, version, schema_version, state, idempotency, state_hash,
                updated_by_principal_id, updated_at
           FROM cwos_runtime_snapshots
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    });
  }

  async compareAndSwap(
    workspaceId: string,
    expectedVersion: number,
    next: Omit<CustomerWorkOsRuntimeEnvelope, "version">,
  ): Promise<CustomerWorkOsRuntimeEnvelope> {
    const candidate: CustomerWorkOsRuntimeEnvelope = { ...copy(next), version: expectedVersion + 1 };
    validateEnvelope(candidate);
    return withWorkspace(this.pool, workspaceId, async (connection) => {
      const result = expectedVersion === 0
        ? await connection.query<SnapshotRow>(
            `INSERT INTO cwos_runtime_snapshots
               (workspace_id, version, schema_version, state, idempotency, state_hash,
                updated_by_principal_id, updated_at)
             VALUES ($1, 1, 1, $2::jsonb, $3::jsonb, $4, $5, $6::timestamptz)
             ON CONFLICT (workspace_id) DO NOTHING
             RETURNING workspace_id, version, schema_version, state, idempotency, state_hash,
                       updated_by_principal_id, updated_at`,
            [workspaceId, JSON.stringify(candidate.domain), JSON.stringify(candidate.idempotency), candidate.stateHash, candidate.updatedByPrincipalId, candidate.updatedAt],
          )
        : await connection.query<SnapshotRow>(
            `UPDATE cwos_runtime_snapshots
                SET version = version + 1,
                    schema_version = 1,
                    state = $3::jsonb,
                    idempotency = $4::jsonb,
                    state_hash = $5,
                    updated_by_principal_id = $6,
                    updated_at = $7::timestamptz
              WHERE workspace_id = $1 AND version = $2
              RETURNING workspace_id, version, schema_version, state, idempotency, state_hash,
                        updated_by_principal_id, updated_at`,
            [workspaceId, expectedVersion, JSON.stringify(candidate.domain), JSON.stringify(candidate.idempotency), candidate.stateHash, candidate.updatedByPrincipalId, candidate.updatedAt],
          );
      const row = result.rows[0];
      if (!row) throw new CustomerWorkOsError("CONCURRENT_MODIFICATION", `runtime version ${expectedVersion} is stale`);
      return fromRow(row);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PgGovernanceApprovalResolver implements GovernanceApprovalResolver {
  constructor(private readonly pool: SqlPool) {}

  async resolve(input: {
    workspaceId: string;
    approvalId: string;
    resourceType: ApprovalReceipt["resourceType"];
    resourceId: string;
    resourceVersion: number;
    action: string;
    payloadHash: string;
  }): Promise<ApprovalReceipt> {
    return withWorkspace(this.pool, input.workspaceId, async (connection) => {
      const result = await connection.query<{
        id: string;
        workspace_id: string;
        resource_id: string;
        resource_version: number;
        action_type: string;
        payload_hash: string;
        status: string;
        decided_by_principal_id: string | null;
      }>(
        `SELECT id, workspace_id, resource_id, resource_version, action_type,
                payload_hash, status, decided_by_principal_id
           FROM orch_governance_controls
          WHERE workspace_id = $1 AND id = $2`,
        [input.workspaceId, input.approvalId],
      );
      const control = result.rows[0];
      if (!control) throw new CustomerWorkOsError("APPROVAL_NOT_FOUND", `approval control not found: ${input.approvalId}`);
      if (
        control.status !== "CONSUMED" ||
        control.resource_id !== input.resourceId ||
        control.resource_version !== input.resourceVersion ||
        control.action_type !== input.action ||
        control.payload_hash !== input.payloadHash ||
        !control.decided_by_principal_id
      ) {
        throw new CustomerWorkOsError("STALE_APPROVAL", "approval control is not consumed or does not match the current payload");
      }
      return {
        id: control.id,
        workspaceId: control.workspace_id,
        resourceType: input.resourceType,
        resourceId: control.resource_id,
        resourceVersion: control.resource_version,
        action: control.action_type,
        payloadHash: control.payload_hash,
        status: "CONSUMED",
        approvedByPrincipalId: control.decided_by_principal_id,
      };
    });
  }
}

export async function createPgCustomerWorkOsInfrastructureFromEnvironment(): Promise<{
  store: CustomerWorkOsSnapshotStore;
  approvals: GovernanceApprovalResolver;
  close(): Promise<void>;
} | undefined> {
  const connectionString = process.env.CWOS_DATABASE_URL ?? process.env.AI_CRM_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return undefined;
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
  const module = await dynamicImport("pg");
  const Pool = module.Pool as new (options: { connectionString: string; max: number; application_name: string }) => SqlPool;
  if (!Pool) throw new CustomerWorkOsError("PG_DRIVER_UNAVAILABLE", "pg Pool export is unavailable");
  const pool = new Pool({ connectionString, max: Number(process.env.CWOS_PG_POOL_MAX ?? 5), application_name: "ai-crm-cwos" });
  const store = new PgCustomerWorkOsSnapshotStore(pool);
  const approvals = new PgGovernanceApprovalResolver(pool);
  return { store, approvals, close: () => pool.end() };
}

interface WorkspaceRuntime {
  service: CustomerWorkOsService;
  version: number;
  idempotency: Map<string, IdempotencyRecord>;
  initialized: boolean;
}

export class CustomerWorkOsRuntimeManager {
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly store: CustomerWorkOsSnapshotStore) {}

  async read<T>(workspaceId: string, operation: (service: CustomerWorkOsService) => T): Promise<T> {
    const runtime = await this.runtime(workspaceId);
    return operation(runtime.service);
  }

  async mutate<T>(input: {
    workspaceId: string;
    principalId: string;
    idempotencyKey: string;
    requestHash: string;
    operation(service: CustomerWorkOsService): T;
    statusCode?: number;
    now?: string;
  }): Promise<{ statusCode: number; payload: T; replayed: boolean }> {
    return this.serialized(input.workspaceId, async () => {
      const runtime = await this.runtime(input.workspaceId);
      const existing = runtime.idempotency.get(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new CustomerWorkOsError("IDEMPOTENCY_KEY_CONFLICT", "idempotency key was used with a different request");
        }
        return { statusCode: existing.statusCode, payload: copy(existing.payload as T), replayed: true };
      }

      const before = runtime.service.exportState();
      const beforeVersion = runtime.version;
      const beforeIdempotency = new Map(runtime.idempotency);
      try {
        const payload = input.operation(runtime.service);
        const statusCode = input.statusCode ?? 201;
        const createdAt = input.now ?? new Date().toISOString();
        runtime.idempotency.set(input.idempotencyKey, {
          key: input.idempotencyKey,
          requestHash: input.requestHash,
          statusCode,
          payload: copy(payload),
          createdAt,
        });
        const retained = [...runtime.idempotency.values()]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(-5000);
        runtime.idempotency = new Map(retained.map((item) => [item.key, item]));
        const domain = runtime.service.exportState();
        const envelopeCore = {
          schemaVersion: 1 as const,
          workspaceId: input.workspaceId,
          domain,
          idempotency: retained,
          updatedByPrincipalId: input.principalId,
          updatedAt: createdAt,
        };
        const stateHash = customerWorkOsPayloadHash(envelopeCore);
        const saved = await this.store.compareAndSwap(input.workspaceId, runtime.version, { ...envelopeCore, stateHash });
        runtime.version = saved.version;
        return { statusCode, payload: copy(payload), replayed: false };
      } catch (error) {
        runtime.service.hydrateState(before);
        runtime.version = beforeVersion;
        runtime.idempotency = beforeIdempotency;
        if (error instanceof CustomerWorkOsError && error.code === "CONCURRENT_MODIFICATION") {
          await this.reload(input.workspaceId, runtime);
        }
        throw error;
      }
    });
  }

  private async runtime(workspaceId: string): Promise<WorkspaceRuntime> {
    let runtime = this.runtimes.get(workspaceId);
    if (!runtime) {
      runtime = { service: new CustomerWorkOsService(), version: 0, idempotency: new Map(), initialized: false };
      this.runtimes.set(workspaceId, runtime);
    }
    if (!runtime.initialized) await this.reload(workspaceId, runtime);
    return runtime;
  }

  private async reload(workspaceId: string, runtime: WorkspaceRuntime): Promise<void> {
    const persisted = await this.store.load(workspaceId);
    if (persisted) {
      runtime.service.hydrateState(persisted.domain);
      runtime.version = persisted.version;
      runtime.idempotency = new Map(persisted.idempotency.map((item) => [item.key, copy(item)]));
    } else {
      runtime.service.hydrateState(emptyState());
      runtime.version = 0;
      runtime.idempotency.clear();
    }
    runtime.initialized = true;
  }

  private async serialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(workspaceId, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(workspaceId) === current) this.locks.delete(workspaceId);
    }
  }
}
