import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  engagementsSql,
  financeItemsSql,
  financeTotalsSql,
  rollupFinanceTotals,
} from "./readonly-lists.js";

interface ReadonlyListOptions {
  readonly pool: Pool;
  readonly workspaceId: string;
  readonly apiKey: string;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function authorized(request: FastifyRequest, options: ReadonlyListOptions): boolean {
  const authorization = header(request, "authorization");
  const presented = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : header(request, "x-api-key") ?? authorization ?? "";
  const actual = Buffer.from(presented, "utf8");
  const expected = Buffer.from(options.apiKey, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected) &&
    header(request, "x-workspace-id") === options.workspaceId;
}

async function withScopedClient<T>(
  pool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original query error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function archivedColumn(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'archived_at'
     ) AS present`,
    [table],
  );
  return result.rows[0]?.present === true;
}

export function registerReadonlyListRoutes(
  app: FastifyInstance,
  options: ReadonlyListOptions,
): void {
  app.get("/api/cwos/accounts", async (request, reply) => {
    if (!authorized(request, options)) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const accounts = await withScopedClient(options.pool, options.workspaceId, async (client) => {
        const result = await client.query<{ id: string; name: string; status: string; kinds: string }>(
          `SELECT id, name, status, kinds::text AS kinds
             FROM cwos_accounts
            WHERE workspace_id = $1::uuid
            ORDER BY name`,
          [options.workspaceId],
        );
        return result.rows;
      });
      return { count: accounts.length, accounts };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });

  app.get("/api/cwos/engagements", async (request, reply) => {
    if (!authorized(request, options)) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const engagements = await withScopedClient(options.pool, options.workspaceId, async (client) => {
        const archived = await archivedColumn(client, "cwos_engagements");
        const sourceStagePresent = (await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cwos_engagements' AND column_name = 'source_stage'
           ) AS present`,
        )).rows[0]?.present === true;
        const result = await client.query<{
          id: string;
          name: string;
          stage: string;
          source_stage: string | null;
          account_name: string | null;
        }>(engagementsSql(archived, sourceStagePresent), [options.workspaceId]);
        return result.rows;
      });
      return { count: engagements.length, engagements };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });

  app.get("/api/cwos/finance", async (request, reply) => {
    if (!authorized(request, options)) return reply.code(401).send({ error: "UNAUTHENTICATED" });
    try {
      const data = await withScopedClient(options.pool, options.workspaceId, async (client) => {
        const archived = await archivedColumn(client, "cwos_financial_items");
        const totals = await client.query<{ direction: string; net: string; vat: string; gross: string }>(
          financeTotalsSql(archived),
          [options.workspaceId],
        );
        const items = await client.query<{
          id: string;
          direction: string;
          gross_amount_krw: string;
          expected_date: string;
          counterparty: string | null;
        }>(financeItemsSql(archived), [options.workspaceId]);
        return { totals: totals.rows, items: items.rows };
      });
      return {
        count: data.items.length,
        totals: rollupFinanceTotals(data.totals),
        items: data.items,
      };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });
}
