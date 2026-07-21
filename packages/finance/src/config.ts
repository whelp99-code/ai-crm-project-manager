/**
 * Finance pack configuration boundary.
 *
 * `docs/finance/accounting-standard-pack.md` §2 leaves every jurisdictional
 * value `BLOCKING — unset` until certified accounting review signs it. This
 * module therefore refuses to invent defaults: every field below MUST be
 * injected by the composition root, and `assertFinancePackConfig` fails
 * closed on any missing or malformed field. Tests inject clearly-labelled
 * fixture values; production wiring must inject the signed pack values and
 * must refuse to start while the pack is still `BLOCKING — unset`.
 *
 * §3 (double-entry/evidence invariants) and §4 (daily-gate rule shape) are
 * fixed now and implemented structurally in `ledger.ts`, `reconciliation.ts`
 * and `daily-gate.ts` against this configuration.
 */

export class FinanceDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FinanceDomainError";
  }
}

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface ChartAccount {
  code: string;
  name: string;
  type: AccountType;
  /**
   * Optional projection classification for the cash/AR/AP figures shown in
   * the finance UI. Revenue/expense figures derive from `type`; cash,
   * receivable and payable positions need this explicit role because the
   * signed chart is supplied by the pack, never inferred from names.
   */
  projectionRole?: "cash" | "receivable" | "payable";
}

export interface FinancePackConfig {
  /** Versioned pack identity; any change resets the daily-gate streak (§4 rule 5). */
  packVersion: number;
  /** Enumerated, versioned chart of accounts (§2). Ledger rejects codes outside it. */
  chartOfAccounts: readonly ChartAccount[];
  /**
   * Exact decimal scale of KRW ledger amounts (§2). MVP is single-currency
   * KRW; scale 0 is expected but must still be supplied, never assumed.
   */
  decimalScale: number;
  /** Asia/Seoul wall-clock day-close cutoff, exact "HH:mm" (§2). */
  dayCloseCutoff: string;
  /**
   * Rule for a metric landing exactly on the cutoff boundary (§2): the
   * boundary instant belongs to the closing day ("inclusive") or to the next
   * day ("exclusive"). Must be explicit; never inferred.
   */
  cutoffBoundary: "inclusive" | "exclusive";
  /**
   * Bank-vs-ledger variance at or below this absolute KRW amount auto-closes
   * as immaterial; above it a finance exception MUST open (§2, §3 rule 5).
   * Zero is legal only as an explicit decision — the field is still required.
   */
  reconciliationToleranceKrw: string;
  /** Versioned policy value; 90 per plan §4 rule 7, but never hardcoded. */
  requiredConsecutiveDays: number;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NON_NEGATIVE_INTEGER = /^\d+$/;

export function assertFinancePackConfig(config: FinancePackConfig): FinancePackConfig {
  if (!Number.isInteger(config.packVersion) || config.packVersion < 1) {
    throw new FinanceDomainError("PACK_UNSET", "packVersion must be a positive integer supplied by the signed accounting pack");
  }
  if (!Array.isArray(config.chartOfAccounts) || config.chartOfAccounts.length === 0) {
    throw new FinanceDomainError("PACK_UNSET", "chartOfAccounts must be the enumerated signed chart, never empty or invented");
  }
  const codes = new Set<string>();
  for (const account of config.chartOfAccounts) {
    if (!account.code.trim() || !account.name.trim()) {
      throw new FinanceDomainError("PACK_UNSET", "every chart account requires a code and name");
    }
    if (codes.has(account.code)) throw new FinanceDomainError("PACK_UNSET", `duplicate chart account code: ${account.code}`);
    codes.add(account.code);
  }
  if (!Number.isInteger(config.decimalScale) || config.decimalScale < 0) {
    throw new FinanceDomainError("PACK_UNSET", "decimalScale must be an explicit non-negative integer");
  }
  if (!HH_MM.test(config.dayCloseCutoff)) {
    throw new FinanceDomainError("PACK_UNSET", "dayCloseCutoff must be an exact HH:mm Asia/Seoul wall-clock time");
  }
  if (config.cutoffBoundary !== "inclusive" && config.cutoffBoundary !== "exclusive") {
    throw new FinanceDomainError("PACK_UNSET", "cutoffBoundary must be explicitly inclusive or exclusive");
  }
  if (!NON_NEGATIVE_INTEGER.test(config.reconciliationToleranceKrw)) {
    throw new FinanceDomainError("PACK_UNSET", "reconciliationToleranceKrw must be an explicit non-negative integer KRW amount");
  }
  if (!Number.isInteger(config.requiredConsecutiveDays) || config.requiredConsecutiveDays < 1) {
    throw new FinanceDomainError("PACK_UNSET", "requiredConsecutiveDays must be a positive versioned policy value");
  }
  return config;
}
