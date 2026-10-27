import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createPgDailyGateRepository, InMemoryDailyGateRepository, type PgQueryable } from "../src/pg-finance-recon-adapter.js";

describe("DailyGateRepository version-transition audit", () => {
  it("uses the governance audit-chain genesis and canonical key ordering", async () => {
    let auditParams: unknown[] | undefined;
    const db: PgQueryable = {
      async query<T = unknown>(sql: string, params: unknown[] = []) {
        if (sql.includes("SELECT 1 FROM finance_daily_gate_evidence")) return { rows: [] as T[], rowCount: 0 };
        if (sql.includes("SELECT head_sequence")) return { rows: [{ head_sequence: 0, head_event_hash: null }] as T[], rowCount: 1 };
        if (sql.includes("INSERT INTO audit_events")) { auditParams = params; return { rows: [{ id: "event-1" }] as T[], rowCount: 1 }; }
        return { rows: [] as T[], rowCount: 1 };
      },
      async withWorkspaceScope(_workspaceId, fn) { return fn(this); },
    };
    await createPgDailyGateRepository(db).recordDayWithGovernance("ws-1", { date: "2026-01-01", qualifying: true, streakAfter: 1, tierAfter: "conservative" }, { streak: 1, tier: "conservative", packVersion: 1 }, { date: "2026-01-01", controllerId: "controller", evidenceId: "e-1", evidenceHash: "a".repeat(64), evidenceSignature: "b".repeat(64), metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: "2026-01-01T09:00:00Z", matrixVersion: 1, policyVersion: 1, packVersion: 1, resultingStreak: 1, resultingTier: "conservative", provenance: { z: 1, a: 2 } });
    const canonical = `{"evidenceHash":"${"a".repeat(64)}","evidenceId":"e-1","kind":"daily_gate_evidence","workspaceId":"ws-1"}`;
    const expected = createHash("sha256").update(`ws-1\0${1}\0FINANCE_DAILY_GATE_EVIDENCE\0e-1\0${canonical}\0${"0".repeat(64)}`, "utf8").digest("hex");
    expect(auditParams?.[5]).toBe(expected);
  });

  it("preflights immutable server evidence before mutating memory state", async () => {
    const repo = new InMemoryDailyGateRepository();
    const evidence = { date: "2026-01-01", controllerId: "controller", evidenceId: "e-1", evidenceHash: "a".repeat(64), evidenceSignature: "b".repeat(64), metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: "2026-01-01T09:00:00Z", matrixVersion: 1, policyVersion: 1, packVersion: 1, resultingStreak: 1, resultingTier: "conservative" as const, provenance: { refs: ["r"], digests: ["c".repeat(64)] } };
    await repo.recordDayWithGovernance("ws-1", { date: evidence.date, qualifying: true, streakAfter: 1, tierAfter: "conservative" }, { streak: 1, tier: "conservative", packVersion: 1 }, evidence);
    await expect(repo.recordDayWithGovernance("ws-1", { date: evidence.date, qualifying: false, streakAfter: 0, tierAfter: "conservative" }, { streak: 0, tier: "conservative", packVersion: 1 }, evidence)).rejects.toThrow("DAILY_GATE_REPLAY");
    expect(await repo.getDailyGateState("ws-1")).toMatchObject({ streak: 1 });
  });

  it("atomically replaces state with the conservative reset and retains immutable reset proof", async () => {
    const repo = new InMemoryDailyGateRepository();
    await repo.resetDailyGateStateWithAudit("ws-1", {
      streak: 0,
      tier: "conservative",
      lastDateEpoch: 20_000,
      packVersion: 2,
    }, {
      reason: "pack_version_mismatch",
      fromPackVersion: 1,
      toPackVersion: 2,
      prior: { streak: 90, tier: "risk_tiered", lastDateEpoch: 20_000, activatedMatrixVersion: 7, packVersion: 1 },
    });

    expect(await repo.getDailyGateState("ws-1")).toEqual({
      streak: 0,
      tier: "conservative",
      lastDateEpoch: 20_000,
      packVersion: 2,
    });
    expect(await repo.listDailyGateVersionTransitions("ws-1")).toEqual([expect.objectContaining({
      reason: "pack_version_mismatch",
      fromPackVersion: 1,
      toPackVersion: 2,
      prior: expect.objectContaining({ tier: "risk_tiered", activatedMatrixVersion: 7 }),
      resetState: expect.objectContaining({ tier: "conservative", streak: 0, packVersion: 2 }),
    })]);
  });

  it("maps null and undefined legacy pack_version as unknown, while retaining a positive PG value", async () => {
    const rows = [
      { workspace_id: "null", streak: 1, tier: "conservative", last_date_epoch: null, activated_matrix_version: null, pack_version: null, version: 1 },
      { workspace_id: "undefined", streak: 1, tier: "conservative", last_date_epoch: null, activated_matrix_version: null, pack_version: undefined, version: 1 },
      { workspace_id: "value", streak: 1, tier: "conservative", last_date_epoch: null, activated_matrix_version: null, pack_version: "3", version: 1 },
    ];
    const db: PgQueryable = { async query<T = unknown>() { return { rows: rows as unknown as T[], rowCount: rows.length }; } };
    const states = await createPgDailyGateRepository(db).listAllDailyGateStates();
    expect(states.find((row) => row.workspaceId === "null")?.packVersion).toBeUndefined();
    expect(states.find((row) => row.workspaceId === "undefined")?.packVersion).toBeUndefined();
    expect(states.find((row) => row.workspaceId === "value")?.packVersion).toBe(3);
  });

  it("does not commit a reset state when its immutable audit INSERT fails in the same workspace transaction", async () => {
    let committed: Record<string, unknown> | undefined;
    const db: PgQueryable = {
      async query() { throw new Error("root query must not be used for a scoped reset"); },
      async withWorkspaceScope(_workspaceId, fn) {
        let pending: Record<string, unknown> | undefined;
        const scoped: PgQueryable = {
          async query<T = unknown>(sql: string, params: unknown[] = []) {
            if (sql.includes("INSERT INTO finance_daily_gate_state")) {
              pending = { workspace_id: params[0], streak: params[1], tier: params[2], pack_version: params[5] };
              return { rows: [] as T[], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO finance_daily_gate_version_transitions")) throw new Error("audit insert failed");
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        const result = await fn(scoped);
        committed = pending;
        return result;
      },
    };
    const repo = createPgDailyGateRepository(db);
    await expect(repo.resetDailyGateStateWithAudit("ws-1", { streak: 0, tier: "conservative", packVersion: 2 }, {
      reason: "pack_version_mismatch", fromPackVersion: 1, toPackVersion: 2,
      prior: { streak: 9, tier: "risk_tiered", packVersion: 1 },
    })).rejects.toThrow("audit insert failed");
    expect(committed).toBeUndefined();
  });
});
