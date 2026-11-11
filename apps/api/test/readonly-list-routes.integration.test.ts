import Fastify from "fastify";
import { Client, Pool, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { registerReadonlyListRoutes } from "../src/readonly-list-routes.js";

describe("operating Core5 readonly HTTP compatibility", () => {
  it("preserves account/engagement/finance responses and actual workspace transactions", async () => {
    const app = Fastify({ logger: false });
    const pool = new Pool();
    const client = Object.assign(new Client(), { release: vi.fn() });
    const queries: { sql: string; args: unknown }[] = [];
    const query = vi.spyOn(client, "query").mockImplementation(async (sql, args) => {
      if (typeof sql !== "string") throw new TypeError("readonly routes must use parameterized SQL");
      queries.push({ sql, args });
      let rows: QueryResultRow[] = [];
      if (sql.includes("FROM cwos_accounts")) rows = [{ id: "account", name: "Owned QA account" }];
      else if (sql.includes("FROM cwos_engagements")) rows = [{ id: "engagement", name: "Owned QA engagement" }];
      else if (sql.includes("GROUP BY")) rows = [{ direction: "IN", net: "10", vat: "2", gross: "12" }];
      else if (sql.includes("FROM cwos_financial_items")) rows = [{ id: "financial", direction: "IN" }];
      else if (sql.includes("information_schema.columns")) rows = [{ present: true }];
      else if (sql !== "BEGIN" && sql !== "COMMIT" && !sql.includes("set_config")) {
        throw new Error(`Unexpected readonly query: ${sql}`);
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    });
    const connect = vi.spyOn(pool, "connect").mockImplementation(async () => client);
    registerReadonlyListRoutes(app, { pool, workspaceId: "owned-readonly-workspace", apiKey: "private-readonly-key" });
    const headers = { "x-api-key": "private-readonly-key", "x-workspace-id": "owned-readonly-workspace" };
    try {
      const accounts = await app.inject({ method: "GET", url: "/api/cwos/accounts", headers });
      expect(accounts.statusCode).toBe(200);
      expect(accounts.json()).toEqual({ count: 1, accounts: [{ id: "account", name: "Owned QA account" }] });
      const engagements = await app.inject({ method: "GET", url: "/api/cwos/engagements", headers });
      expect(engagements.statusCode).toBe(200);
      expect(engagements.json()).toEqual({ count: 1, engagements: [{ id: "engagement", name: "Owned QA engagement" }] });
      const finance = await app.inject({ method: "GET", url: "/api/cwos/finance", headers });
      expect(finance.statusCode).toBe(200);
      expect(finance.json()).toEqual({
        count: 1, totals: {
          IN: { net: "10", vat: "2", gross: "12" }, OUT: { net: "0", vat: "0", gross: "0" },
        },
        items: [{ id: "financial", direction: "IN" }],
      });
      expect(connect).toHaveBeenCalledTimes(3);
      expect(client.release).toHaveBeenCalledTimes(3);
      expect(queries.filter(item => item.sql === "BEGIN")).toHaveLength(3);
      expect(queries.filter(item => item.sql === "COMMIT")).toHaveLength(3);
      for (const scoped of queries.filter(item => item.sql.includes("set_config") || item.sql.includes("FROM cwos_"))) {
        expect(scoped.args).toEqual(["owned-readonly-workspace"]);
      }
      for (const badHeaders of [
        { ...headers, "x-api-key": "wrong-key" },
        { ...headers, "x-workspace-id": "wrong-workspace" },
      ]) {
        const denied = await app.inject({ method: "GET", url: "/api/cwos/accounts", headers: badHeaders });
        expect(denied.statusCode).toBe(401);
      }
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
      connect.mockRestore();
      await app.close();
      await pool.end();
    }
  });
});

describe("admitted Mail account-master HTTP boundary", () => {
  const workspaceId = "blro-reader-fixture";
  const principalId = "mail-reader-fixture";
  const apiKey = "isolated-mail-reader-key";
  const headers = { "x-api-key": apiKey, "x-workspace-id": workspaceId,
    "x-principal-id": principalId, "x-principal-kind": "service" };

  async function reader(admitted = true) {
    const pool = new Pool();
    const client = Object.assign(new Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async (sql, args) => {
      if (typeof sql !== "string") throw new TypeError("expected parameterized account SQL");
      const rows: QueryResultRow[] = [];
      if (sql.includes("FROM cwos_accounts")) {
        expect(sql).toContain("WHERE workspace_id = $1::uuid");
        expect(args).toEqual([workspaceId]);
        rows.push({ id: "account-fixture", name: "Isolated account" });
      } else if (sql.includes("set_config")) {
        expect(args).toEqual([workspaceId]);
      } else if (sql !== "BEGIN" && sql !== "COMMIT") {
        throw new Error("unexpected read-only account query");
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    });
    const connect = vi.spyOn(pool, "connect").mockImplementation(async () => client);
    const app = createApp({ authApiKey: apiKey, customerWorkOsV2Profile: "test",
      customerWorkOsV2MachineBinding: { workspaceId, principalId, kind: "service", readOnly: true,
        ...(admitted ? { mailAccountMasterRead: true } : {}) } });
    registerReadonlyListRoutes(app, { pool, workspaceId, apiKey });
    await app.ready();
    return { app, connect, async close() {
      query.mockRestore();
      connect.mockRestore();
      await app.close();
      await pool.end();
    } };
  }

  it("reads only the admitted workspace account master with the dedicated service identity", async () => {
    const fixture = await reader();
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/cwos/accounts", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ count: 1, accounts: [{ id: "account-fixture", name: "Isolated account" }] });
      expect(fixture.connect).toHaveBeenCalledTimes(1);
    } finally { await fixture.close(); }
  });

  it.each([
    { "x-workspace-id": "different-workspace" },
    { "x-principal-id": "different-principal" },
    { "x-principal-kind": "human" },
    { "x-step-up": "true" },
  ])("rejects altered actor claims without querying accounts: %j", async (claim) => {
    const fixture = await reader();
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/cwos/accounts",
        headers: { ...headers, ...claim } });
      expect(response.statusCode).toBe(403);
      expect(fixture.connect).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"] as const)(
    "refuses %s on the account-master GET exception", async (method) => {
      const fixture = await reader();
      try {
        const response = await fixture.app.inject({ method, url: "/api/cwos/accounts", headers });
        expect(response.statusCode).toBe(403);
        expect(fixture.connect).not.toHaveBeenCalled();
      } finally { await fixture.close(); }
    },
  );

  it.each(["/api/cwos/engagements", "/api/cwos/finance", "/api/cwos/accounts/other-workspace"])(
    "keeps other legacy routes closed: %s", async (url) => {
      const fixture = await reader();
      try {
        const response = await fixture.app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(403);
        expect(fixture.connect).not.toHaveBeenCalled();
      } finally { await fixture.close(); }
    },
  );

  it("denies the account master without explicit server admission", async () => {
    const fixture = await reader(false);
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/cwos/accounts", headers });
      expect(response.statusCode).toBe(403);
      expect(fixture.connect).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it("rejects a different key before the account query", async () => {
    const fixture = await reader();
    try {
      const response = await fixture.app.inject({ method: "GET", url: "/api/cwos/accounts",
        headers: { ...headers, "x-api-key": "wrong-reader-key" } });
      expect(response.statusCode).toBe(401);
      expect(fixture.connect).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });

  it.each([
    { kind: "ai", readOnly: true },
    { kind: "service", readOnly: false },
  ] as const)("rejects an ineligible server binding: %j", ({ kind, readOnly }) => {
    expect(() => createApp({ authApiKey: apiKey, customerWorkOsV2MachineBinding: {
      workspaceId, principalId, kind, readOnly, mailAccountMasterRead: true,
    } })).toThrow(/CWOS_V2_MAIL_ACCOUNT_MASTER_BINDING_INVALID/);
  });
});
