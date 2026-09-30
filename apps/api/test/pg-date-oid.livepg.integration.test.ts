import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DATE (OID 1082) must come back as the raw calendar day with no ::text cast.
 * Guarded by LIVE_PG_TEST=1, same as the other live-pg files. Each case is a
 * fresh process so TZ is real, and the child installs the parser itself.
 */
const LIVE = process.env.LIVE_PG_TEST === "1";
const DATABASE_URL = process.env.DATABASE_URL?.trim() || "postgres://ai_crm:ai_crm_dev@localhost:5432/ai_crm";
const parserModule = join(dirname(fileURLToPath(import.meta.url)), "../src/pg-date-types.ts");

function assertCalendarDay(tz: string): void {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import pg from "pg";
    import { installPgDateStringParser } from ${JSON.stringify(parserModule)};
    installPgDateStringParser(pg);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query("SELECT DATE '2025-12-01' AS d");
      const value = result.rows[0].d;
      if (typeof value !== "string" || value !== "2025-12-01") {
        console.error(JSON.stringify({ tz: process.env.TZ, typeof: typeof value, value }));
        process.exit(1);
      }
      console.log(value);
    } finally {
      await client.end();
    }
  `], {
    env: { ...process.env, TZ: tz, DATABASE_URL },
    encoding: "utf8",
  });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("2025-12-01");
}

describe.skipIf(!LIVE)("pg DATE OID 1082 returns YYYY-MM-DD without ::text", () => {
  it("keeps the calendar day in TZ=Asia/Seoul", () => {
    assertCalendarDay("Asia/Seoul");
  });

  it("keeps the calendar day in TZ=UTC", () => {
    assertCalendarDay("UTC");
  });
});
