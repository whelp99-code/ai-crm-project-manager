import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engagementsSql, financeItemsSql, financeTotalsSql, rollupFinanceTotals } from "../src/readonly-lists.js";
import { parseOperatingConfig, type OperatingEnv } from "../src/ops-boot.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function privateFile(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ops-boot-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function baseEnv(): OperatingEnv {
  return {
    CORE5_API_MODE: "mail-reader",
    DATABASE_URL: "postgres://runtime_api@localhost/owned_fixture",
    ADMIN_DATABASE_URL: "postgres://admin@localhost/owned_fixture",
    MODEL_GATEWAY_DATABASE_URL: "postgres://model_gateway@localhost/owned_fixture",
    WORKSPACE_ID: "workspace-a",
    CWOS_V2_MAIL_READER_PRINCIPAL_ID: "mail-reader",
    CWOS_V2_MAIL_READER_KEY_FILE: privateFile("reader.key", "r".repeat(40)),
  };
}

describe("operating boot configuration", () => {
  it("requires explicit mode and distinct PostgreSQL profiles", () => {
    const env = baseEnv();
    expect(parseOperatingConfig(env)).toMatchObject({ mode: "mail-reader", workspaceId: "workspace-a" });
    const missingMode = { ...env };
    delete missingMode.CORE5_API_MODE;
    expect(() => parseOperatingConfig(missingMode)).toThrow(/OPS_BOOT_CONFIG_REQUIRED/);
    expect(() => parseOperatingConfig({ ...env, ADMIN_DATABASE_URL: "postgres://runtime_api@localhost/owned_fixture" }))
      .toThrow(/DATABASE_PROFILES_NOT_DISTINCT/);
  });

  it("keeps mail-reader credentials separate and rejects inherited operator identity", () => {
    const env = baseEnv();
    expect(parseOperatingConfig(env).apiKey).toBe("r".repeat(40));
    expect(() => parseOperatingConfig({ ...env, AUTH_API_KEY: "operator-key" })).toThrow(/READER_OPERATOR_ENV_FORBIDDEN/);
    expect(() => parseOperatingConfig({ ...env, CWOS_V2_OPERATOR_STEP_UP_VERIFIED: "0" })).toThrow(/READER_OPERATOR_ENV_FORBIDDEN/);
    expect(() => parseOperatingConfig({
      ...env,
      CWOS_V2_MAIL_READER_KEY_FILE: privateFile("short.key", "too-short"),
    })).toThrow(/READER_KEY_TOO_SHORT/);
  });

  it("rejects identical DB roles even when DSN text and secrets differ", () => {
    expect(() => parseOperatingConfig({
      ...baseEnv(),
      DATABASE_URL: "postgres://runtime_api:first@localhost/owned_fixture",
      ADMIN_DATABASE_URL: "postgres://runtime_api:second@localhost/owned_fixture",
    })).toThrowError(/OPS_BOOT_DATABASE_ROLES_NOT_DISTINCT/);
  });

  it("refuses query parameters that override the declared driver role", () => {
    expect(() => parseOperatingConfig({
      ...baseEnv(), DATABASE_URL: "postgres://runtime_api@localhost/owned_fixture?user=admin",
    })).toThrowError(/OPS_BOOT_DATABASE_PROFILE_INVALID/);
  });

  it("rejects short Unicode or internal-whitespace reader credentials", () => {
    for (const value of ["한".repeat(16), `${"r".repeat(32)} space`]) {
      expect(() => parseOperatingConfig({
        ...baseEnv(), CWOS_V2_MAIL_READER_KEY_FILE: privateFile("reader.key", value),
      })).toThrowError(/OPS_BOOT_READER_KEY_TOO_SHORT/);
    }
  });

  it("requires a private existing human auth record and rejects global step-up", () => {
    const sessionPath = privateFile("session.secret", "s".repeat(40));
    const authPath = privateFile("operator.state", "{}");
    const env: OperatingEnv = {
      CORE5_API_MODE: "human",
      DATABASE_URL: "postgres://runtime_api@localhost/owned_fixture",
      ADMIN_DATABASE_URL: "postgres://admin@localhost/owned_fixture",
      MODEL_GATEWAY_DATABASE_URL: "postgres://model_gateway@localhost/owned_fixture",
      WORKSPACE_ID: "workspace-a",
      AUTH_API_KEY: "operator-api-key",
      CWOS_V2_OPERATOR_WORKSPACE_ID: "workspace-a",
      CWOS_V2_OPERATOR_PRINCIPAL_ID: "owner",
      CWOS_V2_OPERATOR_AUTH_STATE_PATH: authPath,
      CWOS_V2_OPERATOR_SESSION_SECRET_FILE: sessionPath,
    };
    expect(parseOperatingConfig(env)).toMatchObject({ mode: "human", principalId: "owner" });
    expect(() => parseOperatingConfig({ ...env, CWOS_V2_OPERATOR_STEP_UP_VERIFIED: "1" })).toThrow(/STEP_UP_ENV_FORBIDDEN/);
  });
});

describe("legacy read-only SQL compatibility", () => {
  it("maps optional archive/source columns while retaining workspace predicates", () => {
    const engagements = engagementsSql(true, false);
    expect(engagements).toContain("NULL::text AS source_stage");
    expect(engagements).toContain("e.workspace_id = $1::uuid");
    expect(engagements).toContain("e.archived_at IS NULL");
    expect(engagements).toContain("p.archived_at IS NULL");
    expect(engagementsSql(false, true)).toContain("e.source_stage");
  });

  it("maps finance archive predicates and legacy total shape", () => {
    expect(financeItemsSql(true)).toContain("f.archived_at IS NULL");
    expect(financeTotalsSql(false)).toContain("AND TRUE");
    expect(rollupFinanceTotals([{ direction: "IN", net: "10", vat: "2", gross: "12" }])).toEqual({
      IN: { net: "10", vat: "2", gross: "12" },
      OUT: { net: "0", vat: "0", gross: "0" },
    });
  });
});
