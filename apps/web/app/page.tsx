import { S1CreateWorkClient } from "./s1-create-work-client";

interface Overview {
  sectionOrder: string[];
  customer: { id: string; name: string; status: string; version: number };
  exceptions: Array<{ id: string; title: string; severity: string; occurredAt: string }>;
  nextActions: Array<{ id: string; title: string; dueAt: string; priority: number }>;
  contracts: Array<{ id: string; title: string; scope: string; effectiveFrom: string; valueKrw?: string }>;
  projects: Array<{ id: string; name: string; status: string; progress: number }>;
  communications: Array<{ id: string; channel: string; summary: string; occurredAt: string }>;
  finance: { status: "pending" } | {
    status: "available";
    asOf: string;
    cashKrw: string;
    receivableKrw: string;
    payableKrw: string;
    projectMarginKrw: string;
  };
}

type LoadResult = { ok: true; overview: Overview } | { ok: false; message: string };

async function loadOverview(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const customerId = process.env.DEMO_CUSTOMER_ID;
  if (!apiBase || !workspaceId || !customerId) {
    return { ok: false, message: "API_BASE_URL, WORKSPACE_ID, DEMO_CUSTOMER_ID 서버 설정이 필요합니다." };
  }
  try {
    const response = await fetch(`${apiBase}/api/customers/${encodeURIComponent(customerId)}/overview`, {
      headers: { "x-workspace-id": workspaceId },
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, message: `고객 정보를 불러오지 못했습니다. API 상태: ${response.status}` };
    return { ok: true, overview: await response.json() as Overview };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

function Empty({ children }: Readonly<{ children: string }>) {
  return <p className="empty">{children}</p>;
}

export default async function CustomerOverviewPage() {
  const result = await loadOverview();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="unavailable-title">
        <h1 id="unavailable-title">고객 운영 화면을 사용할 수 없습니다</h1>
        <p>{result.message}</p>
        <p className="meta">임시 고객이나 재무 수치를 대신 표시하지 않습니다.</p>
      </section>
    );
  }

  const { overview } = result;
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId =
    process.env.DEMO_PRINCIPAL_ID ??
    process.env.OPERATOR_PRINCIPAL_ID ??
    process.env.NEXT_PUBLIC_OPERATOR_PRINCIPAL_ID ??
    "operator-1";
  const canCreateWork = Boolean(apiBase && workspaceId);
  const primaryProjectId = overview.projects[0]?.id;
  const primaryNextAction = overview.nextActions[0]?.title;

  return (
    <>
      <header>
        <h1>{overview.customer.name}</h1>
        <p className="lead">예외와 다음 행동을 먼저 확인하고, 고객·계약·프로젝트 맥락을 한 화면에서 판단합니다.</p>
        <p className="meta">
          <a href="/work">에이전트 작업실</a> · <a href="/approvals">승인 인박스</a>
        </p>
      </header>

      <div className="stack">
        <section className="panel panel-critical" aria-labelledby="exceptions-title">
          <h2 id="exceptions-title">즉시 확인할 예외</h2>
          {overview.exceptions.length === 0 ? <Empty>열린 예외가 없습니다.</Empty> : (
            <ul className="list">
              {overview.exceptions.map((item) => (
                <li key={item.id}><strong>{item.title}</strong> <span className="meta">{item.severity} · {item.occurredAt}</span></li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel panel-action" aria-labelledby="actions-title">
          <h2 id="actions-title">다음 행동</h2>
          {overview.nextActions.length === 0 ? <Empty>대기 중인 다음 행동이 없습니다.</Empty> : (
            <ol className="list">
              {overview.nextActions.map((item) => (
                <li key={item.id}><strong>{item.title}</strong> <span className="meta">우선순위 {item.priority} · 기한 {item.dueAt}</span></li>
              ))}
            </ol>
          )}
          {canCreateWork && apiBase && workspaceId ? (
            <div style={{ marginTop: 12 }}>
              <S1CreateWorkClient
                apiBase={apiBase}
                workspaceId={workspaceId}
                principalId={principalId}
                customerId={overview.customer.id}
                customerName={overview.customer.name}
                {...(primaryProjectId ? { projectId: primaryProjectId } : {})}
                {...(primaryNextAction ? { nextActionTitle: primaryNextAction } : {})}
              />
            </div>
          ) : (
            <p className="meta" style={{ marginTop: 12 }}>
              일감 생성은 API_BASE_URL·WORKSPACE_ID 설정이 있을 때만 가능합니다.
            </p>
          )}
        </section>

        <section className="panel" aria-labelledby="status-title">
          <h2 id="status-title">고객 상태</h2>
          <div className="status-row">
            <span className="status">{overview.customer.status}</span>
            <span className="meta">고객 ID {overview.customer.id} · 데이터 버전 {overview.customer.version}</span>
          </div>
        </section>

        <section className="panel" aria-labelledby="contracts-title">
          <h2 id="contracts-title">계약</h2>
          {overview.contracts.length === 0 ? <Empty>등록된 계약이 없습니다.</Empty> : (
            <div className="grid">{overview.contracts.map((contract) => (
              <article key={contract.id}>
                <h3>{contract.title}</h3>
                <p>{contract.scope}</p>
                <p className="meta">효력 시작 {contract.effectiveFrom}{contract.valueKrw ? ` · ${contract.valueKrw} KRW` : ""}</p>
              </article>
            ))}</div>
          )}
        </section>

        <section className="panel" aria-labelledby="projects-title">
          <h2 id="projects-title">납품 프로젝트</h2>
          {overview.projects.length === 0 ? <Empty>진행 중인 납품 프로젝트가 없습니다.</Empty> : (
            <table><thead><tr><th>프로젝트</th><th>상태</th><th>산출물 진행</th></tr></thead><tbody>
              {overview.projects.map((project) => (
                <tr key={project.id}><td>{project.name}</td><td>{project.status}</td><td>{Math.round(project.progress * 100)}%</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="panel" aria-labelledby="communications-title">
          <h2 id="communications-title">최근 소통</h2>
          {overview.communications.length === 0 ? <Empty>기록된 소통이 없습니다.</Empty> : (
            <ul className="list">{overview.communications.map((item) => (
              <li key={item.id}><strong>{item.channel}</strong> {item.summary} <span className="meta">{item.occurredAt}</span></li>
            ))}</ul>
          )}
        </section>

        <section className={`panel${overview.finance.status === "pending" ? " panel-pending" : ""}`} aria-labelledby="finance-title">
          <h2 id="finance-title">재무</h2>
          {overview.finance.status === "pending" ? (
            <p>재무 프로젝션은 아직 연결되지 않았습니다. 수치를 0으로 대체하지 않습니다.</p>
          ) : (
            <table><thead><tr><th>기준일</th><th>현금</th><th>받을 금액</th><th>지급 금액</th><th>프로젝트 마진</th></tr></thead><tbody><tr>
              <td>{overview.finance.asOf}</td><td>{overview.finance.cashKrw} KRW</td><td>{overview.finance.receivableKrw} KRW</td>
              <td>{overview.finance.payableKrw} KRW</td><td>{overview.finance.projectMarginKrw} KRW</td>
            </tr></tbody></table>
          )}
        </section>
      </div>
    </>
  );
}
