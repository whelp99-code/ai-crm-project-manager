/**
 * PostgreSQL adapter for `ReportService`'s immutable final-report snapshot
 * persistence (Q2 / D2 — reports PG proof).
 *
 * Mirrors `pg-crm-adapter.ts` / `pg-governance-adapter.ts`: a stable
 * repository port, pure row <-> domain mappers, an in-memory implementation
 * for unit/restart tests without PostgreSQL, and
 * `createPgReportsRepository(pool)` for createApp injection. Backed by the
 * `report_snapshots` sidecar table from
 * `0011_reports_model_invocations.sql`.
 *
 * IMMUTABILITY: `snapshot` and `snapshotHash` are stored and read back
 * VERBATIM — this adapter never recomputes the SHA-256 hash from the
 * snapshot payload. `0011`'s `report_snapshots_immutability` trigger
 * enforces the same invariant at the database level regardless of caller,
 * so the hash is guaranteed byte-identical across a restart even if a
 * future caller bug tried to mutate it.
 */

import type { FinalReport, FinalReportSnapshot, ReportStatus } from "./index.js";

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
   * `report_snapshots` (0011) are enforced for the duration of `fn`. See
   * `pg-crm-adapter.ts`'s `PgQueryable.withWorkspaceScope` doc for the full
   * rationale — same contract here.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

export interface ReportSnapshotRow {
  id: string;
  workspace_id: string;
  project_id: string;
  submitted_by_principal_id: string;
  submitted_at: string;
  status: string;
  snapshot: FinalReportSnapshot;
  snapshot_hash: string;
  decided_by_principal_id: string | null;
  decided_at: string | null;
  rejection_reason: string | null;
}

export interface ReportRepository {
  saveReport(report: FinalReport): Promise<void>;
  /**
   * PG-primary scoped read (mirrors `CrmRepository.getCustomersForWorkspace`):
   * every persisted report for one workspace, run through
   * `withWorkspaceScope` so FORCE RLS enforces the workspace boundary.
   */
  getReportsForWorkspace(workspaceId: string): Promise<FinalReport[]>;
  /**
   * List every persisted report across all workspaces. Used for
   * hydrate-on-boot restart-consistency; hydrate runs as the service/owner
   * role so cross-workspace RLS is expected to be bypassed intentionally
   * (mirrors `listAllCustomers`/`listAllControls`).
   */
  listAllReports(): Promise<FinalReport[]>;
}

/** jsonb columns are auto-parsed to JS values by most pg drivers, but stay defensive for raw-string clients. */
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") return JSON.parse(raw) as T;
  return raw as T;
}

export function mapReportRow(row: ReportSnapshotRow): FinalReport {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    submittedByPrincipalId: row.submitted_by_principal_id,
    submittedAt: row.submitted_at,
    status: row.status as ReportStatus,
    // Verbatim passthrough — never recomputed from the stored snapshot.
    snapshot: parseJson<FinalReportSnapshot>(row.snapshot, row.snapshot),
    snapshotHash: row.snapshot_hash,
    ...(row.decided_by_principal_id !== null ? { decidedByPrincipalId: row.decided_by_principal_id } : {}),
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    ...(row.rejection_reason !== null ? { rejectionReason: row.rejection_reason } : {}),
  };
}

/**
 * In-memory report repository for unit/restart tests without PostgreSQL.
 * Round-trips the FinalReport shape (snapshot/snapshotHash verbatim).
 */
export class InMemoryReportRepository implements ReportRepository {
  private readonly reports = new Map<string, FinalReport>();

  async saveReport(report: FinalReport): Promise<void> {
    this.reports.set(`${report.workspaceId}\0${report.id}`, structuredClone(report));
  }

  async getReportsForWorkspace(workspaceId: string): Promise<FinalReport[]> {
    return [...this.reports.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => structuredClone(r));
  }

  async listAllReports(): Promise<FinalReport[]> {
    return [...this.reports.values()].map((r) => structuredClone(r));
  }
}

export function createPgReportsRepository(pool: PgQueryable): ReportRepository {
  return new PgReportRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against the `report_snapshots` sidecar table from
 * `0011_reports_model_invocations.sql` (mirrors `PgCrmRepository`).
 *
 * The UPSERT's `ON CONFLICT DO UPDATE` intentionally never touches
 * `snapshot`/`snapshot_hash`/identity columns — only the decision
 * lifecycle (status/decided_by_principal_id/decided_at/rejection_reason)
 * and version/updated_at. The 0011 immutability trigger enforces this same
 * invariant at the database level even if a future caller bug tried to
 * pass a different snapshot on conflict.
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * `listAllReports` is the hydrate-on-boot admin path: it reads across
 * every workspace and is expected to run under an admin/superuser
 * connection — production must scope hydrate to a dedicated admin role
 * instead of the bootstrap superuser. See docs/ops/sor-persistence.md.
 */
class PgReportRepository implements ReportRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveReport(report: FinalReport): Promise<void> {
    await this.scoped(report.workspaceId, (db) =>
      db.query(
        `INSERT INTO report_snapshots
           (id, workspace_id, project_id, submitted_by_principal_id, submitted_at, status,
            snapshot, snapshot_hash, decided_by_principal_id, decided_at, rejection_reason, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           decided_by_principal_id = EXCLUDED.decided_by_principal_id,
           decided_at = EXCLUDED.decided_at,
           rejection_reason = EXCLUDED.rejection_reason,
           version = report_snapshots.version + 1,
           updated_at = now()`,
        [
          report.id,
          report.workspaceId,
          report.projectId,
          report.submittedByPrincipalId,
          report.submittedAt,
          report.status,
          JSON.stringify(report.snapshot),
          report.snapshotHash,
          report.decidedByPrincipalId ?? null,
          report.decidedAt ?? null,
          report.rejectionReason ?? null,
        ],
      ),
    );
  }

  async getReportsForWorkspace(workspaceId: string): Promise<FinalReport[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<ReportSnapshotRow>(
        `SELECT * FROM report_snapshots WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapReportRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllReports(): Promise<FinalReport[]> {
    const result = await this.db.query<ReportSnapshotRow>(
      `SELECT * FROM report_snapshots ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapReportRow(row));
  }
}
