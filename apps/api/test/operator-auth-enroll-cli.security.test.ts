import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { operatorAuthRecordSchema } from "../src/operator-auth-store.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const fixture = {
  password: "synthetic-cli-owner-password",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", totp: "287082",
};

describe("owner-run private enrollment CLI", () => {
  it("writes private KDF state, hides inputs and refuses to overwrite enrolled state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-enroll-cli-"));
    try {
      const input = join(dir, "input.json");
      const output = join(dir, "state.json");
      const clock = join(dir, "clock.mjs");
      await writeFile(input, JSON.stringify(fixture), { mode: 0o600 });
      await writeFile(clock, "Date.now = () => 59000;\n");
      const args = ["--import", "tsx", "--import", clock,
        "apps/api/src/operator-auth-enroll.mts", "--input", input, "--state", output];
      const result = await run(process.execPath, args, { cwd: root });
      expect(result.stdout).toBe("OPERATOR_ENROLLED\n");
      expect(result.stderr).toBe("");
      const persisted = await readFile(output, "utf8");
      expect(operatorAuthRecordSchema.safeParse(JSON.parse(persisted)).success).toBe(true);
      expect(persisted).not.toContain(fixture.password);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(run(process.execPath, args, { cwd: root })).rejects.toMatchObject({
        code: 1, stdout: "", stderr: "OPERATOR_ENROLLMENT_REJECTED\n",
      });
      expect(await readFile(output, "utf8")).toBe(persisted);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects public input with a fixed error that cannot disclose credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-enroll-cli-"));
    try {
      const input = join(dir, "public.json");
      await writeFile(input, JSON.stringify(fixture), { mode: 0o644 });
      await expect(run(process.execPath, ["--import", "tsx", "apps/api/src/operator-auth-enroll.mts",
        "--input", input, "--state", join(dir, "state.json")], { cwd: root })).rejects.toMatchObject({
        code: 1, stdout: "", stderr: "OPERATOR_ENROLLMENT_REJECTED\n",
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
