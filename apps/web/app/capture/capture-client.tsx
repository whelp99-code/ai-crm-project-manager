"use client";

import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

type CaptureKind = "TEXT" | "EMAIL" | "MESSAGE" | "MEETING" | "VOICE_NOTE" | "DOCUMENT";

interface MutationPreview {
  id: string;
  category: string;
  field: string | null;
  value: unknown;
  confidence: number;
  risk: string;
  status: string;
  rationale: string;
}

interface PlanPreview {
  id: string;
  status: string;
  mutations: MutationPreview[];
  questionIds: string[];
}

export function CaptureClient(props: {
  apiBase: string;
  workspaceId: string;
  principalId: string;
}) {
  const [kind, setKind] = useState<CaptureKind>("TEXT");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanPreview | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const commonHeaders = {
        "x-workspace-id": props.workspaceId,
        "x-principal-id": props.principalId,
        "x-principal-kind": "human",
        "x-step-up": "true",
      };
      const stateResponse = await fetch(`${props.apiBase}/api/cwos/v2.5/state`, { headers: commonHeaders });
      if (!stateResponse.ok) throw new Error(`현재 상태를 불러오지 못했습니다 (${stateResponse.status})`);
      const state = await stateResponse.json() as { version: number };
      const id = `capture-${Date.now()}`;
      const response = await fetch(`${props.apiBase}/api/cwos/v2.5/capture`, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/json",
          "Idempotency-Key": id,
        },
        body: JSON.stringify({
          expectedVersion: state.version,
          capture: {
            id,
            workspaceId: props.workspaceId,
            kind,
            title: null,
            content,
            occurredAt: new Date().toISOString(),
            sender: props.principalId,
            sourceRef: `manual://${id}`,
            providerEventId: null,
            attachments: [],
            language: "ko",
          },
          context: {
            accountAliases: [],
            engagementAliases: [],
            defaultTimezone: "Asia/Seoul",
          },
        }),
      });
      const result = await response.json() as { result?: PlanPreview; message?: string };
      if (!response.ok || !result.result) throw new Error(result.message ?? `입력 처리 실패 (${response.status})`);
      setPlan(result.result);
      setContent("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "입력을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <form className="panel panel-action" onSubmit={submit}>
        <h2>업무를 한 번만 입력하세요</h2>
        <p className="meta">고객·프로젝트·일정·약속·재무 후보를 한 번에 나눠 준비합니다. 금액·계약·외부 행동은 자동 확정하지 않습니다.</p>
        <label>
          입력 종류
          <select value={kind} onChange={(event: ChangeEvent<HTMLSelectElement>) => setKind(event.target.value as CaptureKind)} style={{ display: "block", width: "100%", margin: "8px 0 14px", padding: 10 }}>
            <option value="TEXT">직접 메모</option>
            <option value="EMAIL">이메일</option>
            <option value="MESSAGE">메신저</option>
            <option value="MEETING">회의록</option>
            <option value="VOICE_NOTE">음성 메모 전사</option>
            <option value="DOCUMENT">문서 내용</option>
          </select>
        </label>
        <label>
          내용
          <textarea
            value={content}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setContent(event.target.value)}
            rows={10}
            required
            placeholder="예: 선진 HCI 검수일은 10월 15일, 총판 4천만원은 9월 말 지급, 고객 잔금은 검수 후 입금. 다음 주까지 수정 일정 회신."
            style={{ display: "block", width: "100%", margin: "8px 0 14px", padding: 12, resize: "vertical" }}
          />
        </label>
        <button type="submit" disabled={busy || !content.trim()} style={{ padding: "10px 18px", fontWeight: 700 }}>
          {busy ? "AI가 분류 중…" : "한 번에 정리"}
        </button>
        {error ? <p className="error" style={{ marginTop: 14 }}>{error}</p> : null}
      </form>

      {plan ? (
        <section className="panel" aria-live="polite">
          <h2>AI 업데이트 계획</h2>
          <p><strong>{plan.mutations.length}개 항목</strong>을 준비했습니다. 상태: {plan.status}</p>
          <ul className="list">
            {plan.mutations.map((mutation) => (
              <li key={mutation.id}>
                <strong>{mutation.category}</strong> · 신뢰도 {Math.round(mutation.confidence * 100)}% · 위험 {mutation.risk}
                <div className="meta">{mutation.rationale}</div>
              </li>
            ))}
          </ul>
          <p className="meta" style={{ marginTop: 14 }}>확인이 필요한 질문 {plan.questionIds.length}건 · <a href="/review">Review Inbox에서 확인</a></p>
        </section>
      ) : null}
    </div>
  );
}
