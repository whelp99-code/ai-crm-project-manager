/**
 * PostgreSQL adapter for `ModelGateway`'s MODEL_INVOKE audit-trail
 * persistence (Q2 / D2 — model-gateway PG proof).
 *
 * Mirrors `pg-crm-adapter.ts` / `pg-reports-adapter.ts`: a stable
 * repository port, pure row <-> domain mappers, an in-memory implementation
 * for unit/restart tests without PostgreSQL, and
 * `createPgModelInvocationRepository(pool)` for createApp injection.
 * Backed by the pre-existing `model_invocations` table (0001_foundation.sql,
 * column-shape-adjusted by 0011_reports_model_invocations.sql).
 *
 * ADR-010 DISJOINT-PRINCIPAL BOUNDARY: `model_invocations` write access was
 * deliberately moved from `ai_crm_runtime_api`/`ai_crm_runtime_worker` to
 * the disjoint `ai_crm_runtime_model_gateway` role in
 * `0002_model_gateway_and_break_glass_roles.sql`
 * (`schema.security.test.ts` asserts no later migration ever re-grants it
 * to api/worker). This adapter does not change that boundary — the `pool`
 * injected here MUST be authenticated as (or `SET ROLE`d into)
 * `ai_crm_runtime_model_gateway`, never the shared api/worker pool. See
 * `createApp`'s `modelGatewayDatabaseUrl`/`MODEL_GATEWAY_DATABASE_URL` doc
 * in apps/api/src/app.ts for the connection-level enforcement of this.
 */

import type { ActionType } from "@ai-crm/contracts";
import type { ModelInvocationRecord, RetentionMode } from "./index.js";

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
   * `model_invocations` are enforced for the duration of `fn`. See
   * `pg-crm-adapter.ts`'s `PgQueryable.withWorkspaceScope` doc for the full
   * rationale — same contract here.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

export interface ModelInvocationRow {
  external_id: string;
  workspace_id: string;
  principal_id: string;
  registry_operation_id: string;
  action_type: string;
  model_version: string | null;
  prompt_version: string | null;
  structured_output_schema_version: string | null;
  prompt_digest: string;
  response_digest: string | null;
  retention_mode: string;
  latency_ms: number | null;
  correlation_id: string;
  created_at: Date | string;
}

export interface ModelInvocationRepository {
  saveInvocation(record: ModelInvocationRecord): Promise<void>;
  /**
   * PG-primary scoped read (mirrors `CrmRepository.getCustomersForWorkspace`):
   * every persisted invocation for one workspace, run through
   * `withWorkspaceScope` so FORCE RLS enforces the workspace boundary.
   */
  getInvocationsForWorkspace(workspaceId: string): Promise<ModelInvocationRecord[]>;
  /**
   * List every persisted invocation across all workspaces. Used for
   * hydrate-on-boot restart-consistency; hydrate runs as the
   * model-gateway-scoped connection (never api/worker — see module doc).
   */
  listAllInvocations(): Promise<ModelInvocationRecord[]>;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export function mapInvocationRow(row: ModelInvocationRow): ModelInvocationRecord {
  return {
    id: row.external_id,
    workspaceId: row.workspace_id,
    operationId: row.registry_operation_id,
    actionType: row.action_type as ActionType,
    principalId: row.principal_id,
    promptVersion: row.prompt_version ?? "",
    modelVersion: row.model_version ?? "",
    outputSchemaVersion: row.structured_output_schema_version ?? "",
    redactedPromptDigest: row.prompt_digest,
    responseDigest: row.response_digest ?? "",
    retentionMode: row.retention_mode as RetentionMode,
    latencyMs: row.latency_ms ?? 0,
    correlationId: row.correlation_id,
    createdAt: toIso(row.created_at),
  };
}

/**
 * In-memory model-invocation repository for unit/restart tests without
 * PostgreSQL. Round-trips the ModelInvocationRecord shape.
 */
export class InMemoryModelInvocationRepository implements ModelInvocationRepository {
  private readonly invocations = new Map<string, ModelInvocationRecord>();

  async saveInvocation(record: ModelInvocationRecord): Promise<void> {
    this.invocations.set(`${record.workspaceId}\0${record.id}`, structuredClone(record));
  }

  async getInvocationsForWorkspace(workspaceId: string): Promise<ModelInvocationRecord[]> {
    return [...this.invocations.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => structuredClone(r));
  }

  async listAllInvocations(): Promise<ModelInvocationRecord[]> {
    return [...this.invocations.values()].map((r) => structuredClone(r));
  }
}

export function createPgModelInvocationRepository(pool: PgQueryable): ModelInvocationRepository {
  return new PgModelInvocationRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped INSERT/SELECT
 * statements against `model_invocations` (mirrors `PgCrmRepository`).
 * Append-only: `saveInvocation` is `ON CONFLICT (external_id) DO NOTHING`
 * (invocation records are never updated once written, like audit_events).
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * `listAllInvocations` is the hydrate-on-boot admin path: it reads across
 * every workspace. See docs/ops/sor-persistence.md and this module's
 * class-level ADR-010 doc for the connection/role this pool must use.
 */
class PgModelInvocationRepository implements ModelInvocationRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveInvocation(record: ModelInvocationRecord): Promise<void> {
    await this.scoped(record.workspaceId, (db) =>
      db.query(
        `INSERT INTO model_invocations
           (external_id, workspace_id, principal_id, registry_operation_id, action_type,
            model_version, prompt_version, structured_output_schema_version,
            prompt_digest, response_digest, retention_mode, latency_ms, correlation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (external_id) DO NOTHING`,
        [
          record.id,
          record.workspaceId,
          record.principalId,
          record.operationId,
          record.actionType,
          record.modelVersion,
          record.promptVersion,
          record.outputSchemaVersion,
          record.redactedPromptDigest,
          record.responseDigest,
          record.retentionMode,
          record.latencyMs,
          record.correlationId,
          record.createdAt,
        ],
      ),
    );
  }

  async getInvocationsForWorkspace(workspaceId: string): Promise<ModelInvocationRecord[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<ModelInvocationRow>(
        `SELECT * FROM model_invocations WHERE workspace_id = $1 ORDER BY created_at ASC, external_id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapInvocationRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllInvocations(): Promise<ModelInvocationRecord[]> {
    const result = await this.db.query<ModelInvocationRow>(
      `SELECT * FROM model_invocations ORDER BY created_at ASC, external_id ASC`,
    );
    return result.rows.map((row) => mapInvocationRow(row));
  }
}
