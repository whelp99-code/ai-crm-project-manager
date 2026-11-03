import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/** Runs the private enrollment CLI. Credential values stay in a mode-0600 file, not argv. */
export function enrollThroughCli(statePath: string, input: unknown, now: number): void {
  if (!Number.isSafeInteger(now)) throw new Error("OPERATOR_ENROLLMENT_REJECTED");
  const dir = mkdtempSync(join(tmpdir(), "crm-web-enroll-"));
  try {
    const inputPath = join(dir, "input.json");
    const clockPath = join(dir, "clock.mjs");
    writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    writeFileSync(clockPath, `Date.now = () => ${now};\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--import", clockPath,
      "apps/api/src/operator-auth-enroll.mts",
      "--input", inputPath, "--state", statePath,
    ], { cwd: repoRoot, encoding: "utf8" });
    if (result.status === 0 && result.stdout === "OPERATOR_ENROLLED\n") return;
    let exists = false;
    try { exists = lstatSync(statePath).isFile(); } catch { exists = false; }
    throw Object.assign(new Error("OPERATOR_ENROLLMENT_REJECTED"), {
      code: exists ? "ALREADY_ENROLLED" : "OPERATOR_ENROLLMENT_REJECTED",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
