import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

import type { FinancePackConfig } from "@ai-crm/finance";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Test fixture only — real values come from the signed accounting pack. */
const fixturePack: FinancePackConfig = {
  packVersion: 1,
  chartOfAccounts: [
    { code: "1000", name: "현금", type: "asset", projectionRole: "cash" },
    { code: "1200", name: "매출채권", type: "asset", projectionRole: "receivable" },
    { code: "2100", name: "매입채무", type: "liability", projectionRole: "payable" },
    { code: "4000", name: "용역매출", type: "revenue" },
    { code: "5000", name: "외주비", type: "expense" },
  ],
  decimalScale: 0,
  dayCloseCutoff: "18:00",
  cutoffBoundary: "inclusive",
  reconciliationToleranceKrw: "0",
  requiredConsecutiveDays: 90,
};

const headers = { "x-workspace-id": "ws-1" };
const customer = { id: "customer-1", name: "Acme", status: "active", createdAt: "2026-01-01T00:00:00Z" };
const project = {
  id: "project-1",
  customerId: "customer-1",
  name: "Delivery",
  contractId: "contract-1",
  contractScope: "Approved scope",
  scheduleStart: "2026-01-01",
  scheduleEnd: "2026-03-31",
  deliverables: [{ id: "deliverable-1", title: "Final", required: true, status: "pending", requirementIds: ["req-1"] }],
  riskThreshold: 0.4,
  requirementIds: ["req-1"],
};

async function seed() {
  app = createApp();
  await app.ready();
  expect((await app.inject({ method: "POST", url: "/api/customers", headers, payload: customer })).statusCode).toBe(201);
}

/**
 * Runs the real governance control plane (authorize -> independent approve ->
 * consume) and returns the queued intent id the API dereferences server-side.
 * Tests never fabricate receipts; a protected effect requires this flow.
 */
async function governedIntent(
  command: string,
  resourceId: string,
  resourceVersion: number,
  payload: unknown,
  requester: string,
  approver: string,
): Promise<string> {
  const authorized = await app!.inject({
    method: "POST", url: "/api/governance/authorize", headers,
    payload: { command, resourceId, resourceVersion, payload, requesterPrincipalId: requester },
  });
  const control = authorized.json().control as { id: string; payloadHash: string; policyVersion: number };
  await app!.inject({
    method: "POST", url: `/api/governance/controls/${control.id}/decide`, headers,
    payload: { principalId: approver, decision: "APPROVE" },
  });
  const consumed = await app!.inject({
    method: "POST", url: `/api/governance/controls/${control.id}/consume`, headers,
    payload: { resourceId, resourceVersion, payloadHash: control.payloadHash, policyVersion: control.policyVersion },
  });
  return consumed.json().id as string;
}

