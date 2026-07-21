import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActionRegistry,
  GovernanceAuthorizationService,
  InMemoryGovernanceRepository,
  controlToPersisted,
  createPgGovernanceRepository,
  intentToPersisted,
  mapControlRow,
  mapIntentRow,
  type GovernancePgQueryable,
} from "../src/index.js";

const registry = new ActionRegistry({
  sendCustomer: "CUSTOMER_SEND",
  updateCustomer: "INTERNAL_REVERSIBLE_UPDATE",
});

describe("GOV-PG-01 pure mappers", () => {
  it("maps control and intent rows", () => {
    const control = mapControlRow({
      id: "control-1",
      workspace_id: "ws-1",
      action_type: "CUSTOMER_SEND",
      kind: "APPROVAL",
      resource_id: "customer-1",
      resource_version: 3,
      payload_hash: "abc",
      policy_version: 1,
      requester_principal_id: "ai-executor",
      decided_by_principal_id: "human-owner",
      status: "PENDING",
    });
    expect(control).toMatchObject({
      id: "control-1",
      workspaceId: "ws-1",
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      status: "PENDING",
      decidedByPrincipalId: "human-owner",
    });

    const intent = mapIntentRow({
      id: "intent-1",
      workspace_id: "ws-1",
      action_type: "INTERNAL_REVERSIBLE_UPDATE",
      status: "QUEUED",
      idempotency_key: "k-1",
      resource_id: "customer-1",
      resource_version: 1,
      payload_hash: "def",
      policy_version: 1,
      lease_epoch: 0,
      control_id: "control-1",
    });
    expect(intent).toMatchObject({
      id: "intent-1",
      status: "QUEUED",
      controlId: "control-1",
      leaseEpoch: 0,
    });
  });
});

