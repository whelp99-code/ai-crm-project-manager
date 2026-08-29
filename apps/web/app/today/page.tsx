export const dynamic = "force-dynamic";

interface BriefingResponse {
  runtimeVersion: number;
  briefing: null | {
    headline: string;
    expectedIn7DaysKrw: string;
    expectedOut7DaysKrw: string;
    netCash7DaysKrw: string;
    openClarifications: number;
    dueTodayCommitmentIds: string[];
  };
  findings: Array<{ id: string; severity: string; title: string; explanation: string; recommendedAction: string }>;
}

async function loadBriefing(): Promise<BriefingResponse | null> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId = process.env.OPERATOR_PRINCIPAL_ID ?? process.env.DEMO_PRINCIPAL_ID;
  const apiToken = process.env.API_AUTH_TOKEN ?? process.env.AUTH_API_KEY;
  if (!apiBase || !workspaceId || !principalId || !apiToken) return null;
  const response = await fetch(`${apiBase}/api/cwos/v2.5/briefing`, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-workspace-id": workspaceId,
      "x-principal-id": principalId,
      "x-principal-kind": "human",
      "x-step-up": "true",
    },
    cache: "no-store",
  });
  return response.ok ? await response.json() as BriefingResponse : null;
}

export default async function TodayPage() {
  const result = await loadBriefing();
  if (!result) return <section className="error"><h1>Today Briefing을 불러오지 못했습니다</h1><p>API와 서버 인증 환경설정을 확인하세요.</p></section>;
  if (!result.briefing) return <section className="panel"><h1>Today</h1><p>아직 AI Manager를 실행한 기록이 없습니다.</p></section>;
  return (
    <>
      <header><h1>Today</h1><p className="lead">{result.briefing.headline}</p></header>
      <div className="grid">
        <section className="panel"><h2>7일 예상 입금</h2><strong>{Number(result.briefing.expectedIn7DaysKrw).toLocaleString("ko-KR")}원</strong></section>
        <section className="panel"><h2>7일 예상 출금</h2><strong>{Number(result.briefing.expectedOut7DaysKrw).toLocaleString("ko-KR")}원</strong></section>
        <section className={`panel${Number(result.briefing.netCash7DaysKrw) < 0 ? " panel-critical" : ""}`}><h2>7일 순현금</h2><strong>{Number(result.briefing.netCash7DaysKrw).toLocaleString("ko-KR")}원</strong></section>
        <section className="panel"><h2>확인 대기</h2><strong>{result.briefing.openClarifications}건</strong></section>
      </div>
      <section className="panel" style={{ marginTop: 18 }}>
        <h2>AI Manager 경고</h2>
        {result.findings.length === 0 ? <p className="empty">열린 경고가 없습니다.</p> : (
          <ul className="list">{result.findings.map((finding) => (
            <li key={finding.id}><strong>{finding.severity} · {finding.title}</strong><div>{finding.explanation}</div><div className="meta">권고: {finding.recommendedAction}</div></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
