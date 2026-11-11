import { WorkClient } from "./work-client";

export const dynamic = "force-dynamic";

export default function WorkPage() {
  const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID ?? process.env.NEXT_PUBLIC_WORKSPACE_ID;
  if (!apiBase || !workspaceId) {
    return (
      <section className="error" aria-labelledby="unavailable-title">
        <h1 id="unavailable-title">작업실을 사용할 수 없습니다</h1>
        <p>API_BASE_URL(또는 NEXT_PUBLIC_API_BASE_URL)과 WORKSPACE_ID 서버 설정이 필요합니다.</p>
        <p className="meta">가짜 job/work item으로 화면을 채우지 않습니다.</p>
      </section>
    );
  }

  return (
    <>
      <header>
        <h1>에이전트 작업실</h1>
        <p className="lead">
          자연어 명령은 모델 게이트웨이 서비스 주체로 계획을 세운 뒤, 화이트리스트 ActionType과 거버넌스 통제를 거쳐 적용됩니다.
        </p>
        <p className="meta">
          <a href="/">고객 개요</a> · <a href="/approvals">승인 인박스</a>
        </p>
      </header>
      <WorkClient />
    </>
  );
}
