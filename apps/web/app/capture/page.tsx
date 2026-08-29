import { CaptureClient } from "./capture-client";

export default function CapturePage() {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId = process.env.OPERATOR_PRINCIPAL_ID ?? process.env.DEMO_PRINCIPAL_ID;
  if (!apiBase || !workspaceId || !principalId) {
    return (
      <section className="error">
        <h1>Universal Capture를 사용할 수 없습니다</h1>
        <p>API_BASE_URL, WORKSPACE_ID, OPERATOR_PRINCIPAL_ID 서버 설정이 필요합니다.</p>
      </section>
    );
  }
  return (
    <>
      <header>
        <h1>Universal Capture</h1>
        <p className="lead">메뉴를 찾아다니지 않고 메일·메모·회의 내용을 한 번 입력하면 AI가 여러 업무 항목으로 나눕니다.</p>
      </header>
      <CaptureClient apiBase={apiBase} workspaceId={workspaceId} principalId={principalId} />
    </>
  );
}
