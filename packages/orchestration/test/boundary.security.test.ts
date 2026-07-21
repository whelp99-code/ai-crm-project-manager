import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SEC-01 — orchestration source must never shell out or write arbitrary files.
 * Pattern mirrors packages/connectors/test/connectors.security.test.ts.
 * Comments/docstrings that mention the forbidden APIs are allowed.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const orchestrationSrc = join(currentDir, "../src");

function walk(dir: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block and line comments so doc mentions of forbidden APIs do not fail the suite. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "child_process import/require", re: /\b(?:from\s+["']node:child_process["']|from\s+["']child_process["']|require\s*\(\s*["']node:child_process["']\s*\)|require\s*\(\s*["']child_process["']\s*\))/ },
  { id: "execSync", re: /\bexecSync\b/ },
  { id: "spawnSync", re: /\bspawnSync\b/ },
  { id: "execFileSync", re: /\bexecFileSync\b/ },
  { id: "fs.writeFile", re: /\bfs\.writeFile\b/ },
  { id: "fs.promises.writeFile", re: /\bfs\.promises\.writeFile\b/ },
  { id: "writeFileSync", re: /\bwriteFileSync\b/ },
  { id: "promises.writeFile bare", re: /\bpromises\.writeFile\b/ },
];

describe("SEC-01: orchestration source has no child_process / fs.writeFile", () => {
  const srcFiles = walk(
    orchestrationSrc,
    (p) => p.endsWith(".ts") || p.endsWith(".js"),
  );

  it("finds at least one orchestration src file (sanity guard against a vacuous test)", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it.each(srcFiles.map((p) => [relative(orchestrationSrc, p), p] as const))(
    "%s contains none of the forbidden process/fs-write APIs (comments allowed)",
    (_label, fullPath) => {
      const codeOnly = stripComments(readFileSync(fullPath, "utf8"));
      const offenders = FORBIDDEN_PATTERNS.filter(({ re }) => re.test(codeOnly)).map(({ id }) => id);
      expect(offenders).toEqual([]);
    },
  );
});
