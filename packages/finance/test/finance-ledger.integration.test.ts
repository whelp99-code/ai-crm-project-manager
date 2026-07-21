import { describe, expect, it } from "vitest";
import { assertFinancePackConfig, FinanceDomainError, type ChartAccount, type FinancePackConfig } from "../src/config.js";
import { LedgerService } from "../src/ledger.js";
import { ReconciliationService } from "../src/reconciliation.js";

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(FinanceDomainError);
  try {
    fn();
    expect.fail(`expected ${code} to be thrown`);
  } catch (error) {
    expect(error).toBeInstanceOf(FinanceDomainError);
    expect((error as FinanceDomainError).code).toBe(code);
  }
}

const CHART: ChartAccount[] = [
  { code: "1000", name: "현금", type: "asset" },
  { code: "1200", name: "매출채권", type: "asset" },
  { code: "2100", name: "매입채무", type: "liability" },
  { code: "4000", name: "용역매출", type: "revenue" },
  { code: "5000", name: "외주비", type: "expense" },
];

function fixtureConfig(overrides: Partial<FinancePackConfig> = {}): FinancePackConfig {
  return {
    packVersion: 1,
    chartOfAccounts: CHART,
    decimalScale: 0,
    dayCloseCutoff: "20:00",
    cutoffBoundary: "inclusive",
    reconciliationToleranceKrw: "100",
    requiredConsecutiveDays: 90,
    ...overrides,
  };
}

function ledgerService(): LedgerService {
  return new LedgerService(fixtureConfig());
}

function balancedInput(id: string, overrides: Partial<Parameters<LedgerService["draft"]>[0]> = {}) {
  return {
    id,
    workspaceId: "ws-1",
    entryDate: "2026-07-01",
    description: "revenue recognition",
    lines: [
      { accountCode: "1200", debitKrw: "100000", creditKrw: "0" },
      { accountCode: "4000", debitKrw: "0", creditKrw: "100000" },
    ],
    createdByPrincipalId: "ai-drafter",
    ...overrides,
  };
}

describe("LedgerService — draft validation", () => {
  it("accepts a balanced entry", () => {
    const service = ledgerService();
    const entry = service.draft(balancedInput("je-1"));
    expect(entry.status).toBe("DRAFT");
    expect(entry.version).toBe(1);
  });

  it("rejects unknown account codes", () => {
    const service = ledgerService();
    expect(() =>
      service.draft(
        balancedInput("je-2", {
          lines: [
            { accountCode: "9999", debitKrw: "100", creditKrw: "0" },
            { accountCode: "4000", debitKrw: "0", creditKrw: "100" },
          ],
        }),
      ),
    ).toThrowError(FinanceDomainError);
    try {
      service.draft(
        balancedInput("je-2", {
          lines: [
            { accountCode: "9999", debitKrw: "100", creditKrw: "0" },
            { accountCode: "4000", debitKrw: "0", creditKrw: "100" },
          ],
        }),
      );
    } catch (error) {
      expect((error as FinanceDomainError).code).toBe("UNKNOWN_ACCOUNT");
    }
  });

  it("rejects unbalanced entries", () => {
    const service = ledgerService();
    expect(() =>
      service.draft(
        balancedInput("je-3", {
          lines: [
            { accountCode: "1200", debitKrw: "100", creditKrw: "0" },
            { accountCode: "4000", debitKrw: "0", creditKrw: "90" },
          ],
        }),
      ),
    ).toThrowError(/UNBALANCED_ENTRY|unbalanced/);
  });

  it("rejects a line with both debit and credit non-zero", () => {
    const service = ledgerService();
    expect(() =>
      service.draft(
        balancedInput("je-4", {
          lines: [
            { accountCode: "1200", debitKrw: "100", creditKrw: "50" },
            { accountCode: "4000", debitKrw: "0", creditKrw: "50" },
          ],
        }),
      ),
    ).toThrowError(/INVALID_LINE|non-zero/);
  });

  it("rejects a malformed amount string", () => {
    const service = ledgerService();
    expectCode(
      () =>
        service.draft(
          balancedInput("je-5", {
            lines: [
              { accountCode: "1200", debitKrw: "-100", creditKrw: "0" },
              { accountCode: "4000", debitKrw: "0", creditKrw: "100" },
            ],
          }),
        ),
      "INVALID_AMOUNT",
    );
  });

  it("rejects duplicate entry ids", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-6"));
    expectCode(() => service.draft(balancedInput("je-6")), "DUPLICATE_ID");
  });

  it("rejects fewer than two lines", () => {
    const service = ledgerService();
    expectCode(
      () => service.draft(balancedInput("je-7", { lines: [{ accountCode: "1200", debitKrw: "100", creditKrw: "0" }] })),
      "EMPTY_ENTRY",
    );
  });

  it("rejects a malformed entryDate", () => {
    const service = ledgerService();
    expectCode(() => service.draft(balancedInput("je-8", { entryDate: "2026/07/01" })), "INVALID_DATE");
  });
});