describe("GOV-PG-02 InMemoryGovernanceRepository round-trip + restart", () => {
  it("persists control_requests + execution_intents shapes from a live service", async () => {
    const sut = new GovernanceAuthorizationService(registry);
    const authorized = sut.authorize({
      command: "sendCustomer",
      workspaceId: "ws-1",
      resourceId: "customer-1",
      resourceVersion: 3,
      payload: { message: "hi" },
      requesterPrincipalId: "ai-executor",
    });
    const control = authorized.control!;
    expect(control.status).toBe("PENDING");

    const repo = new InMemoryGovernanceRepository();
    await repo.saveControl(controlToPersisted(control));

    const loaded = await repo.loadControl("ws-1", control.id);
    expect(loaded?.status).toBe("PENDING");
    expect(loaded?.payloadHash).toBe(control.payloadHash);

    // Restart survival: serialize → revive → control still PENDING
    const dir = mkdtempSync(join(tmpdir(), "gov-pg-"));
    const file = join(dir, "gov.json");
    writeFileSync(file, JSON.stringify(repo.toJSON()), "utf8");
    const revived = InMemoryGovernanceRepository.fromJSON(JSON.parse(readFileSync(file, "utf8")));
    const afterRestart = await revived.loadControl("ws-1", control.id);
    expect(afterRestart?.status).toBe("PENDING");
    expect(afterRestart?.id).toBe(control.id);
  });

  it("round-trips an ALLOW intent", async () => {
    const sut = new GovernanceAuthorizationService(registry);
    const intent = sut.authorize({
      command: "updateCustomer",
      workspaceId: "ws-1",
      resourceId: "customer-2",
      resourceVersion: 1,
      payload: { name: "x" },
      requesterPrincipalId: "ai-executor",
    }).intent!;

    const repo = new InMemoryGovernanceRepository();
    await repo.saveIntent(intentToPersisted(intent));
    const loaded = await repo.loadIntent("ws-1", intent.id);
    expect(loaded?.status).toBe("QUEUED");
    expect(loaded?.idempotencyKey).toBe(intent.idempotencyKey);
  });

  it("listAllControls/listAllIntents return every workspace's rows", async () => {
    const repo = new InMemoryGovernanceRepository();
    await repo.saveControl({
      id: "c-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    await repo.saveControl({
      id: "c-2",
      workspaceId: "ws-2",
      resourceId: "r-2",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "APPROVED",
    });
    await repo.saveIntent({
      id: "i-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "INTERNAL_REVERSIBLE_UPDATE",
      status: "QUEUED",
      idempotencyKey: "k",
      leaseEpoch: 0,
    });

    const allControls = await repo.listAllControls();
    expect(allControls.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
    const allIntents = await repo.listAllIntents();
    expect(allIntents.map((i) => i.id)).toEqual(["i-1"]);
  });
});

describe("GOV-PG-03 createPgGovernanceRepository mock client", () => {
  it("saves and loads control/intent rows via real UPSERT/SELECT against orch_governance_controls/intents", async () => {
    const controls = new Map<string, Record<string, unknown>>();
    const intents = new Map<string, Record<string, unknown>>();

    const mock: GovernancePgQueryable = {
      async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql.startsWith("INSERT INTO orch_governance_controls")) {
          const row = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            action_type: String(params[2]),
            kind: params[3],
            resource_id: String(params[4]),
            resource_version: Number(params[5]),
            payload_hash: String(params[6]),
            policy_version: Number(params[7]),
            requester_principal_id: String(params[8]),
            decided_by_principal_id: (params[9] as string | null) ?? null,
            status: String(params[10]),
          };
          controls.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_controls WHERE workspace_id = $1 AND id = $2")) {
          const row = controls.get(`${params[0]}\0${params[1]}`);
          return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
        }
        if (sql.startsWith("INSERT INTO orch_governance_intents")) {
          const row = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            action_type: String(params[2]),
            status: String(params[3]),
            idempotency_key: String(params[4]),
            resource_id: String(params[5]),
            resource_version: Number(params[6]),
            payload_hash: String(params[7]),
            policy_version: Number(params[8]),
            lease_deadline: (params[9] as string | null) ?? null,
            lease_epoch: Number(params[10]),
            lease_token: (params[11] as string | null) ?? null,
            control_id: (params[12] as string | null) ?? null,
          };
          intents.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_intents WHERE workspace_id = $1 AND id = $2")) {
          const row = intents.get(`${params[0]}\0${params[1]}`);
          return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_controls WHERE workspace_id = $1 ORDER BY")) {
          const rows = [...controls.values()].filter((row) => row.workspace_id === params[0]);
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_intents WHERE workspace_id = $1 ORDER BY")) {
          const rows = [...intents.values()].filter((row) => row.workspace_id === params[0]);
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_controls ORDER BY")) {
          const rows = [...controls.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_intents ORDER BY")) {
          const rows = [...intents.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };

    const repo = createPgGovernanceRepository(mock);
    await repo.saveControl({
      id: "c-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    const loaded = await repo.loadControl("ws-1", "c-1");
    expect(loaded?.status).toBe("PENDING");
    expect(loaded?.actionType).toBe("CUSTOMER_SEND");

    await repo.saveIntent({
      id: "i-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "INTERNAL_REVERSIBLE_UPDATE",
      status: "QUEUED",
      idempotencyKey: "k",
      leaseEpoch: 0,
    });
    const intent = await repo.loadIntent("ws-1", "i-1");
    expect(intent?.status).toBe("QUEUED");
  });

  it("listAllControls/listAllIntents read across every workspace via the admin/hydrate path", async () => {
    const controls = new Map<string, Record<string, unknown>>();
    const intents = new Map<string, Record<string, unknown>>();
    const mock: GovernancePgQueryable = {
      async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql.startsWith("INSERT INTO orch_governance_controls")) {
          const row = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            action_type: String(params[2]),
            kind: params[3],
            resource_id: String(params[4]),
            resource_version: Number(params[5]),
            payload_hash: String(params[6]),
            policy_version: Number(params[7]),
            requester_principal_id: String(params[8]),
            decided_by_principal_id: (params[9] as string | null) ?? null,
            status: String(params[10]),
          };
          controls.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO orch_governance_intents")) {
          const row = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            action_type: String(params[2]),
            status: String(params[3]),
            idempotency_key: String(params[4]),
            resource_id: String(params[5]),
            resource_version: Number(params[6]),
            payload_hash: String(params[7]),
            policy_version: Number(params[8]),
            lease_deadline: (params[9] as string | null) ?? null,
            lease_epoch: Number(params[10]),
            lease_token: (params[11] as string | null) ?? null,
            control_id: (params[12] as string | null) ?? null,
          };
          intents.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_controls ORDER BY")) {
          const rows = [...controls.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_intents ORDER BY")) {
          const rows = [...intents.values()];
          return { rows: rows as T[], rowCount: rows.length };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };

    const repo = createPgGovernanceRepository(mock);
    await repo.saveControl({
      id: "c-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    await repo.saveControl({
      id: "c-2",
      workspaceId: "ws-2",
      resourceId: "r-2",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    await repo.saveIntent({
      id: "i-1",
      workspaceId: "ws-2",
      resourceId: "r-2",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "INTERNAL_REVERSIBLE_UPDATE",
      status: "QUEUED",
      idempotencyKey: "k",
      leaseEpoch: 0,
    });

    const allControls = await repo.listAllControls();
    expect(allControls.map((c) => c.id).sort()).toEqual(["c-1", "c-2"]);
    const allIntents = await repo.listAllIntents();
    expect(allIntents.map((i) => i.id)).toEqual(["i-1"]);
  });
});

describe("GOV-PG-04 getControlsForWorkspace/getIntentsForWorkspace scoped read", () => {
  it("InMemoryGovernanceRepository: scoped getters mirror listControls/listIntents", async () => {
    const repo = new InMemoryGovernanceRepository();
    await repo.saveControl({
      id: "c-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    await repo.saveControl({
      id: "c-2",
      workspaceId: "ws-2",
      resourceId: "r-2",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    const ws1Controls = await repo.getControlsForWorkspace("ws-1");
    expect(ws1Controls.map((c) => c.id)).toEqual(["c-1"]);
    const ws2Controls = await repo.getControlsForWorkspace("ws-2");
    expect(ws2Controls.map((c) => c.id)).toEqual(["c-2"]);

    await repo.saveIntent({
      id: "i-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "INTERNAL_REVERSIBLE_UPDATE",
      status: "QUEUED",
      idempotencyKey: "k",
      leaseEpoch: 0,
    });
    const ws1Intents = await repo.getIntentsForWorkspace("ws-1");
    expect(ws1Intents.map((i) => i.id)).toEqual(["i-1"]);
    expect(await repo.getIntentsForWorkspace("ws-2")).toEqual([]);
  });

  it("PgGovernanceRepository: getControlsForWorkspace/getIntentsForWorkspace run the same scoped SELECT as list*", async () => {
    const controls = new Map<string, Record<string, unknown>>();
    const mock: GovernancePgQueryable = {
      async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
        const sql = text.replace(/\s+/g, " ").trim();
        if (sql.startsWith("INSERT INTO orch_governance_controls")) {
          const row = {
            id: String(params[0]),
            workspace_id: String(params[1]),
            action_type: String(params[2]),
            kind: params[3],
            resource_id: String(params[4]),
            resource_version: Number(params[5]),
            payload_hash: String(params[6]),
            policy_version: Number(params[7]),
            requester_principal_id: String(params[8]),
            decided_by_principal_id: (params[9] as string | null) ?? null,
            status: String(params[10]),
          };
          controls.set(`${row.workspace_id}\0${row.id}`, row);
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith("SELECT * FROM orch_governance_controls WHERE workspace_id = $1 ORDER BY")) {
          const rows = [...controls.values()].filter((row) => row.workspace_id === params[0]);
          return { rows: rows as T[], rowCount: rows.length };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const repo = createPgGovernanceRepository(mock);
    await repo.saveControl({
      id: "c-1",
      workspaceId: "ws-1",
      resourceId: "r-1",
      resourceVersion: 1,
      payloadHash: "h",
      policyVersion: 1,
      actionType: "CUSTOMER_SEND",
      kind: "APPROVAL",
      requesterPrincipalId: "ai",
      status: "PENDING",
    });
    const scoped = await repo.getControlsForWorkspace("ws-1");
    expect(scoped.map((c) => c.id)).toEqual(["c-1"]);
  });
});

describe("GOV-PG-05 appendAuditEvents / getAuditChainHead (N-08 D3 audit dual-write)", () => {
  it("InMemoryGovernanceRepository: allocates a contiguous chain-head sequence independent per workspace", async () => {
    const repo = new InMemoryGovernanceRepository();
    expect(await repo.getAuditChainHead("ws-1")).toBe(0);
    const first = await repo.appendAuditEvents("ws-1", [
      { kind: "CONTROL_REQUESTED", subjectId: "control-1", data: { a: 1 } },
      { kind: "CONTROL_APPROVED", subjectId: "control-1", data: { a: 2 } },
    ]);
    expect(first.map((e) => e.sequence)).toEqual([1, 2]);
    expect(first[0]!.eventHash).not.toBe(first[1]!.eventHash);
    expect(await repo.getAuditChainHead("ws-1")).toBe(2);

    // Second call continues the SAME workspace chain (no reset to 1).
    const second = await repo.appendAuditEvents("ws-1", [
      { kind: "CONTROL_CONSUMED", subjectId: "control-1", data: {} },
    ]);
    expect(second[0]!.sequence).toBe(3);

    // Independent workspace starts its own chain at 1.
    const otherWs = await repo.appendAuditEvents("ws-2", [{ kind: "CONTROL_REQUESTED", subjectId: "c", data: {} }]);
    expect(otherWs[0]!.sequence).toBe(1);

    expect(await repo.appendAuditEvents("ws-1", [])).toEqual([]);
  });

  it("PgGovernanceRepository: locks audit_chain_heads FOR UPDATE, inserts audit_events + outbox_events, advances the head", async () => {
    const heads = new Map<string, { head_sequence: number; head_event_hash: string | null }>();
    const auditRows: Array<Record<string, unknown>> = [];
    const outboxRows: Array<Record<string, unknown>> = [];
    let auditIdSeq = 0;
    let scopedWorkspace: string | undefined;

    const mock: GovernancePgQueryable = {
      async query() {
        throw new Error("unscoped query() must not be used for appendAuditEvents");
      },
      async withWorkspaceScope<T>(workspaceId: string, fn: (scoped: GovernancePgQueryable) => Promise<T>): Promise<T> {
        scopedWorkspace = workspaceId;
        const scoped: GovernancePgQueryable = {
          async query<T2 = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T2[]; rowCount: number | null }> {
            const sql = text.replace(/\s+/g, " ").trim();
            if (sql.startsWith("INSERT INTO audit_chain_heads")) {
              const ws = String(params[0]);
              if (!heads.has(ws)) heads.set(ws, { head_sequence: 0, head_event_hash: null });
              return { rows: [] as T2[], rowCount: 1 };
            }
            if (sql.startsWith("SELECT head_sequence, head_event_hash FROM audit_chain_heads WHERE workspace_id = $1 FOR UPDATE")) {
              const head = heads.get(String(params[0]))!;
              return { rows: [head] as T2[], rowCount: 1 };
            }
            if (sql.startsWith("SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1")) {
              const head = heads.get(String(params[0]));
              return { rows: (head ? [{ head_sequence: head.head_sequence }] : []) as T2[], rowCount: head ? 1 : 0 };
            }
            if (sql.startsWith("INSERT INTO audit_events")) {
              const id = `audit-${++auditIdSeq}`;
              auditRows.push({
                id,
                workspace_id: params[0],
                sequence: params[1],
                event_type: params[2],
                payload: params[3],
                previous_event_hash: params[4],
                event_hash: params[5],
                correlation_id: params[6],
              });
              return { rows: [{ id }] as T2[], rowCount: 1 };
            }
            if (sql.startsWith("INSERT INTO outbox_events")) {
              outboxRows.push({
                workspace_id: params[0],
                audit_event_id: params[1],
                event_type: params[2],
                partition_key: params[3],
                payload: params[4],
              });
              return { rows: [] as T2[], rowCount: 1 };
            }
            if (sql.startsWith("UPDATE audit_chain_heads SET head_sequence")) {
              const ws = String(params[0]);
              heads.set(ws, { head_sequence: Number(params[1]), head_event_hash: String(params[3]) });
              return { rows: [] as T2[], rowCount: 1 };
            }
            throw new Error(`unexpected SQL: ${sql}`);
          },
        };
        return fn(scoped);
      },
    };

    const repo = createPgGovernanceRepository(mock);
    const results = await repo.appendAuditEvents("ws-1", [
      { kind: "CONTROL_REQUESTED", subjectId: "control-1", data: { actionType: "CUSTOMER_SEND" } },
      { kind: "CONTROL_APPROVED", subjectId: "control-1", data: {} },
    ]);
    expect(scopedWorkspace).toBe("ws-1");
    expect(results.map((r) => r.sequence)).toEqual([1, 2]);
    expect(auditRows).toHaveLength(2);
    expect(outboxRows).toHaveLength(2);
    expect(outboxRows.every((r) => r.workspace_id === "ws-1")).toBe(true);
    expect(auditRows[0]!.previous_event_hash).toMatch(/^0{64}$/);
    expect(auditRows[1]!.previous_event_hash).toBe(results[0]!.eventHash);
    expect(await repo.getAuditChainHead("ws-1")).toBe(2);

    // Second batch continues the same head (no reset).
    const more = await repo.appendAuditEvents("ws-1", [{ kind: "CONTROL_CONSUMED", subjectId: "control-1", data: {} }]);
    expect(more[0]!.sequence).toBe(3);

    expect(await repo.appendAuditEvents("ws-1", [])).toEqual([]);
  });
});