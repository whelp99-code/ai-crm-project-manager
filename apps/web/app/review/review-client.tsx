"use client";

import { useState } from "react";

export interface ReviewQuestion {
  id: string;
  kind: "baseline" | "capture" | "clarification";
  prompt: string;
  options: Array<{ id: string; label: string; value: unknown }>;
}

export function ReviewClient(props: {
  initialVersion: number;
  questions: ReviewQuestion[];
}) {
  const [runtimeVersion, setRuntimeVersion] = useState(props.initialVersion);
  const [questions, setQuestions] = useState(props.questions);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(question: ReviewQuestion, value: unknown) {
    setBusyId(question.id);
    setError(null);
    try {
      const command = question.kind === "baseline" ? "baseline.answer" : question.kind === "capture" ? "capture.answer" : "clarification.answer";
      const payload = question.kind === "baseline"
        ? { questionId: question.id, answer: value }
        : question.kind === "capture"
          ? { questionId: question.id, answer: value }
          : { taskId: question.id, answer: value, answeredAt: new Date().toISOString() };
      const response = await fetch("/api/cwos/v2.5/commands", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `review-${question.id}-${Date.now()}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ command, expectedVersion: runtimeVersion, payload }),
      });
      const result = await response.json() as { runtimeVersion?: number; message?: string };
      if (!response.ok || result.runtimeVersion === undefined) throw new Error(result.message ?? `확인값 저장 실패 (${response.status})`);
      setRuntimeVersion(result.runtimeVersion);
      setQuestions((items) => items.filter((item) => item.id !== question.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "확인값을 저장하지 못했습니다.");
    } finally {
      setBusyId(null);
    }
  }

  if (questions.length === 0) return <p className="empty">확인할 질문이 없습니다.</p>;
  return (
    <div className="stack">
      {questions.map((question) => (
        <article key={question.id} className="panel">
          <h3>{question.prompt}</h3>
          {question.options.length > 0 ? (
            <div className="status-row">
              {question.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void answer(question, option.value)}
                  style={{ padding: "8px 12px" }}
                >
                  {busyId === question.id ? "저장 중…" : option.label}
                </button>
              ))}
              <button type="button" disabled={busyId !== null} onClick={() => void answer(question, "DEFER")} style={{ padding: "8px 12px" }}>나중에</button>
            </div>
          ) : <p className="meta">선택지가 없는 항목은 상세 편집에서 직접 입력해야 합니다.</p>}
        </article>
      ))}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
