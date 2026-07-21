/**
 * PostgreSQL adapter for `LedgerService` journal entry persistence
 * (PG-C1 — F6 double-entry ledger, first finance-domain PG proof).
 *
 * Mirrors the `pg-crm-adapter.ts` / `pg-governance-adapter.ts` pattern: a
 * stable repository port, pure row <-> domain mappers, an in-memory
 * implementation for unit/restart tests without PostgreSQL, and
 * `createPgLedgerRepository(pool)` for createApp injection.
 *
 * Two properties set this adapter apart from `pg-crm-adapter.ts`:
 *
 *  1. PG-FIRST fail-closed dual-write. `crm_customers` (and governance's
 *     best-effort dual-write helpers in apps/api/src/app.ts) write memory
 *     FIRST and treat PG as a best-effort mirror — a PG failure is swallowed
 *     (logged, `dualWriteFailures` counter bumped) and never fails the
 *     in-flight request. The ledger inverts that ordering: money postings
 *     MUST hit PG before `LedgerService`'s in-memory map is mutated, so a PG
 *     failure aborts the whole operation and memory never runs ahead of the
 *     durable ledger. `LedgerService.previewDraft/previewVerify/previewPost`
 *     (ledger.ts) compute the validated next-state object(s) WITHOUT
 *     committing them to memory; a caller (route wiring — see
 *     /tmp/pgc1-wiring-diff.md) awaits this adapter's write for that exact
 *     object first, and only calls `LedgerService.commitDraft/commitVerify/
 *     commitPost` after the PG write resolves. If the PG write throws, the
 *     caller must propagate the error and MUST NOT call commit* — memory
 *     stays exactly where it was before the attempt.
 *
 *  2. Posted-entry immutability. 0009_finance_ledger.sql's
 *     `finance_journal_entries_immutability` trigger rejects any UPDATE/
 *     DELETE on a POSTED row except the one-time transition to REVERSED
 *     (setting `reversed_by_entry_id`). `postEntryAtomic` below performs
 *     exactly the two writes `LedgerService.post`'s atomic two-row commit
 *     produces (~ledger.ts L134/L137: the newly POSTED entry, plus —
 *     when it reverses another entry — that original's POSTED -> REVERSED
 *     transition) inside ONE `withWorkspaceScope` transaction, so both rows
 *     land together or neither does.
 */

import type { JournalEntry, JournalEntryStatus, JournalLine } from "./ledger.js";

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
   * `finance_journal_entries` (0009) are enforced for the duration of `fn`.
   * See `pg-governance-adapter.ts`'s `PgQueryable.withWorkspaceScope` doc
   * for the full rationale — same contract here.
   */
  withWorkspaceScope?<T>(workspaceId: string, fn: (scoped: PgQueryable) => Promise<T>): Promise<T>;
}

export interface FinanceJournalEntryRow {
  id: string;
  workspace_id: string;
  entry_date: string;
  description: string;
  evidence_ref: string | null;
  lines: JournalLine[] | string;
  debit_total_krw: string;
  credit_total_krw: string;
  status: string;
  created_by_principal_id: string;
  verified_by_principal_id: string | null;
  posted_by_principal_id: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  import_batch_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const NON_NEGATIVE_INTEGER = /^\d+$/;

export interface LedgerRepository {
  /**
   * Single-row upsert for the DRAFT/VERIFIED lifecycle (no immutability
   * concerns — the row has never reached POSTED). Used for `draft`/`verify`
   * PG-first writes and for reversal drafts (which are just another DRAFT
   * row via `LedgerService.previewReverse`/`previewDraft`).
   */
  saveEntry(entry: JournalEntry): Promise<void>;
  /**
   * Atomic two-row POST/REVERSE commit (mirrors `LedgerService.post`'s
   * in-memory atomic commit at ~ledger.ts L134/L137): UPDATEs `entry`
   * (status POSTED, evidence-backed) and, when `reversedOriginal` is
   * provided, UPDATEs that original entry's row to REVERSED with
   * `reversed_by_entry_id = entry.id` — both inside ONE
   * `withWorkspaceScope` transaction, so a mid-way failure leaves neither
   * row changed (rolled back), never one row posted with the other
   * unreversed.
   */
  postEntryAtomic(entry: JournalEntry, reversedOriginal?: JournalEntry): Promise<void>;
  /**
   * PG-primary scoped read (mirrors CRM/governance's
   * `getCustomersForWorkspace`/`getControlsForWorkspace`): every persisted
   * journal entry for one workspace, run through `withWorkspaceScope` so
   * FORCE RLS enforces the workspace boundary.
   */
  getEntriesForWorkspace(workspaceId: string): Promise<JournalEntry[]>;
  /**
   * List every persisted journal entry across all workspaces. Used for
   * hydrate-on-boot restart-consistency (`LedgerService.hydrateJournalEntries`);
   * hydrate runs as the service/owner role so cross-workspace RLS is
   * expected to be bypassed intentionally (mirrors
   * `listAllControls`/`listAllIntents`/`listAllCustomers`).
   */
  listAllEntries(): Promise<JournalEntry[]>;
}

/** Sum of `debitKrw`/`creditKrw` across `lines`, as integer-KRW BigInt totals (validated non-negative integer strings). */
function lineTotals(lines: readonly JournalLine[]): { debitTotal: bigint; creditTotal: bigint } {
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of lines) {
    if (!NON_NEGATIVE_INTEGER.test(line.debitKrw) || !NON_NEGATIVE_INTEGER.test(line.creditKrw)) {
      throw new Error(`invalid integer-KRW amount on line ${line.accountCode}: debit=${line.debitKrw} credit=${line.creditKrw}`);
    }
    debitTotal += BigInt(line.debitKrw);
    creditTotal += BigInt(line.creditKrw);
  }
  return { debitTotal, creditTotal };
}

