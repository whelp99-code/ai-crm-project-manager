import { describe, expect, it } from "vitest";
import { pgSmokeConnectionEnv } from "./pg-smoke-connection-env.js";

describe("pgSmokeConnectionEnv", () => {
  it("fills missing PG settings from the Release Gate DATABASE_URL", () => {
    expect(
      pgSmokeConnectionEnv(
        "postgresql://postgres:postgres@127.0.0.1:5432/ai_crm",
        { PGPASSWORD: "postgres" },
      ),
    ).toEqual({
      PGHOST: "127.0.0.1",
      PGPORT: "5432",
      PGUSER: "postgres",
      PGPASSWORD: "postgres",
      PGDATABASE: "ai_crm",
    });
  });

  it("preserves explicitly supplied PG settings", () => {
    expect(
      pgSmokeConnectionEnv("postgres://ai_crm:url-password@postgres:5432/ai_crm", {
        PGHOST: "ci-postgres",
        PGUSER: "ci-user",
        PGPASSWORD: "ci-password",
      }),
    ).toEqual({
      PGHOST: "ci-postgres",
      PGPORT: "5432",
      PGUSER: "ci-user",
      PGPASSWORD: "ci-password",
      PGDATABASE: "ai_crm",
    });
  });
});
