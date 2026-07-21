/**
 * PostgreSQL adapter for `ReconciliationService`/`DailyGate` persistence
 * (PG-C2 — Ultragoal P6-b G001 domain-PG core, finance reconciliation +
 * daily-gate).
 *
 * Mirrors the `pg-crm-adapter.ts` pattern: stable repository ports, pure
 * row <-> domain mappers, in-memory implementations for unit/restart tests
 * without PostgreSQL, and `createPgFinanceReconRepository(pool)` /
 * `createPgDailyGateRepository(pool)` for createApp injection.
 *
 * Money mapping: `ledgerAmountKrw`/`varianceKrw` are signed integer-KRW
 * strings (`^-?\d+$`) mapped to/from Postgres `numeric` (no declared
 * scale/precision — see 0010_finance_recon_dailygate.sql). `pg` returns
 * `numeric` columns as strings by default, so the round-trip is a
 * pass-through; this module still normalizes via `normalizeSignedInteger`
 * so a value like `"-0"` or `"5.0"` returned by a non-`pg`-driver caller
 * never leaks a non-canonical signed-integer string into the domain layer.
 *
 * `finance_daily_gate_state` holds ONE row per workspace — the DailyGate
 * MACHINE STATE, not a log. `policyVersion` is NEVER persisted here (see
 * 0010's module doc + `DailyGate.restoreState` doc): callers reconstruct it
 * from the live `FinancePackConfig.packVersion` at boot.
 */

import type { Reconciliation, FinanceException, StatementRowRef } from "./reconciliation.js";
import type { DayRecord, FinanceTier } from "./daily-gate.js";

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
   * the finance_* tables (0010) are enforced for the duration of `fn`. Same
   * contract as `PgQueryable.withWorkspaceScope` in `pg-crm-adapter.ts`.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

function normalizeSignedInteger(value: string | number): string {
  const str = typeof value === "number" ? value.toString() : value;
  const trimmed = str.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    // A malformed numeric round-trip is a persistence bug, not a domain
    // input error — fail loudly rather than silently coercing.
    throw new Error(`expected a signed integer KRW string from PG, got: ${str}`);
  }
  if (trimmed === "-0") return "0";
  return trimmed.replace(/^(-?)0+(\d)/, "$1$2");
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toDateString(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  // `pg` parses a `date` column into a JS `Date` at LOCAL midnight (not
  // UTC midnight), so `toISOString()` would shift the date by a day in any
  // timezone ahead of UTC (e.g. Asia/Seoul). Read the local calendar fields
  // instead of converting through UTC.
  const y = value.getFullYear().toString().padStart(4, "0");
  const m = (value.getMonth() + 1).toString().padStart(2, "0");
  const d = value.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Reconciliation + exceptions repository
// ---------------------------------------------------------------------------

export interface FinanceReconciliationRow {
  id: string;
  workspace_id: string;
  statement_row: StatementRowRef | string;
  ledger_amount_krw: string;
  variance_krw: string;
  status: string;
  reconciled_by_principal_id: string;
  reconciled_at: Date | string;
  exception_id: string | null;
  version: number;
}

export interface FinanceExceptionRow {
  id: string;
  workspace_id: string;
  kind: string;
  reconciliation_id: string | null;
  variance_krw: string;
  status: string;
  opened_at: Date | string;
  resolved_by_principal_id: string | null;
  resolved_at: Date | string | null;
  resolution_note: string | null;
  version: number;
}

export interface FinanceReconciliationRepository {
  saveReconciliation(reconciliation: Reconciliation): Promise<void>;
  saveException(exception: FinanceException): Promise<void>;
  getReconciliationsForWorkspace(workspaceId: string): Promise<Reconciliation[]>;
  getExceptionsForWorkspace(workspaceId: string): Promise<FinanceException[]>;
  /** Hydrate-on-boot admin path: every persisted row across all workspaces. */
  listAllReconciliations(): Promise<Reconciliation[]>;
  listAllExceptions(): Promise<FinanceException[]>;
}

export function mapReconciliationRow(row: FinanceReconciliationRow): Reconciliation {
  const statementRow: StatementRowRef =
    typeof row.statement_row === "string" ? (JSON.parse(row.statement_row) as StatementRowRef) : row.statement_row;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    statementRow: {
      account: statementRow.account,
      postedAt: statementRow.postedAt,
      amountKrw: normalizeSignedInteger(statementRow.amountKrw),
      rowFingerprint: statementRow.rowFingerprint,
    },
    ledgerAmountKrw: normalizeSignedInteger(row.ledger_amount_krw),
    varianceKrw: normalizeSignedInteger(row.variance_krw),
    status: row.status as Reconciliation["status"],
    reconciledByPrincipalId: row.reconciled_by_principal_id,
    reconciledAt: toIso(row.reconciled_at),
    ...(row.exception_id !== null ? { exceptionId: row.exception_id } : {}),
  };
}

