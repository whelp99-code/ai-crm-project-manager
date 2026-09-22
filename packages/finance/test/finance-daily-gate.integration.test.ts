import { describe, expect, it } from "vitest";
import { DailyGate, type DayInput } from "../src/daily-gate.js";
import { FinanceDomainError, type FinancePackConfig } from "../src/config.js";

const BASE_CONFIG: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [
    { code: "1000", name: "현금", type: "asset" },
    { code: "1200", name: "매출채권", type: "asset" },
    { code: "2100", name: "매입채무", type: "liability" },
    { code: "4000", name: "용역매출", type: "revenue" },
    { code: "5000", name: "외주비", type: "expense" },
  ],
  decimalScale: 0,
  dayCloseCutoff: "18:00",
  cutoffBoundary: "inclusive",
  reconciliationToleranceKrw: "0",
  requiredConsecutiveDays: 90,
};

function config(overrides: Partial<FinancePackConfig> = {}): FinancePackConfig {
  return { ...BASE_CONFIG, ...overrides };
}

function gate(overrides: Partial<FinancePackConfig> = {}): DailyGate {
  return new DailyGate(config(overrides), "ws-1", 1);
}

/** epoch-day arithmetic mirroring the pure UTC math the implementation uses. */
function dateAt(startDate: string, offsetDays: number): string {
  const [y, m, d] = startDate.split("-").map(Number) as [number, number, number];
  const epochMs = Date.UTC(y, m - 1, d) + offsetDays * 86_400_000;
  const date = new Date(epochMs);
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

function onTimeReceivedAt(date: string): string {
  return `${date}T09:00:00+09:00`;
}

function qualifyingDay(date: string, overrides: Partial<DayInput> = {}): DayInput {
  return {
    date,
    importsCompleted: true,
    entriesBalanced: true,
    openFinanceExceptions: 0,
    receivedAt: onTimeReceivedAt(date),
    ...overrides,
  };
}

function feedQualifyingRun(target: DailyGate, startDate: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    target.recordDay(qualifyingDay(dateAt(startDate, i)));
  }
}

