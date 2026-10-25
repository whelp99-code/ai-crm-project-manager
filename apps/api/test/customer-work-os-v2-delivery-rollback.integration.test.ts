import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  PgCwosV2StateStore,
  type V2PgQueryable,
  type V2RuntimeEnvelope,
} from "../src/customer-work-os-v2-runtime.js";
import { v2Hash, type V2AuditEvent } from "../src/customer-work-os-v2-runtime-core.js";

const workspaceId = "e4444444-4444-4444-8444-444444444444";
const actor: V2Actor = { workspaceId, principalId: "w04-owner", kind: "human", stepUpVerified: true };
const now = "2026-10-07T00:00:00.000Z";
const content = "Synthetic W04 delivery; authoritative acceptance remains unknown.";
const payload = {
  orderId: "w04-order", workItemId: "w04-work", sourceEventId: "w04-source", quoteRevision: "v1",
  revisionId: "w04-submitted", decision: "SUBMITTED",
  quantities: [{ lineId: "w04-line", ordered: 4, delivered: 4, accepted: 0 }],
  content, contentHash: createHash("sha256").update(content).digest("hex"),
  citationRefs: ["evidence://synthetic/w04"],
};

type Snapshot = {
  workspace_id: string;
  version: number;
  state: V2RuntimeEnvelope["state"];
  idempotency: V2RuntimeEnvelope["idempotency"];
  state_hash: string;
  updated_by_principal_id: string;
  updated_at: string;
};
type Tables = { snapshot: Snapshot | null; audit: V2AuditEvent[] };

