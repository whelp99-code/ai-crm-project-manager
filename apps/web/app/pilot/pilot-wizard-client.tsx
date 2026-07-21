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
  defaultApproverId: string;
};

const STEPS = [
  { id: 1, label: "1단계 · 온보딩" },
  { id: 2, label: "2단계 · 작업 제출" },
  { id: 3, label: "3단계 · 승인" },
  { id: 4, label: "4단계 · 완료" },
] as const;

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

export function PilotWizardClient({ apiBase, workspaceId, defaultPrincipalId, defaultApproverId }: Props) {
  const configured = Boolean(apiBase && workspaceId);

  const [step, setStep] = useState(1);
  const [text, setText] = useState("");
  const [principalId, setPrincipalId] = useState(defaultPrincipalId);
  const [approverId, setApproverId] = useState(defaultApproverId);
  const [idempotencyKey, setIdempotencyKey] = useState(() => `pilot-${Date.now()}`);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [controlId, setControlId] = useState("");
  const [decideMessage, setDecideMessage] = useState<string | null>(null);
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
    const body = (await response.json()) as JobView;
    setJob(body);
    const pendingControl = body.workItems.find((item) => item.controlId)?.controlId;
    if (pendingControl) setControlId(pendingControl);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!configured) {
      setError("API_BASE_URL, WORKSPACE_ID 서버 설정이 필요합니다. 가짜 job을 만들지 않습니다.");
      return;
    }
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
      setIdempotencyKey(`pilot-${Date.now()}`);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "command failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDecide(decision: "APPROVE" | "REJECT") {
    if (!configured || !controlId) return;
    setBusy(true);
    setDecideMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/governance/controls/${controlId}/decide`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": workspaceId,
        },
        body: JSON.stringify({ principalId: approverId, decision }),
      });
      const body = (await response.json()) as { error?: string; status?: string };
      if (!response.ok) {
        throw new Error(body.error ?? `decide ${response.status}`);
      }
      setDecideMessage(`${decision} → ${body.status ?? "ok"}`);
      if (jobId) await refreshJob(jobId);
    } catch (err) {
      setDecideMessage(err instanceof Error ? err.message : "decide failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    if (!configured || !jobId) return;
    setBusy(true);
    setError(null);
    try {
      await refreshJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "refresh failed");
    } finally {
      setBusy(false);
    }
  }

  const jobStatus = job?.job.status ?? null;
  const isTerminal = jobStatus ? TERMINAL_STATUSES.has(jobStatus) : false;
  const hasPendingControl = job?.workItems.some((item) => item.controlId) ?? false;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <nav aria-label="파일럿 마법사 단계">
        <ol className="status-row" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {STEPS.map((s) => (
            <li key={s.id}>
              <span
                className="status"
                aria-current={step === s.id ? "step" : undefined}
                style={step === s.id ? { borderColor: "#176b47", fontWeight: 800 } : undefined}
              >
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      {step === 1 ? (
        <section className="panel" aria-labelledby="onboarding-title">
          <h2 id="onboarding-title">온보딩</h2>
          <p>
            이 마법사는 자연어 명령 제출 → 승인 → 완료로 이어지는 S0 루프를 안내합니다. 모든 변경은{" "}
            <code>/api/agent/commands</code>와 승인 <code>decide</code> API로만 이루어지며, 도메인 PATCH 우회는 없습니다.
          </p>
          <ul className="list">
            <li>1단계: 이 화면 — 필수 설정 확인</li>
            <li>2단계: <code>/work</code>와 동일한 방식으로 명령 제출</li>
            <li>3단계: 필요 시 <code>/approvals</code>와 동일한 방식으로 승인</li>
            <li>4단계: job이 종료 상태(done/failed)에 도달하면 완료</li>
          </ul>
          {!configured ? (
            <section className="error" aria-labelledby="pilot-unavailable-title" style={{ marginTop: 16 }}>
              <h3 id="pilot-unavailable-title">파일럿 환경 설정이 필요합니다</h3>
              <p>API_BASE_URL(또는 NEXT_PUBLIC_API_BASE_URL)과 WORKSPACE_ID 서버 설정이 필요합니다.</p>
              <p className="meta">가짜 job으로 화면을 채우지 않습니다. 2단계 명령 제출은 설정 전까지 비활성화됩니다.</p>
            </section>
          ) : (
            <p className="meta">필수 설정이 확인되었습니다. workspace: {workspaceId}</p>
          )}
        </section>
      ) : null}

      {step === 2 ? (
        <section className="panel panel-action" aria-labelledby="submit-title">
          <h2 id="submit-title">작업 제출</h2>
          <p className="meta">
            요청은 Fastify <code>/api/agent/commands</code> 로만 전달됩니다. Next Route Handler mutation은 사용하지 않습니다.
          </p>
          {!configured ? (
            <p className="error">API_BASE_URL, WORKSPACE_ID 서버 설정이 필요합니다. 설정 전까지 제출할 수 없습니다.</p>
          ) : null}
          <form onSubmit={onSubmit} className="stack" style={{ gap: 12 }}>
            <label>
              <span className="meta">운영자 principal</span>
              <input
                value={principalId}
                onChange={(e) => setPrincipalId(e.target.value)}
                required
                disabled={!configured}
                style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
              />
            </label>
            <label>
              <span className="meta">명령 텍스트</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
                disabled={!configured}
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
                disabled={!configured}
                style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
              />
            </label>
            <div className="status-row">
              <button type="submit" disabled={busy || !configured}>
                {busy ? "전송 중…" : "명령 전송"}
              </button>
              {jobId ? (
                <button type="button" disabled={busy || !configured} onClick={() => void onRefresh()}>
                  새로고침
                </button>
              ) : null}
            </div>
          </form>
          {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}
          {job ? (
            <p className="status-row" style={{ marginTop: 12 }}>
              <span className="status">{job.job.status}</span>
              <span className="meta">{job.job.id}</span>
            </p>
          ) : null}
        </section>
      ) : null}

      {step === 3 ? (
        <section className="panel panel-pending" aria-labelledby="approval-title">
          <h2 id="approval-title">승인</h2>
          {!configured ? (
            <p className="error">API_BASE_URL, WORKSPACE_ID 서버 설정이 필요합니다. 승인 데이터를 임의로 채우지 않습니다.</p>
          ) : !jobId ? (
            <p className="empty">아직 제출된 job이 없습니다. 2단계에서 먼저 명령을 제출하세요.</p>
          ) : !hasPendingControl ? (
            <p className="empty">이 job은 승인 통제가 필요하지 않습니다. 4단계로 진행하세요.</p>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <p className="meta">
                체크포인트 단계는 다른 principal이 decide 합니다. 도메인 PATCH 우회 없음. 전체 인박스는{" "}
                <a href="/approvals">승인 인박스</a>에서도 확인할 수 있습니다.
              </p>
              <label>
                <span className="meta">Control ID</span>
                <input
                  value={controlId}
                  onChange={(e) => setControlId(e.target.value)}
                  style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
                />
              </label>
              <label>
                <span className="meta">승인자 principal</span>
                <input
                  value={approverId}
                  onChange={(e) => setApproverId(e.target.value)}
                  style={{ display: "block", width: "100%", marginTop: 4, padding: 8 }}
                />
              </label>
              <div className="status-row">
                <button type="button" disabled={busy || !controlId} onClick={() => void onDecide("APPROVE")}>
                  승인
                </button>
                <button type="button" disabled={busy || !controlId} onClick={() => void onDecide("REJECT")}>
                  반려
                </button>
              </div>
              {decideMessage ? <p className="meta">{decideMessage}</p> : null}
            </div>
          )}
        </section>
      ) : null}

      {step === 4 ? (
        <section className="panel" aria-labelledby="completion-title">
          <h2 id="completion-title">완료</h2>
          {!configured ? (
            <p className="error">API_BASE_URL, WORKSPACE_ID 서버 설정이 필요합니다. 완료 상태를 임의로 표시하지 않습니다.</p>
          ) : !jobId ? (
            <p className="empty">아직 제출된 job이 없습니다. 2단계에서 먼저 명령을 제출하세요.</p>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <p className="status-row">
                <span className="status">{jobStatus}</span>
                <span className="meta">{jobId}</span>
                <button type="button" disabled={busy} onClick={() => void onRefresh()}>
                  새로고침
                </button>
              </p>
              {isTerminal ? (
                <p className="status" style={{ borderColor: "#176b47" }}>
                  파일럿 루프 완료 · pilot loop complete
                </p>
              ) : (
                <p className="meta">job이 아직 종료 상태가 아닙니다. 새로고침으로 최신 상태를 확인하세요.</p>
              )}
            </div>
          )}
        </section>
      ) : null}

      <div className="status-row">
        <button type="button" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
          이전
        </button>
        <button type="button" disabled={step === 4} onClick={() => setStep((s) => Math.min(4, s + 1))}>
          다음
        </button>
      </div>
    </div>
  );
}
