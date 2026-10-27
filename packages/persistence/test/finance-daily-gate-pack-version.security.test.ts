import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  fileURLToPath(new URL("../migrations/0020_finance_daily_gate_pack_version.sql", import.meta.url)),
  "utf8",
);

describe("finance DailyGate pack-version migration", () => {
  it("keeps legacy pack versions explicitly nullable and audits transitions under FORCE RLS", () => {
    expect(sql).toMatch(/ADD COLUMN pack_version bigint NULL/);
    expect(sql).not.toMatch(/ADD COLUMN pack_version bigint[^;]*DEFAULT/i);
    expect(sql).toMatch(/CREATE TABLE finance_daily_gate_version_transitions/);
    expect(sql).toMatch(/ALTER TABLE finance_daily_gate_version_transitions FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON finance_daily_gate_version_transitions TO ai_crm_runtime_api/);
    expect(sql).toMatch(/GRANT SELECT ON finance_daily_gate_version_transitions TO ai_crm_audit_verifier/);
    expect(sql).toMatch(/GRANT USAGE, SELECT ON SEQUENCE finance_daily_gate_version_transitions_id_seq TO ai_crm_runtime_api/);
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*finance_daily_gate_version_transitions[^;]*ai_crm_runtime_api/i);
  });
});
