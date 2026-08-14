/**
 * @ai-crm/imports — versioned CRM/ledger/bank-statement import foundation.
 *
 * Implements the capability-matrix import operations model
 * (`docs/architecture/capability-matrix.md`):
 *  - pinned schema version per source kind; header mismatch fails the batch,
 *  - per-row validation with quarantine (`QUARANTINED` + non-empty error reason),
 *  - file SHA-256 digest dedupe per (workspace, source kind),
 *  - row fingerprint dedupe inside a batch and, for bank statements, the
 *    (account, statement period, row fingerprint) identity across batches,
 *  - freshness (`as_of`) derived only from successfully imported statement rows,
 *  - provenance links (batch id, fingerprint, digest, version) on applied rows,
 *  - SoD: the import operator principal can never verify/approve postings
 *    sourced from its own batch.
 *
 * This package performs no network I/O of any kind — imports are files handed
 * to it as text. The negative-connector invariant is asserted by test.
 */
import { createHash } from "node:crypto";
import type { ActionType } from "@ai-crm/contracts";

export class ImportDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ImportDomainError";
  }
}

export type ImportSourceKind = "CRM" | "LEDGER" | "BANK_STATEMENT";
export type ImportRowStatus = "VALID" | "QUARANTINED" | "IMPORTED";
export type ImportBatchStatus = "COMPLETED" | "QUARANTINED" | "FAILED";

/** Registry action every import batch is mapped to; callers never choose it. */
export const IMPORT_ACTION_TYPES: Readonly<Record<ImportSourceKind, ActionType>> = {
  CRM: "CRM_IMPORT",
  LEDGER: "ACCOUNTING_IMPORT",
  BANK_STATEMENT: "BANK_STATEMENT_IMPORT",
};

/** Pinned, versioned column sets. New columns require a new schema version. */
export const IMPORT_SCHEMAS: Readonly<Record<ImportSourceKind, Readonly<Record<number, readonly string[]>>>> = {
  CRM: { 1: ["customer_id", "name", "status", "created_at"] },
  LEDGER: { 1: ["entry_id", "entry_date", "account_code", "debit_krw", "credit_krw", "description", "evidence_ref"] },
  BANK_STATEMENT: { 1: ["account", "statement_period", "posted_at", "amount_krw", "balance_krw", "description"] },
};

export interface ImportRow {
  rowNumber: number;
  rowFingerprint: string;
  values: Record<string, string>;
  status: ImportRowStatus;
  errorReason?: string;
}

export interface ImportBatch {
  id: string;
  workspaceId: string;
  sourceKind: ImportSourceKind;
  schemaVersion: number;
  fileDigest: string;
  fileVersion: number;
  actionType: ActionType;
  status: ImportBatchStatus;
  failureReason?: string;
  operatorPrincipalId: string;
  submittedAt: string;
  rows: ImportRow[];
}

export interface ProvenanceLink {
  workspaceId: string;
  sourceKind: ImportSourceKind;
  recordId: string;
  importBatchId: string;
  rowFingerprint: string;
  fileDigest: string;
  fileVersion: number;
}

export interface BankFreshness {
  /** Per-account `as_of`: date of the newest successfully imported row. */
  accounts: Record<string, string>;
  /**
   * Conservative overall `as_of`: the *stalest* per-account date. A cash
   * position spanning accounts is never fresher than its stalest statement.
   */
  asOf?: string;
}

export interface SubmitBatchInput {
  id: string;
  workspaceId: string;
  sourceKind: ImportSourceKind;
  schemaVersion: number;
  content: string;
  operatorPrincipalId: string;
  submittedAt: string;
}

/**
 * Applies a validated row to the native domain (e.g. create a CRM customer).
 * Returns the created/affected record id used for the provenance link.
 * Throwing quarantines the row with the error message as `errorReason`.
 */
