import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type DailyGateControlPlane } from "../src/app.js";
import type { FinancePackConfig } from "@ai-crm/finance";
import type { FastifyInstance } from "fastify";

const LIVE = process.env.LIVE_PG_TEST === "1" && Boolean(process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const WS_A = "10000000-0000-4000-8000-000000000001";
const WS_B = "10000000-0000-4000-8000-000000000002";
const CONTROLLER = "20000000-0000-4000-8000-000000000001";
const CFO = "20000000-0000-4000-8000-000000000002";
const USER_CONTROLLER = "30000000-0000-4000-8000-000000000001";
const USER_CFO = "30000000-0000-4000-8000-000000000002";
const pack: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [{ code: "1000", name: "Cash", type: "asset" }],
  decimalScale: 0,
  dayCloseCutoff: "18:00",
  cutoffBoundary: "inclusive",
  reconciliationToleranceKrw: "0",
  requiredConsecutiveDays: 1,
};

type Mode = "valid" | "wrong-role" | "cross-workspace" | "stale-evidence" | "inactive-matrix" | "self-approval" | "stale-approval";
let mode: Mode = "valid";
let app: FastifyInstance | undefined;

function controlPlane(): DailyGateControlPlane {
  return {
    async dayFacts({ workspaceId, date }) {
      return {
        actor: {
          id: CONTROLLER,
          workspaceId: mode === "cross-workspace" ? WS_B : workspaceId,
          role: mode === "wrong-role" ? "CFO" : "CONTROLLER",
          kind: "HUMAN" as const,
          active: true,
        },
        metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 },
        receivedAt: `${date}T17:00:00+09:00`,
        provenance: {
          refs: ["import-batch:live-1", "ledger-close:live-1"],
          digests: ["a".repeat(64), "b".repeat(64)],
          observedAt: `${date}T16:55:00+09:00`,
          expiresAt: mode === "stale-evidence" ? `${date}T17:00:00+09:00` : `${date}T18:00:00+09:00`,
        },
        matrixVersion: 1,
        matrixActive: mode !== "inactive-matrix",
        policyVersion: 1,
        packVersion: 1,
        evidenceId: `live-evidence-${date}`,
        evidenceSecret: "live-test-server-secret",
      };
    },
    async activationFacts({ workspaceId }) {
      return {
        actor: {
          id: mode === "self-approval" ? CONTROLLER : CFO,
          workspaceId,
          role: "CFO",
          kind: "HUMAN" as const,
          active: true,
        },
        matrixVersion: 1,
        matrixActive: true,
        policyVersion: 1,
        packVersion: 1,
        approvalId: "live-approval-1",
        approvedAt: "2026-01-01T17:00:00+09:00",
        expiresAt: mode === "stale-approval" ? "2026-01-01T17:15:00+09:00" : "2026-01-01T20:00:00+09:00",
        evidenceSecret: "live-test-server-secret",
      };
    },
    now: () => new Date("2026-01-01T17:30:00+09:00"),
  };
}

async function boot(): Promise<FastifyInstance> {
  const instance = createApp({ databaseUrl: DATABASE_URL, financePack: pack, dailyGateControlPlane: controlPlane(), pgNotify: false });
  await instance.ready();
  return instance;
}

