/**
 * Daily qualifying-day gate (§4 of `docs/finance/accounting-standard-pack.md`).
 *
 * Pure in-memory state machine: a business day is evaluated against the
 * signed accounting pack's Asia/Seoul day-close cutoff and either extends or
 * resets a consecutive-qualifying-day streak. Reaching
 * `config.requiredConsecutiveDays` moves the finance control tier from
 * `conservative` to `eligible`; only an explicit, separately-approved
 * `activateRiskTier` call may move `eligible` to `risk_tiered` (§4 rule 6).
 * A later historical correction to a non-qualifying day never retroactively
 * restores an already-reset streak (§4 rule 4).
 */

import { FinanceDomainError, assertFinancePackConfig, type FinancePackConfig } from "./config.js";

export type FinanceTier = "conservative" | "eligible" | "risk_tiered";

export interface DayInput {
  /** YYYY-MM-DD Asia/Seoul business day this metric set is for. */
  date: string;
  importsCompleted: boolean;
  entriesBalanced: boolean;
  openFinanceExceptions: number;
  /** ISO timestamp with explicit offset, e.g. "2026-01-05T08:30:00+09:00" or "...Z". */
  receivedAt: string;
  backfilled?: boolean;
}

export interface DayRecord {
  date: string;
  qualifying: boolean;
  reason?: string;
  streakAfter: number;
  tierAfter: FinanceTier;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const SEOUL_OFFSET_MS = 9 * 3_600_000;

interface DateParts {
  y: number;
  m: number;
  d: number;
}

function assertValidDate(date: string): DateParts {
  if (!DATE_RE.test(date)) {
    throw new FinanceDomainError("INVALID_INPUT", `date must be YYYY-MM-DD: ${date}`);
  }
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const epochMs = Date.UTC(y, m - 1, d);
  const check = new Date(epochMs);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new FinanceDomainError("INVALID_INPUT", `date is not a real calendar date: ${date}`);
  }
  return { y, m, d };
}

