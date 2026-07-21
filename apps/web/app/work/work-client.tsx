"use client";

import { useCallback, useState, type FormEvent } from "react";

type JobView = {
  job: { id: string; status: string; rawText?: string; createdByPrincipalId?: string };
  workItems: Array<{
    id: string;
    status: string;
    title?: string;
    suggestedCommand?: string;
    actionType?: string;
    controlId?: string;
    errorCode?: string;
  }>;
};

type Props = {
  apiBase: string;
  workspaceId: string;
  defaultPrincipalId: string;
};

export function WorkClient({ apiBase, workspaceId, defaultPrincipalId }: Props) {
  const [text, setText] = useState("");
  const [principalId, setPrincipalId] = useState(defaultPrincipalId);
  const [idempotencyKey, setIdempotencyKey] = useState(() => `web-${Date.now()}`);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const headers = useCallback(() => {
    return {
      "content-type": "application/json",
      "x-workspace-id": workspaceId,
      "x-principal-id": principalId,
    };
  }, [workspaceId, principalId]);

  async function refreshJob(id: string) {
    const response = await fetch(`${apiBase}/api/agent/jobs/${id}`, {
      headers: headers(),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`job ${response.status}`);
    }
    setJob((await response.json()) as JobView);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/agent/commands`, {
        method: "POST",
        headers: {
          ...headers(),
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ text }),
      });
      const body = (await response.json()) as { jobId?: string; error?: string; message?: string };
      if (!response.ok) {
        throw new Error(body.error ?? body.message ?? `command ${response.status}`);
      }
      if (!body.jobId) throw new Error("missing jobId");
      setJobId(body.jobId);
      await refreshJob(body.jobId);
      setIdempotencyKey(`web-${Date.now()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "command failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!jobId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/agent/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: headers(),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `cancel ${response.status}`);
      }
      await refreshJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="panel panel-action" aria-labelledby="command-title">
        <h2 id="command-title">자연어 명령</h2>
        <p className="meta">
          요청은 Fastify <code>/api/agent/commands</code> 로만 전달됩니다. Next Route Handler mutation은 사용하지 않습니다.
        </p>
        <form onSubmit={onSubmit} className="stack" style={{ gap: 12 }}>
          <label>
            <span className="meta">운영자 principal</span>
            <input
              value={principalId}
              onChange={(e) => setPrincipalId(e.target.value)}
              required
              style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
            />
          </label>
          <label>
            <span className="meta">명령 텍스트</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              rows={4}
              style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
              placeholder="예: 이 계획의 작업을 배정해 주세요"
            />
          </label>
          <label>
            <span className="meta">Idempotency-Key</span>
            <input
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              required
              style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
            />
          </label>
          <div className="status-row">
            <button type="submit" disabled={busy}>
              {busy ? "전송 중…" : "명령 전송"}
            </button>
            {jobId ? (
              <button type="button" disabled={busy} onClick={() => void refreshJob(jobId)}>
                새로고침
              </button>
            ) : null}
            {jobId && job?.job.status === "open" ? (
              <button type="button" disabled={busy} onClick={() => void onCancel()}>
                작업 취소
              </button>
            ) : null}
          </div>
        </form>
        {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
      </section>

      <section className="panel" aria-labelledby="job-title">
        <h2 id="job-title">에이전트 Job</h2>
        {!job ? (
          <p className="empty">아직 제출된 job이 없습니다.</p>
        ) : (
          <>
            <p className="status-row">
              <span className="status">{job.job.status}</span>
              <span className="meta">{job.job.id}</span>
            </p>
            <p className="meta">created_by: {job.job.createdByPrincipalId ?? "—"}</p>
            <table>
              <thead>
                <tr>
                  <th>단계</th>
                  <th>상태</th>
                  <th>명령</th>
                  <th>ActionType</th>
                  <th>Control</th>
                  <th>오류</th>
                </tr>
              </thead>
              <tbody>
                {job.workItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title ?? item.id}</td>
                    <td>{item.status}</td>
                    <td>{item.suggestedCommand ?? "—"}</td>
                    <td>{item.actionType ?? "—"}</td>
                    <td>
                      {item.controlId ? (
                        <a href="/approvals">{item.controlId}</a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{item.errorCode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="meta">
              체크포인트 단계는 <a href="/approvals">승인 인박스</a>에서 다른 principal이 decide 합니다. 도메인 PATCH 우회 없음.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
