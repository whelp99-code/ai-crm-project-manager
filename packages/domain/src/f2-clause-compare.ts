export interface ClauseRevision {
  id: string;
  text: string;
  conditional: boolean;
  citation?: string;
}

export interface ClauseFinding {
  id: string;
  kind: "deleted" | "number_changed" | "date_changed" | "unchanged";
  conditional: boolean;
  citation?: string;
  interpretation: "CITED" | "UNCONFIRMED";
  priorText?: string;
  nextText?: string;
}

export interface ClauseComparison {
  findings: ClauseFinding[];
  overdue: boolean;
  approved: false;
  sent: false;
}

const numberPattern = /\d+/g;
const datePattern = /\d{4}-\d{2}-\d{2}/g;

function interpretation(clause: ClauseRevision): ClauseFinding["interpretation"] {
  return clause.citation && clause.citation.trim().length > 0 ? "CITED" : "UNCONFIRMED";
}

export function compareClauseRevisions(prior: ClauseRevision[], next: ClauseRevision[], now: string): ClauseComparison {
  const nextById = new Map(next.map((clause) => [clause.id, clause]));
  const findings: ClauseFinding[] = [];
  for (const clause of prior) {
    const revised = nextById.get(clause.id);
    if (!revised) {
      const deleted: ClauseFinding = {
        id: clause.id,
        kind: "deleted",
        conditional: clause.conditional,
        interpretation: interpretation(clause),
        priorText: clause.text,
      };
      if (clause.citation) deleted.citation = clause.citation;
      findings.push(deleted);
      continue;
    }
    const priorNumbers = clause.text.match(numberPattern)?.join(",") ?? "";
    const nextNumbers = revised.text.match(numberPattern)?.join(",") ?? "";
    const priorDates = clause.text.match(datePattern)?.join(",") ?? "";
    const nextDates = revised.text.match(datePattern)?.join(",") ?? "";
    const kind = priorDates !== nextDates ? "date_changed" : priorNumbers !== nextNumbers ? "number_changed" : "unchanged";
    const finding: ClauseFinding = {
      id: clause.id,
      kind,
      conditional: revised.conditional,
      interpretation: interpretation(revised.citation ? revised : clause),
      priorText: clause.text,
      nextText: revised.text,
    };
    const citation = revised.citation ?? clause.citation;
    if (citation) finding.citation = citation;
    findings.push(finding);
  }
  const deadline = findings.find((item) => item.kind === "date_changed")?.nextText?.match(datePattern)?.[0];
  return {
    findings,
    overdue: deadline !== undefined && deadline < now,
    approved: false,
    sent: false,
  };
}
