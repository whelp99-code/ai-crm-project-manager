import { PilotWizardClient } from "./pilot-wizard-client";

export default function PilotPage() {
  const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  const workspaceId = process.env.WORKSPACE_ID ?? process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "";
  const defaultPrincipalId =
    process.env.OPERATOR_PRINCIPAL_ID ?? process.env.NEXT_PUBLIC_OPERATOR_PRINCIPAL_ID ?? "pilot-1";
  const defaultApproverId =
    process.env.APPROVER_PRINCIPAL_ID ?? process.env.NEXT_PUBLIC_APPROVER_PRINCIPAL_ID ?? "approver-1";

  return (
    <>
      <header>
        <h1>파일럿 온보딩 마법사</h1>
        <p className="lead">
          비개발자 파일럿 사용자가 명령 제출부터 승인, 완료까지 S0 루프를 직접 따라갈 수 있도록 안내하는 4단계 마법사입니다.
        </p>
        <p className="meta">
          <a href="/work">작업실</a> · <a href="/approvals">승인 인박스</a> · <a href="/monitor">모니터</a>
        </p>
      </header>
      <PilotWizardClient
        apiBase={apiBase}
        workspaceId={workspaceId}
        defaultPrincipalId={defaultPrincipalId}
        defaultApproverId={defaultApproverId}
      />
    </>
  );
}
