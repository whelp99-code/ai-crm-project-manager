import { withOwnerCookie } from "../owner-server";
import { RecordList } from "../record-list";
import { stageLabel } from "./labels";

export const dynamic = "force-dynamic";

interface EngagementRow {
  id: string;
  name: string;
  stage: string;
  source_stage?: string | null;
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
    const response = await fetch(`${apiBase}/api/cwos/engagements`, await withOwnerCookie({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    }));
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
        <p className="lead">노션에서 가져온 프로젝트 {result.count}건</p>
      </header>
      <section className="panel" aria-labelledby="engagement-list-title">
        <h2 id="engagement-list-title" className="visually-hidden">프로젝트 목록</h2>
        <p className="meta" data-testid="engagement-count">표시 {result.engagements.length} / 합계 {result.count}</p>
        <RecordList
          placeholder="프로젝트 이름 검색"
          empty={result.engagements.length === 0 ? "표시할 프로젝트가 없습니다." : "찾는 프로젝트가 없습니다."}
          items={result.engagements.map((engagement) => ({
            id: engagement.id,
            name: engagement.name,
            chips: [{ text: stageLabel(engagement.stage, engagement.source_stage) }],
            sub: engagement.account_name ?? "연결 계정 없음",
          }))}
        />
      </section>
    </>
  );
}
