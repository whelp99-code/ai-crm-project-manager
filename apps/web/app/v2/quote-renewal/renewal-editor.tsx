"use client";

import { useState, type FormEvent } from "react";
import styles from "./draft.module.css";

export interface ContractItem { id: string; description: string; quantity: number; unitPriceKrw: string | null }
export interface ContractTerms {
  startDate: string | null; endDate: string | null; valueKrw: string | null;
  items: ContractItem[] | null; conditions: string[] | null;
}
export interface ContractSource {
  kind: "NORMALIZED" | "OWNER_INPUT"; id: string; version: number | null;
  reference: string; terms: ContractTerms;
}
export interface ContractDraft { source: ContractSource; terms: ContractTerms }
export interface SavedRenewal {
  id: string;
  revisions: { revisionId: string; revisionLabel: string; contractDraft?: ContractDraft }[];
  receipts: { revisionId: string; approvalStatus: "NOT_APPROVED"; status: "INTERNAL_CANDIDATE" }[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown) => value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
const money = (value: unknown) => value === null || (typeof value === "string" && /^\d+$/.test(value));
export function isContractTerms(value: unknown): value is ContractTerms {
  return object(value) && date(value.startDate) && date(value.endDate) && money(value.valueKrw)
    && (value.items === null || (Array.isArray(value.items) && value.items.every(item => object(item)
      && typeof item.id === "string" && typeof item.description === "string"
      && typeof item.quantity === "number" && money(item.unitPriceKrw))))
    && (value.conditions === null || (Array.isArray(value.conditions) && value.conditions.every(item => typeof item === "string")));
}
export function isContractSource(value: unknown): value is ContractSource {
  return object(value) && (value.kind === "NORMALIZED" || value.kind === "OWNER_INPUT")
    && typeof value.id === "string" && (value.version === null || typeof value.version === "number")
    && typeof value.reference === "string" && isContractTerms(value.terms);
}
export function isSavedRenewal(value: unknown): value is SavedRenewal {
  return object(value) && typeof value.id === "string"
    && Array.isArray(value.revisions) && value.revisions.every(item => object(item)
      && typeof item.revisionId === "string" && typeof item.revisionLabel === "string"
      && (item.contractDraft === undefined || (object(item.contractDraft)
        && isContractSource(item.contractDraft.source) && isContractTerms(item.contractDraft.terms))))
    && Array.isArray(value.receipts) && value.receipts.every(item => object(item)
      && typeof item.revisionId === "string" && item.approvalStatus === "NOT_APPROVED" && item.status === "INTERNAL_CANDIDATE");
}
const key = (source: ContractSource) => `${source.kind}:${source.id}:${source.version ?? "input"}`;
const krw = (value: string | null) => value === null ? "미확인" : `${BigInt(value).toLocaleString("ko-KR")} 원`;
function fieldsToTerms(fields: FormData, rows: number): ContractTerms {
  const text = (name: string) => String(fields.get(name) ?? "").trim();
  return {
    startDate: text("startDate") || null, endDate: text("endDate") || null,
    valueKrw: text("valueKrw") || null,
    items: fields.get("itemsUnknown") === "on" ? null : Array.from({ length: rows }, (_, index) => ({
      id: text(`itemId-${index}`), description: text(`itemDescription-${index}`),
      quantity: Number(text(`itemQuantity-${index}`)), unitPriceKrw: text(`itemPrice-${index}`) || null,
    })),
    conditions: text("conditions") ? text("conditions").split("\n").map(item => item.trim()).filter(Boolean) : null,
  };
}

export function RenewalEditor({ contracts, drafts, runtimeVersion, csrf, onSaved, onCompare, compareBusy }: {
  contracts: ContractSource[]; drafts: SavedRenewal[]; runtimeVersion: number;
  csrf: string | null; onSaved: () => Promise<void>;
  onCompare: (renewalId: string, revisionId: string) => void;
  compareBusy: boolean;
}) {
  const [selected, setSelected] = useState("__manual");
  const [manualSource, setManualSource] = useState<ContractSource | null>(null);
  const [sourceRows, setSourceRows] = useState(1);
  const [rows, setRows] = useState(1);
  const [sourceItemsUnknown, setSourceItemsUnknown] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const source = selected === "__manual" ? manualSource : contracts.find(item => key(item) === selected) ?? null;

  function connectSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const terms = fieldsToTerms(fields, sourceRows);
    if (!isContractTerms(terms)) { setError("원본 금액과 날짜를 확인해 주세요. 비어 있는 값은 미확인으로 저장합니다."); return; }
    setManualSource({ kind: "OWNER_INPUT", id: String(fields.get("sourceId") ?? "").trim(),
      version: null, reference: String(fields.get("reference") ?? "").trim(), terms });
    setRows(terms.items?.length || 1); setError("");
  }
  async function createRenewal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || !csrf) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cwos/v2/document-drafts", {
        method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          action: "RENEWAL", expectedVersion: runtimeVersion, renewalId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
          revisionLabel: String(fields.get("revisionLabel") ?? "").trim(),
          source: source.kind === "NORMALIZED" ? { kind: source.kind, id: source.id, version: source.version }
            : { kind: source.kind, id: source.id, reference: source.reference, terms: source.terms },
          terms: fieldsToTerms(fields, rows),
        }),
      });
      if (!response.ok) throw new Error(`재계약 초안을 저장하지 못했습니다 (${response.status}). 원본과 입력을 확인하거나 목록을 새로고침하세요.`);
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "재계약 저장 실패"); }
    finally { setBusy(false); }
  }

  return <section className={styles.panel} aria-labelledby="renewal-title">
    <h2 id="renewal-title">2. 기존 계약으로 재계약 초안 만들기</h2>
    <label>기존 계약<select value={selected} disabled={busy} onChange={event => {
      setSelected(event.target.value); setManualSource(null); setError("");
      const next = contracts.find(item => key(item) === event.target.value);
      setRows(next?.terms.items?.length || 1);
    }}>
      <option value="__manual">기존 계약 자료 직접 입력 (원본 검증 전)</option>
      {contracts.map(item => <option key={key(item)} value={key(item)}>{item.id} · {item.kind === "OWNER_INPUT" ? "직접 입력 · 미검증" : `등록 버전 ${item.version}`}</option>)}
    </select></label>
    {contracts.length === 0 && <p className={styles.muted}>등록된 계약이 없습니다. 보유한 기존 계약의 근거와 값을 직접 연결하세요. 계약을 새로 만들거나 원본을 변경하지 않습니다.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {selected === "__manual" && !manualSource && <form onSubmit={connectSource} className={styles.panel}>
      <h3>기존 계약 자료</h3>
      <div className={styles.grid}>
        <label>기존 계약 식별자<input name="sourceId" required /></label>
        <label>원본 문서 근거<input name="reference" required /></label>
        <label>기존 시작일<input name="startDate" type="date" /></label>
        <label>기존 종료일<input name="endDate" type="date" /></label>
        <label>기존 계약금액 (원)<input name="valueKrw" inputMode="numeric" pattern="[0-9]+" /></label>
      </div>
      <label className={styles.checkbox}><input name="itemsUnknown" type="checkbox" checked={sourceItemsUnknown} onChange={event => setSourceItemsUnknown(event.target.checked)} />원본 품목 미확인</label>
      {!sourceItemsUnknown && Array.from({ length: sourceRows }, (_, index) => <fieldset key={index}><legend>기존 품목 {index + 1}</legend><div className={styles.grid}>
        <label>품목 식별자<input name={`itemId-${index}`} required /></label>
        <label>품목 설명<input name={`itemDescription-${index}`} required /></label>
        <label>수량<input name={`itemQuantity-${index}`} type="number" min="1" step="1" required /></label>
        <label>단가 (원, 미확인은 비워두기)<input name={`itemPrice-${index}`} inputMode="numeric" pattern="[0-9]+" /></label>
      </div></fieldset>)}
      <button type="button" onClick={() => setSourceRows(value => value + 1)} disabled={sourceItemsUnknown || sourceRows >= 100}>기존 품목 추가</button>
      <button type="button" onClick={() => setSourceRows(value => value - 1)} disabled={sourceItemsUnknown || sourceRows === 1}>마지막 기존 품목 삭제</button>
      <label>기존 조건 (한 줄에 하나)<textarea name="conditions" /></label>
      <p className={styles.muted}>원본에서 확인한 값만 입력하세요. 비워둔 기간·금액·조건은 미확인입니다.</p>
      <button className={styles.primary}>계약 자료 연결</button>
    </form>}
    {source && <>
      <div className={styles.panel}>
        <h3>원본: {source.id}</h3><p>{source.reference}</p>
        <p>{source.kind === "OWNER_INPUT" ? "직접 입력 자료 · 원본 검증 전" : `등록된 원본 버전 ${source.version}`}</p>
        <p>{source.terms.startDate ?? "시작일 미확인"} → {source.terms.endDate ?? "종료일 미확인"} · {krw(source.terms.valueKrw)}</p>
      </div>
      <form key={key(source)} onSubmit={createRenewal} className={styles.panel}>
        <h3>재계약 변경값</h3>
        <label>재계약 초안 이름<input name="revisionLabel" required /></label>
        <div className={styles.grid}>
          <label>재계약 시작일<input name="startDate" type="date" defaultValue={source.terms.startDate ?? ""} required /></label>
          <label>재계약 종료일<input name="endDate" type="date" defaultValue={source.terms.endDate ?? ""} required /></label>
          <label>재계약 금액 (원)<input name="valueKrw" inputMode="numeric" pattern="[0-9]+" defaultValue={source.terms.valueKrw ?? ""} required /></label>
        </div>
        {Array.from({ length: rows }, (_, index) => {
          const item = source.terms.items?.[index];
          return <fieldset key={index}><legend>재계약 품목 {index + 1}</legend><div className={styles.grid}>
            <label>품목 식별자<input name={`itemId-${index}`} defaultValue={item?.id ?? ""} required /></label>
            <label>품목 설명<input name={`itemDescription-${index}`} defaultValue={item?.description ?? ""} required /></label>
            <label>수량<input name={`itemQuantity-${index}`} type="number" min="1" step="1" defaultValue={item?.quantity ?? ""} required /></label>
            <label>단가 (원)<input name={`itemPrice-${index}`} inputMode="numeric" pattern="[0-9]+" defaultValue={item?.unitPriceKrw ?? ""} /></label>
          </div></fieldset>;
        })}
        <button type="button" disabled={busy || rows >= 100} onClick={() => setRows(value => value + 1)}>재계약 품목 추가</button>
        <button type="button" disabled={busy || rows === 1} onClick={() => setRows(value => value - 1)}>마지막 재계약 품목 삭제</button>
        <label>재계약 조건 (한 줄에 하나)<textarea name="conditions" defaultValue={source.terms.conditions?.join("\n") ?? ""} /></label>
        <p className={styles.muted}>총 계약금액은 입력값입니다. 품목 단가 합계나 부가세를 임의로 추정하지 않습니다. 승인·발송은 하지 않습니다.</p>
        <button className={styles.primary} disabled={busy || !csrf}>{busy ? "저장 중…" : "재계약 초안 만들기"}</button>
      </form>
    </>}
    <section aria-labelledby="renewal-saved"><h3 id="renewal-saved">저장된 재계약 초안</h3>
      {drafts.length === 0 && <p>아직 재계약 초안이 없습니다.</p>}
      {drafts.flatMap(draft => draft.revisions.filter(revision => revision.contractDraft !== undefined).map(revision => {
        const contract = revision.contractDraft;
        if (!contract) return null;
        return <article data-renewal-id={draft.id} key={`${draft.id}:${revision.revisionId}`} className={styles.panel}>
          <h4>{revision.revisionLabel} · 미승인 내부 초안</h4><p>원본 {contract.source.id} · {contract.source.reference}</p>
          <p>{contract.terms.startDate ?? "시작일 미확인"} → {contract.terms.endDate ?? "종료일 미확인"} · {krw(contract.terms.valueKrw)}</p>
          {contract.terms.items?.map(item => <p key={item.id}>{item.description} · 수량 {item.quantity} · 단가 {krw(item.unitPriceKrw)}</p>)}
          {contract.terms.conditions?.map((condition, index) => <p key={index}>{condition}</p>)}
          <p className={styles.muted}>해지 통지기간 미확인{contract.source.kind === "OWNER_INPUT" ? " · 원본 검증 전" : ""}</p>
          <button type="button" disabled={compareBusy} onClick={() => onCompare(draft.id, revision.revisionId)}>나란히 비교</button>
        </article>;
      }))}
    </section>
  </section>;
}