export function mapExceptionRow(row: FinanceExceptionRow): FinanceException {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as FinanceException["kind"],
    reconciliationId: row.reconciliation_id ?? "",
    varianceKrw: normalizeSignedInteger(row.variance_krw),
    status: row.status as FinanceException["status"],
    openedAt: toIso(row.opened_at),
    ...(row.resolved_by_principal_id !== null ? { resolvedByPrincipalId: row.resolved_by_principal_id } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: toIso(row.resolved_at) } : {}),
    ...(row.resolution_note !== null ? { resolutionNote: row.resolution_note } : {}),
  };
}

/**
 * In-memory reconciliation repository for unit/restart tests without
 * PostgreSQL. Round-trips the Reconciliation/FinanceException shapes.
 */
export class InMemoryFinanceReconciliationRepository implements FinanceReconciliationRepository {
  private readonly reconciliations = new Map<string, Reconciliation>();
  private readonly exceptions = new Map<string, FinanceException>();

  async saveReconciliation(reconciliation: Reconciliation): Promise<void> {
    this.reconciliations.set(`${reconciliation.workspaceId}\0${reconciliation.id}`, structuredClone(reconciliation));
  }

  async saveException(exception: FinanceException): Promise<void> {
    this.exceptions.set(`${exception.workspaceId}\0${exception.id}`, structuredClone(exception));
  }

  async getReconciliationsForWorkspace(workspaceId: string): Promise<Reconciliation[]> {
    return [...this.reconciliations.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => structuredClone(r));
  }

  async getExceptionsForWorkspace(workspaceId: string): Promise<FinanceException[]> {
    return [...this.exceptions.values()]
      .filter((e) => e.workspaceId === workspaceId)
      .map((e) => structuredClone(e));
  }

  async listAllReconciliations(): Promise<Reconciliation[]> {
    return [...this.reconciliations.values()].map((r) => structuredClone(r));
  }

  async listAllExceptions(): Promise<FinanceException[]> {
    return [...this.exceptions.values()].map((e) => structuredClone(e));
  }
}

