import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("ops-boot accounts route", () => {
  const src = readFileSync(join(apiRoot, "ops-boot.mts"), "utf8");

  it("serves a read-only accounts query on localhost", () => {
    expect(src).toContain('app.get("/api/cwos/accounts"');
    expect(src).toContain("SELECT id, name, status, kinds::text AS kinds");
    expect(src).toContain("FROM cwos_accounts");
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(src).toContain('host: "127.0.0.1"');
  });

  it("rejects a missing or mismatched workspace key", () => {
    expect(src).toContain("timingSafeEqual");
    expect(src).toContain("UNAUTHENTICATED");
    expect(src).toContain("x-workspace-id");
  });
});
