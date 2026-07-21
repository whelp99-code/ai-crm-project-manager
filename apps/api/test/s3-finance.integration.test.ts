import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FinancePackConfig } from "@ai-crm/finance";
import type { ModelClient } from "@ai-crm/model-gateway";
import { COMMAND_MAP, mapCommand, mapCommandKey } from "../src/command-map.js";
import { createApp, GOVERNANCE_COMMANDS, type CreateAppOptions } from "../src/app.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Test fixture only — real values come from the signed accounting pack. See docs/ops/finance-pack-pilot.md. */
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

const WS = "ws-s3";
const headers = { "x-workspace-id": WS };
const customer = {
  id: "customer-s3",
  name: "S3 Acme",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
};

const MONEY_COMMANDS = [
  "finance.ledger_post",
  "finance.invoice_issue",
  "finance.payment_execute",
] as const;

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

/**
 * Runs the real governance control plane (authorize -> independent approve ->
 * consume) and returns the queued intent id the API dereferences server-side.
 */
async function governedIntent(
  api: FastifyInstance,
  command: string,
  resourceId: string,
  resourceVersion: number,
  payload: unknown,
  requester: string,
  approver: string,
): Promise<string> {
  const authorized = await api.inject({
    method: "POST",
    url: "/api/governance/authorize",
    headers,
    payload: { command, resourceId, resourceVersion, payload, requesterPrincipalId: requester },
  });
  expect(authorized.statusCode).toBe(201);
  const control = authorized.json().control as { id: string; payloadHash: string; policyVersion: number };
  const decided = await api.inject({
    method: "POST",
    url: `/api/governance/controls/${control.id}/decide`,
    headers,
    payload: { principalId: approver, decision: "APPROVE" },
  });
  expect(decided.statusCode).toBe(200);
  const consumed = await api.inject({
    method: "POST",
    url: `/api/governance/controls/${control.id}/consume`,
    headers,
    payload: {
      resourceId,
      resourceVersion,
      payloadHash: control.payloadHash,
      policyVersion: control.policyVersion,
    },
  });
  expect(consumed.statusCode).toBe(201);
  return consumed.json().id as string;
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

describe("S3 finance integration", () => {
  it("S3-I-01: import operator ≠ ledger verifier/poster on same batch (SoD)", async () => {
    const api = await ready({ financePack: fixturePack });
    expect(
      (await api.inject({ method: "POST", url: "/api/customers", headers, payload: customer })).statusCode,
    ).toBe(201);

    const importOperator = "import-operator-s3";
    const bank = await api.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: {
        id: "bank-s3-1",
        sourceKind: "BANK_STATEMENT",
        schemaVersion: 1,
        content: [
          "account,statement_period,posted_at,amount_krw,balance_krw,description",
          "acct-s3,2026-06,2026-06-30,500000,500000,Net",
        ].join("\n"),
        operatorPrincipalId: importOperator,
        submittedAt: "2026-07-15T09:00:00+09:00",
      },
    });
    expect(bank.statusCode).toBe(201);
    expect(bank.json()).toMatchObject({ status: "COMPLETED", operatorPrincipalId: importOperator });

    const draft = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries",
      headers,
      payload: {
        id: "entry-s3-1",
        entryDate: "2026-06-30",
        description: "bank-sourced",
        evidenceRef: "ev-s3-1",
        importBatchId: "bank-s3-1",
        createdByPrincipalId: "finance-creator",
        lines: [
          { accountCode: "1000", debitKrw: "500000", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "500000" },
        ],
      },
    });
    expect(draft.statusCode).toBe(201);

    // Import operator cannot verify a posting sourced from their own batch.
    const verifyAsImporter = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-1/verify",
      headers,
      payload: { verifierPrincipalId: importOperator },
    });
    expect(verifyAsImporter.statusCode).toBe(400);
    expect(verifyAsImporter.json()).toMatchObject({ error: "SOD_VIOLATION" });

    const verified = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-1/verify",
      headers,
      payload: { verifierPrincipalId: "finance-verifier" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: "VERIFIED", version: 2 });

    // Import operator cannot post either (checked before intent consumption).
    const postAsImporter = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-1/post",
      headers,
      payload: { posterPrincipalId: importOperator },
    });
    expect(postAsImporter.statusCode).toBe(400);
    expect(postAsImporter.json()).toMatchObject({ error: "SOD_VIOLATION" });

    // Distinct poster + consumed LEDGER_POST intent succeeds.
    const intentId = await governedIntent(
      api,
      "finance.ledger_post",
      "entry-s3-1",
      2,
      { entryId: "entry-s3-1" },
      "finance-creator",
      "controller",
    );
    const posted = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-1/post",
      headers,
      payload: { posterPrincipalId: "cfo-approver", intentId },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({
      status: "POSTED",
      postedByPrincipalId: "cfo-approver",
    });
    expect(posted.json().postedByPrincipalId).not.toBe(importOperator);
    expect(posted.json().verifiedByPrincipalId).not.toBe(importOperator);
  });

  it("S3-I-02: quarantine row → zero ledger/CRM mutate", async () => {
    const api = await ready({ financePack: fixturePack });
    expect(
      (await api.inject({ method: "POST", url: "/api/customers", headers, payload: customer })).statusCode,
    ).toBe(201);

    // Seed one live customer so a duplicate import row is quarantined without overwrite.
    const beforeOverview = await api.inject({
      method: "GET",
      url: "/api/customers/customer-s3/overview",
      headers,
    });
    expect(beforeOverview.statusCode).toBe(200);
    expect(beforeOverview.json()).toMatchObject({
      customer: { id: "customer-s3", name: "S3 Acme" },
      finance: { status: "pending" },
    });

    const crmImport = await api.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: {
        id: "import-s3-crm-q",
        sourceKind: "CRM",
        schemaVersion: 1,
        content: [
          "customer_id,name,status,created_at",
          // Duplicate of existing → quarantined; must not mutate CRM name/status.
          "customer-s3,Hijacked Name,inactive,2026-02-01T00:00:00Z",
          // Invalid status → quarantined; must never create this customer.
          "customer-ghost,,active,2026-02-01T00:00:00Z",
          // New valid row still imports (batch becomes QUARANTINED overall).
          "customer-s3-ok,Beta,active,2026-02-02T00:00:00Z",
        ].join("\n"),
        operatorPrincipalId: "import-operator",
        submittedAt: "2026-07-15T09:00:00+09:00",
      },
    });
    expect(crmImport.statusCode).toBe(201);
    expect(crmImport.json()).toMatchObject({
      status: "QUARANTINED",
      rows: [
        { status: "QUARANTINED", errorReason: expect.stringContaining("customer already exists") },
        { status: "QUARANTINED" },
        { status: "IMPORTED" },
      ],
    });

    // Existing customer unchanged (no mutate from quarantined duplicate).
    const afterOverview = await api.inject({
      method: "GET",
      url: "/api/customers/customer-s3/overview",
      headers,
    });
    expect(afterOverview.json()).toMatchObject({
      customer: { id: "customer-s3", name: "S3 Acme", status: "active" },
    });

    // Ghost quarantined row never became a CRM record.
    const ghost = await api.inject({
      method: "GET",
      url: "/api/customers/customer-ghost/overview",
      headers,
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toMatchObject({ error: expect.stringMatching(/NOT_FOUND|CUSTOMER/) });

    // Valid imported peer exists.
    const ok = await api.inject({
      method: "GET",
      url: "/api/customers/customer-s3-ok/overview",
      headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ customer: { id: "customer-s3-ok", name: "Beta" } });

    // LEDGER import: malformed rows quarantine; no journal draft/post side-effect surface.
    const ledgerImport = await api.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: {
        id: "import-s3-ledger-q",
        sourceKind: "LEDGER",
        schemaVersion: 1,
        content: [
          "entry_id,entry_date,account_code,debit_krw,credit_krw,description,evidence_ref",
          "bad-entry,not-a-date,1000,100,0,x,ev",
          "ok-shape,2026-06-30,1000,100,0,y,ev",
        ].join("\n"),
        operatorPrincipalId: "import-operator",
        submittedAt: "2026-07-15T09:00:00+09:00",
      },
    });
    expect(ledgerImport.statusCode).toBe(201);
    const ledgerBatch = ledgerImport.json() as {
      status: string;
      rows: Array<{ status: string; values?: Record<string, string> }>;
    };
    expect(ledgerBatch.status).toBe("QUARANTINED");
    expect(ledgerBatch.rows.some((row) => row.status === "QUARANTINED")).toBe(true);

    // Ledger import never wires a domain applier into journal_entries — balances stay empty
    // and fabricated entry ids from quarantined/imported ledger CSV rows are absent.
    const balances = await api.inject({ method: "GET", url: "/api/finance/balances", headers });
    expect(balances.statusCode).toBe(200);
    expect(balances.json()).toEqual({});

    for (const entryId of ["bad-entry", "ok-shape"]) {
      const missing = await api.inject({
        method: "POST",
        url: `/api/finance/journal-entries/${entryId}/verify`,
        headers,
        payload: { verifierPrincipalId: "finance-verifier" },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: expect.stringMatching(/NOT_FOUND/) });
    }

    // Bank quarantine does not advance freshness (no successful imported statement rows).
    const bankQ = await api.inject({
      method: "POST",
      url: "/api/imports",
      headers,
      payload: {
        id: "import-s3-bank-q",
        sourceKind: "BANK_STATEMENT",
        schemaVersion: 1,
        content: [
          "account,statement_period,posted_at,amount_krw,balance_krw,description",
          "acct-bad,2026-13,not-a-date,abc,xyz,broken",
        ].join("\n"),
        operatorPrincipalId: "import-operator",
        submittedAt: "2026-07-15T09:00:00+09:00",
      },
    });
    expect(bankQ.statusCode).toBe(201);
    expect(bankQ.json()).toMatchObject({ status: "QUARANTINED" });
    const freshness = await api.inject({ method: "GET", url: "/api/imports/bank/freshness", headers });
    expect(freshness.statusCode).toBe(200);
    expect(freshness.json()).toEqual({ accounts: {} });

    // 360 finance remains pending — no bank as_of, no ledger mutation from quarantine paths.
    const financePending = await api.inject({
      method: "GET",
      url: "/api/customers/customer-s3/overview",
      headers,
    });
    expect(financePending.json()).toMatchObject({ finance: { status: "pending" } });
  });

  it("S3-I-03: LEDGER_POST (and money actions) require consumed governance intent; COMMAND_MAP rejects finance.money keys", async () => {
    const api = await ready({ financePack: fixturePack });

    // COMMAND_MAP stays the S0 five-key whitelist — money keys never auto-map.
    expect(Object.keys(COMMAND_MAP).sort()).toEqual(
      ["internal.update", "pm.plan_create", "pm.plan_revise", "pm.target_set", "pm.task_assign"].sort(),
    );
    for (const command of MONEY_COMMANDS) {
      expect(mapCommand(command)).toBeNull();
      expect(mapCommandKey(command)).toBeNull();
    }
    expect(mapCommand("finance.verify")).toBeNull();
    expect(mapCommand("finance.report")).toBeNull();

    // GOVERNANCE_COMMANDS still registers money actions for explicit API/governance paths.
    expect(GOVERNANCE_COMMANDS["finance.ledger_post"]).toBe("LEDGER_POST");
    expect(GOVERNANCE_COMMANDS["finance.invoice_issue"]).toBe("INVOICE_ISSUE");
    expect(GOVERNANCE_COMMANDS["finance.payment_execute"]).toBe("PAYMENT_EXECUTE");

    // Policy via authorize API: money actions always open APPROVAL (REQUIRE_APPROVAL).
    for (const command of MONEY_COMMANDS) {
      const authorized = await api.inject({
        method: "POST",
        url: "/api/governance/authorize",
        headers,
        payload: {
          command,
          resourceId: `resource-${command}`,
          resourceVersion: 1,
          payload: { probe: true },
          requesterPrincipalId: "finance-requester",
        },
      });
      expect(authorized.statusCode).toBe(201);
      const body = authorized.json() as {
        control?: { kind: string; actionType: string; status: string };
        intent?: unknown;
      };
      expect(body.intent).toBeUndefined();
      expect(body.control).toMatchObject({
        kind: "APPROVAL",
        status: "PENDING",
        actionType: GOVERNANCE_COMMANDS[command],
      });
    }

    // Invoice/payment execute HTTP routes are governance-registered but API surface deferred.
    // No /api/finance/invoice* or /api/finance/payment* mount — only LEDGER_POST has execute path today.
    for (const url of [
      "/api/finance/invoices",
      "/api/finance/invoice-issue",
      "/api/finance/payments",
      "/api/finance/payment-execute",
    ]) {
      const missing = await api.inject({ method: "POST", url, headers, payload: {} });
      expect(missing.statusCode).toBe(404);
    }

    // LEDGER_POST execute path requires a consumed governed intent.
    const draft = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries",
      headers,
      payload: {
        id: "entry-s3-gov",
        entryDate: "2026-06-30",
        description: "governed post",
        evidenceRef: "ev-gov",
        createdByPrincipalId: "finance-creator",
        lines: [
          { accountCode: "1000", debitKrw: "1000", creditKrw: "0" },
          { accountCode: "4000", debitKrw: "0", creditKrw: "1000" },
        ],
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(
      (
        await api.inject({
          method: "POST",
          url: "/api/finance/journal-entries/entry-s3-gov/verify",
          headers,
          payload: { verifierPrincipalId: "finance-verifier" },
        })
      ).statusCode,
    ).toBe(200);

    const postDenied = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-gov/post",
      headers,
      payload: { posterPrincipalId: "cfo-approver" },
    });
    expect(postDenied.statusCode).toBe(400);
    expect(postDenied.json()).toMatchObject({ error: "INVALID_INPUT" });

    const forged = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-gov/post",
      headers,
      payload: { posterPrincipalId: "cfo-approver", intentId: "intent-forged-000" },
    });
    expect(forged.statusCode).toBe(404);

    const intentId = await governedIntent(
      api,
      "finance.ledger_post",
      "entry-s3-gov",
      2,
      { entryId: "entry-s3-gov" },
      "finance-creator",
      "controller",
    );
    const posted = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-gov/post",
      headers,
      payload: { posterPrincipalId: "cfo-approver", intentId },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json()).toMatchObject({ status: "POSTED" });

    // Single-use: replay burns as STALE_INTENT.
    const replay = await api.inject({
      method: "POST",
      url: "/api/finance/journal-entries/entry-s3-gov/post",
      headers,
      payload: { posterPrincipalId: "other-poster", intentId },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "STALE_INTENT" });
  });

  it("S3-I-04: missing finance pack → finance routes 503 FINANCE_PACK_UNSET; 360 finance pending; agent/report path does not auto LEDGER_POST", async () => {
    // No financePack injection — surface stays fail-closed (see docs/ops/finance-pack-pilot.md).
    const api = await ready({
      modelClient: planClient([
        {
          suggestedCommand: "finance.ledger_post",
          title: "Post ledger from finance report",
          resourceId: "entry-imaginary",
          resourceVersion: 2,
          payload: { entryId: "entry-imaginary" },
        },
        {
          suggestedCommand: "finance.invoice_issue",
          title: "Issue invoice",
          resourceId: "inv-1",
          payload: {},
        },
        {
          suggestedCommand: "finance.payment_execute",
          title: "Pay vendor",
          resourceId: "pay-1",
          payload: {},
        },
        {
          suggestedCommand: "finance.report",
          title: "Finance report",
          resourceId: "rpt-1",
          payload: {},
        },
      ]),
    });

    expect(
      (await api.inject({ method: "POST", url: "/api/customers", headers, payload: customer })).statusCode,
    ).toBe(201);

    for (const [method, url, payload] of [
      [
        "POST",
        "/api/finance/journal-entries",
        {
          id: "entry-no-pack",
          entryDate: "2026-06-30",
          description: "x",
          lines: [
            { accountCode: "1000", debitKrw: "1", creditKrw: "0" },
            { accountCode: "4000", debitKrw: "0", creditKrw: "1" },
          ],
          createdByPrincipalId: "p1",
        },
      ],
      ["GET", "/api/finance/balances", undefined],
      [
        "POST",
        "/api/finance/reconciliations",
        {
          id: "recon-1",
          statementRow: { account: "a", postedAt: "2026-06-30", amountKrw: "1", rowFingerprint: "fp" },
          ledgerAmountKrw: "1",
          reconciledByPrincipalId: "p1",
          reconciledAt: "2026-07-01T10:00:00+09:00",
        },
      ],
      ["GET", "/api/finance/exceptions", undefined],
      ["GET", "/api/finance/daily-gate", undefined],
      [
        "POST",
        "/api/finance/daily-gate/days",
        {
          date: "2026-07-01",
          importsCompleted: true,
          entriesBalanced: true,
          openFinanceExceptions: 0,
          receivedAt: "2026-07-01T17:00:00+09:00",
        },
      ],
    ] as const) {
      const res = await api.inject({
        method,
        url,
        headers,
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json()).toMatchObject({ error: "FINANCE_PACK_UNSET" });
    }

    const overview = await api.inject({
      method: "GET",
      url: "/api/customers/customer-s3/overview",
      headers,
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      sectionOrder: expect.arrayContaining(["finance"]),
      finance: { status: "pending" },
    });

    // Natural-command / model path: finance money + report commands stay unmapped — never auto LEDGER_POST.
    const agent = await api.inject({
      method: "POST",
      url: "/api/agent/commands",
      headers: {
        ...headers,
        "x-principal-id": "operator-s3",
        "idempotency-key": "s3-finance-unmap",
      },
      payload: { text: "run finance report and post the ledger" },
    });
    expect(agent.statusCode).toBe(202);
    const agentBody = agent.json() as { jobId: string; status: string };
    expect(agentBody.status).toBe("failed");

    const job = await api.inject({
      method: "GET",
      url: `/api/agent/jobs/${agentBody.jobId}`,
      headers: { ...headers, "x-principal-id": "operator-s3" },
    });
    expect(job.statusCode).toBe(200);
    const snap = job.json() as {
      workItems: Array<{ status: string; errorCode?: string; suggestedCommand?: string; actionType?: string }>;
    };
    expect(snap.workItems).toHaveLength(4);
    for (const item of snap.workItems) {
      expect(item).toMatchObject({ status: "failed", errorCode: "UNMAPPED_COMMAND" });
      expect(item.actionType).toBeUndefined();
    }

    // Static map honesty (belt-and-suspenders with agent path).
    expect(mapCommand("finance.ledger_post")).toBeNull();
    expect(mapCommand("finance.report")).toBeNull();
  });
});
