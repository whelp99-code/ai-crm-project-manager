import Fastify from "fastify";
import { Client, Pool, type QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
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
