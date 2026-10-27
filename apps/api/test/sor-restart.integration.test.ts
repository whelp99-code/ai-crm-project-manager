import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import type { FinancePackConfig } from "@ai-crm/finance";
import { createApp, type CreateAppOptions } from "../src/app.js";

/**
 * G-01 restart-consistent SoR: hydrate-on-boot.
 *
 * Builds a tiny shared fake Postgres pool (in-memory Maps keyed by row
 * identity, routed by SQL text — same shape as the orchestration/governance
 * package unit-test mocks) and injects the SAME pool instance into two
 * independently constructed `createApp` instances, simulating a process
 * restart: instance A persists via dual-write on mutation; instance B is a
 * freshly booted process that must hydrate its in-memory SoR from the shared
 * pool before serving reads.
 */

interface FakePgRow {
  [key: string]: unknown;
}

function createSharedFakePool() {
  const orchJobs = new Map<string, FakePgRow>();
  const orchWorkItems = new Map<string, FakePgRow[]>();
  const orchJobEvents = new Map<string, FakePgRow[]>();
  const govControls = new Map<string, Record<string, unknown>>();
  const govIntents = new Map<string, Record<string, unknown>>();
  const auditChainHeads = new Map<string, { head_sequence: number; head_event_hash: string | null }>();
  const auditEvents = new Map<string, Record<string, unknown>>();
  const crmCustomers = new Map<string, Record<string, unknown>>();
  const dailyGateStates = new Map<string, FakePgRow>();
  const dailyGateDayRecords: FakePgRow[] = [];
  const dailyGateVersionTransitions: FakePgRow[] = [];
  let auditEventSeq = 0;

  async function query<T = unknown>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (/^select 1/i.test(sql)) {
      return { rows: [{ ok: 1 }] as unknown as T[], rowCount: 1 };
    }

    // --- orchestration: orch_jobs / orch_work_items / orch_job_events ---
    if (sql.startsWith("INSERT INTO orch_jobs")) {
      const row: FakePgRow = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        source: String(params[2]),
        raw_text: (params[3] as string | null) ?? null,
        plan_invocation_id: (params[4] as string | null) ?? null,
        status: String(params[5]),
        created_by_principal_id: String(params[6]),
        idempotency_key: (params[7] as string | null) ?? null,
        created_at: String(params[8]),
        updated_at: String(params[9]),
      };
      orchJobs.set(`${row.workspace_id}\0${row.id}`, row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM orch_work_items")) {
      orchWorkItems.set(`${params[0]}\0${params[1]}`, []);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO orch_work_items")) {
      const key = `${params[2]}\0${params[1]}`;
      const list = orchWorkItems.get(key) ?? [];
      list.push({
        id: String(params[0]),
        job_id: String(params[1]),
        workspace_id: String(params[2]),
        sequence: Number(params[3]),
        title: String(params[4]),
        status: String(params[5]),
        suggested_command: (params[6] as string | null) ?? null,
        action_type: (params[7] as string | null) ?? null,
        assigned_principal_id: (params[8] as string | null) ?? null,
        control_id: (params[9] as string | null) ?? null,
        intent_id: (params[10] as string | null) ?? null,
        resource_type: (params[11] as string | null) ?? null,
        resource_id: (params[12] as string | null) ?? null,
        resource_version: (params[13] as number | null) ?? null,
        progress: Number(params[14] ?? 0),
        error_code: (params[15] as string | null) ?? null,
        result_ref: params[16] == null ? null : JSON.parse(String(params[16])),
        created_at: String(params[17]),
        updated_at: String(params[18]),
      });
      orchWorkItems.set(key, list);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM orch_job_events")) {
      orchJobEvents.set(`${params[0]}\0${params[1]}`, []);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO orch_job_events")) {
      const key = `${params[2]}\0${params[1]}`;
      const list = orchJobEvents.get(key) ?? [];
      list.push({
        id: String(params[0]),
        job_id: String(params[1]),
        workspace_id: String(params[2]),
        kind: String(params[3]),
        payload: JSON.parse(String(params[4])),
        at: String(params[5]),
      });
      orchJobEvents.set(key, list);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 AND id = $2")) {
      const row = orchJobs.get(`${params[0]}\0${params[1]}`);
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 AND idempotency_key = $2")) {
      const row = [...orchJobs.values()].find(
        (j) => j.workspace_id === params[0] && j.idempotency_key === params[1],
      );
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM orch_jobs WHERE workspace_id = $1 ORDER BY")) {
      const rows = [...orchJobs.values()].filter((j) => j.workspace_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM orch_jobs ORDER BY")) {
      const rows = [...orchJobs.values()];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM orch_work_items")) {
      const list = orchWorkItems.get(`${params[0]}\0${params[1]}`) ?? [];
      return { rows: list as T[], rowCount: list.length };
    }
    if (sql.startsWith("SELECT * FROM orch_job_events")) {
      const list = orchJobEvents.get(`${params[0]}\0${params[1]}`) ?? [];
      return { rows: list as T[], rowCount: list.length };
    }

    // --- governance: orch_governance_controls / orch_governance_intents (0004) ---
    if (sql.startsWith("INSERT INTO orch_governance_controls")) {
      const row: FakePgRow = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        action_type: String(params[2]),
        kind: params[3] as string,
        resource_id: String(params[4]),
        resource_version: Number(params[5]),
        payload_hash: String(params[6]),
        policy_version: Number(params[7]),
        trusted_context_hash: (params[8] as string | null) ?? null,
        requester_principal_id: String(params[9]),
        decided_by_principal_id: (params[10] as string | null) ?? null,
        status: String(params[11]),
      };
      govControls.set(`${row.workspace_id}\0${row.id}`, row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_controls WHERE workspace_id = $1 AND id = $2")) {
      const row = govControls.get(`${params[0]}\0${params[1]}`);
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO orch_governance_intents")) {
      const row: FakePgRow = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        action_type: String(params[2]),
        status: String(params[3]),
        idempotency_key: String(params[4]),
        resource_id: String(params[5]),
        resource_version: Number(params[6]),
        payload_hash: String(params[7]),
        policy_version: Number(params[8]),
        trusted_context_hash: (params[9] as string | null) ?? null,
        lease_deadline: (params[10] as string | null) ?? null,
        lease_epoch: Number(params[11]),
        lease_token: (params[12] as string | null) ?? null,
        control_id: (params[13] as string | null) ?? null,
      };
      govIntents.set(`${row.workspace_id}\0${row.id}`, row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_intents WHERE workspace_id = $1 AND id = $2")) {
      const row = govIntents.get(`${params[0]}\0${params[1]}`);
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_controls ORDER BY")) {
      const rows = [...govControls.values()];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_intents ORDER BY")) {
      const rows = [...govIntents.values()];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_controls WHERE workspace_id = $1 ORDER BY")) {
      const rows = [...govControls.values()].filter((d) => d.workspace_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM orch_governance_intents WHERE workspace_id = $1 ORDER BY")) {
      const rows = [...govIntents.values()].filter((d) => d.workspace_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    // --- audit chain: audit_chain_heads / audit_events / outbox_events (N-08 / D3) ---
    if (sql.startsWith("INSERT INTO audit_chain_heads")) {
      const ws = String(params[0]);
      if (!auditChainHeads.has(ws)) auditChainHeads.set(ws, { head_sequence: 0, head_event_hash: null });
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT head_sequence, head_event_hash FROM audit_chain_heads WHERE workspace_id = $1 FOR UPDATE")) {
      const head = auditChainHeads.get(String(params[0])) ?? { head_sequence: 0, head_event_hash: null };
      return { rows: [head] as unknown as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT head_sequence FROM audit_chain_heads WHERE workspace_id = $1")) {
      const head = auditChainHeads.get(String(params[0]));
      return { rows: (head ? [{ head_sequence: head.head_sequence }] : []) as unknown as T[], rowCount: head ? 1 : 0 };
    }
    if (sql.startsWith("UPDATE audit_chain_heads SET head_sequence")) {
      const ws = String(params[0]);
      auditChainHeads.set(ws, { head_sequence: Number(params[1]), head_event_hash: String(params[3]) });
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO audit_events")) {
      const id = `audit-fake-${++auditEventSeq}`;
      auditEvents.set(id, {
        id,
        workspace_id: params[0],
        sequence: params[1],
        event_type: params[2],
        payload: params[3],
        previous_event_hash: params[4],
        event_hash: params[5],
        correlation_id: params[6],
      });
      return { rows: [{ id }] as unknown as T[], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO outbox_events")) {
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, sequence, event_type, payload, previous_event_hash, event_hash FROM audit_events WHERE workspace_id = $1 ORDER BY sequence ASC")) {
      const rows = [...auditEvents.values()]
        .filter((row) => row.workspace_id === params[0])
        .sort((a, b) => Number(a.sequence) - Number(b.sequence));
      return { rows: rows as T[], rowCount: rows.length };
    }

    // --- CRM: crm_customers (N-12 / D2) ---
    if (sql.startsWith("INSERT INTO crm_customers")) {
      const row: FakePgRow = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        name: String(params[2]),
        status: String(params[3]),
        version: Number(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
      };
      crmCustomers.set(`${row.workspace_id}\0${row.id}`, row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM crm_customers WHERE workspace_id = $1 ORDER BY")) {
      const rows = [...crmCustomers.values()].filter((d) => d.workspace_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM crm_customers ORDER BY")) {
      const rows = [...crmCustomers.values()];
      return { rows: rows as T[], rowCount: rows.length };
    }

    if (sql.startsWith("INSERT INTO finance_daily_gate_state")) {
      const workspaceId = String(params[0]);
      const prior = dailyGateStates.get(workspaceId);
      dailyGateStates.set(workspaceId, {
        workspace_id: workspaceId, streak: Number(params[1]), tier: String(params[2]),
        last_date_epoch: params[3] as string | number | null, activated_matrix_version: params[4] as string | number | null,
        pack_version: params[5] as string | number | null, version: Number(prior?.version ?? 0) + 1,
      });
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO finance_day_records")) {
      dailyGateDayRecords.push({ workspace_id: params[0], date: params[1], qualifying: params[2], reason: params[3], streak_after: params[4], tier_after: params[5] });
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql === "SELECT * FROM finance_daily_gate_state") {
      const rows = [...dailyGateStates.values()];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith("SELECT * FROM finance_daily_gate_state WHERE workspace_id = $1")) {
      const row = dailyGateStates.get(String(params[0]));
      return { rows: (row ? [row] : []) as T[], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("SELECT business_date,controller_principal_id,evidence_id,evidence_hash")) {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql.startsWith("SELECT business_date,evidence_hash,cfo_principal_id,approval_id")) {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO finance_daily_gate_version_transitions")) {
      dailyGateVersionTransitions.push({ workspace_id: params[0], reason: params[1], from_pack_version: params[2], to_pack_version: params[3] });
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT * FROM finance_day_records ORDER BY")) {
      return { rows: dailyGateDayRecords as T[], rowCount: dailyGateDayRecords.length };
    }

    // --- P6-b G001 (PG-A/B/C1/C2): this fake pool does not seed any rows for
    // the new sub-aggregate/PM/delivery/finance-recon/daily-gate tables, but
    // hydrate-on-boot still issues cross-workspace listAll* reads against them
    // once a pool is present (repo construction is unconditional on `pool`).
    // Empty-result stubs keep this restart-consistency test scoped to its own
    // orch_jobs/governance/crm_customers assertions.
    if (
      sql.startsWith("SELECT * FROM crm_contracts ORDER BY") ||
      sql.startsWith("SELECT * FROM crm_communications ORDER BY") ||
      sql.startsWith("SELECT * FROM crm_next_actions ORDER BY") ||
      sql.startsWith("SELECT * FROM crm_operational_exceptions ORDER BY") ||
      sql.startsWith("SELECT * FROM pm_plans ORDER BY") ||
      sql.startsWith("SELECT * FROM pm_assignments ORDER BY") ||
      sql.startsWith("SELECT * FROM pm_targets ORDER BY") ||
      sql.startsWith("SELECT * FROM pm_target_observations ORDER BY") ||
      sql.startsWith("SELECT * FROM pm_variance_exceptions ORDER BY") ||
      sql.startsWith("SELECT * FROM delivery_projects ORDER BY") ||
      sql.startsWith("SELECT * FROM finance_reconciliations ORDER BY") ||
      sql.startsWith("SELECT * FROM finance_exceptions ORDER BY") ||
      sql.startsWith("SELECT * FROM finance_journal_entries ORDER BY") ||
      // Q2 (D2): reports hydrate-on-boot is unconditional on `pool` (like the
      // sub-aggregate tables above), not gated on any of orch/gov/crm.
      sql.startsWith("SELECT * FROM report_snapshots ORDER BY")
    ) {
      return { rows: [] as T[], rowCount: 0 };
    }

    throw new Error(`unexpected SQL in shared fake pool: ${sql}`);
  }

  return {
    query,
    seedDailyGateState(row: FakePgRow) { dailyGateStates.set(String(row.workspace_id), row); },
    dailyGateVersionTransitions,
  };
}

function planClient(steps: Array<Record<string, unknown>>): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: steps.map((step) => {
            const {
              suggestedCommand,
              title = "step",
              resourceType = "",
              resourceId = "",
              resourceVersion = 1,
              payload = {},
            } = step;
            return {
              suggestedCommand,
              title,
              resourceType,
              resourceId,
              resourceVersion,
              payloadJson: JSON.stringify(payload ?? {}),
            };
          }),
        },
        modelVersion: "test-plan",
        retentionHonored: true,
      };
    },
  };
}

const WS = "ws-restart";
const OPERATOR = "operator-restart";
const FINANCE_PACK: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [{ code: "1000", name: "Cash", type: "asset" }], decimalScale: 0,
  dayCloseCutoff: "18:00", cutoffBoundary: "inclusive", reconciliationToleranceKrw: "0", requiredConsecutiveDays: 1,
};

function headers(extra: Record<string, string> = {}) {
  return {
    "x-workspace-id": WS,
    "x-principal-id": OPERATOR,
    ...extra,
  };
}

const apps: FastifyInstance[] = [];
async function bootApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const instance = createApp(options);
  apps.push(instance);
  await instance.ready();
  return instance;
}

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

describe("G-01 SoR restart-consistency: hydrate-on-boot", () => {
  it("a freshly booted instance (simulated restart) sees jobs + governance controls persisted by a prior instance through the same pool", async () => {
    const pgPool = createSharedFakePool();

    // Instance A: the "pre-restart" process. Creates a plan + an agent
    // command that produces a job (with a work item) and, because
    // pm.task_assign is CHECKPOINT-governed, a control.
    const instanceA = await bootApp({
      pgPool,
      modelClient: planClient([
        {
          suggestedCommand: "pm.task_assign",
          title: "Assign task",
          resourceId: "task-restart-1",
          resourceVersion: 1,
          payload: {
            projectId: "proj-restart",
            planId: "plan-restart",
            taskId: "task-restart-1",
            assigneePrincipalId: "worker-restart",
          },
        },
      ]),
    });

    await instanceA.inject({
      method: "POST",
      url: "/api/pm/plans",
      headers: { "x-workspace-id": WS },
      payload: {
        id: "plan-restart",
        projectId: "proj-restart",
        objective: "restart survival",
        taskIds: ["task-restart-1"],
        createdByPrincipalId: OPERATOR,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const created = await instanceA.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-restart-1" }),
      payload: { text: "assign task across restart" },
    });
    expect(created.statusCode).toBe(202);
    const { jobId } = created.json() as { jobId: string };

    const beforeRestart = await instanceA.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: { "x-workspace-id": WS },
    });
    expect(beforeRestart.statusCode).toBe(200);
    const beforeSnapshot = beforeRestart.json() as {
      job: { id: string; status: string };
      workItems: Array<{ id: string; controlId?: string; suggestedCommand?: string }>;
    };
    expect(beforeSnapshot.job.id).toBe(jobId);
    const controlId = beforeSnapshot.workItems[0]?.controlId;
    expect(controlId).toBeTruthy();

    const controlsBefore = await instanceA.inject({
      method: "GET",
      url: "/api/governance/controls",
      headers: { "x-workspace-id": WS },
    });
    expect((controlsBefore.json() as Array<{ id: string }>).some((c) => c.id === controlId)).toBe(true);

    // --- Simulate restart: construct instance B fresh, sharing the SAME pool. ---
    const instanceB = await bootApp({ pgPool });

    const afterRestart = await instanceB.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: { "x-workspace-id": WS },
    });
    expect(afterRestart.statusCode).toBe(200);
    const afterSnapshot = afterRestart.json() as {
      job: { id: string; status: string };
      workItems: Array<{ id: string; controlId?: string }>;
    };
    expect(afterSnapshot.job.id).toBe(jobId);
    expect(afterSnapshot.workItems).toHaveLength(beforeSnapshot.workItems.length);
    expect(afterSnapshot.workItems[0]?.id).toBe(beforeSnapshot.workItems[0]?.id);

    const controlsAfter = await instanceB.inject({
      method: "GET",
      url: "/api/governance/controls",
      headers: { "x-workspace-id": WS },
    });
    expect(controlsAfter.statusCode).toBe(200);
    expect((controlsAfter.json() as Array<{ id: string }>).some((c) => c.id === controlId)).toBe(true);
  });

  it("memory-mode instances (no pool) do NOT share state across independent constructions", async () => {
    const instanceA = await bootApp({
      modelClient: planClient([{ suggestedCommand: "internal.update" }]),
    });
    const created = await instanceA.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: headers({ "idempotency-key": "idem-memory-only" }),
      payload: { text: "memory mode only" },
    });
    expect(created.statusCode).toBe(202);
    const { jobId } = created.json() as { jobId: string };

    const instanceB = await bootApp({});
    const lookup = await instanceB.inject({
      method: "GET",
      url: `/api/agent/jobs/${jobId}`,
      headers: { "x-workspace-id": WS },
    });
    expect(lookup.statusCode).toBe(404);

    const runtimeA = (instanceA as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm;
    const runtimeB = (instanceB as FastifyInstance & { aiCrm?: { persistenceMode: string } }).aiCrm;
    expect(runtimeA?.persistenceMode).toBe("memory");
    expect(runtimeB?.persistenceMode).toBe("memory");
  });

  it("fresh app restart preserves same-version risk state, but audits one conservative reset for missing or mismatched pack versions", async () => {
    const samePool = createSharedFakePool();
    samePool.seedDailyGateState({
      workspace_id: WS, streak: 1, tier: "risk_tiered", last_date_epoch: 20_000,
      activated_matrix_version: 7, pack_version: 1, version: 1,
    });
    const sameRestart = await bootApp({ pgPool: samePool, financePack: FINANCE_PACK });
    expect((await sameRestart.inject({ method: "GET", url: "/api/finance/daily-gate", headers: headers() })).json()).toEqual({ streak: 1, tier: "risk_tiered", policyVersion: 1 });
    expect(samePool.dailyGateVersionTransitions).toHaveLength(0);

    for (const [name, packVersion, reason] of [["missing", null, "persisted_pack_version_missing"], ["mismatch", 2, "pack_version_mismatch"]] as const) {
      const driftPool = createSharedFakePool();
      driftPool.seedDailyGateState({ workspace_id: WS, streak: 9, tier: "risk_tiered", last_date_epoch: 20_000, activated_matrix_version: 7, pack_version: packVersion, version: 1 });
      const driftRestart = await bootApp({ pgPool: driftPool, financePack: FINANCE_PACK });
      expect((await driftRestart.inject({ method: "GET", url: "/api/finance/daily-gate", headers: headers() })).json(), name).toEqual({ streak: 0, tier: "conservative", policyVersion: 1 });
      expect(driftPool.dailyGateVersionTransitions).toEqual([expect.objectContaining({ reason, from_pack_version: packVersion, to_pack_version: 1 })]);
      await bootApp({ pgPool: driftPool, financePack: FINANCE_PACK });
      expect(driftPool.dailyGateVersionTransitions, `${name} reset is audited once`).toHaveLength(1);
    }
  });
});
