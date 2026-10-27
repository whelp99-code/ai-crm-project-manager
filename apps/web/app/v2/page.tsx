export const dynamic = "force-dynamic";

interface Readiness {
  workspaceId: string;
  runtimeVersion: number;
  stateHash: string;
  openFindings: number;
  completedMilestones: string[];
  releaseManifests: number;
  ready: boolean;
}

type LoadResult =
  | { ok: true; readiness: Readiness }
  | { ok: false; message: string };

async function loadReadiness(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId =
    process.env.DEMO_PRINCIPAL_ID ??
    process.env.OPERATOR_PRINCIPAL_ID ??
    process.env.NEXT_PUBLIC_OPERATOR_PRINCIPAL_ID;
  if (!apiBase || !workspaceId || !principalId) {
    return {
      ok: false,
      message: "API_BASE_URL, WORKSPACE_ID, DEMO_PRINCIPAL_ID 서버 설정이 필요합니다.",
    };
  }

  const headers: Record<string, string> = {
    "x-workspace-id": workspaceId,
    "x-principal-id": principalId,
    "x-principal-kind": "human",
    "x-step-up": "true",
  };
  const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(`${apiBase}/api/cwos/v2/readiness`, {
      headers,
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, message: `v2 런타임 상태를 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    return { ok: true, readiness: await response.json() as Readiness };
  } catch {
    return { ok: false, message: "v2 API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

export default async function CustomerWorkOsV2Page() {
  const result = await loadReadiness();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="v2-unavailable-title">
        <h1 id="v2-unavailable-title">Customer Work OS v2 상태를 사용할 수 없습니다</h1>
        <p>{result.message}</p>
        <p className="meta">실행 증거가 없을 때 준비 상태를 임의로 표시하지 않습니다.</p>
      </section>
    );
  }

  const { readiness } = result;
  return (
    <>
      <header>
        <h1>Customer Work OS v2.0.0</h1>
        <p className="lead">Identity·PSA·Unified Inbox·Connector·Dynamic Graph·AI Council·Portal·Operations의 통합 런타임 상태입니다.</p>
        <p className="meta"><a href="/">고객 운영 화면</a> · <a href="/work">에이전트 작업실</a> · <a href="/approvals">승인 인박스</a></p>
      </header>

      <div className="stack">
        <section className={`panel${readiness.ready ? " panel-action" : " panel-critical"}`} aria-labelledby="v2-readiness-title">
          <h2 id="v2-readiness-title">릴리스 준비 상태</h2>
          <div className="status-row">
            <span className="status">{readiness.ready ? "READY" : "NOT READY"}</span>
            <span className="meta">Runtime version {readiness.runtimeVersion} · Open findings {readiness.openFindings}</span>
          </div>
        </section>

        <section className="panel" aria-labelledby="v2-milestones-title">
          <h2 id="v2-milestones-title">완료된 마일스톤</h2>
          {readiness.completedMilestones.length === 0 ? (
            <p className="empty">완료 증거가 등록된 마일스톤이 없습니다.</p>
          ) : (
            <ul className="list">
              {readiness.completedMilestones.map((version) => <li key={version}><strong>{version}</strong></li>)}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="v2-evidence-title">
          <h2 id="v2-evidence-title">상태 증거</h2>
          <table>
            <thead><tr><th>Workspace</th><th>State hash</th><th>Release manifests</th></tr></thead>
            <tbody><tr><td>{readiness.workspaceId}</td><td><code>{readiness.stateHash}</code></td><td>{readiness.releaseManifests}</td></tr></tbody>
          </table>
        </section>
      </div>
    </>
  );
}