export function mapJournalEntryRow(row: FinanceJournalEntryRow): JournalEntry {
  const lines = typeof row.lines === "string" ? (JSON.parse(row.lines) as JournalLine[]) : row.lines;
  const entry: JournalEntry = {
    id: row.id,
    workspaceId: row.workspace_id,
    entryDate: row.entry_date,
    description: row.description,
    lines,
    status: row.status as JournalEntryStatus,
    createdByPrincipalId: row.created_by_principal_id,
    version: row.version,
  };
  if (row.evidence_ref !== null) entry.evidenceRef = row.evidence_ref;
  if (row.verified_by_principal_id !== null) entry.verifiedByPrincipalId = row.verified_by_principal_id;
  if (row.posted_by_principal_id !== null) entry.postedByPrincipalId = row.posted_by_principal_id;
  if (row.reverses_entry_id !== null) entry.reversesEntryId = row.reverses_entry_id;
  if (row.reversed_by_entry_id !== null) entry.reversedByEntryId = row.reversed_by_entry_id;
  if (row.import_batch_id !== null) entry.importBatchId = row.import_batch_id;
  return entry;
}

/**
 * In-memory ledger repository for unit/restart tests without PostgreSQL.
 * Round-trips the JournalEntry shape (including BigInt-precision money as
 * plain strings — no numeric coercion, so 10^30-scale amounts round-trip
 * exactly, same as the PG-backed implementation's `numeric` columns).
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly entries = new Map<string, JournalEntry>();

  async saveEntry(entry: JournalEntry): Promise<void> {
    this.entries.set(`${entry.workspaceId}\0${entry.id}`, structuredClone(entry));
  }

  async postEntryAtomic(entry: JournalEntry, reversedOriginal?: JournalEntry): Promise<void> {
    this.entries.set(`${entry.workspaceId}\0${entry.id}`, structuredClone(entry));
    if (reversedOriginal) {
      this.entries.set(`${reversedOriginal.workspaceId}\0${reversedOriginal.id}`, structuredClone(reversedOriginal));
    }
  }

  async getEntriesForWorkspace(workspaceId: string): Promise<JournalEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.workspaceId === workspaceId)
      .map((e) => structuredClone(e));
  }

  async listAllEntries(): Promise<JournalEntry[]> {
    return [...this.entries.values()].map((e) => structuredClone(e));
  }
}

export function createPgLedgerRepository(pool: PgQueryable): LedgerRepository {
  return new PgLedgerRepository(pool);
}

/**
 * PG-backed repository. Performs real column-mapped INSERT/UPDATE/SELECT
 * statements against the `finance_journal_entries` sidecar table from
 * 0009_finance_ledger.sql (mirrors `PgCrmRepository`/`PgGovernanceRepository`).
 *
 * Per-workspace ops run through `db.withWorkspaceScope` when the injected
 * pool provides it, so a SET LOCAL-equivalent via
 * `set_config('app.workspace_id', ..., true)` is honored by FORCE RLS.
 * `listAllEntries` is the hydrate-on-boot admin path: it reads across every
 * workspace and is expected to run under an admin/superuser connection —
 * production must scope hydrate to a dedicated admin role instead of the
 * bootstrap superuser. See docs/ops/sor-persistence.md.
 */
