import { isContractSource, isContractTerms, type ContractSource, type ContractTerms } from "./renewal-editor";
import styles from "./draft.module.css";

type Field = { key: "period" | "amount" | "items" | "conditions"; status: "CHANGED" | "UNCHANGED" | "UNKNOWN" };
export interface ComparisonData {
  renewalId: string; revisionId: string; source: ContractSource; terms: ContractTerms;
  approvalStatus: "NOT_APPROVED";
  comparison: { fields: Field[]; amountDeltaKrw: string | null };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function isComparisonData(value: unknown): value is ComparisonData {
  return object(value) && typeof value.renewalId === "string" && typeof value.revisionId === "string"
    && isContractSource(value.source) && isContractTerms(value.terms) && value.approvalStatus === "NOT_APPROVED"
    && object(value.comparison) && (value.comparison.amountDeltaKrw === null
      || (typeof value.comparison.amountDeltaKrw === "string" && /^-?\d+$/.test(value.comparison.amountDeltaKrw)))
    && Array.isArray(value.comparison.fields) && value.comparison.fields.length === 4
    && new Set(value.comparison.fields.map(field => object(field) ? field.key : null)).size === 4
    && value.comparison.fields.every(field => object(field)
      && ["period", "amount", "items", "conditions"].includes(String(field.key))
      && ["CHANGED", "UNCHANGED", "UNKNOWN"].includes(String(field.status)));
}
const labels: Record<Field["key"], string> = { period: "기간", amount: "금액", items: "품목", conditions: "조건" };
const statusLabel: Record<Field["status"], string> = { CHANGED: "변경됨", UNCHANGED: "변경 없음", UNKNOWN: "확인 필요" };
const money = (value: string | null) => value === null ? "미확인" : `${BigInt(value).toLocaleString("ko-KR")} 원`;

export function ComparisonPanel({ data }: { data: ComparisonData }) {
  const render = (terms: ContractTerms, key: Field["key"]) => {
    if (key === "period") return <p>{terms.startDate ?? "시작일 미확인"} → {terms.endDate ?? "종료일 미확인"}</p>;
    if (key === "amount") return <p>{money(terms.valueKrw)}</p>;
    if (key === "items") return terms.items === null ? <p>원본 품목 미확인</p>
      : terms.items.length === 0 ? <p>품목 없음</p> : terms.items.map(item => <p key={item.id}>{item.id} · {item.description}<br />수량 {item.quantity} · 단가 {money(item.unitPriceKrw)}</p>);
    return terms.conditions === null ? <p>조건 미확인</p> : terms.conditions.length === 0 ? <p>조건 없음</p>
      : terms.conditions.map((condition, index) => <p key={index}>{condition}</p>);
  };
  return <section className={styles.panel} aria-labelledby="comparison-title" data-comparison data-comparison-renewal={data.renewalId}>
    <h2 id="comparison-title">3. 기존 계약과 재계약 초안 나란히 비교</h2>
    <p>원본 {data.source.id} · {data.source.reference}</p>
    <p className={styles.muted}>미승인 재계약 초안{data.source.kind === "OWNER_INPUT" ? " · 직접 입력 원본 검증 전" : ` · 원본 등록 버전 ${data.source.version}`} · 확인하지 못한 항목은 변경 없음으로 표시하지 않습니다.</p>
    <p>입력 금액 차이: {money(data.comparison.amountDeltaKrw)}</p>
    {data.comparison.fields.map(field => <section key={field.key}
      className={`${styles.panel} ${field.status === "CHANGED" ? styles.changed : ""}`}
      data-field={field.key} data-status={field.status}>
      <h3>{labels[field.key]} · {statusLabel[field.status]}</h3>
      <div className={styles.grid}>
        <div><h4>기존 계약</h4>{render(data.source.terms, field.key)}</div>
        <div><h4>재계약 초안</h4>{render(data.terms, field.key)}</div>
      </div>
    </section>)}
  </section>;
}