export function createPgFinanceReconciliationRepository(pool: PgQueryable): FinanceReconciliationRepository {
  return new PgFinanceReconciliationRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against `finance_reconciliations`/`finance_exceptions` from
 * 0010_finance_recon_dailygate.sql (mirrors `PgCrmRepository`).
 */
class PgFinanceReconciliationRepository implements FinanceReconciliationRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveReconciliation(reconciliation: Reconciliation): Promise<void> {
    await this.scoped(reconciliation.workspaceId, (db) =>
      db.query(
        `INSERT INTO finance_reconciliations (
           id, workspace_id, statement_row, ledger_amount_krw, variance_krw,
           status, reconciled_by_principal_id, reconciled_at, exception_id, version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
         ON CONFLICT (id) DO UPDATE SET
           statement_row = EXCLUDED.statement_row,
           ledger_amount_krw = EXCLUDED.ledger_amount_krw,
           variance_krw = EXCLUDED.variance_krw,
           status = EXCLUDED.status,
           reconciled_by_principal_id = EXCLUDED.reconciled_by_principal_id,
           reconciled_at = EXCLUDED.reconciled_at,
           exception_id = EXCLUDED.exception_id,
           version = finance_reconciliations.version + 1,
           updated_at = now()`,
        [
          reconciliation.id,
          reconciliation.workspaceId,
          JSON.stringify(reconciliation.statementRow),
          reconciliation.ledgerAmountKrw,
          reconciliation.varianceKrw,
          reconciliation.status,
          reconciliation.reconciledByPrincipalId,
          reconciliation.reconciledAt,
          reconciliation.exceptionId ?? null,
        ],
      ),
    );
  }

  async saveException(exception: FinanceException): Promise<void> {
    await this.scoped(exception.workspaceId, (db) =>
      db.query(
        `INSERT INTO finance_exceptions (
           id, workspace_id, kind, reconciliation_id, variance_krw, status,
           opened_at, resolved_by_principal_id, resolved_at, resolution_note, version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           reconciliation_id = EXCLUDED.reconciliation_id,
           variance_krw = EXCLUDED.variance_krw,
           status = EXCLUDED.status,
           opened_at = EXCLUDED.opened_at,
           resolved_by_principal_id = EXCLUDED.resolved_by_principal_id,
           resolved_at = EXCLUDED.resolved_at,
           resolution_note = EXCLUDED.resolution_note,
           version = finance_exceptions.version + 1,
           updated_at = now()`,
        [
          exception.id,
          exception.workspaceId,
          exception.kind,
          exception.reconciliationId,
          exception.varianceKrw,
          exception.status,
          exception.openedAt,
          exception.resolvedByPrincipalId ?? null,
          exception.resolvedAt ?? null,
          exception.resolutionNote ?? null,
        ],
      ),
    );
  }

  async getReconciliationsForWorkspace(workspaceId: string): Promise<Reconciliation[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<FinanceReconciliationRow>(
        `SELECT * FROM finance_reconciliations WHERE workspace_id = $1 ORDER BY reconciled_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapReconciliationRow(row));
  }

  async getExceptionsForWorkspace(workspaceId: string): Promise<FinanceException[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<FinanceExceptionRow>(
        `SELECT * FROM finance_exceptions WHERE workspace_id = $1 ORDER BY opened_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapExceptionRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllReconciliations(): Promise<Reconciliation[]> {
    const result = await this.db.query<FinanceReconciliationRow>(
      `SELECT * FROM finance_reconciliations ORDER BY reconciled_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapReconciliationRow(row));
  }

  async listAllExceptions(): Promise<FinanceException[]> {
    const result = await this.db.query<FinanceExceptionRow>(
      `SELECT * FROM finance_exceptions ORDER BY opened_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapExceptionRow(row));
  }
}

// ---------------------------------------------------------------------------
// Daily-gate state + day-record repository
// ---------------------------------------------------------------------------

export interface DailyGateStateInput {
  streak: number;
  tier: FinanceTier;
  lastDateEpoch?: number | undefined;
  activatedMatrixVersion?: number | undefined;
}

export interface DailyGateStateRow {
  workspace_id: string;
  streak: number;
  tier: string;
  last_date_epoch: string | number | null;
  activated_matrix_version: string | number | null;
  version: number;
}

export interface AppendDayRecordInput {
  date: string;
  qualifying: boolean;
  reason?: string;
  streakAfter: number;
  tierAfter: FinanceTier;
}

export interface DayRecordRow {
  workspace_id: string;
  date: Date | string;
  qualifying: boolean;
  reason: string | null;
  streak_after: number;
  tier_after: string;
}

export interface DailyGateRepository {
  saveDailyGateState(workspaceId: string, state: DailyGateStateInput): Promise<void>;
  getDailyGateState(workspaceId: string): Promise<DailyGateStateInput | undefined>;
  appendDayRecord(workspaceId: string, record: AppendDayRecordInput): Promise<void>;
  listDayRecords(workspaceId: string): Promise<DayRecord[]>;
  /** Hydrate-on-boot admin path: every persisted state row across all workspaces. */
  listAllDailyGateStates(): Promise<Array<{ workspaceId: string } & DailyGateStateInput>>;
  listAllDayRecords(): Promise<Array<{ workspaceId: string } & DayRecord>>;
}

function mapDailyGateStateRow(row: DailyGateStateRow): DailyGateStateInput {
  return {
    streak: row.streak,
    tier: row.tier as FinanceTier,
    ...(row.last_date_epoch !== null ? { lastDateEpoch: Number(row.last_date_epoch) } : {}),
    ...(row.activated_matrix_version !== null ? { activatedMatrixVersion: Number(row.activated_matrix_version) } : {}),
  };
}

function mapDayRecordRow(row: DayRecordRow): DayRecord {
  return {
    date: toDateString(row.date),
    qualifying: row.qualifying,
    streakAfter: row.streak_after,
    tierAfter: row.tier_after as FinanceTier,
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}

/**
 * In-memory daily-gate repository for unit/restart tests without
 * PostgreSQL. Round-trips machine state + day records.
 */
export class InMemoryDailyGateRepository implements DailyGateRepository {
  private readonly states = new Map<string, DailyGateStateInput>();
  private readonly dayRecords = new Map<string, DayRecord>();

  async saveDailyGateState(workspaceId: string, state: DailyGateStateInput): Promise<void> {
    this.states.set(workspaceId, { ...state });
  }

  async getDailyGateState(workspaceId: string): Promise<DailyGateStateInput | undefined> {
    const state = this.states.get(workspaceId);
    return state ? { ...state } : undefined;
  }

  async appendDayRecord(workspaceId: string, record: AppendDayRecordInput): Promise<void> {
    this.dayRecords.set(`${workspaceId}\0${record.date}`, {
      date: record.date,
      qualifying: record.qualifying,
      streakAfter: record.streakAfter,
      tierAfter: record.tierAfter,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    });
  }

  async listDayRecords(workspaceId: string): Promise<DayRecord[]> {
    return [...this.dayRecords.entries()]
      .filter(([key]) => key.startsWith(`${workspaceId}\0`))
      .map(([, record]) => structuredClone(record))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async listAllDailyGateStates(): Promise<Array<{ workspaceId: string } & DailyGateStateInput>> {
    return [...this.states.entries()].map(([workspaceId, state]) => ({ workspaceId, ...state }));
  }

  async listAllDayRecords(): Promise<Array<{ workspaceId: string } & DayRecord>> {
    return [...this.dayRecords.entries()].map(([key, record]) => ({
      workspaceId: key.slice(0, key.indexOf("\0")),
      ...structuredClone(record),
    }));
  }
}

export function createPgDailyGateRepository(pool: PgQueryable): DailyGateRepository {
  return new PgDailyGateRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped UPSERT/SELECT
 * statements against `finance_daily_gate_state`/`finance_day_records` from
 * 0010_finance_recon_dailygate.sql.
 *
 * `saveDailyGateState` is called on every tier transition (conservative ->
 * eligible, eligible -> risk_tiered, any demotion) and on every `recordDay`
 * call (the streak/lastDateEpoch always change) — see the app.ts wiring
 * diff for the exact call sites. `appendDayRecord` is called once per
 * `DailyGate.recordDay` result (INSERT-only: a day, once recorded, is never
 * mutated in place).
 */
class PgDailyGateRepository implements DailyGateRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveDailyGateState(workspaceId: string, state: DailyGateStateInput): Promise<void> {
    await this.scoped(workspaceId, (db) =>
      db.query(
        `INSERT INTO finance_daily_gate_state (workspace_id, streak, tier, last_date_epoch, activated_matrix_version, version)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (workspace_id) DO UPDATE SET
           streak = EXCLUDED.streak,
           tier = EXCLUDED.tier,
           last_date_epoch = EXCLUDED.last_date_epoch,
           activated_matrix_version = EXCLUDED.activated_matrix_version,
           version = finance_daily_gate_state.version + 1,
           updated_at = now()`,
        [
          workspaceId,
          state.streak,
          state.tier,
          state.lastDateEpoch ?? null,
          state.activatedMatrixVersion ?? null,
        ],
      ),
    );
  }

  async getDailyGateState(workspaceId: string): Promise<DailyGateStateInput | undefined> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<DailyGateStateRow>(`SELECT * FROM finance_daily_gate_state WHERE workspace_id = $1`, [workspaceId]),
    );
    const row = result.rows[0];
    return row ? mapDailyGateStateRow(row) : undefined;
  }

  async appendDayRecord(workspaceId: string, record: AppendDayRecordInput): Promise<void> {
    await this.scoped(workspaceId, (db) =>
      db.query(
        `INSERT INTO finance_day_records (workspace_id, date, qualifying, reason, streak_after, tier_after)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, date) DO NOTHING`,
        [workspaceId, record.date, record.qualifying, record.reason ?? null, record.streakAfter, record.tierAfter],
      ),
    );
  }

  async listDayRecords(workspaceId: string): Promise<DayRecord[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<DayRecordRow>(
        `SELECT * FROM finance_day_records WHERE workspace_id = $1 ORDER BY date ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapDayRecordRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllDailyGateStates(): Promise<Array<{ workspaceId: string } & DailyGateStateInput>> {
    const result = await this.db.query<DailyGateStateRow>(`SELECT * FROM finance_daily_gate_state`);
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, ...mapDailyGateStateRow(row) }));
  }

  async listAllDayRecords(): Promise<Array<{ workspaceId: string } & DayRecord>> {
    const result = await this.db.query<DayRecordRow>(`SELECT * FROM finance_day_records ORDER BY workspace_id ASC, date ASC`);
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, ...mapDayRecordRow(row) }));
  }
}
