import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  PgCwosV2StateStore,
  type V2PgQueryable,
  type V2RuntimeEnvelope,
} from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "b1111111-1111-4111-8111-111111111111";
const owner: V2Actor = {
  principalId: "human-owner",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

function permissionDenied(relation: string): Error & { code: string } {
  const error = new Error(`permission denied for table ${relation}`) as Error & { code: string };
  error.code = "42501";
  return error;
}

function rlsViolation(relation: string): Error & { code: string } {
  const error = new Error(`new row violates row-level security policy for table "${relation}"`) as Error & {
    code: string;
  };
  error.code = "42501";
  return error;
}

/**
 * Mirrors ai_crm_runtime_api on FORCE RLS: SELECT/INSERT on append-only audit
 * (no UPDATE, so FOR UPDATE is 42501), snapshot INSERT requires app.workspace_id,
 * and SELECT without the GUC looks like an empty workspace.
 */
function leastPrivilegeQueryable(): V2PgQueryable {
  let snapshot: {
    workspace_id: string;
    version: number;
    state: V2RuntimeEnvelope["state"];
    idempotency: V2RuntimeEnvelope["idempotency"];
    state_hash: string;
    updated_by_principal_id: string;
    updated_at: string;
  } | undefined;
  const events: Array<{ sequence: number; event_hash: string }> = [];

  return {
    async query() {
      throw new Error("unscoped query() is forbidden");
    },
    async withWorkspaceScope<T>(scopedWorkspaceId: string, fn: (scoped: V2PgQueryable) => Promise<T>) {
      let guc: string | undefined;
      const scoped: V2PgQueryable = {
        async query<T2 = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
          const sql = text.replace(/\s+/g, " ").trim();
          if (sql.startsWith("SELECT set_config('app.workspace_id'")) {
            guc = String(values[0] ?? "");
            return { rows: [{ set_config: guc }] as T2[], rowCount: 1 };
          }
          if (sql.startsWith("SELECT pg_advisory_xact_lock(")) {
            return { rows: [{}] as T2[], rowCount: 1 };
          }
          if (sql.includes("FROM cwos_v2_audit_events")) {
            if (/\bFOR UPDATE\b/i.test(sql)) throw permissionDenied("cwos_v2_audit_events");
            const prior = events.at(-1);
            return { rows: (prior ? [prior] : []) as T2[], rowCount: prior ? 1 : 0 };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_audit_events")) {
            if (guc !== scopedWorkspaceId) throw rlsViolation("cwos_v2_audit_events");
            events.push({ sequence: Number(values[1]), event_hash: String(values[11]) });
            return { rows: [] as T2[], rowCount: 1 };
          }
          if (sql.includes("FROM cwos_v2_runtime_snapshots")) {
            if (guc !== scopedWorkspaceId) return { rows: [] as T2[], rowCount: 0 };
            if (!snapshot) return { rows: [] as T2[], rowCount: 0 };
            return {
              rows: [
                {
                  workspace_id: snapshot.workspace_id,
                  version: snapshot.version,
                  state: snapshot.state,
                  idempotency: snapshot.idempotency,
                  state_hash: snapshot.state_hash,
                  updated_by_principal_id: snapshot.updated_by_principal_id,
                  updated_at: snapshot.updated_at,
                },
              ] as T2[],
              rowCount: 1,
            };
          }
          if (sql.startsWith("INSERT INTO cwos_v2_runtime_snapshots")) {
            if (guc !== scopedWorkspaceId) throw rlsViolation("cwos_v2_runtime_snapshots");
            snapshot = {
              workspace_id: scopedWorkspaceId,
              version: 1,
              state: JSON.parse(String(values[1])) as V2RuntimeEnvelope["state"],
              idempotency: JSON.parse(String(values[2])) as V2RuntimeEnvelope["idempotency"],
              state_hash: String(values[3]),
              updated_by_principal_id: String(values[4]),
              updated_at: String(values[5]),
            };
            return { rows: [] as T2[], rowCount: 1 };
          }
          if (sql.startsWith("UPDATE cwos_v2_runtime_snapshots")) {
            if (guc !== scopedWorkspaceId) throw rlsViolation("cwos_v2_runtime_snapshots");
            if (!snapshot) return { rows: [] as T2[], rowCount: 0 };
            snapshot = {
              ...snapshot,
              version: snapshot.version + 1,
              state: JSON.parse(String(values[1])) as V2RuntimeEnvelope["state"],
              idempotency: JSON.parse(String(values[2])) as V2RuntimeEnvelope["idempotency"],
              state_hash: String(values[3]),
              updated_by_principal_id: String(values[4]),
              updated_at: String(values[5]),
            };
            return { rows: [] as T2[], rowCount: 1 };
          }
          throw new Error(`unexpected sql: ${sql}`);
        },
      };
      return fn(scoped);
    },
  };
}

describe("PgCwosV2StateStore least-privilege bootstrap", () => {
  it("registers the first human without UPDATE on append-only audit and without a pre-set GUC", async () => {
    const runtime = new CustomerWorkOsV2RuntimeManager(
      new PgCwosV2StateStore(leastPrivilegeQueryable()),
      () => "2026-08-15T00:00:00.000Z",
    );

    const result = await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "bootstrap-human",
      command: "identity.registerPrincipal",
      payload: {
        id: owner.principalId,
        kind: "human",
        displayName: "JM Park",
        active: true,
      },
    });

    expect(result.statusCode).toBe(200);
    expect(result.envelope.version).toBe(1);
    expect(result.envelope.state.identity.principals).toEqual([
      expect.objectContaining({
        id: owner.principalId,
        kind: "human",
        displayName: "JM Park",
        active: true,
      }),
    ]);
  });
});
