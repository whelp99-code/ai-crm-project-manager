import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "../migrations/0021_finance_daily_gate_governance.sql"), "utf8");

describe("0021 governed DailyGate evidence", () => {
  it("keeps evidence and activation append-only, replay-safe, provenance-complete, and workspace isolated", () => {
    expect(sql).toContain("CREATE TABLE finance_daily_gate_evidence");
    expect(sql).toContain("CREATE TABLE finance_daily_gate_activations");
    for (const column of ["metrics jsonb NOT NULL", "received_at timestamptz NOT NULL", "provenance jsonb NOT NULL", "resulting_streak", "resulting_tier"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/UNIQUE \(workspace_id, evidence_id\)/);
    expect(sql).toMatch(/UNIQUE \(workspace_id, evidence_hash\)/);
    expect(sql).toMatch(/UNIQUE \(workspace_id, approval_id\)/);
    expect(sql).toMatch(/UNIQUE \(workspace_id, approval_hash\)/);
    expect(sql).toContain("REFERENCES finance_daily_gate_evidence (workspace_id, evidence_hash)");
    expect(sql.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(sql.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(sql.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(2);
    expect(sql).toContain("REVOKE UPDATE, DELETE ON finance_daily_gate_evidence, finance_daily_gate_activations");
  });
});
