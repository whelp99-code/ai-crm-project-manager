import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0019_customer_work_os_v2_runtime.sql", import.meta.url),
  "utf8",
);

describe("Customer Work OS v2 PostgreSQL security contract", () => {
  it("uses UUID workspace keys and forced workspace RLS", () => {
    expect(sql).toContain("workspace_id uuid");
    expect(sql).toContain("ALTER TABLE cwos_v2_runtime_snapshots FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE cwos_v2_audit_events FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("current_setting('app.workspace_id', true)");
  });

  it("makes the audit chain append-only, contiguous and snapshot-bound", () => {
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON cwos_v2_audit_events");
    expect(sql).toContain("NEW.sequence <> previous_sequence + 1");
    expect(sql).toContain("NEW.previous_event_hash IS DISTINCT FROM previous_event_hash_value");
    expect(sql).toContain("NEW.before_state_hash IS DISTINCT FROM previous_after_state_hash");
    expect(sql).toContain("snapshot_state_hash IS DISTINCT FROM NEW.after_state_hash");
    expect(sql).toContain("BEFORE DELETE ON cwos_v2_runtime_snapshots");
  });

  it("does not grant v2 state mutation to the model-gateway principal", () => {
    expect(sql).not.toContain("ai_crm_runtime_model_gateway");
    expect(sql).not.toMatch(/GRANT\s+DELETE/i);
  });
});