describe("LedgerService — draft → verify → post workflow", () => {
  it("posts through the full three-role workflow", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-10", { evidenceRef: "evidence://intake/1" }));
    const verified = service.verify("ws-1", "je-10", "ai-verifier");
    expect(verified.status).toBe("VERIFIED");
    const posted = service.post("ws-1", "je-10", "cfo-approver");
    expect(posted.status).toBe("POSTED");
    expect(posted.postedByPrincipalId).toBe("cfo-approver");
  });

  it("rejects verify when verifier equals creator", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-11", { evidenceRef: "evidence://intake/1" }));
    expectCode(() => service.verify("ws-1", "je-11", "ai-drafter"), "SOD_VIOLATION");
  });

  it("rejects post when poster equals creator", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-12", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-12", "ai-verifier");
    expectCode(() => service.post("ws-1", "je-12", "ai-drafter"), "SOD_VIOLATION");
  });

  it("rejects post when poster equals verifier", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-13", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-13", "ai-verifier");
    expectCode(() => service.post("ws-1", "je-13", "ai-verifier"), "SOD_VIOLATION");
  });

  it("requires evidenceRef before an entry can post", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-14"));
    service.verify("ws-1", "je-14", "ai-verifier");
    expectCode(() => service.post("ws-1", "je-14", "cfo-approver"), "EVIDENCE_REQUIRED");
  });
});

describe("LedgerService — posted immutability and reversal", () => {
  it("reverses a posted entry, marks the original REVERSED, and nets balances to zero", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-20", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-20", "ai-verifier");
    service.post("ws-1", "je-20", "cfo-approver");

    const reversal = service.reverse("ws-1", "je-20", "je-20-rev", "ai-drafter", "2026-07-02");
    expect(reversal.status).toBe("DRAFT");
    expect(reversal.reversesEntryId).toBe("je-20");
    service.verify("ws-1", "je-20-rev", "ai-verifier");
    const postedReversal = service.post("ws-1", "je-20-rev", "cfo-approver");
    expect(postedReversal.status).toBe("POSTED");

    const original = service.getEntry("ws-1", "je-20");
    expect(original.status).toBe("REVERSED");
    expect(original.reversedByEntryId).toBe("je-20-rev");

    const balances = service.balances("ws-1");
    expect(balances["1200"]).toBe("0");
    expect(balances["4000"]).toBe("0");
  });

  it("rejects reversing an entry that is not POSTED", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-21", { evidenceRef: "evidence://intake/1" }));
    expectCode(() => service.reverse("ws-1", "je-21", "je-21-rev", "ai-drafter", "2026-07-02"), "INVALID_STATE");
  });

  it("rejects reversing an already-REVERSED entry", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-22", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-22", "ai-verifier");
    service.post("ws-1", "je-22", "cfo-approver");
    service.draft({
      id: "je-22-rev",
      workspaceId: "ws-1",
      entryDate: "2026-07-02",
      description: "manual reversal",
      evidenceRef: "evidence://intake/1",
      lines: [
        { accountCode: "4000", debitKrw: "100000", creditKrw: "0" },
        { accountCode: "1200", debitKrw: "0", creditKrw: "100000" },
      ],
      createdByPrincipalId: "ai-drafter",
      reversesEntryId: "je-22",
    });
    service.verify("ws-1", "je-22-rev", "ai-verifier");
    service.post("ws-1", "je-22-rev", "cfo-approver");
    expectCode(() => service.reverse("ws-1", "je-22", "je-22-rev-2", "ai-drafter", "2026-07-03"), "INVALID_STATE");
  });

  it("rejects posting a second reversal of an already-REVERSED original without stranding balances", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-30", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-30", "ai-verifier");
    service.post("ws-1", "je-30", "cfo-approver");

    // Two reversal drafts of the same original, both prepared before either posts.
    service.reverse("ws-1", "je-30", "je-30-rev-a", "ai-drafter", "2026-07-02");
    // Draft a second, independent reversal directly (reverse() would reject a REVERSED original,
    // so build it while the original is still POSTED).
    service.draft({
      id: "je-30-rev-b",
      workspaceId: "ws-1",
      entryDate: "2026-07-02",
      description: "second reversal",
      evidenceRef: "evidence://intake/1",
      lines: [
        { accountCode: "4000", debitKrw: "100000", creditKrw: "0" },
        { accountCode: "1200", debitKrw: "0", creditKrw: "100000" },
      ],
      createdByPrincipalId: "ai-drafter",
      reversesEntryId: "je-30",
    });
    service.verify("ws-1", "je-30-rev-a", "ai-verifier");
    service.verify("ws-1", "je-30-rev-b", "ai-verifier");

    // First reversal posts and marks the original REVERSED; balances net to zero.
    service.post("ws-1", "je-30-rev-a", "cfo-approver");
    expect(service.balances("ws-1")["1200"]).toBe("0");

    // Second reversal must reject AND must not commit itself to POSTED (no double-reversal in balances).
    expectCode(() => service.post("ws-1", "je-30-rev-b", "cfo-approver"), "INVALID_STATE");
    expect(service.getEntry("ws-1", "je-30-rev-b").status).toBe("VERIFIED");
    expect(service.balances("ws-1")["1200"]).toBe("0");
  });

  it("excludes DRAFT and VERIFIED entries from balances", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-23", { evidenceRef: "evidence://intake/1" }));
    service.verify("ws-1", "je-23", "ai-verifier");
    expect(service.balances("ws-1")).toEqual({});
  });
});