function epochDay(date: string): number {
  const { y, m, d } = assertValidDate(date);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function epochDayToDateString(epochDayNumber: number): string {
  const date = new Date(epochDayNumber * MS_PER_DAY);
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** UTC epoch ms of the Asia/Seoul day-close cutoff instant for `date`. */
function seoulCutoffInstantMs(parts: DateParts, cutoff: string): number {
  const [hh, mm] = cutoff.split(":").map(Number);
  return Date.UTC(parts.y, parts.m - 1, parts.d, hh, mm) - SEOUL_OFFSET_MS;
}

function isLate(date: string, config: FinancePackConfig, receivedAt: string): boolean {
  const receivedMs = Date.parse(receivedAt);
  if (Number.isNaN(receivedMs)) {
    throw new FinanceDomainError("INVALID_INPUT", `receivedAt is not a valid ISO timestamp: ${receivedAt}`);
  }
  const cutoffMs = seoulCutoffInstantMs(assertValidDate(date), config.dayCloseCutoff);
  return config.cutoffBoundary === "inclusive" ? receivedMs > cutoffMs : receivedMs >= cutoffMs;
}

export class DailyGate {
  private readonly config: FinancePackConfig;
  private readonly records = new Map<string, DayRecord>();
  private streak = 0;
  private tier: FinanceTier = "conservative";
  private lastDateEpoch: number | undefined;
  private activatedMatrixVersion: number | undefined;

  constructor(
    config: FinancePackConfig,
    private readonly workspaceId: string,
    private policyVersion: number,
  ) {
    this.config = assertFinancePackConfig(config);
    if (!workspaceId.trim()) {
      throw new FinanceDomainError("INVALID_INPUT", "workspaceId is required");
    }
    if (!Number.isInteger(policyVersion) || policyVersion < 1) {
      throw new FinanceDomainError("INVALID_INPUT", "policyVersion must be a positive integer");
    }
  }

  recordDay(day: DayInput): DayRecord {
    this.assertDayInput(day);
    const newEpoch = epochDay(day.date);
    if (this.lastDateEpoch !== undefined) {
      if (newEpoch <= this.lastDateEpoch) {
        throw new FinanceDomainError("OUT_OF_ORDER", `day ${day.date} must be strictly after the last recorded day`);
      }
      for (let e = this.lastDateEpoch + 1; e < newEpoch; e += 1) {
        this.applyDay(epochDayToDateString(e), false, "missing");
      }
    }
    const late = isLate(day.date, this.config, day.receivedAt);
    const backfilled = day.backfilled === true;
    let qualifying: boolean;
    let reason: string | undefined;
    if (backfilled) {
      qualifying = false;
      reason = "backfilled";
    } else if (late) {
      qualifying = false;
      reason = "late";
    } else if (!(day.importsCompleted && day.entriesBalanced && day.openFinanceExceptions === 0)) {
      qualifying = false;
      reason = "failed";
    } else {
      qualifying = true;
    }
    const record = this.applyDay(day.date, qualifying, reason);
    return structuredClone(record);
  }

  changePolicyVersion(newVersion: number): void {
    if (!Number.isInteger(newVersion) || newVersion < 1) {
      throw new FinanceDomainError("INVALID_INPUT", "newVersion must be a positive integer");
    }
    if (newVersion === this.policyVersion) {
      throw new FinanceDomainError("INVALID_INPUT", `policy version unchanged: ${newVersion}`);
    }
    this.policyVersion = newVersion;
    this.streak = 0;
    if (this.tier === "eligible") this.tier = "conservative";
  }

  activateRiskTier(approvedMatrixVersion: number, approverPrincipalId: string): void {
    if (this.tier !== "eligible") {
      const activated = this.activatedMatrixVersion !== undefined ? `, matrix version ${this.activatedMatrixVersion} already active` : "";
      throw new FinanceDomainError(
        "INVALID_STATE",
        `risk-tier activation for workspace ${this.workspaceId} requires eligible tier, found ${this.tier}${activated}`,
      );
    }
    if (!Number.isInteger(approvedMatrixVersion) || approvedMatrixVersion < 1) {
      throw new FinanceDomainError("INVALID_INPUT", "approvedMatrixVersion must be a positive integer");
    }
    if (!approverPrincipalId.trim()) {
      throw new FinanceDomainError("INVALID_INPUT", "approverPrincipalId is required");
    }
    this.tier = "risk_tiered";
    this.activatedMatrixVersion = approvedMatrixVersion;
  }

  historicalCorrection(date: string, note: string): { date: string; note: string; correctedAt: true } {
    if (!note.trim()) {
      throw new FinanceDomainError("INVALID_INPUT", "note is required for a historical correction");
    }
    const record = this.records.get(date);
    if (!record) {
      throw new FinanceDomainError("NOT_FOUND", `no recorded day: ${date}`);
    }
    if (record.qualifying) {
      throw new FinanceDomainError(
        "INVALID_STATE",
        `historical correction only applies to a non-qualifying day, ${date} is qualifying`,
      );
    }
    return { date, note, correctedAt: true };
  }

  status(): { streak: number; tier: FinanceTier; policyVersion: number } {
    return { streak: this.streak, tier: this.tier, policyVersion: this.policyVersion };
  }

  private assertDayInput(day: DayInput): void {
    assertValidDate(day.date);
    if (!Number.isInteger(day.openFinanceExceptions) || day.openFinanceExceptions < 0) {
      throw new FinanceDomainError("INVALID_INPUT", "openFinanceExceptions must be a non-negative integer");
    }
    if (Number.isNaN(Date.parse(day.receivedAt))) {
      throw new FinanceDomainError("INVALID_INPUT", `receivedAt is not a valid ISO timestamp: ${day.receivedAt}`);
    }
  }

  private applyDay(date: string, qualifying: boolean, reason?: string): DayRecord {
    if (qualifying) {
      this.streak += 1;
    } else {
      // §4 rule 4: a reset removes earned eligibility. Restoring it requires a
      // fresh full streak (a controller-approved re-evaluation), never a patch.
      this.streak = 0;
      if (this.tier === "eligible") this.tier = "conservative";
    }
    if (this.streak >= this.config.requiredConsecutiveDays && this.tier === "conservative") {
      this.tier = "eligible";
    }
    const record: DayRecord = {
      date,
      qualifying,
      streakAfter: this.streak,
      tierAfter: this.tier,
      ...(reason !== undefined ? { reason } : {}),
    };
    this.records.set(date, record);
    this.lastDateEpoch = epochDay(date);
    return record;
  }
}
