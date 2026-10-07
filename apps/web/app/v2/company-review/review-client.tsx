"use client";

import { useEffect, useState } from "react";
import styles from "./review.module.css";

type Status = "FRESH" | "STALE" | "UNKNOWN";
interface Source {
  kind: string;
  recordId: string;
  revisionId: string | null;
  sourceHash: string | null;
  evidenceRefs: string[];
  observedAt: string | null;
  sourceOccurredAt: string | null;
  freshness: Status;
}
interface Group {
  status: Status;
  candidateCount: number | null;
  quantityTotals: Record<string, string> | null;
  sources: Source[];
}
interface Overview {
  workspaceId: string;
  asOf: string;
  freshnessThresholdMs: number;
  authority: "LOCAL_CANDIDATE_ONLY";
  revenue: Group;
  purchases: Group;
  receivables: Group;
  delivery: Group;
  renewals: Group;
  work: Group;
}
type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: Overview };

function safeEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function Evidence({ value }: { value: string }) {
  const href = safeEvidenceUrl(value);
  return href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <span>{value}</span>;
}

function GroupCard({ title, group }: { title: string; group: Group }) {
  return (
    <section className="panel" aria-label={title}>
      <div className="status-row">
        <h2>{title}</h2>
        <span className="status">{group.status}</span>
      </div>
      {group.candidateCount === null
        ? <p>Company total: UNKNOWN</p>
        : <p>Local candidate records: {group.candidateCount}</p>}
      {group.quantityTotals && (
        <dl>
          <dt>Candidate quantities (not company totals)</dt>
          {Object.entries(group.quantityTotals).map(([name, quantity]) => (
            <dd key={name}>{name}: {quantity}</dd>
          ))}
        </dl>
      )}
      {group.sources.length === 0 ? (
        <p className="empty">No verified company source observations are available.</p>
      ) : (
        <ul className="list">
          {group.sources.map((source) => (
            <li key={`${source.kind}:${source.recordId}`}>
              <strong>{source.kind}</strong> · {source.recordId}
              {source.revisionId && <> · revision {source.revisionId}</>}
              <div className="meta">
                Observation: {source.observedAt ?? "UNKNOWN"} · {source.freshness}
                {source.sourceOccurredAt && <> · source event occurred {source.sourceOccurredAt}</>}
              </div>
              {source.sourceHash && <div className="meta">Source hash: {source.sourceHash}</div>}
              {source.evidenceRefs.length > 0 && (
                <div className="meta">
                  Evidence: {source.evidenceRefs.map((ref, index) => (
                    <span key={`${ref}:${index}`}>
                      {index > 0 && ", "}<Evidence value={ref} />
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CompanyReviewClient() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    fetch("/api/local-review/company-overview", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Local API read unavailable (${response.status})`);
        return await response.json() as Overview;
      })
      .then((data) => { if (active) setState({ kind: "ready", data }); })
      .catch((error: unknown) => {
        if (active) setState({ kind: "error", message: error instanceof Error ? error.message : "Local API read unavailable" });
      });
    return () => { active = false; };
  }, []);

  if (state.kind === "loading") return <p role="status">Reading the authenticated local candidate API…</p>;
  if (state.kind === "error") {
    return <section className="error"><h1>Company candidate review unavailable</h1><p>{state.message}</p></section>;
  }

  const { data } = state;
  return (
    <div className={`stack ${styles.review}`}>
      <section className="panel panel-pending">
        <h1>Company overview · local candidate review</h1>
        <p>LOCAL CANDIDATE ONLY. W04/W05 fixtures are not company-authoritative evidence; this view does not establish G019 acceptance.</p>
        <p>Revenue, purchases, and receivables are UNKNOWN because no verified company producer is connected. Customer-level views are not company aggregates.</p>
        <p className="meta">Workspace {data.workspaceId} · as of {data.asOf} · freshness threshold {data.freshnessThresholdMs / 86_400_000} days</p>
      </section>
      <div className={`grid ${styles.groups}`}>
        <GroupCard title="Revenue" group={data.revenue} />
        <GroupCard title="Purchases" group={data.purchases} />
        <GroupCard title="Receivables" group={data.receivables} />
        <GroupCard title="Delivery candidates" group={data.delivery} />
        <GroupCard title="Renewal candidates" group={data.renewals} />
        <GroupCard title="Work candidates" group={data.work} />
      </div>
    </div>
  );
}
