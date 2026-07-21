/**
 * Double-entry journal ledger per `docs/finance/accounting-standard-pack.md`
 * §3: balanced entries, mandatory evidence before POSTED, posted-entry
 * immutability (corrections are reversals, never updates/deletes), and a
 * three-role draft → verify → post separation-of-duty workflow.
 */

import { assertFinancePackConfig, FinanceDomainError, type FinancePackConfig } from "./config.js";

export interface JournalLine {
  accountCode: string;
  debitKrw: string;
  creditKrw: string;
  description?: string;
}

export type JournalEntryStatus = "DRAFT" | "VERIFIED" | "POSTED" | "REVERSED";

export interface JournalEntry {
  id: string;
  workspaceId: string;
  /** YYYY-MM-DD */
  entryDate: string;
  description: string;
  evidenceRef?: string;
  lines: JournalLine[];
  status: JournalEntryStatus;
  createdByPrincipalId: string;
  verifiedByPrincipalId?: string;
  postedByPrincipalId?: string;
  reversesEntryId?: string;
  reversedByEntryId?: string;
  importBatchId?: string;
  version: number;
}

export type DraftJournalEntryInput = Omit<
  JournalEntry,
  "status" | "verifiedByPrincipalId" | "postedByPrincipalId" | "reversedByEntryId" | "version"
>;

const ENTRY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NON_NEGATIVE_INTEGER = /^\d+$/;

export class LedgerService {
  private readonly accountCodes: ReadonlySet<string>;
  private readonly entries = new Map<string, JournalEntry>();

  constructor(config: FinancePackConfig) {
    assertFinancePackConfig(config);
    this.accountCodes = new Set(config.chartOfAccounts.map((account) => account.code));
  }

