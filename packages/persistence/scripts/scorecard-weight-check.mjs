#!/usr/bin/env node
// =============================================================================
// scorecard-weight-check.mjs
//
// Continued-dev Q1 (methodology): a guard against the §1.1 "110 vs declared
// 100" error class documented in docs/planning/merge-corp-shell/04-SCORECARD.md
// §3H — the §1.1 dimension-weight table's D1..D12 weights summed to 110 while
// the section header claimed "합 100" (sum 100), silently inflating every
// absolute score derived from `기여점 = (차원/5) × 가중` by ~10% until Claude
// red-team #3 caught it (2026-07-22).
//
// This script parses the §1.1 weight table directly from 04-SCORECARD.md,
// sums the per-dimension weights, and asserts the sum matches the declared
// max stated in the §1.1 header. It is READ-ONLY: it never touches the
// scorecard's dimension scores/history, only verifies the weight table is
// internally consistent with its own header claim.
//
// Usage: node packages/persistence/scripts/scorecard-weight-check.mjs
// Exit 0 + "PASS" line on match; exit 1 + a clear diagnostic on mismatch or
// a parse failure (fail-closed — a script that can't find the table must
// not silently report success).
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");
const scorecardPath = join(repoRoot, "docs/planning/merge-corp-shell/04-SCORECARD.md");

function fail(message) {
  console.error(`[scorecard-weight-check] FAIL: ${message}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(scorecardPath, "utf8");
} catch (error) {
  fail(`could not read ${scorecardPath}: ${error instanceof Error ? error.message : String(error)}`);
}

// --- 1. Locate the §1.1 section (from its "### 1.1" heading to the next
// "###"/"##" heading) so the weight-table regex below can't accidentally
// match an unrelated table elsewhere in the (very long) document. ---
const sectionStart = text.indexOf("### 1.1");
if (sectionStart === -1) {
  fail(`could not find the "### 1.1" section heading in ${scorecardPath}`);
}
const nextHeadingMatch = text.slice(sectionStart + 1).match(/\n#{2,3}\s/);
const sectionEnd = nextHeadingMatch ? sectionStart + 1 + nextHeadingMatch.index : text.length;
const section = text.slice(sectionStart, sectionEnd);

// --- 2. Extract the declared max from the §1.1 header line itself. Binds
// to the CANONICAL value only — either the explicit "실제 합" (actual sum)
// label (e.g. "실제 합 **110**" / "실제 합 110") or, failing that, a bolded
// "합 **N**" figure — NEVER the first bare "합 N" occurrence. A header can
// legitimately contain an earlier explanatory aside quoting a wrong
// historical figure (e.g. "...원래 "합 100"이라 오표기됐으나... 실제 합
// **110**..."); matching the first "합 N" blindly would silently pick up
// that aside's "100" instead of the canonical "110" and false-fail this
// guard against a correct table. See git history / §3H for the exact
// "110 vs declared 100" incident this class of bug caused.
// ---
const headerLine = section.slice(0, section.indexOf("\n") === -1 ? section.length : section.indexOf("\n"));
const declaredMatch =
  headerLine.match(/실제\s*합\s*\**\s*(\d+)/) ?? headerLine.match(/합\s*\*\*(\d+)\*\*/);
if (!declaredMatch) {
  fail(
    `could not find a canonical "실제 합 <N>" or bolded "합 **<N>**" (sum N) figure in the §1.1 header line: ${JSON.stringify(headerLine)}`,
  );
}
const declaredMax = Number(declaredMatch[1]);

// --- 3. Parse the weight table rows: "| D<n> | <label> | <weight> |". ---
const rowPattern = /\|\s*D(\d+)\s*\|[^|]+\|\s*(\d+(?:\.\d+)?)\s*\|/g;
const rows = [];
let match;
while ((match = rowPattern.exec(section)) !== null) {
  rows.push({ dimension: `D${match[1]}`, weight: Number(match[2]) });
}
if (rows.length === 0) {
  fail(`found no "| D<n> | ... | <weight> |" rows in the §1.1 section — table shape may have changed`);
}

// Sanity: expect exactly D1..D12, no duplicates, no gaps — a malformed table
// (e.g. a stray unrelated "| D3 | ... | 4.5 |" contribution-table row bleeding
// into the section slice) should fail loudly rather than silently mis-sum.
const seen = new Set();
for (const row of rows) {
  if (seen.has(row.dimension)) {
    fail(`duplicate row for ${row.dimension} in the §1.1 weight table — expected exactly one row per dimension`);
  }
  seen.add(row.dimension);
}
const expectedDimensions = Array.from({ length: 12 }, (_, i) => `D${i + 1}`);
const missing = expectedDimensions.filter((d) => !seen.has(d));
if (missing.length > 0) {
  fail(`missing weight row(s) for ${missing.join(", ")} in the §1.1 weight table (found: ${rows.map((r) => r.dimension).join(", ")})`);
}

const sum = rows.reduce((total, row) => total + row.weight, 0);

// --- 4. Assert sum == declared max (the exact error class this guards). ---
if (sum !== declaredMax) {
  fail(
    `§1.1 weight table sums to ${sum} but the header declares "합 ${declaredMax}" — ` +
      `these MUST match (this is the exact 110-vs-100 error class from §3H). ` +
      `Per-dimension weights: ${rows.map((r) => `${r.dimension}=${r.weight}`).join(", ")}`,
  );
}

console.log(
  `[scorecard-weight-check] PASS: §1.1 weight table sum (${sum}) matches the declared header max (${declaredMax}). ` +
    `Dimensions: ${rows.map((r) => `${r.dimension}=${r.weight}`).join(", ")}`,
);