describe("DailyGate", () => {
  it("moves conservative -> eligible exactly at day 90 and stays eligible at day 91 (89/90/91 boundary)", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    expect(g.status()).toEqual({ streak: 89, tier: "conservative", policyVersion: 1 });

    const day90 = g.recordDay(qualifyingDay(dateAt("2026-01-01", 89)));
    expect(day90.qualifying).toBe(true);
    expect(day90.streakAfter).toBe(90);
    expect(day90.tierAfter).toBe("eligible");
    expect(g.status().tier).toBe("eligible");

    const day91 = g.recordDay(qualifyingDay(dateAt("2026-01-01", 90)));
    expect(day91.streakAfter).toBe(91);
    expect(day91.tierAfter).toBe("eligible");
    expect(g.status()).toEqual({ streak: 91, tier: "eligible", policyVersion: 1 });
  });

  it("resets a streak already at 89 on a failed day (openFinanceExceptions > 0)", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    const failedDate = dateAt("2026-01-01", 89);
    const record = g.recordDay(qualifyingDay(failedDate, { openFinanceExceptions: 2 }));
    expect(record.qualifying).toBe(false);
    expect(record.reason).toBe("failed");
    expect(record.streakAfter).toBe(0);
    expect(g.status().streak).toBe(0);
    expect(g.status().tier).toBe("conservative");
  });

  it("resets a streak already at 89 on a missing day (a skipped calendar date)", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    // Skip the next calendar day entirely (index 89) — jump straight to index 90.
    const nextRecordedDate = dateAt("2026-01-01", 90);
    const record = g.recordDay(qualifyingDay(nextRecordedDate));
    expect(record.date).toBe(nextRecordedDate);
    // The recorded day itself is qualifying, but the skipped day reset the streak first.
    expect(record.qualifying).toBe(true);
    expect(record.streakAfter).toBe(1);
    expect(g.status().streak).toBe(1);
    expect(g.status().tier).toBe("conservative");
  });

  it("resets a streak already at 89 on a late day (receivedAt after that day's cutoff)", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    const lateDate = dateAt("2026-01-01", 89);
    const record = g.recordDay(qualifyingDay(lateDate, { receivedAt: `${lateDate}T19:00:00+09:00` }));
    expect(record.qualifying).toBe(false);
    expect(record.reason).toBe("late");
    expect(record.streakAfter).toBe(0);
    expect(g.status().streak).toBe(0);
  });

  it("resets a streak already at 89 on a backfilled day", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    const backfilledDate = dateAt("2026-01-01", 89);
    const record = g.recordDay(qualifyingDay(backfilledDate, { backfilled: true }));
    expect(record.qualifying).toBe(false);
    expect(record.reason).toBe("backfilled");
    expect(record.streakAfter).toBe(0);
    expect(g.status().streak).toBe(0);
  });

  it("assigns the exact cutoff-boundary instant deterministically per config (inclusive on-time, exclusive late)", () => {
    const boundaryDate = "2026-03-10";
    const boundaryReceivedAt = `${boundaryDate}T18:00:00+09:00`;

    const inclusiveGate = gate({ cutoffBoundary: "inclusive" });
    const inclusiveRecord = inclusiveGate.recordDay(qualifyingDay(boundaryDate, { receivedAt: boundaryReceivedAt }));
    expect(inclusiveRecord.qualifying).toBe(true);
    expect(inclusiveRecord.reason).toBeUndefined();

    const exclusiveGate = gate({ cutoffBoundary: "exclusive" });
    const exclusiveRecord = exclusiveGate.recordDay(qualifyingDay(boundaryDate, { receivedAt: boundaryReceivedAt }));
    expect(exclusiveRecord.qualifying).toBe(false);
    expect(exclusiveRecord.reason).toBe("late");
  });

  it("a UTC Z-suffixed timestamp equal to 17:59 KST is on time under the 18:00 cutoff", () => {
    const g = gate();
    // 17:59 Asia/Seoul (UTC+9) == 08:59 UTC.
    const record = g.recordDay(qualifyingDay("2026-03-10", { receivedAt: "2026-03-10T08:59:00Z" }));
    expect(record.qualifying).toBe(true);
  });

  it("resets the streak on a mid-streak policy-version bump even with otherwise-qualifying data, without changing tier", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    expect(g.status().streak).toBe(89);

    g.changePolicyVersion(2);
    expect(g.status()).toEqual({ streak: 0, tier: "conservative", policyVersion: 2 });

    const nextRecord = g.recordDay(qualifyingDay(dateAt("2026-01-01", 89)));
    expect(nextRecord.streakAfter).toBe(1);
    expect(g.status().tier).toBe("conservative");
  });

  it("rejects a no-op policy-version change", () => {
    const g = gate();
    expect(() => g.changePolicyVersion(1)).toThrow(FinanceDomainError);
    try {
      g.changePolicyVersion(1);
    } catch (error) {
      expect(error).toBeInstanceOf(FinanceDomainError);
      expect((error as FinanceDomainError).code).toBe("INVALID_INPUT");
    }
  });

  it("historicalCorrection on a reset-by-failure day records the correction without restoring the streak or the day's qualifying flag, and reaching eligible still needs a fresh 90-day run", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 89);
    const failedDate = dateAt("2026-01-01", 89);
    g.recordDay(qualifyingDay(failedDate, { openFinanceExceptions: 3 }));
    expect(g.status().streak).toBe(0);

    const correction = g.historicalCorrection(failedDate, "reconciled: exceptions were false positives");
    expect(correction).toEqual({ date: failedDate, note: "reconciled: exceptions were false positives", correctedAt: true });
    // Streak and tier are unaffected by the correction itself.
    expect(g.status()).toEqual({ streak: 0, tier: "conservative", policyVersion: 1 });

    // A fresh run of the full 90 consecutive days is required to reach eligible.
    feedQualifyingRun(g, dateAt(failedDate, 1), 89);
    expect(g.status().tier).toBe("conservative");
    g.recordDay(qualifyingDay(dateAt(failedDate, 90)));
    expect(g.status().tier).toBe("eligible");
  });

  it("historicalCorrection rejects an already-qualifying day", () => {
    const g = gate();
    const record = g.recordDay(qualifyingDay("2026-01-01"));
    expect(record.qualifying).toBe(true);
    expect(() => g.historicalCorrection("2026-01-01", "note")).toThrow(FinanceDomainError);
  });

  it("historicalCorrection rejects an unknown date and an empty note", () => {
    const g = gate();
    g.recordDay(qualifyingDay("2026-01-01", { openFinanceExceptions: 1 }));
    expect(() => g.historicalCorrection("2026-02-02", "note")).toThrow(FinanceDomainError);
    expect(() => g.historicalCorrection("2026-01-01", "  ")).toThrow(FinanceDomainError);
  });

  it("activateRiskTier throws from conservative, succeeds from eligible, and reaching day 90 alone never yields risk_tiered", () => {
    const g = gate();
    expect(() => g.activateRiskTier(1, "cfo-1")).toThrow(FinanceDomainError);

    feedQualifyingRun(g, "2026-01-01", 90);
    expect(g.status().tier).toBe("eligible");

    g.activateRiskTier(7, "cfo-1");
    expect(g.status().tier).toBe("risk_tiered");
  });

  it("rejects out-of-order recording (same or earlier date than the last recorded day)", () => {
    const g = gate();
    g.recordDay(qualifyingDay("2026-01-05"));
    expect(() => g.recordDay(qualifyingDay("2026-01-05"))).toThrow(FinanceDomainError);
    expect(() => g.recordDay(qualifyingDay("2026-01-04"))).toThrow(FinanceDomainError);
    try {
      g.recordDay(qualifyingDay("2026-01-05"));
    } catch (error) {
      expect((error as FinanceDomainError).code).toBe("OUT_OF_ORDER");
    }
  });
  it("demotes eligible -> conservative when the streak resets, so eligibility is never sticky", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 90);
    expect(g.status().tier).toBe("eligible");

    // A failed day both resets the streak AND removes earned eligibility (§4 rule 4).
    const failed = g.recordDay(qualifyingDay(dateAt("2026-01-01", 90), { openFinanceExceptions: 1 }));
    expect(failed).toMatchObject({ qualifying: false, streakAfter: 0, tierAfter: "conservative" });
    expect(g.status().tier).toBe("conservative");

    // Regaining eligibility requires a full fresh run, not a single day.
    g.recordDay(qualifyingDay(dateAt("2026-01-01", 91)));
    expect(g.status()).toMatchObject({ streak: 1, tier: "conservative" });
  });

  it("demotes eligible -> conservative on a policy-version change", () => {
    const g = gate();
    feedQualifyingRun(g, "2026-01-01", 90);
    expect(g.status().tier).toBe("eligible");
    g.changePolicyVersion(2);
    expect(g.status()).toMatchObject({ streak: 0, tier: "conservative", policyVersion: 2 });
  });

  it("fails closed on an unknown or mismatched persisted pack version while preserving the hydrated day boundary", () => {
    const g = gate();
    const result = g.restoreState({
      streak: 90,
      tier: "risk_tiered",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: 7,
    });

    expect(result).toMatchObject({
      reset: true,
      reason: "persisted_pack_version_missing",
      fromPackVersion: undefined,
      toPackVersion: 1,
      prior: { streak: 90, tier: "risk_tiered", activatedMatrixVersion: 7 },
      resetState: { streak: 0, tier: "conservative", lastDateEpoch: 20_000, activatedMatrixVersion: undefined, packVersion: 1 },
    });
    expect(g.snapshotState()).toEqual({
      streak: 0,
      tier: "conservative",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: undefined,
      packVersion: 1,
    });

    const mismatch = g.restoreState({
      streak: 12,
      tier: "eligible",
      lastDateEpoch: 20_001,
      packVersion: 2,
    });
    expect(mismatch).toMatchObject({
      reset: true,
      reason: "pack_version_mismatch",
      fromPackVersion: 2,
      toPackVersion: 1,
    });
  });

  it("restores exactly only when the persisted pack version is the live positive version and clears risk activation on a policy bump", () => {
    const g = gate();
    const result = g.restoreState({
      streak: 91,
      tier: "risk_tiered",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: 7,
      packVersion: 1,
    });
    expect(result).toEqual({ reset: false });
    expect(g.snapshotState()).toEqual({
      streak: 91,
      tier: "risk_tiered",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: 7,
      packVersion: 1,
    });

    g.changePolicyVersion(2);
    expect(g.snapshotState()).toEqual({
      streak: 0,
      tier: "conservative",
      lastDateEpoch: 20_000,
      activatedMatrixVersion: undefined,
      packVersion: 2,
    });
  });
});
