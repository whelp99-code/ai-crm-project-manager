/**
 * Bank-vs-ledger reconciliation per `docs/finance/accounting-standard-pack.md`
 * §3 rule 5: a variance beyond the pack's configured tolerance always opens a
 * `finance_exceptions` row and is never silently absorbed.
 */

import { assertFinancePackConfig, FinanceDomainError, type FinancePackConfig } from "./config.js";

export interface StatementRowRef {
  account: string;
  postedAt: string;
  /** Signed integer KRW string. */
  amountKrw: string;
  rowFingerprint: string;
}

export interface Reconciliation {
  id: string;
  workspaceId: string;
  statementRow: StatementRowRef;
  ledgerAmountKrw: string;
  varianceKrw: string;
  status: "MATCHED" | "VARIANCE";
  reconciledByPrincipalId: string;
  reconciledAt: string;
  exceptionId?: string;
}

export interface FinanceException {
  id: string;
  workspaceId: string;
  kind: "RECONCILIATION_VARIANCE";
  reconciliationId: string;
  varianceKrw: string;
  status: "OPEN" | "RESOLVED";
  openedAt: string;
  resolvedByPrincipalId?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ReconcileInput {
  id: string;
  workspaceId: string;
  statementRow: StatementRowRef;
  ledgerAmountKrw: string;
  reconciledByPrincipalId: string;
  reconciledAt: string;
  exceptionId?: string;
}

const SIGNED_INTEGER = /^-?\d+$/;

export class ReconciliationService {
  private readonly config: FinancePackConfig;
  private readonly reconciliations = new Map<string, Reconciliation>();
  private readonly exceptions = new Map<string, FinanceException>();
  private readonly reconciledFingerprints = new Set<string>();

  constructor(config: FinancePackConfig) {
    this.config = assertFinancePackConfig(config);
  }
  /**
   * Restart-consistency hydrate-on-boot (PG-C2): rebuild the in-memory
   * `reconciliations`/`exceptions` maps AND the `reconciledFingerprints`
   * dedup set wholesale from persisted rows (read back from PG at process
   * start), so a fresh process reflects prior reconciliations/exceptions
   * instead of starting empty. Mirrors `CrmService.hydrateCustomers`.
   */
  hydrateReconciliations(reconciliations: readonly Reconciliation[], exceptions: readonly FinanceException[]): void {
    this.reconciliations.clear();
    this.exceptions.clear();
    this.reconciledFingerprints.clear();
    for (const exception of exceptions) {
      this.exceptions.set(exception.id, structuredClone(exception));
    }
    for (const reconciliation of reconciliations) {
      this.reconciliations.set(reconciliation.id, structuredClone(reconciliation));
      this.reconciledFingerprints.add(`${reconciliation.workspaceId}::${reconciliation.statementRow.rowFingerprint}`);
    }
  }

  /**
   * PG-FIRST fail-closed dual-write hook: validates `input` and builds the
   * (not-yet-committed) `Reconciliation`/`FinanceException` pair WITHOUT
   * mutating `reconciliations`/`exceptions`/`reconciledFingerprints`. The
   * caller persists the returned pair to PG, then calls `commitReconcile`
   * with the SAME objects — mirrors `LedgerService.previewDraft`/
   * `commitDraft` (packages/finance/src/ledger.ts).
   */
  previewReconcile(input: ReconcileInput): { reconciliation: Reconciliation; exception?: FinanceException } {
    if (this.reconciliations.has(input.id)) {
      throw new FinanceDomainError("DUPLICATE_ID", `reconciliation already exists: ${input.id}`);
    }
    if (!SIGNED_INTEGER.test(input.statementRow.amountKrw)) {
      throw new FinanceDomainError("INVALID_AMOUNT", "statement amount must be a signed integer KRW string");
    }
    if (!SIGNED_INTEGER.test(input.ledgerAmountKrw)) {
      throw new FinanceDomainError("INVALID_AMOUNT", "ledger amount must be a signed integer KRW string");
    }

    const fingerprintKey = `${input.workspaceId}::${input.statementRow.rowFingerprint}`;
    if (this.reconciledFingerprints.has(fingerprintKey)) {
      throw new FinanceDomainError(
        "DUPLICATE_RECONCILIATION",
        `statement row already reconciled: ${input.statementRow.rowFingerprint}`,
      );
    }

    const statement = BigInt(input.statementRow.amountKrw);
    const ledger = BigInt(input.ledgerAmountKrw);
    const diff = statement - ledger;
    const variance = diff < 0n ? -diff : diff;
    const tolerance = BigInt(this.config.reconciliationToleranceKrw);
    const status: Reconciliation["status"] = variance <= tolerance ? "MATCHED" : "VARIANCE";

    let exceptionId: string | undefined;
    let exception: FinanceException | undefined;
    if (status === "VARIANCE") {
      if (!input.exceptionId || !input.exceptionId.trim()) {
        throw new FinanceDomainError("EXCEPTION_ID_REQUIRED", "a reconciliation variance requires a caller-supplied exceptionId");
      }
      if (this.exceptions.has(input.exceptionId)) {
        throw new FinanceDomainError("DUPLICATE_ID", `exception already exists: ${input.exceptionId}`);
      }
      exceptionId = input.exceptionId;
      exception = {
        id: exceptionId,
        workspaceId: input.workspaceId,
        kind: "RECONCILIATION_VARIANCE",
        reconciliationId: input.id,
        varianceKrw: variance.toString(),
        status: "OPEN",
        openedAt: input.reconciledAt,
      };
    }

    const reconciliation: Reconciliation = {
      id: input.id,
      workspaceId: input.workspaceId,
      statementRow: { ...input.statementRow },
      ledgerAmountKrw: input.ledgerAmountKrw,
      varianceKrw: variance.toString(),
      status,
      reconciledByPrincipalId: input.reconciledByPrincipalId,
      reconciledAt: input.reconciledAt,
      ...(exceptionId !== undefined ? { exceptionId } : {}),
    };
    return exception !== undefined ? { reconciliation, exception } : { reconciliation };
  }

