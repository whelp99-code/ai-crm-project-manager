import { describe, expect, it } from "vitest";
import { compareClauseRevisions, type ClauseRevision } from "../src/f2-clause-compare.js";

const prior: ClauseRevision[] = [
  { id: "delivery", text: "검수 기한 2026-08-31", conditional: false, citation: "contract://rev-1#delivery" },
  { id: "payment", text: "지급 30일", conditional: true },
  { id: "removed", text: "자동 갱신", conditional: false, citation: "contract://rev-1#renewal" },
];

const next: ClauseRevision[] = [
  { id: "delivery", text: "검수 기한 2026-09-30", conditional: false, citation: "contract://rev-2#delivery" },
  { id: "payment", text: "지급 45일", conditional: true },
];

describe("compareClauseRevisions", () => {
  it("keeps deleted and conditional clauses and detects date and number changes once", () => {
    const first = compareClauseRevisions(prior, next, "2026-10-01");
    const replay = compareClauseRevisions(prior, next, "2026-10-01");
    expect(replay).toEqual(first);
    expect(first.findings.map((item) => [item.id, item.kind, item.conditional, item.interpretation])).toEqual([
      ["delivery", "date_changed", false, "CITED"],
      ["payment", "number_changed", true, "UNCONFIRMED"],
      ["removed", "deleted", false, "CITED"],
    ]);
    expect(first.overdue).toBe(true);
    expect(first.approved).toBe(false);
    expect(first.sent).toBe(false);
  });
});
