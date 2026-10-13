import { DecideClient } from "./decide-client";

export const dynamic = "force-dynamic";

interface ControlRequest {
  id: string;
  actionType: string;
  kind: "APPROVAL" | "CHECKPOINT";
  status: string;
  resourceId: string;
  requesterPrincipalId: string;
}

interface NotificationRecord {
  id: string;
  subjectId: string;
  status: string;
  attempts: number;
}

interface FinalReport {
  id: string;
  projectId: string;
  status: string;
  submittedByPrincipalId: string;
  rejectionReason?: string;
}

type LoadResult =
  | {
      ok: true;
      controls: ControlRequest[];
      notifications: NotificationRecord[];
      reports: FinalReport[];
      apiBase: string;
      workspaceId: string;
    }
  | { ok: false; message: string };

async function fetchJson<T>(base: string, ws: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers: { "x-workspace-id": ws }, cache: "no-store" });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
}

async function load(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  if (!apiBase || !workspaceId) {
    return { ok: false, message: "API_BASE_URL, WORKSPACE_ID 서버 설정이 필요합니다." };
  }
  try {
    const [controls, notifications, reports] = await Promise.all([
      fetchJson<ControlRequest[]>(apiBase, workspaceId, "/api/governance/controls?status=PENDING"),
      fetchJson<NotificationRecord[]>(apiBase, workspaceId, "/api/notifications"),
      fetchJson<FinalReport[]>(apiBase, workspaceId, "/api/reports").catch(() => [] as FinalReport[]),
    ]);
    return { ok: true, controls, notifications, reports, apiBase, workspaceId };
  } catch {
    return { ok: false, message: "승인/알림 데이터를 불러오지 못했습니다. 운영 상태를 확인하세요." };
  }
}

function Empty({ children }: Readonly<{ children: string }>) {
  return <p className="empty">{children}</p>;
}

export default async function ApprovalsPage() {
  const result = await load();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="unavailable-title">
        <h1 id="unavailable-title">승인 화면을 사용할 수 없습니다</h1>
        <p>{result.message}</p>
        <p className="meta">대기 중인 통제나 알림을 임의 값으로 대체하지 않습니다.</p>
      </section>
    );
  }

  const { controls, notifications, reports, apiBase, workspaceId } = result;
  const approverId =
    process.env.APPROVER_PRINCIPAL_ID ?? process.env.NEXT_PUBLIC_APPROVER_PRINCIPAL_ID ?? "approver-1";
  return (
    <>
      <header>
        <h1>승인 · 예외 인박스</h1>
        <p className="lead">보호 대상 조치는 등록된 통제와 사람 승인, 감사 증적을 통과해야 실행됩니다.</p>
      </header>

      <div className="stack">
        <section className="panel panel-critical" aria-labelledby="controls-title">
          <h2 id="controls-title">대기 중 통제</h2>
          {controls.length === 0 ? <Empty>대기 중인 승인/체크포인트가 없습니다.</Empty> : (
            <table><thead><tr><th>조치</th><th>종류</th><th>대상</th><th>요청자</th></tr></thead><tbody>
              {controls.map((control) => (
                <tr key={control.id}>
                  <td>{control.actionType}</td>
                  <td>{control.kind === "APPROVAL" ? "승인 필요" : "체크포인트"}</td>
                  <td>{control.resourceId}</td>
                  <td>
                    {control.requesterPrincipalId}
                    <DecideClient
                      apiBase={apiBase}
                      workspaceId={workspaceId}
                      controlId={control.id}
                      defaultApproverId={approverId}
                    />
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="panel panel-action" aria-labelledby="notifications-title">
          <h2 id="notifications-title">알림 수명주기</h2>
          {notifications.length === 0 ? <Empty>활성 알림이 없습니다.</Empty> : (
            <table><thead><tr><th>대상</th><th>상태</th><th>시도</th></tr></thead><tbody>
              {notifications.map((item) => (
                <tr key={item.id}><td>{item.subjectId}</td><td>{item.status}</td><td>{item.attempts}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>

        <section className="panel" aria-labelledby="reports-title">
          <h2 id="reports-title">최종 보고</h2>
          {reports.length === 0 ? <Empty>제출된 최종 보고가 없습니다.</Empty> : (
            <table><thead><tr><th>보고</th><th>프로젝트</th><th>상태</th><th>반려 사유</th></tr></thead><tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>{report.id}</td><td>{report.projectId}</td><td>{report.status}</td>
                  <td>{report.rejectionReason ?? "—"}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </section>
      </div>
    </>
  );
}