export type RowApplier = (batch: Omit<ImportBatch, "rows">, row: ImportRow) => string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STATEMENT_PERIOD = /^\d{4}-\d{2}$/;
const INTEGER_AMOUNT = /^-?\d+$/;
const NON_NEGATIVE_AMOUNT = /^\d+$/;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF/LF). */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && content[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
}

function validateRow(sourceKind: ImportSourceKind, values: Record<string, string>): string | undefined {
  switch (sourceKind) {
    case "CRM": {
      if (!values.customer_id?.trim()) return "customer_id is required";
      if (!values.name?.trim()) return "name is required";
      if (!["active", "at_risk", "inactive"].includes(values.status ?? "")) {
        return `status must be active|at_risk|inactive, got: ${values.status ?? ""}`;
      }
      if (!ISO_TIMESTAMP.test(values.created_at ?? "")) return `created_at must be an ISO timestamp, got: ${values.created_at ?? ""}`;
      return undefined;
    }
    case "LEDGER": {
      if (!values.entry_id?.trim()) return "entry_id is required";
      if (!ISO_DATE.test(values.entry_date ?? "")) return `entry_date must be YYYY-MM-DD, got: ${values.entry_date ?? ""}`;
      if (!values.account_code?.trim()) return "account_code is required";
      const debit = values.debit_krw ?? "";
      const credit = values.credit_krw ?? "";
      if (!NON_NEGATIVE_AMOUNT.test(debit) || !NON_NEGATIVE_AMOUNT.test(credit)) {
        return "debit_krw and credit_krw must be non-negative integer KRW amounts";
      }
      if ((debit === "0") === (credit === "0")) return "exactly one of debit_krw/credit_krw must be non-zero";
      if (!values.evidence_ref?.trim()) return "evidence_ref is required for every ledger row";
      return undefined;
    }
    case "BANK_STATEMENT": {
      if (!values.account?.trim()) return "account is required";
      if (!STATEMENT_PERIOD.test(values.statement_period ?? "")) {
        return `statement_period must be YYYY-MM, got: ${values.statement_period ?? ""}`;
      }
      if (!ISO_DATE.test(values.posted_at ?? "")) return `posted_at must be YYYY-MM-DD, got: ${values.posted_at ?? ""}`;
      if (!(values.posted_at ?? "").startsWith(values.statement_period ?? "")) {
        return `posted_at ${values.posted_at ?? ""} is outside statement_period ${values.statement_period ?? ""}`;
      }
      if (!INTEGER_AMOUNT.test(values.amount_krw ?? "")) return "amount_krw must be an integer KRW amount";
      if (!INTEGER_AMOUNT.test(values.balance_krw ?? "")) return "balance_krw must be an integer KRW amount";
      return undefined;
    }
  }
}

export class ImportService {
  private readonly batches = new Map<string, ImportBatch>();
  /** `${workspaceId}:${sourceKind}:${fileDigest}` → batch id */
  private readonly digests = new Map<string, string>();
  /** `${workspaceId}:${sourceKind}` → last assigned file version */
  private readonly fileVersions = new Map<string, number>();
  /** Bank identity `${workspaceId}:${account}:${period}:${fingerprint}` → batch id */
  private readonly bankRowIdentities = new Map<string, string>();
  /** `${workspaceId}:${account}` → freshest imported posted_at */
  private readonly bankAsOf = new Map<string, string>();
  /** `${workspaceId}:${sourceKind}:${recordId}` → provenance */
  private readonly provenance = new Map<string, ProvenanceLink>();

  constructor(private readonly appliers: Partial<Record<ImportSourceKind, RowApplier>> = {}) {}

  submitBatch(input: SubmitBatchInput): ImportBatch {
    if (this.batches.has(input.id)) throw new ImportDomainError("DUPLICATE_ID", `import batch already exists: ${input.id}`);
    const columns = IMPORT_SCHEMAS[input.sourceKind][input.schemaVersion];
    if (!columns) {
      throw new ImportDomainError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `${input.sourceKind} import schema version ${input.schemaVersion} is not pinned`,
      );
    }

