import { kindLabel, parseKinds, statusLabel } from "./labels";

export const dynamic = "force-dynamic";

interface AccountRow {
  id: string;
  name: string;
  status: string;
  kinds: string;
}

type LoadResult =
  | { ok: true; count: number; accounts: AccountRow[] }
  | { ok: false; message: string };

async function loadAccounts(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (!apiBase || !workspaceId || !apiKey) {
    return { ok: false, message: "API_BASE_URL, WORKSPACE_ID, AUTH_API_KEY 서버 설정이 필요합니다." };
  }
  try {
    const response = await fetch(`${apiBase}/api/cwos/accounts`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, message: `계정 목록을 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    const body = await response.json() as { count: number; accounts: AccountRow[] };
    return { ok: true, count: body.count, accounts: body.accounts };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

export default async function AccountsPage() {
  const result = await loadAccounts();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="accounts-unavailable-title">
        <h1 id="accounts-unavailable-title">계정 목록을 사용할 수 없습니다</h1>
        <p>{result.message}</p>
      </section>
    );
  }
  return (
    <>
      <header>
        <h1>계정 {result.count}</h1>
        <p className="lead">Notion 스냅샷에서 정규 테이블로 반입된 계정입니다. 격리된 행은 이 목록에 없습니다.</p>
      </header>
      <section className="panel" aria-labelledby="account-list-title">
        <h2 id="account-list-title">계정 목록</h2>
        <p className="meta" data-testid="account-count">표시 {result.accounts.length} / 합계 {result.count}</p>
        <table className="account-table">
          <thead>
            <tr><th>이름</th><th>상태</th><th>구분</th></tr>
          </thead>
          <tbody>
            {result.accounts.map((account) => (
              <tr key={account.id}>
                <td data-label="이름">{account.name}</td>
                <td data-label="상태">{statusLabel(account.status)}</td>
                <td data-label="구분">
                  <span className="chips">
                    {parseKinds(account.kinds).map((kind) => (
                      <span className="chip" key={kind}>{kindLabel(kind)}</span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