// Only the snapshot/audit SQL issued by PgCwosV2StateStore is modeled, not PostgreSQL.
function stagedSnapshotAuditFixture() {
  let committed: Tables = { snapshot: null, audit: [] };
  const trace: string[] = [];
  const auditFailure = new Error("synthetic audit INSERT failure after staged snapshot");
  let failedStage: Tables | undefined;
  let visibleDuringFailure: Tables | undefined;
  const pool: V2PgQueryable = {
    async query() { throw new Error("unscoped query forbidden"); },
    async withWorkspaceScope<T>(scope: string, fn: (db: V2PgQueryable) => Promise<T>): Promise<T> {
      if (scope !== workspaceId) throw new Error("unexpected workspace");
      const stage = structuredClone(committed);
      let guc: string | undefined;
      const db: V2PgQueryable = {
        async query<R = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("SELECT set_config('app.workspace_id'")) {
            guc = String(values[0]);
            if (guc !== scope) throw new Error("workspace GUC differs");
            return { rows: [] as R[], rowCount: 1 };
          }
          if (guc !== scope || values[0] !== scope) throw new Error("query outside scoped workspace");
          if (sql.startsWith("SELECT pg_advisory_xact_lock(")) return { rows: [] as R[], rowCount: 1 };
          if (sql.includes("FROM cwos_v2_runtime_snapshots")) {
            return { rows: (stage.snapshot ? [structuredClone(stage.snapshot)] : []) as R[], rowCount: stage.snapshot ? 1 : 0 };
          }
          if (sql.includes("FROM cwos_v2_audit_events")) {
            const previous = stage.audit.at(-1);
            return { rows: (previous ? [{ sequence: previous.sequence, event_hash: previous.eventHash }] : []) as R[], rowCount: previous ? 1 : 0 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_runtime_snapshots") || sql.startsWith("UPDATE cwos_v2_runtime_snapshots")) {
            const update = sql.startsWith("UPDATE");
            if (update && (!stage.snapshot || stage.snapshot.version !== values[6])) return { rows: [] as R[], rowCount: 0 };
            if (!update && stage.snapshot) throw new Error("duplicate snapshot");
            stage.snapshot = {
              workspace_id: scope, version: (stage.snapshot?.version ?? 0) + 1,
              state: JSON.parse(String(values[1])) as Snapshot["state"],
              idempotency: JSON.parse(String(values[2])) as Snapshot["idempotency"],
              state_hash: String(values[3]), updated_by_principal_id: String(values[4]), updated_at: String(values[5]),
            };
            trace.push("snapshot-staged");
            return { rows: [] as R[], rowCount: 1 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_audit_events")) {
            trace.push("audit-insert");
            if (values[5] === "w04-audit-failure") {
              failedStage = structuredClone(stage);
              visibleDuringFailure = structuredClone(committed);
              trace.push("audit-failed");
              throw auditFailure;
            }
            stage.audit.push({
              workspaceId: scope, sequence: Number(values[1]), operationId: String(values[2]),
              principalId: String(values[3]), command: String(values[4]), idempotencyKey: String(values[5]),
              requestHash: String(values[6]), beforeStateHash: String(values[7]), afterStateHash: String(values[8]),
              resultHash: String(values[9]), previousEventHash: values[10] === null ? null : String(values[10]),
              eventHash: String(values[11]), createdAt: String(values[12]),
            });
            return { rows: [] as R[], rowCount: 1 };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
      };
      try {
        const result = await fn(db);
        committed = stage;
        trace.push("scope-committed");
        return result;
      } catch (error) {
        trace.push("scope-rolled-back");
        throw error;
      }
    },
  };
  return {
    pool, trace, auditFailure,
    inspect: () => structuredClone(committed),
    failedStage: () => structuredClone(failedStage),
    visibleDuringFailure: () => structuredClone(visibleDuringFailure),
  };
}

describe("W04 snapshot/audit staged transaction simulation (not live PostgreSQL)", () => {
  it("rolls back a staged delivery snapshot on audit failure and commits both on success", async () => {
    const fixture = stagedSnapshotAuditFixture();
    const runtime = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(fixture.pool), () => now);
    await runtime.command({
      workspaceId, actor, expectedVersion: 0, idempotencyKey: "w04-principal",
      command: "identity.registerPrincipal", payload: { id: actor.principalId, kind: "human", displayName: "Synthetic owner", active: true },
    });
    await runtime.command({
      workspaceId, actor, expectedVersion: 1, idempotencyKey: "w04-membership",
      command: "identity.addMembership", payload: { id: "w04-membership", principalId: actor.principalId },
    });
    await runtime.command({ workspaceId, actor, expectedVersion: 2, idempotencyKey: "w04-submission", command: "delivery.recordRevision", payload });
    const before = await runtime.read(workspaceId);
    const beforeTables = fixture.inspect();
    const nextPayload = {
      ...payload, revisionId: "w04-partial", decision: "PARTIAL_ACCEPTED",
      quantities: [{ lineId: "w04-line", ordered: 4, delivered: 4, accepted: 1 }],
    };
    const request = { workspaceId, actor, expectedVersion: before.version, command: "delivery.recordRevision", payload: nextPayload };
    const traceStart = fixture.trace.length;
    await expect(runtime.command({ ...request, idempotencyKey: "w04-audit-failure" })).rejects.toBe(fixture.auditFailure);
    expect(fixture.trace.slice(traceStart)).toEqual([
      "scope-committed", "snapshot-staged", "audit-insert", "audit-failed", "scope-rolled-back",
    ]);
    const staged = fixture.failedStage();
    expect(staged?.snapshot?.version).toBe(before.version + 1);
    expect(staged?.snapshot?.state.delivery?.orders[0]?.revisions).toHaveLength(2);
    expect(staged?.snapshot?.state.delivery?.orders[0]?.revisions[1]).toMatchObject({ revisionId: "w04-partial", quantities: nextPayload.quantities });
    expect(staged?.snapshot?.idempotency.at(-1)?.key).toBe("w04-audit-failure");
    expect(staged?.audit).toEqual(beforeTables.audit);
    expect(fixture.visibleDuringFailure()).toEqual(beforeTables);
    expect(fixture.inspect()).toEqual(beforeTables);
    expect(await runtime.read(workspaceId)).toEqual(before);
    const reopened = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(fixture.pool), () => now);
    expect(await reopened.read(workspaceId)).toEqual(before);

    const healthyTraceStart = fixture.trace.length;
    const accepted = await reopened.command({ ...request, idempotencyKey: "w04-audit-success" });
    expect(fixture.trace.slice(healthyTraceStart)).toEqual([
      "scope-committed", "snapshot-staged", "audit-insert", "scope-committed",
    ]);
    const after = fixture.inspect();
    expect(after.snapshot?.version).toBe(before.version + 1);
    expect(after.snapshot?.state).toEqual(accepted.envelope.state);
    expect(after.snapshot?.state_hash).toBe(accepted.envelope.stateHash);
    expect(after.snapshot?.idempotency).toEqual(accepted.envelope.idempotency);
    expect(accepted.envelope.stateHash).not.toBe(before.stateHash);
    expect(accepted.envelope.state.delivery?.orders[0]?.revisions).toHaveLength(2);
    expect(accepted.envelope.state.delivery?.orders[0]?.revisions[0]).toEqual(before.state.delivery?.orders[0]?.revisions[0]);
    expect(accepted.envelope.state.delivery?.orders[0]).toMatchObject({ authoritativeAcceptance: "UNKNOWN", paymentEligibility: "UNKNOWN" });
    expect(accepted.envelope.idempotency.some(item => item.key === "w04-audit-failure")).toBe(false);
    expect(accepted.envelope.idempotency.at(-1)?.key).toBe("w04-audit-success");
    expect(after.audit.slice(0, -1)).toEqual(beforeTables.audit);
    expect(after.audit).toHaveLength(beforeTables.audit.length + 1);
    const event = after.audit.at(-1);
    if (!event) throw new Error("committed audit required");
    expect(event).toMatchObject({
      sequence: beforeTables.audit.length + 1, previousEventHash: beforeTables.audit.at(-1)?.eventHash,
      command: "delivery.recordRevision", idempotencyKey: "w04-audit-success",
      beforeStateHash: before.stateHash, afterStateHash: accepted.envelope.stateHash,
      resultHash: v2Hash(accepted.result), requestHash: v2Hash({ command: request.command, payload: request.payload, actor }),
    });
    const { eventHash, ...core } = event;
    expect(eventHash).toBe(v2Hash(core));
    expect(await new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(fixture.pool), () => now).read(workspaceId)).toEqual(accepted.envelope);
  });
});