    const fileDigest = sha256(input.content);
    const digestKey = `${input.workspaceId}:${input.sourceKind}:${fileDigest}`;
    const existing = this.digests.get(digestKey);
    if (existing) {
      throw new ImportDomainError("DUPLICATE_IMPORT", `file digest already imported by batch ${existing}; re-import is rejected`);
    }

    const versionKey = `${input.workspaceId}:${input.sourceKind}`;
    const fileVersion = (this.fileVersions.get(versionKey) ?? 0) + 1;

    const base: Omit<ImportBatch, "rows"> = {
      id: input.id,
      workspaceId: input.workspaceId,
      sourceKind: input.sourceKind,
      schemaVersion: input.schemaVersion,
      fileDigest,
      fileVersion,
      actionType: IMPORT_ACTION_TYPES[input.sourceKind],
      status: "COMPLETED",
      operatorPrincipalId: input.operatorPrincipalId,
      submittedAt: input.submittedAt,
    };

    const parsed = parseCsv(input.content);
    const header = parsed[0];
    if (!header || header.join(",") !== columns.join(",")) {
      const failed: ImportBatch = {
        ...base,
        status: "FAILED",
        failureReason: `header must be exactly [${columns.join(",")}] for ${input.sourceKind} schema v${input.schemaVersion}`,
        rows: [],
      };
      this.batches.set(failed.id, failed);
      this.digests.set(digestKey, failed.id);
      this.fileVersions.set(versionKey, fileVersion);
      return structuredClone(failed);
    }

    const seenFingerprints = new Set<string>();
    const rows: ImportRow[] = parsed.slice(1).map((cells, index) => {
      const rowNumber = index + 1;
      const values: Record<string, string> = {};
      columns.forEach((column, columnIndex) => {
        values[column] = cells[columnIndex] ?? "";
      });
      const rowFingerprint = sha256(JSON.stringify(columns.map((column) => values[column])));
      const row: ImportRow = { rowNumber, rowFingerprint, values, status: "VALID" };

      if (cells.length !== columns.length) {
        return { ...row, status: "QUARANTINED", errorReason: `expected ${columns.length} columns, got ${cells.length}` };
      }
      const validationError = validateRow(input.sourceKind, values);
      if (validationError) return { ...row, status: "QUARANTINED", errorReason: validationError };
      if (seenFingerprints.has(rowFingerprint)) {
        return { ...row, status: "QUARANTINED", errorReason: "duplicate row fingerprint inside batch" };
      }
      seenFingerprints.add(rowFingerprint);

      if (input.sourceKind === "BANK_STATEMENT") {
        const identity = `${input.workspaceId}:${values.account}:${values.statement_period}:${rowFingerprint}`;
        const owner = this.bankRowIdentities.get(identity);
        if (owner) {
          return {
            ...row,
            status: "QUARANTINED",
            errorReason: `statement row already imported by batch ${owner} (account/period/fingerprint identity)`,
          };
        }
      }
      return row;
    });

    // Apply every still-valid row; application failure quarantines, never partially imports.
    for (const row of rows) {
      if (row.status !== "VALID") continue;
      try {
        const recordId = this.applyRow(base, row);
        row.status = "IMPORTED";
        this.provenance.set(`${base.workspaceId}:${base.sourceKind}:${recordId}`, {
          workspaceId: base.workspaceId,
          sourceKind: base.sourceKind,
          recordId,
          importBatchId: base.id,
          rowFingerprint: row.rowFingerprint,
          fileDigest: base.fileDigest,
          fileVersion: base.fileVersion,
        });
        if (base.sourceKind === "BANK_STATEMENT") {
          const identity = `${base.workspaceId}:${row.values.account}:${row.values.statement_period}:${row.rowFingerprint}`;
          this.bankRowIdentities.set(identity, base.id);
          const accountKey = `${base.workspaceId}:${row.values.account}`;
          const current = this.bankAsOf.get(accountKey);
          const postedAt = row.values.posted_at!;
          if (!current || postedAt > current) this.bankAsOf.set(accountKey, postedAt);
        }
      } catch (error) {
        row.status = "QUARANTINED";
        row.errorReason = error instanceof Error && error.message ? error.message : "row application failed";
      }
    }

