import { stageLabel } from "./labels";

export const dynamic = "force-dynamic";

interface EngagementRow {
  id: string;
  name: string;
  stage: string;
  account_name: string | null;
}

type LoadResult =
  | { ok: true; count: number; engagements: EngagementRow[] }
  | { ok: false; message: string };

async function loadEngagements(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (!apiBase || !workspaceId || !apiKey) {
    return { ok: false, message: "API_BASE_URL, WORKSPACE_ID, AUTH_API_KEY 서버 설정이 필요합니다." };
  }
  try {
    const response = await fetch(`${apiBase}/api/cwos/engagements`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, message: `프로젝트 목록을 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    const body = await response.json() as { count: number; engagements: EngagementRow[] };
    return { ok: true, count: body.count, engagements: body.engagements };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

export default async function EngagementsPage() {
  const result = await loadEngagements();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="engagements-unavailable-title">
        <h1 id="engagements-unavailable-title">프로젝트 목록을 사용할 수 없습니다</h1>
        <p>{result.message}</p>
      </section>
    );
  }
  return (
    <>
      <header>
        <h1>프로젝트 {result.count}</h1>
        <p className="lead">정규 테이블의 프로젝트입니다. 동기화로 보관된 행은 이 목록에 없습니다.</p>
      </header>
      <section className="panel" aria-labelledby="engagement-list-title">
        <h2 id="engagement-list-title">프로젝트 목록</h2>
        <p className="meta" data-testid="engagement-count">표시 {result.engagements.length} / 합계 {result.count}</p>
        {result.engagements.length === 0 ? <p className="empty">표시할 프로젝트가 없습니다.</p> : (
          <table className="data-table">
            <thead>
              <tr><th>이름</th><th>단계</th><th>계정</th></tr>
            </thead>
            <tbody>
              {result.engagements.map((engagement) => (
                <tr key={engagement.id}>
                  <td data-label="이름">{engagement.name}</td>
                  <td data-label="단계">{stageLabel(engagement.stage)}</td>
                  <td data-label="계정">{engagement.account_name ?? <span className="empty">연결 계정 없음</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