describe.skipIf(!LIVE)("daily-gate governance against real PostgreSQL", () => {
  beforeAll(async () => {
    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO workspaces (id, name) VALUES ($1,'issue6-a'),($2,'issue6-b') ON CONFLICT (id) DO NOTHING`,
        [WS_A, WS_B],
      );
      await client.query(
        `INSERT INTO users (id, workspace_id, email, display_name, role) VALUES
          ($1,$3,'controller-issue6@example.invalid','Controller','CONTROLLER'),
          ($2,$3,'cfo-issue6@example.invalid','CFO','CFO')
         ON CONFLICT (id) DO NOTHING`,
        [USER_CONTROLLER, USER_CFO, WS_A],
      );
      await client.query(
        `INSERT INTO principals (id, workspace_id, kind, user_id, role, display_name) VALUES
          ($1,$3,'HUMAN',$4,'CONTROLLER','Controller'),
          ($2,$3,'HUMAN',$5,'CFO','CFO')
         ON CONFLICT (id) DO NOTHING`,
        [CONTROLLER, CFO, WS_A, USER_CONTROLLER, USER_CFO],
      );
    } finally {
      await client.end();
    }
    app = await boot();
  });

  afterAll(async () => { await app?.close(); });

  it("rejects unauthorized, forged, cross-workspace, stale, inactive, self-approved and replayed requests; persists the valid public-API path atomically", async () => {
    const headers = { "x-workspace-id": WS_A };
    const dayUrl = "/api/finance/daily-gate/days";
    const activationUrl = "/api/finance/daily-gate/activate-risk-tier";
    const status = async () => (await app!.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json() as { streak: number; tier: string };

    expect((await app!.inject({ method: "POST", url: dayUrl, headers, payload: { date: "2026-01-01", importsCompleted: true } })).json()).toMatchObject({ error: "INVALID_INPUT" });
    for (const rejectedMode of ["wrong-role", "cross-workspace", "stale-evidence", "inactive-matrix"] as const) {
      mode = rejectedMode;
      const response = await app!.inject({ method: "POST", url: dayUrl, headers, payload: { date: "2026-01-01" } });
      expect(response.statusCode, rejectedMode).toBe(400);
      expect(await status(), rejectedMode).toMatchObject({ streak: 0, tier: "conservative" });
    }

    mode = "valid";
    expect((await app!.inject({ method: "POST", url: dayUrl, headers, payload: { date: "2026-01-01" } })).statusCode).toBe(201);
    expect(await status()).toMatchObject({ streak: 1, tier: "eligible" });
    const eligibleAuthorize = await app!.inject({
      method: "POST", url: "/api/governance/authorize", headers,
      payload: { command: "finance.verify", resourceId: "finance-live-eligible", resourceVersion: 1, payload: { amount: "10" }, requesterPrincipalId: "operator", tier: "risk_tiered", evidenceHash: "forged" },
    });
    expect(eligibleAuthorize.statusCode).toBe(201);
    const eligibleBody = eligibleAuthorize.json() as { requiredControl: string; control: { id: string; payloadHash: string; policyVersion: number; trustedContextHash: string } };
    expect(eligibleBody).toMatchObject({ requiredControl: "CHECKPOINT", control: { trustedContextHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await app!.inject({ method: "POST", url: `/api/governance/controls/${eligibleBody.control.id}/decide`, headers, payload: { principalId: "independent-controller", decision: "APPROVE" } })).statusCode).toBe(200);
    expect((await app!.inject({ method: "POST", url: dayUrl, headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_REPLAY" });
    expect((await app!.inject({ method: "POST", url: activationUrl, headers, payload: { date: "2026-01-01", approvedMatrixVersion: 7 } })).json()).toMatchObject({ error: "INVALID_INPUT" });

    for (const rejectedMode of ["self-approval", "stale-approval"] as const) {
      mode = rejectedMode;
      expect((await app!.inject({ method: "POST", url: activationUrl, headers, payload: { date: "2026-01-01" } })).json(), rejectedMode).toMatchObject({ error: "DAILY_GATE_INVALID_APPROVAL" });
      expect(await status(), rejectedMode).toMatchObject({ streak: 1, tier: "eligible" });
    }

    mode = "valid";
    expect((await app!.inject({ method: "POST", url: activationUrl, headers, payload: { date: "2026-01-01" } })).statusCode).toBe(200);
    expect(await status()).toMatchObject({ streak: 1, tier: "risk_tiered" });
    const riskAuthorize = await app!.inject({
      method: "POST", url: "/api/governance/authorize", headers,
      payload: { command: "finance.verify", resourceId: "finance-live-risk", resourceVersion: 1, payload: {}, requesterPrincipalId: "operator", tier: "conservative", matrixVersion: 999 },
    });
    expect(riskAuthorize.statusCode).toBe(201);
    expect(riskAuthorize.json()).toMatchObject({ requiredControl: "ALLOW", intent: { trustedContextHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((await app!.inject({ method: "POST", url: activationUrl, headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_REPLAY" });

    const { Client } = (await import("pg")) as typeof import("pg");
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const evidence = await client.query(`SELECT metrics, received_at, resulting_streak, resulting_tier, provenance, evidence_hash, evidence_signature FROM finance_daily_gate_evidence WHERE workspace_id=$1`, [WS_A]);
      expect(evidence.rows).toHaveLength(1);
      expect(evidence.rows[0]).toMatchObject({ metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, resulting_streak: 1, resulting_tier: "eligible" });
      expect(String(evidence.rows[0].evidence_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(evidence.rows[0].evidence_signature)).toMatch(/^[0-9a-f]{64}$/);
      const activations = await client.query(`SELECT cfo_principal_id, approval_hash, approval_signature FROM finance_daily_gate_activations WHERE workspace_id=$1`, [WS_A]);
      expect(activations.rows).toHaveLength(1);
      expect(activations.rows[0].cfo_principal_id).toBe(CFO);
      const audit = await client.query(`SELECT event_type FROM audit_events WHERE workspace_id=$1 AND event_type LIKE 'FINANCE_DAILY_GATE_%' ORDER BY sequence`, [WS_A]);
      expect(audit.rows.map((row) => row.event_type)).toEqual(["FINANCE_DAILY_GATE_EVIDENCE", "FINANCE_DAILY_GATE_ACTIVATION"]);
      const outbox = await client.query(`SELECT payload FROM outbox_events WHERE workspace_id=$1 AND event_type LIKE 'FINANCE_DAILY_GATE_%' ORDER BY created_at, id`, [WS_A]);
      expect(outbox.rows).toHaveLength(2);
      expect(outbox.rows.every((row) => Object.keys(row.payload as Record<string, unknown>).sort().join(",") === "eventId,kind,workspaceId")).toBe(true);
      const governed = await client.query(`SELECT trusted_context_hash FROM orch_governance_controls WHERE workspace_id=$1 AND id=$2`, [WS_A, eligibleBody.control.id]);
      expect(governed.rows[0]?.trusted_context_hash).toMatch(/^[0-9a-f]{64}$/);
      const riskIntent = await client.query(`SELECT trusted_context_hash FROM orch_governance_intents WHERE workspace_id=$1 AND action_type='FINANCE_VERIFY' ORDER BY created_at DESC LIMIT 1`, [WS_A]);
      expect(riskIntent.rows[0]?.trusted_context_hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(client.query(`UPDATE finance_daily_gate_evidence SET resulting_streak=2 WHERE workspace_id=$1`, [WS_A])).rejects.toThrow(/immutable/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE ai_crm_runtime_api");
      await client.query(`SELECT set_config('app.workspace_id',$1,true)`, [WS_B]);
      const hidden = await client.query(`SELECT count(*)::int AS count FROM finance_daily_gate_evidence WHERE workspace_id=$1`, [WS_A]);
      expect(hidden.rows[0].count).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }

    await app!.close();
    app = await boot();
    expect(await status()).toMatchObject({ streak: 1, tier: "risk_tiered" });
    const staleConsume = await app.inject({
      method: "POST", url: `/api/governance/controls/${eligibleBody.control.id}/consume`, headers,
      payload: { resourceId: "finance-live-eligible", resourceVersion: 1, payloadHash: eligibleBody.control.payloadHash, policyVersion: eligibleBody.control.policyVersion },
    });
    expect(staleConsume.statusCode).toBe(409);
    expect(staleConsume.json()).toMatchObject({ error: "STALE_CONTROL_FINANCE_CONTEXT" });
    const auditVerify = await app.inject({ method: "GET", url: "/api/governance/audit/verify", headers });
    expect(auditVerify.statusCode).toBe(200);
    expect(auditVerify.json()).toMatchObject({ valid: true });
  }, 60_000);
});
