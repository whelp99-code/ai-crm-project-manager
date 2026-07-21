"use client";

import { useState } from "react";

type Props = {
  apiBase: string;
  workspaceId: string;
  principalId: string;
  customerId: string;
  customerName: string;
  projectId?: string | undefined;
  nextActionTitle?: string | undefined;
};

export function S1CreateWorkClient({
  apiBase,
  workspaceId,
  principalId,
  customerId,
  customerName,
  projectId,
  nextActionTitle,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      const resourceType = projectId ? "project" : "customer";
      const resourceId = projectId ?? customerId;
      const actionHint = nextActionTitle?.trim()
        ? `다음 행동: ${nextActionTitle.trim()}. `
        : "";
      const text =
        `${actionHint}고객 ${customerName}(${customerId})에 대해 internal.update로 내부 일감을 생성하세요.`.slice(
          0,
          500,
        );
      const response = await fetch(`${apiBase}/api/agent/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": workspaceId,
          "x-principal-id": principalId,
          "idempotency-key": `s1-360-${customerId}-${Date.now()}`,
        },
        body: JSON.stringify({
          text,
          resourceBinding: { resourceType, resourceId },
        }),
      });
      const body = (await response.json()) as {
        jobId?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? body.message ?? `command ${response.status}`);
      }
      if (!body.jobId) throw new Error("missing jobId");
      setJobId(body.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "command failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="status-row">
        <button type="button" disabled={busy} onClick={() => void onCreate()}>
          {busy ? "생성 중…" : "이 고객으로 일감 만들기"}
        </button>
        <span className="meta">
          ADR-012 바인딩: {projectId ? `project/${projectId}` : `customer/${customerId}`} · POST /api/agent/commands only
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {jobId ? (
        <p className="status-row">
          <span className="status">job 생성됨</span>
          <span className="meta">{jobId}</span>
          <a href="/work">작업실에서 보기</a>
        </p>
      ) : null}
    </div>
  );
}