describe("CRM and delivery API", () => {
  it("requires authoritative workspace headers", async () => {
    app = createApp();
    await app.ready();
    const response = await app.inject({ method: "POST", url: "/api/customers", payload: customer });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "WORKSPACE_REQUIRED" });
  });

  it("renders exception-first customer overview with honest pending finance", async () => {
    await seed();
    await app!.inject({
      method: "POST", url: "/api/customers/customer-1/exceptions", headers,
      payload: { id: "exception-1", title: "Delay", severity: "high", priority: 9, occurredAt: "2026-01-02T00:00:00Z" },
    });
    await app!.inject({
      method: "POST", url: "/api/customers/customer-1/next-actions", headers,
      payload: { id: "action-1", title: "Review", priority: 8, dueAt: "2026-01-03T00:00:00Z" },
    });
    expect((await app!.inject({ method: "POST", url: "/api/projects", headers, payload: project })).statusCode).toBe(201);
    const response = await app!.inject({ method: "GET", url: "/api/customers/customer-1/overview", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sectionOrder: ["exceptions", "nextActions", "status", "contracts", "projects", "communications", "finance"],
      exceptions: [{ id: "exception-1" }],
      nextActions: [{ id: "action-1" }],
      projects: [{ id: "project-1" }],
      finance: { status: "pending" },
    });
  });

  it("denies an unauthorized protected scope change and accepts a governance-consumed one", async () => {
    await seed();
    await app!.inject({ method: "POST", url: "/api/projects", headers, payload: project });

    // Without a consumed governance intent the protected change is refused.
    const denied = await app!.inject({
      method: "PATCH", url: "/api/projects/project-1/baseline", headers,
      payload: { expectedVersion: 1, patch: { contractScope: "New scope" } },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json()).toMatchObject({ error: "INVALID_INPUT" });

    // A forged/foreign intent id is rejected — the API dereferences governance state.
    const forged = await app!.inject({
      method: "PATCH", url: "/api/projects/project-1/baseline", headers,
      payload: { expectedVersion: 1, patch: { contractScope: "New scope" }, intentId: "intent-000999" },
    });
    expect(forged.statusCode).toBe(404);

    const intentId = await governedIntent("project.scope_change", "project-1", 1, { contractScope: "New scope" }, "ai-pm", "human-approver");
    const allowed = await app!.inject({
      method: "PATCH", url: "/api/projects/project-1/baseline", headers,
      payload: { expectedVersion: 1, patch: { contractScope: "New scope" }, intentId },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ contractScope: "New scope", version: 2 });

    // The same intent cannot be replayed for a second effect (single-use).
    const replay = await app!.inject({
      method: "PATCH", url: "/api/projects/project-1/baseline", headers,
      payload: { expectedVersion: 2, patch: { contractScope: "Second scope" }, intentId },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "STALE_INTENT" });
  });

  it("executes the persisted PM plan and revision workflow through a consumed checkpoint", async () => {
    await seed();
    const created = await app!.inject({
      method: "POST", url: "/api/pm/plans", headers,
      payload: {
        id: "plan-1", projectId: "project-1", objective: "Deliver", taskIds: ["task-1"],
        createdByPrincipalId: "ai-pm", createdAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(created.statusCode).toBe(201);

    // A revision without a consumed checkpoint intent is refused.
    const denied = await app!.inject({
      method: "POST", url: "/api/pm/plans/plan-1/revisions", headers,
      payload: { expectedVersion: 1, objective: "x", taskIds: ["task-1"], createdByPrincipalId: "ai-pm", createdAt: "2026-01-02T00:00:00Z" },
    });
    expect(denied.statusCode).toBe(400);

    const intentId = await governedIntent("pm.plan_revise", "plan-1", 1, { objective: "Deliver approved scope", taskIds: ["task-1", "task-2"] }, "ai-pm", "human-approver");
    const revised = await app!.inject({
      method: "POST", url: "/api/pm/plans/plan-1/revisions", headers,
      payload: {
        expectedVersion: 1, objective: "Deliver approved scope", taskIds: ["task-1", "task-2"],
        createdByPrincipalId: "ai-pm", createdAt: "2026-01-02T00:00:00Z", intentId,
      },
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.json()).toMatchObject({ version: 2, revisions: [{ revision: 1 }, { revision: 2 }] });
  });

  it("binds the approved PM payload: a consumed checkpoint cannot execute a different revision body", async () => {
    await seed();
    await app!.inject({
      method: "POST", url: "/api/pm/plans", headers,
      payload: { id: "plan-9", projectId: "project-1", objective: "Deliver", taskIds: ["task-1"], createdByPrincipalId: "ai-pm", createdAt: "2026-01-01T00:00:00Z" },
    });
    // Approve a revision to objective "A"; then try to execute objective "B" with the same intent.
    const intentId = await governedIntent("pm.plan_revise", "plan-9", 1, { objective: "Objective A", taskIds: ["task-1"] }, "ai-pm", "human-approver");
    const tampered = await app!.inject({
      method: "POST", url: "/api/pm/plans/plan-9/revisions", headers,
      payload: { expectedVersion: 1, objective: "Objective B (unapproved)", taskIds: ["task-1"], createdByPrincipalId: "ai-pm", createdAt: "2026-01-02T00:00:00Z", intentId },
    });
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json()).toMatchObject({ error: "STALE_INTENT" });
  });
  it("imports a versioned CRM CSV with quarantine, provenance status and duplicate rejection", async () => {
    await seed();
    const content = [
      "customer_id,name,status,created_at",
      "customer-1,Duplicate Acme,active,2026-01-01T00:00:00Z",
      "customer-2,Beta,active,2026-01-02T00:00:00Z",
    ].join("\n");
    const payload = {
      id: "import-1", sourceKind: "CRM", schemaVersion: 1, content,
      operatorPrincipalId: "import-operator", submittedAt: "2026-07-15T09:00:00+09:00",
    };
    const created = await app!.inject({ method: "POST", url: "/api/imports", headers, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: "QUARANTINED",
      actionType: "CRM_IMPORT",
      fileVersion: 1,
      rows: [
        { status: "QUARANTINED", errorReason: expect.stringContaining("customer already exists") },
        { status: "IMPORTED" },
      ],
    });

    const duplicate = await app!.inject({ method: "POST", url: "/api/imports", headers, payload: { ...payload, id: "import-2" } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "DUPLICATE_IMPORT" });

    // Imported customer is a live native CRM record.
    const overview = await app!.inject({ method: "GET", url: "/api/customers/customer-2/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ customer: { id: "customer-2", name: "Beta" } });

    // Cross-workspace read of the batch fails closed.
    const foreign = await app!.inject({ method: "GET", url: "/api/imports/import-1", headers: { "x-workspace-id": "ws-2" } });
    expect(foreign.statusCode).toBe(400);
  });

  it("reports bank statement freshness from successfully imported rows only", async () => {
    await seed();
    const submit = (id: string, rows: string[]) =>
      app!.inject({
        method: "POST", url: "/api/imports", headers,
        payload: {
          id, sourceKind: "BANK_STATEMENT", schemaVersion: 1,
          content: ["account,statement_period,posted_at,amount_krw,balance_krw,description", ...rows].join("\n"),
          operatorPrincipalId: "import-operator", submittedAt: "2026-07-15T09:00:00+09:00",
        },
      });
    expect((await submit("bank-1", ["acct-1,2026-05,2026-05-31,1000,1000,A"])).statusCode).toBe(201);
    expect((await submit("bank-2", ["acct-2,2026-06,2026-06-15,2000,2000,B"])).statusCode).toBe(201);
    const freshness = await app!.inject({ method: "GET", url: "/api/imports/bank/freshness", headers });
    expect(freshness.statusCode).toBe(200);
    expect(freshness.json()).toEqual({ accounts: { "acct-1": "2026-05-31", "acct-2": "2026-06-15" }, asOf: "2026-05-31" });
  });
  it("keeps the finance surface fail-closed while the accounting pack is unset", async () => {
    await seed();
    const denied = await app!.inject({
      method: "POST", url: "/api/finance/journal-entries", headers,
      payload: { id: "entry-1", entryDate: "2026-06-30", description: "x", lines: [], createdByPrincipalId: "p1" },
    });
    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toMatchObject({ error: "FINANCE_PACK_UNSET" });
    const overview = await app!.inject({ method: "GET", url: "/api/customers/customer-1/overview", headers });
    expect(overview.json()).toMatchObject({ finance: { status: "pending" } });
  });

  it("runs the evidence-backed finance round trip into the customer 360 (AC-01/AC-08)", async () => {
    app = createApp({ financePack: fixturePack });
    await app.ready();
    expect((await app.inject({ method: "POST", url: "/api/customers", headers, payload: customer })).statusCode).toBe(201);

    // Finance stays pending until a bank statement is successfully imported.
    const before = await app.inject({ method: "GET", url: "/api/customers/customer-1/overview", headers });
    expect(before.json()).toMatchObject({ finance: { status: "pending" } });

    const bank = await app.inject({
      method: "POST", url: "/api/imports", headers,
      payload: {
        id: "bank-1", sourceKind: "BANK_STATEMENT", schemaVersion: 1,
        content: ["account,statement_period,posted_at,amount_krw,balance_krw,description", "acct-1,2026-06,2026-06-30,800000,800000,Net"].join("\n"),
        operatorPrincipalId: "import-operator", submittedAt: "2026-07-15T09:00:00+09:00",
      },
    });
    expect(bank.statusCode).toBe(201);

    const draft = await app.inject({
      method: "POST", url: "/api/finance/journal-entries", headers,
      payload: {
        id: "entry-1", entryDate: "2026-06-30", description: "용역매출", evidenceRef: "evidence-1",
        createdByPrincipalId: "finance-creator",
        lines: [
          { accountCode: "1000", debitKrw: "1000000", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "1000000" },
        ],
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ status: "DRAFT" });

    // SoD: creator cannot verify; distinct verifier and poster required.
    const sod = await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-1/verify", headers,
      payload: { verifierPrincipalId: "finance-creator" },
    });
    expect(sod.statusCode).toBe(400);
    expect(sod.json()).toMatchObject({ error: "SOD_VIOLATION" });
    expect((await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-1/verify", headers,
      payload: { verifierPrincipalId: "finance-verifier" },
    })).statusCode).toBe(200);
    // LEDGER_POST is permanently REQUIRE_APPROVAL: post requires a consumed governance intent.
    const postDenied = await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-1/post", headers,
      payload: { posterPrincipalId: "cfo-approver" },
    });
    expect(postDenied.statusCode).toBe(400);
    const postIntent1 = await governedIntent("finance.ledger_post", "entry-1", 2, { entryId: "entry-1" }, "finance-creator", "controller");
    expect((await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-1/post", headers,
      payload: { posterPrincipalId: "cfo-approver", intentId: postIntent1 },
    })).statusCode).toBe(200);

    // Second entry sourced from the bank import batch: the import operator may not post it.
    await app.inject({
      method: "POST", url: "/api/finance/journal-entries", headers,
      payload: {
        id: "entry-2", entryDate: "2026-06-30", description: "외주비", evidenceRef: "evidence-2", importBatchId: "bank-1",
        createdByPrincipalId: "finance-creator",
        lines: [
          { accountCode: "5000", debitKrw: "200000", creditKrw: "0" },
          { accountCode: "1000", debitKrw: "0", creditKrw: "200000" },
        ],
      },
    });
    await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-2/verify", headers,
      payload: { verifierPrincipalId: "finance-verifier" },
    });
    // Import-operator SoD is checked before the intent is consumed, so this fails without one.
    const importSod = await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-2/post", headers,
      payload: { posterPrincipalId: "import-operator" },
    });
    expect(importSod.statusCode).toBe(400);
    expect(importSod.json()).toMatchObject({ error: "SOD_VIOLATION" });
    const postIntent2 = await governedIntent("finance.ledger_post", "entry-2", 2, { entryId: "entry-2" }, "finance-creator", "controller");
    expect((await app.inject({
      method: "POST", url: "/api/finance/journal-entries/entry-2/post", headers,
      payload: { posterPrincipalId: "cfo-approver", intentId: postIntent2 },
    })).statusCode).toBe(200);

    // Customer 360 finance section: evidence-backed figures, honest as_of.
    const overview = await app.inject({ method: "GET", url: "/api/customers/customer-1/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      sectionOrder: ["exceptions", "nextActions", "status", "contracts", "projects", "communications", "finance"],
      finance: {
        status: "available", asOf: "2026-06-30",
        cashKrw: "800000", receivableKrw: "0", payableKrw: "0", projectMarginKrw: "800000",
      },
    });
  });

  it("opens and resolves reconciliation variances and reports the daily gate", async () => {
    app = createApp({ financePack: fixturePack });
    await app.ready();
    const variance = await app.inject({
      method: "POST", url: "/api/finance/reconciliations", headers,
      payload: {
        id: "recon-1",
        statementRow: { account: "acct-1", postedAt: "2026-06-30", amountKrw: "800000", rowFingerprint: "fp-1" },
        ledgerAmountKrw: "790000", reconciledByPrincipalId: "finance-verifier",
        reconciledAt: "2026-07-01T10:00:00+09:00", exceptionId: "fx-1",
      },
    });
    expect(variance.statusCode).toBe(201);
    expect(variance.json()).toMatchObject({ status: "VARIANCE", varianceKrw: "10000", exceptionId: "fx-1" });
    expect((await app.inject({ method: "GET", url: "/api/finance/exceptions", headers })).json()).toMatchObject([{ id: "fx-1", status: "OPEN" }]);

    const resolved = await app.inject({
      method: "POST", url: "/api/finance/exceptions/fx-1/resolve", headers,
      payload: { resolvedByPrincipalId: "cfo-approver", resolvedAt: "2026-07-02T10:00:00+09:00", resolutionNote: "Bank fee posting corrected" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: "RESOLVED" });

    const day = await app.inject({
      method: "POST", url: "/api/finance/daily-gate/days", headers,
      payload: { date: "2026-07-01", importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0, receivedAt: "2026-07-01T17:00:00+09:00" },
    });
    expect(day.statusCode).toBe(201);
    expect(day.json()).toMatchObject({ qualifying: true, streakAfter: 1, tierAfter: "conservative" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ streak: 1, tier: "conservative" });
  });
});
