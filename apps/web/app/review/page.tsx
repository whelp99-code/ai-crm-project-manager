import { ReviewClient, type ReviewQuestion } from "./review-client";

export const dynamic = "force-dynamic";

interface ReviewResponse {
  runtimeVersion: number;
  stateHash: string;
  review: {
    baselineQuestions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string; value: unknown }> }>;
    capturePlans: Array<{ id: string; sourceId: string; mutations: Array<{ id: string; category: string; confidence: number; risk: string; rationale: string }> }>;
    captureQuestions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string; value: unknown }> }>;
    clarificationTasks: Array<{ id: string; prompt: string; priority: number; options: Array<{ id: string; label: string; value: unknown }> }>;
    syncItems: Array<{ id: string; sourceRef: string; status: string; failureCode: string | null }>;
  };
}

async function loadReview(): Promise<ReviewResponse | null> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId = process.env.OPERATOR_PRINCIPAL_ID ?? process.env.DEMO_PRINCIPAL_ID;
  const apiToken = process.env.API_AUTH_TOKEN ?? process.env.AUTH_API_KEY;
  if (!apiBase || !workspaceId || !principalId || !apiToken) return null;
  const response = await fetch(`${apiBase}/api/cwos/v2.5/review`, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-workspace-id": workspaceId,
      "x-principal-id": principalId,
      "x-principal-kind": "human",
      "x-step-up": "true",
    },
    cache: "no-store",
  });
  return response.ok ? await response.json() as ReviewResponse : null;
}

export default async function ReviewPage() {
  const result = await loadReview();
  if (!result) {
    return <section className="error"><h1>Review Inbox를 불러오지 못했습니다</h1><p>API와 서버 인증 환경설정을 확인하세요.</p></section>;
  }
  const questions: ReviewQuestion[] = [
    ...result.review.baselineQuestions.map((item) => ({ ...item, kind: "baseline" as const })),
    ...result.review.captureQuestions.map((item) => ({ ...item, kind: "capture" as const })),
    ...result.review.clarificationTasks.map((item) => ({ ...item, kind: "clarification" as const })),
  ];
  const total = questions.length + result.review.syncItems.length;
  return (
    <>
      <header>
        <h1>AI Review Inbox</h1>
        <p className="lead">AI가 확신하지 못한 내용과 고위험 변경만 확인합니다. 확실한 내용을 다시 입력할 필요가 없습니다.</p>
        <p className="meta">Runtime {result.runtimeVersion} · 확인 대기 {total}건</p>
      </header>
      <div className="stack">
        <section className="panel panel-action">
          <h2>입력별 업데이트 계획</h2>
          {result.review.capturePlans.length === 0 ? <p className="empty">검토할 업데이트 계획이 없습니다.</p> : (
            <ul className="list">{result.review.capturePlans.map((plan) => (
              <li key={plan.id}><strong>{plan.sourceId}</strong> · {plan.mutations.length}개 변경 후보
                <ul>{plan.mutations.map((mutation) => <li key={mutation.id}>{mutation.category} · {Math.round(mutation.confidence * 100)}% · {mutation.risk}</li>)}</ul>
              </li>
            ))}</ul>
          )}
        </section>
        <section>
          <h2>짧은 확인 질문</h2>
          <ReviewClient initialVersion={result.runtimeVersion} questions={questions} />
        </section>
        <section className="panel panel-critical">
          <h2>격리·동기화 문제</h2>
          {result.review.syncItems.length === 0 ? <p className="empty">격리되거나 실패한 외부 입력이 없습니다.</p> : (
            <ul className="list">{result.review.syncItems.map((item) => <li key={item.id}><strong>{item.status}</strong> {item.sourceRef} <span className="meta">{item.failureCode}</span></li>)}</ul>
          )}
        </section>
      </div>
    </>
  );
}
