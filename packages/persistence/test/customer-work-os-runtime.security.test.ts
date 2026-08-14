import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeSql = readFileSync(fileURLToPath(new URL("../migrations/0013_customer_work_os_runtime.sql", import.meta.url)), "utf8");
const auditSql = readFileSync(fileURLToPath(new URL("../migrations/0014_customer_work_os_audit.sql", import.meta.url)), "utf8");

describe("Customer Work OS durable runtime SQL", () => {
  it("uses optimistic concurrency and forbids snapshot deletion", () => {
    expect(runtimeSql).toContain("version bigint NOT NULL");
    expect(runtimeSql).toContain("NEW.version <> OLD.version + 1");
    expect(runtimeSql).toContain("runtime snapshots cannot be deleted");
    expect(runtimeSql).toContain("REVOKE DELETE ON cwos_runtime_snapshots");
  });

  it("forces workspace RLS and grants no model-gateway access", () => {
    expect(runtimeSql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(runtimeSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(runtimeSql).toContain("current_setting('app.workspace_id', true)");
    expect(runtimeSql).not.toContain("ai_crm_runtime_model_gateway");
    expect(auditSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(auditSql).not.toContain("ai_crm_runtime_model_gateway");
  });

  it("stores an append-only, contiguous, idempotency-bound audit chain", () => {
    expect(auditSql).toContain("CREATE TABLE cwos_runtime_events");
    expect(auditSql).toContain("previous_event_hash");
    expect(auditSql).toContain("event_hash");
    expect(auditSql).toContain("UNIQUE (workspace_id, sequence)");
    expect(auditSql).toContain("UNIQUE (workspace_id, idempotency_key)");
    expect(auditSql).toContain("cwos_runtime_events is append-only");
    expect(auditSql).toContain("NEW.head_sequence <> OLD.head_sequence + 1");
    expect(auditSql).toContain("REVOKE UPDATE, DELETE ON cwos_runtime_events");
  });

  it("records before/after/request/result hashes and the acting principal", () => {
    for (const column of [
      "operation_id",
      "principal_id",
      "idempotency_key",
      "request_hash",
      "before_state_hash",
      "after_state_hash",
      "result_hash",
    ]) expect(auditSql).toContain(column);
  });
});
