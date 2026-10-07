import { describe, expect, it } from "vitest";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";

describe("pgSmokeConnectionEnv", () => {
  it("uses the supplied database URL without local credential overrides", () => {
    const env = pgSmokeConnectionEnv(
      "postgresql://postgres:ci%2Dpassword@127.0.0.1:32785/ai_crm",
      {},
    );
    expect(env).toEqual({
      PGHOST: "127.0.0.1",
      PGPORT: "32785",
      PGUSER: "postgres",
      PGPASSWORD: "ci-password",
      PGDATABASE: "ai_crm",
    });
  });

  it("preserves explicit CI PG values", () => {
    const env = pgSmokeConnectionEnv(
      "postgresql://postgres:postgres@127.0.0.1/ai_crm",
      { PGHOST: "ci-postgres", PGUSER: "ci-user", PGPASSWORD: "ci-password" },
    );
    expect(env).toMatchObject({
      PGHOST: "ci-postgres", PGUSER: "ci-user", PGPASSWORD: "ci-password",
    });
  });
});
