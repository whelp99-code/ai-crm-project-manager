import { timingSafeEqual } from "node:crypto";
import pg from "pg";
import { createApp } from "./src/app.ts";

const port = Number(process.env.CORE5_API_PORT ?? "4312");
const workspaceId = process.env.WORKSPACE_ID ?? "";
const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN ?? "";
if (!workspaceId || !apiKey || !process.env.DATABASE_URL) {
  console.error("boot refused: WORKSPACE_ID, AUTH_API_KEY, DATABASE_URL required");
  process.exit(1);
}

function keyOk(header: string | undefined): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : header ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  application_name: "core5-api-accounts",
});

const app = createApp();
app.get("/api/cwos/accounts", async (request, reply) => {
  const presented = request.headers.authorization ?? request.headers["x-api-key"];
  const headerKey = Array.isArray(presented) ? presented[0] : presented;
  const requested = request.headers["x-workspace-id"];
  const requestedWorkspace = Array.isArray(requested) ? requested[0] : requested;
  if (!keyOk(headerKey) || requestedWorkspace !== workspaceId) {
    return reply.code(401).send({ error: "UNAUTHENTICATED" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await client.query<{ id: string; name: string; status: string; kinds: string }>(
      `SELECT id, name, status, kinds::text AS kinds
         FROM cwos_accounts
        WHERE workspace_id = $1::uuid
        ORDER BY name`,
      [workspaceId],
    );
    await client.query("COMMIT");
    return { count: result.rowCount ?? result.rows.length, accounts: result.rows };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    request.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  } finally {
    client.release();
  }
});

await app.listen({ port, host: "127.0.0.1" });
console.log(`core5 api listening 127.0.0.1:${port}`);
