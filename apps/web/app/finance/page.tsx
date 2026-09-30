import { directionLabel, formatKrw } from "./labels";

export const dynamic = "force-dynamic";

interface MoneyTotals {
  net: string;
  vat: string;
  gross: string;
}

interface FinanceItem {
  id: string;
  direction: string;
  gross_amount_krw: string;
  expected_date: string;
  counterparty: string | null;
}

type LoadResult =
  | { ok: true; count: number; totals: { IN: MoneyTotals; OUT: MoneyTotals }; items: FinanceItem[] }
  | { ok: false; message: string };

async function loadFinance(): Promise<LoadResult> {
  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (!apiBase || !workspaceId || !apiKey) {
    return { ok: false, message: "API_BASE_URL, WORKSPACE_ID, AUTH_API_KEY 서버 설정이 필요합니다." };
  }
  try {
    const response = await fetch(`${apiBase}/api/cwos/finance`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, message: `재무 목록을 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    const body = await response.json() as { count: number; totals: { IN: MoneyTotals; OUT: MoneyTotals }; items: FinanceItem[] };
    return { ok: true, count: body.count, totals: body.totals, items: body.items };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

function TotalCard({ title, totals, testId }: { title: string; totals: MoneyTotals; testId: string }) {
  return (
    <section className="panel" data-testid={testId}>
      <h2>{title}</h2>
      <p className="meta">공급가액 · 부가세 · 합계</p>
      <p data-testid={`${testId}-figures`}>{formatKrw(totals.net)} / {formatKrw(totals.vat)} / {formatKrw(totals.gross)}원</p>
    </section>
  );
}

export default async function FinancePage() {
  const result = await loadFinance();
  if (!result.ok) {
    return (
      <section className="error" aria-labelledby="finance-unavailable-title">
        <h1 id="finance-unavailable-title">재무 목록을 사용할 수 없습니다</h1>
        <p>{result.message}</p>
      </section>
    );
  }
  return (
    <>
      <header>
        <h1>재무 {result.count}</h1>
        <p className="lead">정규 테이블에서 집계한 금액입니다. 동기화로 보관된 행은 합계와 목록에 없습니다.</p>
      </header>
      <div className="stack">
      <div className="grid">
        <TotalCard title="매출" totals={result.totals.IN} testId="finance-in" />
        <TotalCard title="매입" totals={result.totals.OUT} testId="finance-out" />
      </div>
      <section className="panel" aria-labelledby="finance-list-title">
        <h2 id="finance-list-title">재무 항목</h2>
        <p className="meta" data-testid="finance-count">표시 {result.items.length} / 합계 {result.count}</p>
        {result.items.length === 0 ? <p className="empty">표시할 재무 항목이 없습니다.</p> : (
          <table className="data-table">
            <thead>
              <tr><th>구분</th><th>금액</th><th>날짜</th><th>거래처</th></tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="구분">{directionLabel(item.direction)}</td>
                  <td data-label="금액">{formatKrw(item.gross_amount_krw)}원</td>
                  <td data-label="날짜">{item.expected_date}</td>
                  <td data-label="거래처">{item.counterparty ?? <span className="empty">거래처 없음</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      </div>
    </>
  );
}
