import { withOwnerCookie } from "../owner-server";
import { RecordList } from "../record-list";
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
    const response = await fetch(`${apiBase}/api/cwos/finance`, await withOwnerCookie({
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
      },
      cache: "no-store",
    }));
    if (!response.ok) {
      return { ok: false, message: `재무 목록을 불러오지 못했습니다. API 상태: ${response.status}` };
    }
    const body = await response.json() as { count: number; totals: { IN: MoneyTotals; OUT: MoneyTotals }; items: FinanceItem[] };
    return { ok: true, count: body.count, totals: body.totals, items: body.items };
  } catch {
    return { ok: false, message: "API에 연결할 수 없습니다. 운영 상태와 서버 설정을 확인하세요." };
  }
}

function TotalCard({ title, totals, testId, tone }: { title: string; totals: MoneyTotals; testId: string; tone: "in" | "out" }) {
  return (
    <section className="panel" data-testid={testId}>
      <h2><span className={`chip chip-${tone}`}>{title}</span></h2>
      <p className="money-gross">{formatKrw(totals.gross)}원</p>
      <p className="money-bits" data-testid={`${testId}-figures`}>
        <span>공급가 {formatKrw(totals.net)}</span>
        <span>부가세 {formatKrw(totals.vat)}</span>
      </p>
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
        <p className="lead">노션에서 가져온 금액 {result.count}건</p>
      </header>
      <div className="stack">
      <div className="grid">
        <TotalCard title="매출" totals={result.totals.IN} testId="finance-in" tone="in" />
        <TotalCard title="매입" totals={result.totals.OUT} testId="finance-out" tone="out" />
      </div>
      <section className="panel" aria-labelledby="finance-list-title">
        <h2 id="finance-list-title" className="visually-hidden">재무 항목</h2>
        <p className="meta" data-testid="finance-count">표시 {result.items.length} / 합계 {result.count}</p>
        <RecordList
          placeholder="거래처 검색"
          empty={result.items.length === 0 ? "표시할 재무 항목이 없습니다." : "찾는 거래처가 없습니다."}
          items={result.items.map((item) => ({
            id: item.id,
            name: item.counterparty ?? "거래처 없음",
            chips: [item.direction === "IN"
              ? { text: directionLabel(item.direction), tone: "in" as const }
              : item.direction === "OUT"
                ? { text: directionLabel(item.direction), tone: "out" as const }
                : { text: directionLabel(item.direction) }],
            sub: item.expected_date,
            amount: formatKrw(item.gross_amount_krw),
          }))}
        />
      </section>
      </div>
    </>
  );
}