  /**
   * Hydrate-on-boot (PG-C1 restart survival): replaces the in-memory entry
   * set wholesale with `entries` (as persisted/restored from
   * `PgLedgerRepository.listAllEntries()`). Mirrors
   * `CrmService.hydrateCustomers` / `OrchestrationStore.hydrate` — clears
   * first so a restart never merges stale in-memory state with the
   * PG-sourced snapshot.
   */
  hydrateJournalEntries(entries: readonly JournalEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.id, structuredClone(entry));
    }
  }

  draft(input: DraftJournalEntryInput): JournalEntry {
    return this.commitDraft(this.buildDraftEntry(input));
  }

  /**
   * PG-FIRST fail-closed dual-write hook: validates and computes the DRAFT
   * entry WITHOUT committing it to memory, so a caller (route wiring) can
   * persist it to PG first and only call `commitDraft` once that write
   * succeeds — a PG failure then never leaves memory ahead of PG. `draft()`
   * is implemented as `commitDraft(buildDraftEntry(input))`, so behavior is
   * unchanged for callers that do not split the two steps.
   */
  previewDraft(input: DraftJournalEntryInput): JournalEntry {
    return structuredClone(this.buildDraftEntry(input));
  }

  /** PG-FIRST fail-closed dual-write hook: commits an already-validated (`previewDraft`) entry. */
  commitDraft(entry: JournalEntry): JournalEntry {
    if (this.entries.has(entry.id)) {
      throw new FinanceDomainError("DUPLICATE_ID", `journal entry already exists: ${entry.id}`);
    }
    const stored = structuredClone(entry);
    this.entries.set(stored.id, stored);
    return structuredClone(stored);
  }

  private buildDraftEntry(input: DraftJournalEntryInput): JournalEntry {
    if (this.entries.has(input.id)) {
      throw new FinanceDomainError("DUPLICATE_ID", `journal entry already exists: ${input.id}`);
    }
    if (input.lines.length < 2) {
      throw new FinanceDomainError("EMPTY_ENTRY", "journal entry requires at least two lines");
    }
    if (!ENTRY_DATE_RE.test(input.entryDate)) {
      throw new FinanceDomainError("INVALID_DATE", `entryDate must be YYYY-MM-DD: ${input.entryDate}`);
    }

    let debitTotal = 0n;
    let creditTotal = 0n;
    for (const line of input.lines) {
      if (!this.accountCodes.has(line.accountCode)) {
        throw new FinanceDomainError("UNKNOWN_ACCOUNT", `unknown chart account: ${line.accountCode}`);
      }
      if (!NON_NEGATIVE_INTEGER.test(line.debitKrw) || !NON_NEGATIVE_INTEGER.test(line.creditKrw)) {
        throw new FinanceDomainError("INVALID_AMOUNT", "debit/credit must be non-negative integer KRW strings");
      }
      const debit = BigInt(line.debitKrw);
      const credit = BigInt(line.creditKrw);
      if ((debit > 0n) === (credit > 0n)) {
        throw new FinanceDomainError("INVALID_LINE", "exactly one of debit or credit must be non-zero per line");
      }
      debitTotal += debit;
      creditTotal += credit;
    }
    if (debitTotal !== creditTotal) {
      throw new FinanceDomainError("UNBALANCED_ENTRY", `entry is unbalanced: debit ${debitTotal} != credit ${creditTotal}`);
    }

    return {
      ...input,
      lines: input.lines.map((line) => ({ ...line })),
      status: "DRAFT",
      version: 1,
    };
  }

  verify(workspaceId: string, entryId: string, verifierPrincipalId: string): JournalEntry {
    return this.commitVerify(this.buildVerifiedEntry(workspaceId, entryId, verifierPrincipalId));
  }

  /** PG-FIRST fail-closed dual-write hook: see `previewDraft` doc — same split for the VERIFIED transition. */
  previewVerify(workspaceId: string, entryId: string, verifierPrincipalId: string): JournalEntry {
    return structuredClone(this.buildVerifiedEntry(workspaceId, entryId, verifierPrincipalId));
  }

  /** PG-FIRST fail-closed dual-write hook: commits an already-validated (`previewVerify`) entry. */
  commitVerify(entry: JournalEntry): JournalEntry {
    const stored = structuredClone(entry);
    this.entries.set(stored.id, stored);
    return structuredClone(stored);
  }

  private buildVerifiedEntry(workspaceId: string, entryId: string, verifierPrincipalId: string): JournalEntry {
    const entry = this.requireEntry(workspaceId, entryId);
    if (entry.status !== "DRAFT") {
      throw new FinanceDomainError("INVALID_STATE", `entry ${entryId} is not DRAFT`);
    }
    if (verifierPrincipalId === entry.createdByPrincipalId) {
      throw new FinanceDomainError("SOD_VIOLATION", "verifier must differ from the drafting principal");
    }
    return {
      ...entry,
      status: "VERIFIED",
      verifiedByPrincipalId: verifierPrincipalId,
      version: entry.version + 1,
    };
  }

  post(workspaceId: string, entryId: string, posterPrincipalId: string): JournalEntry {
    const { next, reversedOriginal } = this.buildPostedEntries(workspaceId, entryId, posterPrincipalId);
    return this.commitPost(next, reversedOriginal);
  }

  /**
   * PG-FIRST fail-closed dual-write hook: validates and computes the atomic
   * two-row POST transition (the posted `next` entry, plus — when this
   * entry reverses another — the original entry's POSTED -> REVERSED
   * transition) WITHOUT committing either to memory. A caller persists both
   * rows to PG inside ONE `withWorkspaceScope` transaction first, and only
   * calls `commitPost` after that PG write succeeds.
   */
  previewPost(workspaceId: string, entryId: string, posterPrincipalId: string): { next: JournalEntry; reversedOriginal?: JournalEntry } {
    const { next, reversedOriginal } = this.buildPostedEntries(workspaceId, entryId, posterPrincipalId);
    return {
      next: structuredClone(next),
      ...(reversedOriginal ? { reversedOriginal: structuredClone(reversedOriginal) } : {}),
    };
  }

  /** PG-FIRST fail-closed dual-write hook: commits an already-validated (`previewPost`) atomic two-row transition. */
  commitPost(next: JournalEntry, reversedOriginal?: JournalEntry): JournalEntry {
    const storedNext = structuredClone(next);
    this.entries.set(storedNext.id, storedNext);
    if (reversedOriginal) {
      const storedReversed = structuredClone(reversedOriginal);
      this.entries.set(storedReversed.id, storedReversed);
    }
    return structuredClone(storedNext);
  }

  private buildPostedEntries(
    workspaceId: string,
    entryId: string,
    posterPrincipalId: string,
  ): { next: JournalEntry; reversedOriginal?: JournalEntry } {
    const entry = this.requireEntry(workspaceId, entryId);
    if (entry.status !== "VERIFIED") {
      throw new FinanceDomainError("INVALID_STATE", `entry ${entryId} is not VERIFIED`);
    }
    if (posterPrincipalId === entry.createdByPrincipalId || posterPrincipalId === entry.verifiedByPrincipalId) {
      throw new FinanceDomainError("SOD_VIOLATION", "poster must differ from both the drafting and verifying principals");
    }
    if (!entry.evidenceRef || !entry.evidenceRef.trim()) {
      throw new FinanceDomainError("EVIDENCE_REQUIRED", "journal entry requires evidenceRef before it can be POSTED");
    }

    // Validate the reversal target BEFORE computing any state, so a rejected
    // double-reversal never strands a POSTED reversal that would distort balances.
    let reversedOriginal: JournalEntry | undefined;
    if (entry.reversesEntryId) {
      const original = this.requireEntry(workspaceId, entry.reversesEntryId);
      if (original.status !== "POSTED") {
        throw new FinanceDomainError("INVALID_STATE", `original entry ${original.id} is not POSTED`);
      }
      reversedOriginal = { ...original, status: "REVERSED", reversedByEntryId: entryId, version: original.version + 1 };
    }

    const next: JournalEntry = {
      ...entry,
      status: "POSTED",
      postedByPrincipalId: posterPrincipalId,
      version: entry.version + 1,
    };

    return reversedOriginal ? { next, reversedOriginal } : { next };
  }

  /**
   * Corrections never update/delete a POSTED entry (§3 rule 3): this creates
   * a new DRAFT entry with debit/credit swapped per line, linked back to the
   * original via `reversesEntryId`. The original transitions to REVERSED
   * only once the reversal itself reaches POSTED (see `post`).
   */
  reverse(workspaceId: string, originalEntryId: string, reversalEntryId: string, principalId: string, entryDate: string): JournalEntry {
    return this.draft(this.buildReversalInput(workspaceId, originalEntryId, reversalEntryId, principalId, entryDate));
  }

  /** PG-FIRST fail-closed dual-write hook: see `previewDraft` doc — same split for the reversal DRAFT. */
  previewReverse(workspaceId: string, originalEntryId: string, reversalEntryId: string, principalId: string, entryDate: string): JournalEntry {
    return this.previewDraft(this.buildReversalInput(workspaceId, originalEntryId, reversalEntryId, principalId, entryDate));
  }

  private buildReversalInput(
    workspaceId: string,
    originalEntryId: string,
    reversalEntryId: string,
    principalId: string,
    entryDate: string,
  ): DraftJournalEntryInput {
    const original = this.requireEntry(workspaceId, originalEntryId);
    if (original.status !== "POSTED") {
      throw new FinanceDomainError("INVALID_STATE", `entry ${originalEntryId} must be POSTED to reverse`);
    }

    const reversalLines: JournalLine[] = original.lines.map((line) => ({
      accountCode: line.accountCode,
      debitKrw: line.creditKrw,
      creditKrw: line.debitKrw,
      ...(line.description !== undefined ? { description: line.description } : {}),
    }));

    return {
      id: reversalEntryId,
      workspaceId,
      entryDate,
      description: `Reversal of ${originalEntryId}`,
      lines: reversalLines,
      createdByPrincipalId: principalId,
      reversesEntryId: originalEntryId,
      ...(original.evidenceRef !== undefined ? { evidenceRef: original.evidenceRef } : {}),
    };
  }

  getEntry(workspaceId: string, entryId: string): JournalEntry {
    return structuredClone(this.requireEntry(workspaceId, entryId));
  }

  /**
   * Signed net (debit − credit) per account. DRAFT/VERIFIED entries never
   * contribute; POSTED entries do, and a REVERSED original still counts
   * alongside its posted reversal so the pair nets to zero.
   */
  balances(workspaceId: string): Record<string, string> {
    const totals = new Map<string, bigint>();
    for (const entry of this.entries.values()) {
      if (entry.workspaceId !== workspaceId || (entry.status !== "POSTED" && entry.status !== "REVERSED")) continue;
      for (const line of entry.lines) {
        const delta = BigInt(line.debitKrw) - BigInt(line.creditKrw);
        totals.set(line.accountCode, (totals.get(line.accountCode) ?? 0n) + delta);
      }
    }
    const result: Record<string, string> = {};
    for (const [code, amount] of totals) {
      result[code] = amount.toString();
    }
    return result;
  }

  private requireEntry(workspaceId: string, entryId: string): JournalEntry {
    const entry = this.entries.get(entryId);
    if (!entry) throw new FinanceDomainError("NOT_FOUND", `journal entry not found: ${entryId}`);
    if (entry.workspaceId !== workspaceId) {
      throw new FinanceDomainError("CROSS_WORKSPACE", "journal entry belongs to another workspace");
    }
    return entry;
  }
}
