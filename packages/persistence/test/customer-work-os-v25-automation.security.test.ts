import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../migrations/0020_customer_work_os_v25_automation.sql", import.meta.url)),
  "utf8",
);

describe("Customer Work OS v2.5 automation persistence", () => {
  it("creates workspace-scoped snapshot and append-only audit tables", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cwos_v25_automation_snapshots");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS cwos_v25_automation_audit_events");
    expect(migration).toContain("PRIMARY KEY (workspace_id, sequence)");
    expect(migration).toContain("UNIQUE (workspace_id, idempotency_key)");
  });

  it("forces RLS and requires transaction-scoped workspace identity", () => {
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("current_setting('app.workspace_id', true)");
  });

  it("prevents snapshot deletion and audit mutation", () => {
    expect(migration).toContain("cwos_v25 automation snapshots cannot be deleted");
    expect(migration).toContain("cwos_v25 automation audit events are append-only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON cwos_v25_automation_audit_events");
  });

  it("preserves contiguous audit and state-hash chains", () => {
    expect(migration).toContain("audit sequence must be contiguous");
    expect(migration).toContain("previous event hash mismatch");
    expect(migration).toContain("before-state hash mismatch");
    expect(migration).toContain("after-state hash must equal authoritative snapshot");
  });

  it("does not grant model-gateway mutation access", () => {
    expect(migration).not.toContain("ai_crm_runtime_model_gateway");
    expect(migration).toContain("ai_crm_runtime_api");
    expect(migration).toContain("ai_crm_runtime_worker");
  });
});
