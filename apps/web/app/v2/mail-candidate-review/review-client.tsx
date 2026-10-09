"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./review.module.css";

interface Review {
  readonly id: string;
  readonly outcome: "LINKED" | "NEW_ACCOUNT_CANDIDATE" | "DISCARDED" | "UNDONE";
  readonly accountId: string | null;
  readonly companyName: string | null;
  readonly reason: string | null;
  readonly reviewedAt: string;
  readonly reviewedByPrincipalId: string;
}
interface Candidate {
  readonly id: string;
  readonly provider: string;
  readonly senderCompany: string | null;
  readonly summary: string;
  readonly receivedAt: string | null;
  readonly createdAt: string;
  readonly evidenceUrl: string | null;
  readonly sourceLocator: string;
  readonly review: Review | null;
  readonly history: readonly Review[];
}
interface Queue {
  readonly workspaceId: string;
  readonly runtimeVersion: number;
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  readonly candidates: readonly Candidate[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function review(value: unknown): value is Review {
  return object(value) && typeof value.id === "string"
    && ["LINKED", "NEW_ACCOUNT_CANDIDATE", "DISCARDED", "UNDONE"].includes(String(value.outcome))
    && nullableText(value.accountId) && nullableText(value.companyName) && nullableText(value.reason)
    && typeof value.reviewedAt === "string" && typeof value.reviewedByPrincipalId === "string";
}
function queue(value: unknown): value is Queue {
  return object(value) && typeof value.workspaceId === "string" && typeof value.runtimeVersion === "number"
    && Array.isArray(value.accounts) && value.accounts.every(item => object(item)
      && typeof item.id === "string" && typeof item.name === "string")
    && Array.isArray(value.candidates) && value.candidates.every(item => object(item)
      && typeof item.id === "string" && typeof item.provider === "string" && typeof item.summary === "string"
      && nullableText(item.senderCompany) && nullableText(item.receivedAt) && nullableText(item.evidenceUrl)
      && typeof item.createdAt === "string" && typeof item.sourceLocator === "string"
      && (item.review === null || review(item.review)) && Array.isArray(item.history) && item.history.every(review));
}
const outcomeLabel = { LINKED: "거래처 연결 확정", NEW_ACCOUNT_CANDIDATE: "새 거래처 후보 확정",
  DISCARDED: "버림", UNDONE: "되돌림 · 검토 대기" } as const;
const reasons = { NOT_RELEVANT: "업무와 무관", DUPLICATE: "중복 메일", SPAM: "스팸", OTHER: "기타" } as const;
type Reason = keyof typeof reasons;
type Decision = { readonly action: "LINK"; readonly accountId: string }
  | { readonly action: "NEW_ACCOUNT"; readonly companyName: string }
  | { readonly action: "DISCARD"; readonly reason: Reason }
  | { readonly action: "UNDO"; readonly reviewId: string };
const date = (value: string) => new Date(value).toLocaleString("ko-KR");

function CandidateCard({ candidate, accounts, disabled, decide }: {
  readonly candidate: Candidate;
  readonly accounts: Queue["accounts"];
  readonly disabled: boolean;
  readonly decide: (id: string, decision: Decision) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [company, setCompany] = useState(candidate.senderCompany ?? "");
  const [reason, setReason] = useState<Reason>("NOT_RELEVANT");
  const active = candidate.review !== null && candidate.review.outcome !== "UNDONE";
  return (
    <article className={`panel ${styles.card}`} aria-labelledby={`candidate-${candidate.id}`}>
      <div className={styles.cardHeading}>
        <div><p className="meta">{candidate.senderCompany ?? "보낸 사람 회사 미제공"}</p>
          <h2 id={`candidate-${candidate.id}`}>{candidate.summary}</h2></div>
        <span className="status">{candidate.review ? outcomeLabel[candidate.review.outcome] : "검토 대기"}</span>
      </div>
      <dl className={styles.evidence}>
        <div><dt>받은 날짜</dt><dd>{candidate.receivedAt ? date(candidate.receivedAt) : "원본 수신 날짜 미제공"}</dd></div>
        <div><dt>후보 등록일</dt><dd>{date(candidate.createdAt)}</dd></div>
        <div><dt>근거 메일</dt><dd>{candidate.evidenceUrl
          ? <a href={candidate.evidenceUrl} target="_blank" rel="noreferrer">원본 메일 열기</a>
          : <span>열 수 있는 링크 미제공</span>}<small>{candidate.sourceLocator}</small></dd></div>
      </dl>
      {active ? (
        <div className={styles.current}>
          <p>{candidate.review?.companyName ?? accounts.find(a => a.id === candidate.review?.accountId)?.name
            ?? candidate.review?.reason ?? "검토 기록을 보관했습니다."}</p>
          <button type="button" disabled={disabled} onClick={() => {
            if (candidate.review) void decide(candidate.id, { action: "UNDO", reviewId: candidate.review.id });
          }}>되돌리기</button>
        </div>
      ) : (
        <div className={styles.controls}>
          <div className={styles.field}>
            <label htmlFor={`target-${candidate.id}`}>확정할 거래처</label>
            <select id={`target-${candidate.id}`} value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}>
              <option value="">거래처 선택</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              <option value="__new__">새 거래처 후보로 기록</option>
            </select>
            {target === "__new__" && <><label htmlFor={`company-${candidate.id}`}>새 거래처 후보 이름</label>
              <input id={`company-${candidate.id}`} value={company} maxLength={200} disabled={disabled}
                onChange={e => setCompany(e.target.value)} /></>}
            <button type="button" className={styles.primary}
              disabled={disabled || !target || (target === "__new__" && !company.trim())}
              onClick={() => void decide(candidate.id, target === "__new__"
                ? { action: "NEW_ACCOUNT", companyName: company.trim() } : { action: "LINK", accountId: target })}>확정</button>
          </div>
          <div className={styles.field}>
            <label htmlFor={`reason-${candidate.id}`}>버리는 사유</label>
            <select id={`reason-${candidate.id}`} value={reason} disabled={disabled} onChange={e => {
              const selected = e.target.value;
              if (selected === "NOT_RELEVANT" || selected === "DUPLICATE" || selected === "SPAM" || selected === "OTHER") setReason(selected);
            }}>
              {Object.entries(reasons).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
            <button type="button" disabled={disabled} onClick={() => void decide(candidate.id, { action: "DISCARD", reason })}>버리기</button>
          </div>
        </div>
      )}
      {candidate.history.length > 0 && <details className={styles.history}><summary>감사 기록 {candidate.history.length}건</summary>
        <ol>{candidate.history.map(item => <li key={item.id}>{outcomeLabel[item.outcome]}
          {" · "}{date(item.reviewedAt)}{" · "}{item.reviewedByPrincipalId}</li>)}</ol></details>}
    </article>
  );
}

export function MailCandidateReviewClient() {
  const [data, setData] = useState<Queue | null>(null);
  const [csrf, setCsrf] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/cwos/v2/mail-candidate-review", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      setData(null);
      throw new Error(response.status === 401 || response.status === 403
        ? "현재 운영 owner 세션을 연결해 주세요. 만료된 세션은 다시 인증해야 합니다."
        : "후보 목록을 불러오지 못했습니다. API 설정과 연결을 확인해 주세요.");
    }
    const body: unknown = await response.json();
    if (!queue(body)) throw new Error("후보 응답 형식이 올바르지 않습니다.");
    setData(body);
  }, []);
  useEffect(() => {
    void load().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "목록 연결 실패"))
      .finally(() => setLoaded(true));
  }, [load]);
  const importProof = async (file: File) => {
    setWorking(true); setError("");
    try {
      if (file.size > 8192) throw new Error("운영 세션 JSON 파일이 너무 큽니다.");
      const response = await fetch("/api/cwos/v2/review-session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: await file.text(), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("유효한 현재 owner 세션 증명만 연결할 수 있습니다.");
      const proof: unknown = await response.json();
      if (!object(proof) || typeof proof.csrf !== "string" || typeof proof.expiresAt !== "string") {
        throw new Error("운영 세션 응답이 올바르지 않습니다.");
      }
      setCsrf(proof.csrf); setExpiresAt(proof.expiresAt);
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "운영 세션 연결 실패"); }
    finally { setWorking(false); }
  };
  const decide = async (candidateId: string, decision: Decision) => {
    if (!data || !csrf) return;
    setWorking(true); setError("");
    try {
      const response = await fetch("/api/cwos/v2/mail-candidate-review", {
        method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", "x-csrf-token": csrf, "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ expectedVersion: data.runtimeVersion, candidateId, ...decision }),
      });
      if (!response.ok) throw new Error(response.status === 409
        ? "다른 검토로 상태가 바뀌었습니다. 목록을 새로고침하고 다시 검토해 주세요."
        : response.status === 401 || response.status === 403
          ? "owner 세션이 만료되었거나 권한이 없습니다. 현재 운영 세션을 다시 연결해 주세요."
          : "검토를 저장하지 못했습니다. 입력과 API 연결을 확인해 주세요.");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "검토 저장 실패"); }
    finally { setWorking(false); }
  };
  return (
    <div className={styles.review}>
      <header><p className="meta">W07 · OWNER REVIEW</p><h1>메일 후보 검토</h1>
        <p className="lead">메일 근거를 확인하고 거래처 연결을 결정하세요. 발송·외부 쓰기는 하지 않습니다.</p></header>
      <section className={`panel ${styles.session}`} aria-labelledby="owner-session-title">
        <div><h2 id="owner-session-title">현재 운영 owner 세션</h2>
          <p className="meta">기존 인증에서 받은 cookie·csrf JSON을 연결합니다. 새 로그인이나 키 발급은 하지 않습니다.</p>
          {expiresAt && <p className="meta">세션 만료 {date(expiresAt)}</p>}</div>
        <label className={styles.fileLabel}>운영 세션 연결
          <input type="file" accept="application/json,.json" disabled={working} aria-label="운영 세션 증명 파일"
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importProof(file); }} />
        </label>
      </section>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {data && <div className={styles.toolbar}><p className="meta" aria-live="polite">
        {data.candidates.length}개 후보 · {data.workspaceId} · 검토 버전 {data.runtimeVersion}
      </p><button type="button" disabled={working} onClick={() => { setError("");
        void load().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "목록 연결 실패"));
      }}>목록 새로고침</button></div>}
      {!loaded && <p role="status">후보 목록을 불러오는 중입니다.</p>}
      {data?.candidates.length === 0 && <section className="panel"><h2>검토할 메일 후보가 없습니다</h2>
        <p className="meta">Mail이 후보를 기록하면 이 목록에 표시됩니다.</p></section>}
      <div className="stack">{data?.candidates.map(candidate => <CandidateCard key={candidate.id} candidate={candidate}
        accounts={data.accounts} disabled={working || !csrf} decide={decide} />)}</div>
      <p className={`meta ${styles.note}`}>새 거래처 후보 확정은 검토 기록만 남깁니다. 실제 거래처를 자동 생성하지 않습니다.
        회사·수신 날짜가 미제공이면 원본 메타데이터를 추정하지 않습니다.</p>
    </div>
  );
}