describe("LedgerService — cross-workspace", () => {
  it("denies access to an entry from another workspace", () => {
    const service = ledgerService();
    service.draft(balancedInput("je-30", { evidenceRef: "evidence://intake/1" }));
    expectCode(() => service.getEntry("ws-2", "je-30"), "CROSS_WORKSPACE");
  });
});

describe("ReconciliationService", () => {
  function reconciliationService(): ReconciliationService {
    return new ReconciliationService(fixtureConfig());
  }

  it("matches when variance is within tolerance and opens no exception", () => {
    const service = reconciliationService();
    const result = service.reconcile({
      id: "recon-1",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "100050", rowFingerprint: "fp-1" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
    });
    expect(result.status).toBe("MATCHED");
    expect(result.exceptionId).toBeUndefined();
    expect(service.openExceptions("ws-1")).toHaveLength(0);
  });

  it("flags a variance above tolerance and opens an exception", () => {
    const service = reconciliationService();
    const result = service.reconcile({
      id: "recon-2",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "101000", rowFingerprint: "fp-2" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
      exceptionId: "exc-1",
    });
    expect(result.status).toBe("VARIANCE");
    expect(result.exceptionId).toBe("exc-1");
    const open = service.openExceptions("ws-1");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: "OPEN", varianceKrw: "1000" });
  });

  it("requires a caller-supplied exceptionId when a variance occurs", () => {
    const service = reconciliationService();
    expectCode(
      () =>
        service.reconcile({
          id: "recon-3",
          workspaceId: "ws-1",
          statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "105000", rowFingerprint: "fp-3" },
          ledgerAmountKrw: "100000",
          reconciledByPrincipalId: "ai-reconciler",
          reconciledAt: "2026-07-01T09:05:00Z",
        }),
      "EXCEPTION_ID_REQUIRED",
    );
  });

  it("rejects reconciling the same statement row fingerprint twice", () => {
    const service = reconciliationService();
    service.reconcile({
      id: "recon-4",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "100000", rowFingerprint: "fp-4" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
    });
    expectCode(
      () =>
        service.reconcile({
          id: "recon-5",
          workspaceId: "ws-1",
          statementRow: { account: "1000", postedAt: "2026-07-01T09:10:00Z", amountKrw: "100000", rowFingerprint: "fp-4" },
          ledgerAmountKrw: "100000",
          reconciledByPrincipalId: "ai-reconciler",
          reconciledAt: "2026-07-01T09:15:00Z",
        }),
      "DUPLICATE_RECONCILIATION",
    );
  });

  it("resolves an open exception with a note from a different principal", () => {
    const service = reconciliationService();
    service.reconcile({
      id: "recon-6",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "101000", rowFingerprint: "fp-6" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
      exceptionId: "exc-6",
    });
    const resolved = service.resolveException("ws-1", "exc-6", "cfo-approver", "2026-07-02T00:00:00Z", "confirmed timing difference");
    expect(resolved.status).toBe("RESOLVED");
    expect(service.openExceptions("ws-1")).toHaveLength(0);
  });

  it("rejects resolving an exception without a note", () => {
    const service = reconciliationService();
    service.reconcile({
      id: "recon-7",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "101000", rowFingerprint: "fp-7" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
      exceptionId: "exc-7",
    });
    expectCode(() => service.resolveException("ws-1", "exc-7", "cfo-approver", "2026-07-02T00:00:00Z", ""), "RESOLUTION_NOTE_REQUIRED");
  });

  it("rejects resolving an exception by the same principal who reconciled", () => {
    const service = reconciliationService();
    service.reconcile({
      id: "recon-8",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "101000", rowFingerprint: "fp-8" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
      exceptionId: "exc-8",
    });
    expectCode(() => service.resolveException("ws-1", "exc-8", "ai-reconciler", "2026-07-02T00:00:00Z", "note"), "SOD_VIOLATION");
  });

  it("denies cross-workspace access to an exception", () => {
    const service = reconciliationService();
    service.reconcile({
      id: "recon-9",
      workspaceId: "ws-1",
      statementRow: { account: "1000", postedAt: "2026-07-01T09:00:00Z", amountKrw: "101000", rowFingerprint: "fp-9" },
      ledgerAmountKrw: "100000",
      reconciledByPrincipalId: "ai-reconciler",
      reconciledAt: "2026-07-01T09:05:00Z",
      exceptionId: "exc-9",
    });
    expectCode(() => service.resolveException("ws-2", "exc-9", "cfo-approver", "2026-07-02T00:00:00Z", "note"), "CROSS_WORKSPACE");
  });
});

describe("assertFinancePackConfig", () => {
  it("rejects an empty chart of accounts", () => {
    expectCode(() => assertFinancePackConfig(fixtureConfig({ chartOfAccounts: [] })), "PACK_UNSET");
  });
});
