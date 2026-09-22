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

import { createHash, randomUUID } from "node:crypto";
import type { Reconciliation, FinanceException, StatementRowRef } from "./reconciliation.js";
import type { DailyGatePersistedState, DayRecord, FinanceTier } from "./daily-gate.js";

/** Exact governance canonical-object serialization for audit chain material. */
function stableAuditStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableAuditStringify).join(",")}]`;
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stableAuditStringify(objectValue[key])}`).join(",")}}`;
  }
  throw new Error("DAILY_GATE_AUDIT_NON_CANONICAL_VALUE");
}

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
  /**
   * Atomic two-row reconcile commit (mirrors `LedgerRepository.postEntryAtomic`):
   * UPSERTs `reconciliation` and, when `exception` is supplied (a VARIANCE
   * reconcile that opens a new exception), UPSERTs it too — both inside ONE
   * `withWorkspaceScope` transaction, so a mid-way failure (e.g. the
   * exception INSERT throwing) rolls back the reconciliation row as well.
   * Prevents the "reconciliation persisted, exception lost" partial-commit
   * window that a restart would otherwise silently paper over (hydrate
   * re-adds the fingerprint to `reconciledFingerprints` while
   * `openExceptions` returns `[]` for the missing exception).
   */
  saveReconciliationWithException(reconciliation: Reconciliation, exception?: FinanceException): Promise<void>;
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
  async saveReconciliationWithException(reconciliation: Reconciliation, exception?: FinanceException): Promise<void> {
    this.reconciliations.set(`${reconciliation.workspaceId}\0${reconciliation.id}`, structuredClone(reconciliation));
    if (exception) {
      this.exceptions.set(`${exception.workspaceId}\0${exception.id}`, structuredClone(exception));
    }
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

  private async insertReconciliation(db: PgQueryable, reconciliation: Reconciliation): Promise<void> {
    await db.query(
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
    );
  }

  async saveReconciliation(reconciliation: Reconciliation): Promise<void> {
    await this.scoped(reconciliation.workspaceId, (db) => this.insertReconciliation(db, reconciliation));
  }

  private async insertException(db: PgQueryable, exception: FinanceException): Promise<void> {
    await db.query(
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
    );
  }

  async saveException(exception: FinanceException): Promise<void> {
    await this.scoped(exception.workspaceId, (db) => this.insertException(db, exception));
  }

  /**
   * Atomic two-row reconcile commit — see `FinanceReconciliationRepository`
   * doc. Both writes run on the SAME scoped connection/transaction (one
   * `withWorkspaceScope` call), so a failure on either statement rolls back
   * both.
   */
  async saveReconciliationWithException(reconciliation: Reconciliation, exception?: FinanceException): Promise<void> {
    await this.scoped(reconciliation.workspaceId, async (db) => {
      await this.insertReconciliation(db, reconciliation);
      if (exception) {
        await this.insertException(db, exception);
      }
    });
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

export interface DailyGateStateInput extends DailyGatePersistedState {}

export interface DailyGateStateRow {
  workspace_id: string;
  streak: number;
  tier: string;
  last_date_epoch: string | number | null;
  activated_matrix_version: string | number | null;
  pack_version: string | number | null;
  version: number;
}

export interface DailyGateVersionTransition {
  reason: "persisted_pack_version_missing" | "pack_version_mismatch";
  fromPackVersion?: number | undefined;
  toPackVersion: number;
  prior: DailyGateStateInput;
  resetState?: DailyGateStateInput;
}

export interface AppendDayRecordInput {
  date: string;
  qualifying: boolean;
  reason?: string;
  streakAfter: number;
  tierAfter: FinanceTier;
}

export interface DailyGateEvidenceInput {
  date: string; controllerId: string; evidenceId: string; evidenceHash: string; evidenceSignature: string;
  metrics: { importsCompleted: boolean; entriesBalanced: boolean; openFinanceExceptions: number };
  receivedAt: string; matrixVersion: number; policyVersion: number; packVersion: number;
  resultingStreak: number; resultingTier: FinanceTier; provenance: unknown;
}
export interface DailyGateActivationInput {
  date: string; evidenceHash: string; cfoId: string; approvalId: string; approvalHash: string; approvalSignature: string; approvedAt: string; expiresAt: string;
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
  /**
   * Atomic two-row record-day commit (mirrors `LedgerRepository.postEntryAtomic`
   * / `FinanceReconciliationRepository.saveReconciliationWithException`):
   * INSERTs `record` and UPSERTs the resulting machine `state` — both inside
   * ONE `withWorkspaceScope` transaction, so a mid-way failure (e.g. the
   * state UPSERT throwing) rolls back the day-record row as well. Prevents
   * a day record persisting without its streak/tier state update (or vice
   * versa), which would otherwise diverge the DailyGate machine state from
   * its own recorded history after a restart.
   */
  appendDayRecordWithState(workspaceId: string, record: AppendDayRecordInput, state: DailyGateStateInput): Promise<void>;
  recordDayWithGovernance(workspaceId: string, record: AppendDayRecordInput, state: DailyGateStateInput, evidence: DailyGateEvidenceInput): Promise<void>;
  activateRiskTierWithGovernance(workspaceId: string, state: DailyGateStateInput, activation: DailyGateActivationInput): Promise<void>;
  listDailyGateEvidence(workspaceId: string): Promise<DailyGateEvidenceInput[]>;
  listDailyGateActivations(workspaceId: string): Promise<DailyGateActivationInput[]>;
  /** Atomically persists a conservative version-drift reset and immutable proof. */
  resetDailyGateStateWithAudit(workspaceId: string, state: DailyGateStateInput, transition: DailyGateVersionTransition): Promise<void>;
  listDailyGateVersionTransitions(workspaceId: string): Promise<DailyGateVersionTransition[]>;
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
    ...(row.pack_version !== null && row.pack_version !== undefined ? { packVersion: Number(row.pack_version) } : {}),
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
  private readonly versionTransitions = new Map<string, DailyGateVersionTransition[]>();
  private readonly evidence = new Map<string, DailyGateEvidenceInput>();
  private readonly activations = new Map<string, DailyGateActivationInput>();
  private readonly evidenceTokens = new Set<string>();
  private readonly approvalTokens = new Set<string>();

  async saveDailyGateState(workspaceId: string, state: DailyGateStateInput): Promise<void> {
    this.states.set(workspaceId, { ...state });
  }

  async getDailyGateState(workspaceId: string): Promise<DailyGateStateInput | undefined> {
    const state = this.states.get(workspaceId);
    return state ? { ...state } : undefined;
  }

  async appendDayRecord(workspaceId: string, record: AppendDayRecordInput): Promise<void> {
    const key = `${workspaceId}\0${record.date}`;
    if (this.dayRecords.has(key)) {
      throw new Error("DUPLICATE_DAILY_GATE_RECORD");
    }
    this.dayRecords.set(key, {
      date: record.date,
      qualifying: record.qualifying,
      streakAfter: record.streakAfter,
      tierAfter: record.tierAfter,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    });
  }
  async appendDayRecordWithState(
    workspaceId: string,
    record: AppendDayRecordInput,
    state: DailyGateStateInput,
  ): Promise<void> {
    await this.appendDayRecord(workspaceId, record);
    await this.saveDailyGateState(workspaceId, state);
  }
  async recordDayWithGovernance(workspaceId: string, record: AppendDayRecordInput, state: DailyGateStateInput, evidence: DailyGateEvidenceInput): Promise<void> {
    const key = `${workspaceId}\0${evidence.date}`;
    if (this.evidence.has(key) || this.evidenceTokens.has(`${workspaceId}\0${evidence.evidenceId}`) || this.evidenceTokens.has(`${workspaceId}\0${evidence.evidenceHash}`)) throw new Error("DAILY_GATE_REPLAY");
    await this.appendDayRecordWithState(workspaceId, record, state);
    this.evidence.set(key, structuredClone(evidence));
    this.evidenceTokens.add(`${workspaceId}\0${evidence.evidenceId}`); this.evidenceTokens.add(`${workspaceId}\0${evidence.evidenceHash}`);
  }
  async activateRiskTierWithGovernance(workspaceId: string, state: DailyGateStateInput, activation: DailyGateActivationInput): Promise<void> {
    const key = `${workspaceId}\0${activation.date}`;
    if (this.activations.has(key) || this.approvalTokens.has(`${workspaceId}\0${activation.approvalId}`) || this.approvalTokens.has(`${workspaceId}\0${activation.approvalHash}`)) throw new Error("DAILY_GATE_REPLAY");
    this.activations.set(key, structuredClone(activation));
    this.approvalTokens.add(`${workspaceId}\0${activation.approvalId}`); this.approvalTokens.add(`${workspaceId}\0${activation.approvalHash}`);
    await this.saveDailyGateState(workspaceId, state);
  }
  async listDailyGateEvidence(workspaceId: string): Promise<DailyGateEvidenceInput[]> { return [...this.evidence.entries()].filter(([key]) => key.startsWith(`${workspaceId}\0`)).map(([, item]) => structuredClone(item)); }
  async listDailyGateActivations(workspaceId: string): Promise<DailyGateActivationInput[]> { return [...this.activations.entries()].filter(([key]) => key.startsWith(`${workspaceId}\0`)).map(([, item]) => structuredClone(item)); }

  async resetDailyGateStateWithAudit(
    workspaceId: string,
    state: DailyGateStateInput,
    transition: DailyGateVersionTransition,
  ): Promise<void> {
    const audit = { ...transition, resetState: { ...state }, prior: { ...transition.prior } };
    this.states.set(workspaceId, { ...state });
    this.versionTransitions.set(workspaceId, [...(this.versionTransitions.get(workspaceId) ?? []), audit]);
  }

  async listDailyGateVersionTransitions(workspaceId: string): Promise<DailyGateVersionTransition[]> {
    return structuredClone(this.versionTransitions.get(workspaceId) ?? []);
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

  private async upsertDailyGateState(db: PgQueryable, workspaceId: string, state: DailyGateStateInput): Promise<void> {
    await db.query(
      `INSERT INTO finance_daily_gate_state (workspace_id, streak, tier, last_date_epoch, activated_matrix_version, pack_version, version)
         VALUES ($1,$2,$3,$4,$5,$6,1)
         ON CONFLICT (workspace_id) DO UPDATE SET
           streak = EXCLUDED.streak,
           tier = EXCLUDED.tier,
           last_date_epoch = EXCLUDED.last_date_epoch,
           activated_matrix_version = EXCLUDED.activated_matrix_version,
           pack_version = EXCLUDED.pack_version,
           version = finance_daily_gate_state.version + 1,
           updated_at = now()`,
      [
        workspaceId,
        state.streak,
        state.tier,
        state.lastDateEpoch ?? null,
        state.activatedMatrixVersion ?? null,
        state.packVersion ?? null,
      ],
    );
  }

  async saveDailyGateState(workspaceId: string, state: DailyGateStateInput): Promise<void> {
    await this.scoped(workspaceId, (db) => this.upsertDailyGateState(db, workspaceId, state));
  }

  async getDailyGateState(workspaceId: string): Promise<DailyGateStateInput | undefined> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<DailyGateStateRow>(`SELECT * FROM finance_daily_gate_state WHERE workspace_id = $1`, [workspaceId]),
    );
    const row = result.rows[0];
    return row ? mapDailyGateStateRow(row) : undefined;
  }

  private async insertDayRecord(db: PgQueryable, workspaceId: string, record: AppendDayRecordInput): Promise<void> {
    const result = await db.query(
      `INSERT INTO finance_day_records (workspace_id, date, qualifying, reason, streak_after, tier_after)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, date) DO NOTHING
         RETURNING workspace_id`,
      [workspaceId, record.date, record.qualifying, record.reason ?? null, record.streakAfter, record.tierAfter],
    );
    if (result.rowCount !== 1) throw new Error("DUPLICATE_DAILY_GATE_RECORD");
  }

  private async appendAudit(db: PgQueryable, workspaceId: string, kind: string, subjectId: string, keys: Record<string, string>): Promise<void> {
    await db.query(`INSERT INTO audit_chain_heads (workspace_id, head_sequence) VALUES ($1,0) ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId]);
    const head = await db.query<{ head_sequence: string | number; head_event_hash: string | null }>(`SELECT head_sequence, head_event_hash FROM audit_chain_heads WHERE workspace_id = $1 FOR UPDATE`, [workspaceId]);
    const sequence = Number(head.rows[0]?.head_sequence ?? 0) + 1;
    const previousHash = head.rows[0]?.head_event_hash ?? "0".repeat(64);
    const data = { ...keys };
    const material = `${workspaceId}\0${sequence}\0${kind}\0${subjectId}\0${stableAuditStringify(data)}\0${previousHash}`;
    const eventHash = createHash("sha256").update(material, "utf8").digest("hex");
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO audit_events (workspace_id, sequence, event_type, payload, previous_event_hash, event_hash, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [workspaceId, sequence, kind, JSON.stringify({ subjectId, data }), previousHash, eventHash, randomUUID()],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) throw new Error("DAILY_GATE_AUDIT_INSERT_FAILED");
    await db.query(`INSERT INTO outbox_events (workspace_id, audit_event_id, event_type, partition_key, payload, status) VALUES ($1,$2,$3,$4,$5,'PENDING')`, [workspaceId, eventId, kind, workspaceId, JSON.stringify({ workspaceId, eventId, kind })]);
    await db.query(`UPDATE audit_chain_heads SET head_sequence=$2, head_event_id=$3, head_event_hash=$4, updated_at=now() WHERE workspace_id=$1`, [workspaceId, sequence, eventId, eventHash]);
  }

  async recordDayWithGovernance(workspaceId: string, record: AppendDayRecordInput, state: DailyGateStateInput, evidence: DailyGateEvidenceInput): Promise<void> {
    await this.scoped(workspaceId, async (db) => {
      const replay = await db.query(`SELECT 1 FROM finance_daily_gate_evidence WHERE workspace_id=$1 AND (business_date=$2 OR evidence_id=$3 OR evidence_hash=$4) FOR UPDATE`, [workspaceId, evidence.date, evidence.evidenceId, evidence.evidenceHash]);
      if (replay.rows.length > 0) throw new Error("DAILY_GATE_REPLAY");
      await db.query(`INSERT INTO finance_daily_gate_evidence (workspace_id,business_date,controller_principal_id,controller_role,evidence_id,evidence_hash,evidence_signature,metrics,received_at,matrix_version,policy_version,pack_version,resulting_streak,resulting_tier,provenance) VALUES ($1,$2,$3,'CONTROLLER',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [workspaceId, evidence.date, evidence.controllerId, evidence.evidenceId, evidence.evidenceHash, evidence.evidenceSignature, JSON.stringify(evidence.metrics), evidence.receivedAt, evidence.matrixVersion, evidence.policyVersion, evidence.packVersion, evidence.resultingStreak, evidence.resultingTier, JSON.stringify(evidence.provenance)]);
      await this.appendAudit(db, workspaceId, "FINANCE_DAILY_GATE_EVIDENCE", evidence.evidenceId, { workspaceId, evidenceId: evidence.evidenceId, evidenceHash: evidence.evidenceHash, kind: "daily_gate_evidence" });
      await this.insertDayRecord(db, workspaceId, record);
      await this.upsertDailyGateState(db, workspaceId, state);
    });
  }

  async activateRiskTierWithGovernance(workspaceId: string, state: DailyGateStateInput, activation: DailyGateActivationInput): Promise<void> {
    await this.scoped(workspaceId, async (db) => {
      const replay = await db.query(`SELECT 1 FROM finance_daily_gate_activations WHERE workspace_id=$1 AND (business_date=$2 OR approval_id=$3 OR approval_hash=$4) FOR UPDATE`, [workspaceId, activation.date, activation.approvalId, activation.approvalHash]);
      if (replay.rows.length > 0) throw new Error("DAILY_GATE_REPLAY");
      await db.query(`INSERT INTO finance_daily_gate_activations (workspace_id,business_date,evidence_hash,cfo_principal_id,approval_id,approval_hash,approval_signature,approved_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [workspaceId, activation.date, activation.evidenceHash, activation.cfoId, activation.approvalId, activation.approvalHash, activation.approvalSignature, activation.approvedAt, activation.expiresAt]);
      await this.appendAudit(db, workspaceId, "FINANCE_DAILY_GATE_ACTIVATION", activation.approvalId, { workspaceId, approvalId: activation.approvalId, approvalHash: activation.approvalHash, kind: "daily_gate_activation" });
      await this.upsertDailyGateState(db, workspaceId, state);
    });
  }

  async listDailyGateEvidence(workspaceId: string): Promise<DailyGateEvidenceInput[]> {
    const result = await this.scoped(workspaceId, (db) => db.query<{ business_date: Date | string; controller_principal_id: string; evidence_id: string; evidence_hash: string; evidence_signature: string; metrics: DailyGateEvidenceInput["metrics"]; received_at: Date | string; matrix_version: number; policy_version: number; pack_version: number; resulting_streak: number; resulting_tier: FinanceTier; provenance: unknown }>(`SELECT business_date,controller_principal_id,evidence_id,evidence_hash,evidence_signature,metrics,received_at,matrix_version,policy_version,pack_version,resulting_streak,resulting_tier,provenance FROM finance_daily_gate_evidence WHERE workspace_id=$1 ORDER BY business_date ASC`, [workspaceId]));
    return result.rows.map((row) => ({ date: toDateString(row.business_date), controllerId: row.controller_principal_id, evidenceId: row.evidence_id, evidenceHash: row.evidence_hash, evidenceSignature: row.evidence_signature, metrics: structuredClone(row.metrics), receivedAt: toIso(row.received_at), matrixVersion: Number(row.matrix_version), policyVersion: Number(row.policy_version), packVersion: Number(row.pack_version), resultingStreak: Number(row.resulting_streak), resultingTier: row.resulting_tier, provenance: row.provenance }));
  }
  async listDailyGateActivations(workspaceId: string): Promise<DailyGateActivationInput[]> {
    const result = await this.scoped(workspaceId, (db) => db.query<{ business_date: Date | string; evidence_hash: string; cfo_principal_id: string; approval_id: string; approval_hash: string; approval_signature: string; approved_at: Date | string; expires_at: Date | string }>(`SELECT business_date,evidence_hash,cfo_principal_id,approval_id,approval_hash,approval_signature,approved_at,expires_at FROM finance_daily_gate_activations WHERE workspace_id=$1 ORDER BY business_date ASC`, [workspaceId]));
    return result.rows.map((row) => ({ date: toDateString(row.business_date), evidenceHash: row.evidence_hash, cfoId: row.cfo_principal_id, approvalId: row.approval_id, approvalHash: row.approval_hash, approvalSignature: row.approval_signature, approvedAt: new Date(row.approved_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() }));
  }

  async appendDayRecord(workspaceId: string, record: AppendDayRecordInput): Promise<void> {
    await this.scoped(workspaceId, (db) => this.insertDayRecord(db, workspaceId, record));
  }

  /**
   * Atomic two-row record-day commit — see `DailyGateRepository` doc. Both
   * writes run on the SAME scoped connection/transaction (one
   * `withWorkspaceScope` call), so a failure on either statement rolls back
   * both.
   */
  async appendDayRecordWithState(
    workspaceId: string,
    record: AppendDayRecordInput,
    state: DailyGateStateInput,
  ): Promise<void> {
    await this.scoped(workspaceId, async (db) => {
      await this.insertDayRecord(db, workspaceId, record);
      await this.upsertDailyGateState(db, workspaceId, state);
    });
  }

  async resetDailyGateStateWithAudit(
    workspaceId: string,
    state: DailyGateStateInput,
    transition: DailyGateVersionTransition,
  ): Promise<void> {
    await this.scoped(workspaceId, async (db) => {
      await this.upsertDailyGateState(db, workspaceId, state);
      await db.query(
        `INSERT INTO finance_daily_gate_version_transitions
          (workspace_id, reason, from_pack_version, to_pack_version, prior_streak, prior_tier, prior_last_date_epoch, prior_activated_matrix_version, reset_streak, reset_tier, reset_last_date_epoch, reset_activated_matrix_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [workspaceId, transition.reason, transition.fromPackVersion ?? null, transition.toPackVersion,
          transition.prior.streak, transition.prior.tier, transition.prior.lastDateEpoch ?? null, transition.prior.activatedMatrixVersion ?? null,
          state.streak, state.tier, state.lastDateEpoch ?? null, state.activatedMatrixVersion ?? null],
      );
    });
  }

  async listDailyGateVersionTransitions(workspaceId: string): Promise<DailyGateVersionTransition[]> {
    const result = await this.scoped(workspaceId, (db) => db.query<{
      reason: DailyGateVersionTransition["reason"]; from_pack_version: string | number | null; to_pack_version: string | number;
      prior_streak: number; prior_tier: FinanceTier; prior_last_date_epoch: string | number | null; prior_activated_matrix_version: string | number | null;
      reset_streak: number; reset_tier: FinanceTier; reset_last_date_epoch: string | number | null; reset_activated_matrix_version: string | number | null;
    }>(`SELECT reason, from_pack_version, to_pack_version, prior_streak, prior_tier, prior_last_date_epoch, prior_activated_matrix_version, reset_streak, reset_tier, reset_last_date_epoch, reset_activated_matrix_version FROM finance_daily_gate_version_transitions WHERE workspace_id = $1 ORDER BY id ASC`, [workspaceId]));
    return result.rows.map((row) => ({
      reason: row.reason,
      ...(row.from_pack_version !== null ? { fromPackVersion: Number(row.from_pack_version) } : {}),
      toPackVersion: Number(row.to_pack_version),
      prior: { streak: row.prior_streak, tier: row.prior_tier, ...(row.prior_last_date_epoch !== null ? { lastDateEpoch: Number(row.prior_last_date_epoch) } : {}), ...(row.prior_activated_matrix_version !== null ? { activatedMatrixVersion: Number(row.prior_activated_matrix_version) } : {}) },
      resetState: { streak: row.reset_streak, tier: row.reset_tier, ...(row.reset_last_date_epoch !== null ? { lastDateEpoch: Number(row.reset_last_date_epoch) } : {}), ...(row.reset_activated_matrix_version !== null ? { activatedMatrixVersion: Number(row.reset_activated_matrix_version) } : {}), packVersion: Number(row.to_pack_version) },
    }));
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