    // Invariant: a batch is COMPLETED only when every non-quarantined row is IMPORTED.
    const unprocessed = rows.filter((row) => row.status !== "IMPORTED" && row.status !== "QUARANTINED");
    if (unprocessed.length > 0) {
      throw new ImportDomainError("BATCH_INCOMPLETE", `rows not processed: ${unprocessed.map((row) => row.rowNumber).join(",")}`);
    }
    const quarantined = rows.some((row) => row.status === "QUARANTINED");
    const batch: ImportBatch = { ...base, status: quarantined ? "QUARANTINED" : "COMPLETED", rows };
    this.batches.set(batch.id, batch);
    this.digests.set(digestKey, batch.id);
    this.fileVersions.set(versionKey, fileVersion);
    return structuredClone(batch);
  }

  getBatch(workspaceId: string, batchId: string): ImportBatch {
    return structuredClone(this.requireBatch(workspaceId, batchId));
  }

  /** Provenance of an applied record; every imported record must resolve. */
  provenanceOf(workspaceId: string, sourceKind: ImportSourceKind, recordId: string): ProvenanceLink {
    const link = this.provenance.get(`${workspaceId}:${sourceKind}:${recordId}`);
    if (!link) throw new ImportDomainError("NOT_FOUND", `no provenance for ${sourceKind} record: ${recordId}`);
    return structuredClone(link);
  }

  /** Bank freshness derived only from successfully imported statement rows. */
  bankFreshness(workspaceId: string): BankFreshness {
    const accounts: Record<string, string> = {};
    const prefix = `${workspaceId}:`;
    for (const [key, asOf] of this.bankAsOf) {
      if (key.startsWith(prefix)) accounts[key.slice(prefix.length)] = asOf;
    }
    const dates = Object.values(accounts).sort();
    const result: BankFreshness = { accounts };
    if (dates.length > 0) result.asOf = dates[0]!;
    return result;
  }

  /**
   * SoD guard: the principal verifying/approving a protected action sourced
   * from a batch (e.g. `LEDGER_POST`) must differ from the import operator.
   */
  assertVerifierDistinct(workspaceId: string, batchId: string, verifierPrincipalId: string): void {
    const batch = this.requireBatch(workspaceId, batchId);
    if (batch.operatorPrincipalId === verifierPrincipalId) {
      throw new ImportDomainError(
        "SOD_VIOLATION",
        `principal ${verifierPrincipalId} imported batch ${batchId} and cannot verify or approve postings sourced from it`,
      );
    }
  }

  private applyRow(batch: Omit<ImportBatch, "rows">, row: ImportRow): string {
    const applier = this.appliers[batch.sourceKind];
    if (applier) return applier(batch, structuredClone(row));
    // Default record identity when no domain applier is wired.
    switch (batch.sourceKind) {
      case "CRM":
        return row.values.customer_id!;
      case "LEDGER":
        return row.values.entry_id!;
      case "BANK_STATEMENT":
        return `${row.values.account}:${row.values.statement_period}:${row.rowFingerprint}`;
    }
  }

  private requireBatch(workspaceId: string, batchId: string): ImportBatch {
    const batch = this.batches.get(batchId);
    if (!batch) throw new ImportDomainError("NOT_FOUND", `import batch not found: ${batchId}`);
    if (batch.workspaceId !== workspaceId) throw new ImportDomainError("CROSS_WORKSPACE", "import batch belongs to another workspace");
    return batch;
  }
}


export * from "./notion-cwos.js";
