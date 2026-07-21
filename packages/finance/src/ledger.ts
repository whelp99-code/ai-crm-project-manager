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

  draft(input: DraftJournalEntryInput): JournalEntry {
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

    const entry: JournalEntry = {
      ...input,
      lines: input.lines.map((line) => ({ ...line })),
      status: "DRAFT",
      version: 1,
    };
    this.entries.set(entry.id, structuredClone(entry));
    return structuredClone(entry);
  }

  verify(workspaceId: string, entryId: string, verifierPrincipalId: string): JournalEntry {
    const entry = this.requireEntry(workspaceId, entryId);
    if (entry.status !== "DRAFT") {
      throw new FinanceDomainError("INVALID_STATE", `entry ${entryId} is not DRAFT`);
    }
    if (verifierPrincipalId === entry.createdByPrincipalId) {
      throw new FinanceDomainError("SOD_VIOLATION", "verifier must differ from the drafting principal");
    }
    const next: JournalEntry = {
      ...entry,
      status: "VERIFIED",
      verifiedByPrincipalId: verifierPrincipalId,
      version: entry.version + 1,
    };
    this.entries.set(entryId, next);
    return structuredClone(next);
  }

  post(workspaceId: string, entryId: string, posterPrincipalId: string): JournalEntry {
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

    // Validate the reversal target BEFORE committing any state, so a rejected
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
    // Commit both sides together only after all validation has passed.
    this.entries.set(entryId, next);
    if (reversedOriginal) this.entries.set(reversedOriginal.id, reversedOriginal);

    return structuredClone(next);
  }

  /**
   * Corrections never update/delete a POSTED entry (§3 rule 3): this creates
   * a new DRAFT entry with debit/credit swapped per line, linked back to the
   * original via `reversesEntryId`. The original transitions to REVERSED
   * only once the reversal itself reaches POSTED (see `post`).
   */
  reverse(workspaceId: string, originalEntryId: string, reversalEntryId: string, principalId: string, entryDate: string): JournalEntry {
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

    const input: DraftJournalEntryInput = {
      id: reversalEntryId,
      workspaceId,
      entryDate,
      description: `Reversal of ${originalEntryId}`,
      lines: reversalLines,
      createdByPrincipalId: principalId,
      reversesEntryId: originalEntryId,
      ...(original.evidenceRef !== undefined ? { evidenceRef: original.evidenceRef } : {}),
    };
    return this.draft(input);
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