class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: PgQueryable) {}

  private async scoped<T>(workspaceId: string, fn: (db: PgQueryable) => Promise<T>): Promise<T> {
    if (this.db.withWorkspaceScope) {
      return this.db.withWorkspaceScope(workspaceId, fn);
    }
    return fn(this.db);
  }

  async saveEntry(entry: JournalEntry): Promise<void> {
    const { debitTotal, creditTotal } = lineTotals(entry.lines);
    await this.scoped(entry.workspaceId, (db) =>
      db.query(
        `INSERT INTO finance_journal_entries (
           id, workspace_id, entry_date, description, evidence_ref, lines,
           debit_total_krw, credit_total_krw, status, created_by_principal_id,
           verified_by_principal_id, posted_by_principal_id, reverses_entry_id,
           reversed_by_entry_id, import_batch_id, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           entry_date = EXCLUDED.entry_date,
           description = EXCLUDED.description,
           evidence_ref = EXCLUDED.evidence_ref,
           lines = EXCLUDED.lines,
           debit_total_krw = EXCLUDED.debit_total_krw,
           credit_total_krw = EXCLUDED.credit_total_krw,
           status = EXCLUDED.status,
           verified_by_principal_id = EXCLUDED.verified_by_principal_id,
           posted_by_principal_id = EXCLUDED.posted_by_principal_id,
           reverses_entry_id = EXCLUDED.reverses_entry_id,
           reversed_by_entry_id = EXCLUDED.reversed_by_entry_id,
           import_batch_id = EXCLUDED.import_batch_id,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          entry.id,
          entry.workspaceId,
          entry.entryDate,
          entry.description,
          entry.evidenceRef ?? null,
          JSON.stringify(entry.lines),
          debitTotal.toString(),
          creditTotal.toString(),
          entry.status,
          entry.createdByPrincipalId,
          entry.verifiedByPrincipalId ?? null,
          entry.postedByPrincipalId ?? null,
          entry.reversesEntryId ?? null,
          entry.reversedByEntryId ?? null,
          entry.importBatchId ?? null,
          entry.version,
        ],
      ),
    );
  }

  /**
   * Atomic two-row POST/REVERSE commit in ONE `withWorkspaceScope`
   * transaction. `entry` transitions VERIFIED -> POSTED (an ordinary
   * UPDATE, unrestricted by the immutability trigger since `OLD.status`
   * there is `VERIFIED`). When `reversedOriginal` is supplied, its row
   * transitions POSTED -> REVERSED with `reversed_by_entry_id = entry.id`
   * SET — exactly the one shape the immutability trigger allows on an
   * already-POSTED row. Both writes share the SAME scoped connection/
   * transaction, so a trigger rejection or any other failure on either
   * statement rolls back both.
   */
  async postEntryAtomic(entry: JournalEntry, reversedOriginal?: JournalEntry): Promise<void> {
    await this.scoped(entry.workspaceId, async (db) => {
      const { debitTotal, creditTotal } = lineTotals(entry.lines);
      await db.query(
        `INSERT INTO finance_journal_entries (
           id, workspace_id, entry_date, description, evidence_ref, lines,
           debit_total_krw, credit_total_krw, status, created_by_principal_id,
           verified_by_principal_id, posted_by_principal_id, reverses_entry_id,
           reversed_by_entry_id, import_batch_id, version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           posted_by_principal_id = EXCLUDED.posted_by_principal_id,
           version = EXCLUDED.version,
           updated_at = now()`,
        [
          entry.id,
          entry.workspaceId,
          entry.entryDate,
          entry.description,
          entry.evidenceRef ?? null,
          JSON.stringify(entry.lines),
          debitTotal.toString(),
          creditTotal.toString(),
          entry.status,
          entry.createdByPrincipalId,
          entry.verifiedByPrincipalId ?? null,
          entry.postedByPrincipalId ?? null,
          entry.reversesEntryId ?? null,
          entry.reversedByEntryId ?? null,
          entry.importBatchId ?? null,
          entry.version,
        ],
      );

      if (reversedOriginal) {
        await db.query(
          `UPDATE finance_journal_entries
             SET status = $1, reversed_by_entry_id = $2, version = $3, updated_at = now()
           WHERE id = $4 AND workspace_id = $5`,
          [
            reversedOriginal.status,
            reversedOriginal.reversedByEntryId,
            reversedOriginal.version,
            reversedOriginal.id,
            reversedOriginal.workspaceId,
          ],
        );
      }
    });
  }

  async getEntriesForWorkspace(workspaceId: string): Promise<JournalEntry[]> {
    const result = await this.scoped(workspaceId, (db) =>
      db.query<FinanceJournalEntryRow>(
        `SELECT * FROM finance_journal_entries WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
        [workspaceId],
      ),
    );
    return result.rows.map((row) => mapJournalEntryRow(row));
  }

  /** Hydrate-on-boot admin path: reads across every workspace (see class doc). */
  async listAllEntries(): Promise<JournalEntry[]> {
    const result = await this.db.query<FinanceJournalEntryRow>(
      `SELECT * FROM finance_journal_entries ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map((row) => mapJournalEntryRow(row));
  }
}
