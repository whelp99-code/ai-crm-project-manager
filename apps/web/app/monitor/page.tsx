interface Metrics {
  status: string;
  agent: { jobsTotal: number; jobsByStatus: Record<string, number> };
  governance: {
    controlsTotal: number;
    controlsByStatus: Record<string, number>;
    intentsTotal: number;
    intentsByStatus: Record<string, number>;
  };
  dualWriteFailures: number;
  sse: { activeJobSubscriptions: number };
}

type LoadResult = { ok: true; metrics: Metrics; apiBase: string } | { ok: false; message: string };

async function loadMetrics(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!apiBase) {
    return { ok: false, message: "API_BASE_URL(또는 NEXT_PUBLIC_API_BASE_URL) 서버 설정이 필요합니다." };
  }
  try {
    // Read-only: /metrics carries no tenant data and requires no API key,
    // same posture as /health (see apps/api/src/app.ts). The monitor page
    // never issues domain PATCH/POST — mutations stay confined to
    // /api/agent/commands on the work page.
    const response = await fetch(`${apiBase}/metrics`, { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, message: `모니터 데이터를 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    return { ok: true, metrics: (await response.json()) as Metrics, apiBase };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

function StatusTable({ title, byStatus }: Readonly<{ title: string; byStatus: Record<string, number> }>) {
  const entries = Object.entries(byStatus);
  return (
    <section className="panel" aria-labelledby={`${title}-title`}>
      <h2 id={`${title}-title`}>{title}</h2>
      {entries.length === 0 ? (
        <p className="empty">데이터가 없습니다.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>상태</th>
              <th>건수</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([status, count]) => (
              <tr key={status}>
                <td>{status}</td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function MonitorPage() {
  const result = await loadMetrics();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="unavailable-title">
        <h1 id="unavailable-title">모니터를 사용할 수 없습니다</h1>
        <p>{result.message}</p>
        <p className="meta">가짜 지표로 화면을 채우지 않습니다.</p>
      </section>
    );
  }

  const { metrics } = result;
  return (
    <>
      <header>
        <h1>파일럿 모니터</h1>
        <p className="lead">
          운영 지표는 <code>GET /metrics</code>를 통해 읽기 전용으로 표시됩니다. 이 화면에서는 어떤 조치도 실행하지 않습니다.
        </p>
        <p className="meta">
          <a href="/work">작업실</a> · <a href="/approvals">승인 인박스</a>
        </p>
      </header>

      <div className="stack">
        <section className="panel" aria-labelledby="summary-title">
          <h2 id="summary-title">요약</h2>
          <div className="status-row">
            <span className="status">작업 {metrics.agent.jobsTotal}건</span>
            <span className="status">통제 {metrics.governance.controlsTotal}건</span>
            <span className="status">의도 {metrics.governance.intentsTotal}건</span>
            <span className="status">SSE 구독 {metrics.sse.activeJobSubscriptions}건</span>
            <span className="status">이중 기록 실패 {metrics.dualWriteFailures}건</span>
          </div>
        </section>

        <StatusTable title="작업 상태" byStatus={metrics.agent.jobsByStatus} />
        <StatusTable title="통제 상태" byStatus={metrics.governance.controlsByStatus} />
        <StatusTable title="의도 상태" byStatus={metrics.governance.intentsByStatus} />
      </div>
    </>
  );
}