  /** PG-FIRST fail-closed dual-write hook: commits an already-validated (`previewReconcile`) pair. */
  commitReconcile(reconciliation: Reconciliation, exception?: FinanceException): Reconciliation {
    if (exception !== undefined) {
      this.exceptions.set(exception.id, structuredClone(exception));
    }
    const fingerprintKey = `${reconciliation.workspaceId}::${reconciliation.statementRow.rowFingerprint}`;
    this.reconciliations.set(reconciliation.id, structuredClone(reconciliation));
    this.reconciledFingerprints.add(fingerprintKey);
    return structuredClone(reconciliation);
  }

  reconcile(input: ReconcileInput): Reconciliation {
    const { reconciliation, exception } = this.previewReconcile(input);
    return this.commitReconcile(reconciliation, exception);
  }

  /**
   * PG-FIRST fail-closed dual-write hook: validates and builds the
   * (not-yet-committed) RESOLVED exception WITHOUT mutating `exceptions`.
   * See `previewReconcile` doc.
   */
  previewResolveException(
    workspaceId: string,
    exceptionId: string,
    resolvedByPrincipalId: string,
    resolvedAt: string,
    resolutionNote: string,
  ): FinanceException {
    const exception = this.requireException(workspaceId, exceptionId);
    if (exception.status !== "OPEN") {
      throw new FinanceDomainError("INVALID_STATE", `exception ${exceptionId} is not OPEN`);
    }
    if (!resolutionNote || !resolutionNote.trim()) {
      throw new FinanceDomainError("RESOLUTION_NOTE_REQUIRED", "resolving an exception requires a non-empty note");
    }
    const reconciliation = this.reconciliations.get(exception.reconciliationId);
    if (reconciliation && reconciliation.reconciledByPrincipalId === resolvedByPrincipalId) {
      throw new FinanceDomainError("SOD_VIOLATION", "resolver must differ from the reconciling principal");
    }

    return {
      ...exception,
      status: "RESOLVED",
      resolvedByPrincipalId,
      resolvedAt,
      resolutionNote,
    };
  }

  /** PG-FIRST fail-closed dual-write hook: commits an already-validated (`previewResolveException`) exception. */
  commitResolveException(resolved: FinanceException): FinanceException {
    this.exceptions.set(resolved.id, structuredClone(resolved));
    return structuredClone(resolved);
  }

  resolveException(
    workspaceId: string,
    exceptionId: string,
    resolvedByPrincipalId: string,
    resolvedAt: string,
    resolutionNote: string,
  ): FinanceException {
    const resolved = this.previewResolveException(workspaceId, exceptionId, resolvedByPrincipalId, resolvedAt, resolutionNote);
    return this.commitResolveException(resolved);
  }

  openExceptions(workspaceId: string): FinanceException[] {
    return [...this.exceptions.values()]
      .filter((exception) => exception.workspaceId === workspaceId && exception.status === "OPEN")
      .map((exception) => structuredClone(exception));
  }

  private requireException(workspaceId: string, exceptionId: string): FinanceException {
    const exception = this.exceptions.get(exceptionId);
    if (!exception) throw new FinanceDomainError("NOT_FOUND", `exception not found: ${exceptionId}`);
    if (exception.workspaceId !== workspaceId) {
      throw new FinanceDomainError("CROSS_WORKSPACE", "exception belongs to another workspace");
    }
    return exception;
  }
}
