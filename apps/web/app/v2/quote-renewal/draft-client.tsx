"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import styles from "./draft.module.css";
import { RenewalEditor, isContractSource, isSavedRenewal, type ContractSource, type SavedRenewal } from "./renewal-editor";
import { ComparisonPanel, isComparisonData, type ComparisonData } from "./comparison-panel";

interface DraftQuote {
  readonly identity: string;
  readonly templateRef: string;
  readonly quote: {
    readonly versionLabel: string; readonly scope: string; readonly validUntil: string;
    readonly totalPriceKrw: string; readonly totalCostKrw: string;
    readonly bomLines: readonly { readonly id: string; readonly description: string;
      readonly quantity: number; readonly unitCostKrw: string; readonly unitPriceKrw: string }[];
  };
  readonly vat: { readonly netAmountKrw: string; readonly vatAmountKrw: string; readonly grossAmountKrw: string };
  readonly po: { readonly customerPoId: string; readonly supplierPoId: string };
}
interface DraftList {
  readonly runtimeVersion: number;
  readonly engagements: readonly { readonly id: string; readonly name: string; readonly version: number }[];
  readonly quoteDrafts: readonly DraftQuote[];
  readonly contracts: ContractSource[];
  readonly renewalDrafts: SavedRenewal[];
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function krw(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}
function draftList(value: unknown): value is DraftList {
  return object(value) && typeof value.runtimeVersion === "number"
    && Array.isArray(value.engagements) && value.engagements.every(item => object(item)
      && typeof item.id === "string" && typeof item.name === "string" && typeof item.version === "number")
    && Array.isArray(value.quoteDrafts) && value.quoteDrafts.every(item => object(item)
      && typeof item.identity === "string" && typeof item.templateRef === "string"
      && object(item.quote) && typeof item.quote.versionLabel === "string"
      && typeof item.quote.scope === "string" && typeof item.quote.validUntil === "string"
      && krw(item.quote.totalPriceKrw) && krw(item.quote.totalCostKrw)
      && Array.isArray(item.quote.bomLines) && item.quote.bomLines.every(line => object(line)
        && typeof line.id === "string" && typeof line.description === "string"
        && typeof line.quantity === "number" && krw(line.unitCostKrw) && krw(line.unitPriceKrw))
      && object(item.vat) && krw(item.vat.netAmountKrw) && krw(item.vat.vatAmountKrw) && krw(item.vat.grossAmountKrw)
      && object(item.po) && typeof item.po.customerPoId === "string" && typeof item.po.supplierPoId === "string")
    && Array.isArray(value.contracts) && value.contracts.every(isContractSource)
    && Array.isArray(value.renewalDrafts) && value.renewalDrafts.every(isSavedRenewal);
}
const money = (value: string) => `${BigInt(value).toLocaleString("ko-KR")} 원`;

export function DocumentDraftClient() {
  const [data, setData] = useState<DraftList | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [lineIds, setLineIds] = useState([0]);
  const [comparison, setComparison] = useState<ComparisonData | null>(null);
  const [comparing, setComparing] = useState(false);

  async function compare(renewalId: string, revisionId: string) {
    setComparing(true); setError(""); setComparison(null);
    try {
      const query = new URLSearchParams({ renewalId, revisionId });
      const response = await fetch(`/api/cwos/v2/document-drafts?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`계약 비교를 불러오지 못했습니다 (${response.status}). 세션과 초안을 확인하세요.`);
      const result: unknown = await response.json();
      if (!isComparisonData(result)) throw new Error("비교 응답을 읽지 못했습니다.");
      setComparison(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "비교 불러오기 실패"); }
    finally { setComparing(false); }
  }

  async function load() {
    const response = await fetch("/api/cwos/v2/document-drafts", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(response.status === 401 || response.status === 403
        ? "현재 로그인 세션을 확인하지 못했습니다. 다시 로그인해 주세요."
        : `초안을 불러오지 못했습니다 (${response.status}). 목록을 다시 불러오세요.`);
    }
    const parsed: unknown = await response.json();
    if (!draftList(parsed)) throw new Error("초안 응답을 읽지 못했습니다. 운영 상태를 확인하세요.");
    setData(parsed);
  }
  useEffect(() => {
    const connectSession = async () => {
      const response = await fetch("/api/self-entry", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const session: unknown = await response.json();
        if (object(session) && typeof session.csrf === "string") setCsrf(session.csrf);
      }
      await load();
    };
    void connectSession().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "초안을 불러오지 못했습니다."));
  }, []);

  async function connect(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPending(true); setError("");
    try {
      const proof: unknown = JSON.parse(await file.text());
      const response = await fetch("/api/cwos/v2/review-session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof),
      });
      if (!response.ok) throw new Error("owner 세션을 연결하지 못했습니다. 현재 인증에서 받은 JSON을 확인하세요.");
      const session: unknown = await response.json();
      if (!object(session) || typeof session.csrf !== "string") throw new Error("세션 응답이 올바르지 않습니다.");
      setCsrf(session.csrf);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "세션 연결을 실패했습니다.");
    } finally { setPending(false); event.target.value = ""; }
  }

  async function createQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !csrf) return;
    const fields = new FormData(event.currentTarget);
    const value = (key: string) => String(fields.get(key) ?? "").trim();
    const engagement = data.engagements.find(item => item.id === value("engagement"));
    if (!engagement) { setError("목록에서 프로젝트를 선택해 주세요."); return; }
    setPending(true); setError("");
    try {
      const lines = lineIds.map(id => ({
        id: `line-${id}`, sourceId: value(`source-${id}`), productId: value(`product-${id}`),
        description: value(`description-${id}`), quantity: Number(value(`quantity-${id}`)),
        unitCostKrw: value(`cost-${id}`), unitPriceKrw: value(`price-${id}`),
      }));
      if (lines.some(line => !/^\d+$/.test(line.unitPriceKrw) || !/^\d+$/.test(line.unitCostKrw))
        || !/^\d+$/.test(value("vat"))) throw new Error("원 단위 금액은 0 이상의 정수로 입력해 주세요.");
      const net = lines.reduce((sum, line) => sum + BigInt(line.unitPriceKrw) * BigInt(line.quantity), 0n);
      const vat = BigInt(value("vat"));
      const response = await fetch("/api/cwos/v2/document-drafts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          action: "QUOTE", expectedVersion: data.runtimeVersion,
          input: {
            engagement: { id: engagement.id, version: engagement.version }, lines,
            versionLabel: value("revision"), validUntil: value("validUntil"), scope: value("scope"),
            options: value("options").split("\n").map(item => item.trim()).filter(Boolean),
            templateRef: value("template"), po: { customerPoId: value("customerPo"), supplierPoId: value("supplierPo") },
            vat: { netAmountKrw: net.toString(), vatAmountKrw: vat.toString(), grossAmountKrw: (net + vat).toString() },
          },
        }),
      });
      if (!response.ok) {
        const failure: unknown = await response.json();
        throw new Error(`초안을 저장하지 못했습니다 (${response.status}${object(failure) && typeof failure.error === "string" ? ` · ${failure.error}` : ""}). 입력을 확인하거나 목록을 새로고침하세요.`);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "초안 저장을 실패했습니다.");
    } finally { setPending(false); }
  }

  return <div className={styles.page}>
    <header><p className={styles.muted}>W01 · W05 · 계약 초안</p><h1>견적·발주와 재계약</h1>
      <p>입력과 기존 자료로 초안을 만듭니다. 발송·서명·결제는 하지 않습니다.</p></header>
    <section className={styles.panel} aria-labelledby="session-title">
      <h2 id="session-title">현재 로그인 세션</h2>
      {!csrf && <label>운영 인증의 cookie·csrf JSON<input type="file" accept="application/json,.json" onChange={connect} disabled={pending} /></label>}
      <p className={styles.muted}>CRM 비밀번호·OTP로 확인한 세션을 사용합니다.</p>
    </section>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!data && !error && <p role="status">초안을 불러오는 중입니다.</p>}
    {data && <>
      <button type="button" disabled={pending} onClick={() => { setError(""); void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "불러오기 실패")); }}>목록 새로고침</button>
      <form className={styles.panel} onSubmit={createQuote}>
        <h2>1. 견적·발주 초안 만들기</h2>
        {data.engagements.length === 0 && <p>등록된 프로젝트가 없습니다. 기존 프로젝트 등록을 먼저 완료해 주세요.</p>}
        <div className={styles.grid}>
          <label>프로젝트<select name="engagement" required disabled={pending}><option value="">프로젝트 선택</option>{data.engagements.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>초안 버전<input name="revision" required maxLength={200} /></label>
          <label>견적 유효 기한<input name="validUntil" type="date" required /></label>
          <label>양식 근거<input name="template" required placeholder="기존 양식 이름 또는 문서 참조" /></label>
          <label>고객 발주 참조<input name="customerPo" required /></label>
          <label>공급사 발주 참조<input name="supplierPo" required /></label>
        </div>
        <label>범위·조건<textarea name="scope" required /></label>
        {lineIds.map((id, index) => <fieldset key={id}><legend>품목 {index + 1}</legend><div className={styles.grid}>
          <label>품목 근거<input name={`source-${id}`} required /></label>
          <label>제품 참조<input name={`product-${id}`} required /></label>
          <label>품목 설명<input name={`description-${id}`} required /></label>
          <label>수량<input name={`quantity-${id}`} type="number" min="1" step="1" required /></label>
          <label>매입 단가 (원)<input name={`cost-${id}`} inputMode="numeric" pattern="[0-9]+" required /></label>
          <label>판매 단가 (원)<input name={`price-${id}`} inputMode="numeric" pattern="[0-9]+" required /></label>
        </div></fieldset>)}
        <button type="button" disabled={pending || lineIds.length >= 100} onClick={() => setLineIds(ids => [...ids, (ids.at(-1) ?? 0) + 1])}>품목 추가</button>
        <button type="button" disabled={pending || lineIds.length === 1} onClick={() => setLineIds(ids => ids.slice(0, -1))}>마지막 품목 삭제</button>
        <label>옵션 (한 줄에 하나)<textarea name="options" /></label>
        <label>부가세 (원, 입력값)<input name="vat" inputMode="numeric" pattern="[0-9]+" required /></label>
        <p className={styles.muted}>양식 승인 여부는 확인하지 않은 초안입니다. 금액은 입력한 단가·수량·부가세로만 계산합니다.</p>
        <button className={styles.primary} disabled={pending || !csrf || data.engagements.length === 0}>{pending ? "저장 중…" : "견적·발주 초안 만들기"}</button>
      </form>
      <section className={styles.panel} aria-labelledby="saved-title"><h2 id="saved-title">저장된 견적·발주 초안</h2>
        {data.quoteDrafts.length === 0 && <p>아직 초안이 없습니다. 위에서 첫 초안을 만들어 주세요.</p>}
        {data.quoteDrafts.map(draft => <article key={draft.identity} className={styles.panel}>
          <h3>{draft.quote.versionLabel} · 미승인 초안</h3><p>{draft.quote.scope}</p>
          <p>유효 기한 {draft.quote.validUntil} · 양식 {draft.templateRef}</p>
          {draft.quote.bomLines.map(line => <p key={line.id}>{line.description} · 수량 {line.quantity} · 판매 단가 {money(line.unitPriceKrw)} · 매입 단가 {money(line.unitCostKrw)}</p>)}
          <div className={styles.grid}>
            <div><h4>견적·고객 발주 초안</h4><p>{draft.po.customerPoId}</p><p>공급가 {money(draft.vat.netAmountKrw)} · 부가세 {money(draft.vat.vatAmountKrw)} · 합계 {money(draft.vat.grossAmountKrw)}</p></div>
            <div><h4>공급사 발주 초안</h4><p>{draft.po.supplierPoId}</p><p>매입 합계 {money(draft.quote.totalCostKrw)} · 매입 부가세 미확인</p></div>
          </div>
        </article>)}
      </section>
      <RenewalEditor contracts={data.contracts} drafts={data.renewalDrafts}
        runtimeVersion={data.runtimeVersion} csrf={csrf} onSaved={load}
        compareBusy={comparing}
        onCompare={(renewalId, revisionId) => { void compare(renewalId, revisionId); }} />
      {comparing && <p role="status">원본과 재계약 초안을 비교하는 중입니다.</p>}
      {comparison && <ComparisonPanel data={comparison} />}
    </>}
  </div>;
}
