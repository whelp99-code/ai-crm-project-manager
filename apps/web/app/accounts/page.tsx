import { withOwnerCookie } from "../owner-server";
import { RecordList } from "../record-list";
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
    const response = await fetch(`${apiBase}/api/cwos/accounts`, await withOwnerCookie({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    }));
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
        <p className="lead">노션에서 가져온 고객 {result.count}곳</p>
      </header>
      <section className="panel" aria-labelledby="account-list-title">
        <h2 id="account-list-title" className="visually-hidden">계정 목록</h2>
        <p className="meta" data-testid="account-count">표시 {result.accounts.length} / 합계 {result.count}</p>
        <RecordList
          placeholder="이름 검색"
          empty="찾는 계정이 없습니다."
          items={result.accounts.map((account) => ({
            id: account.id,
            name: account.name,
            chips: [
              { text: statusLabel(account.status) },
              ...parseKinds(account.kinds).map((kind) => ({ text: kindLabel(kind) })),
            ],
            sub: "",
          }))}
        />
      </section>
    </>
  );
}
