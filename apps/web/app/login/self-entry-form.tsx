"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./self-entry-form.module.css";

function message(code: string): string {
  switch (code) {
    case "OPERATOR_RATE_LIMITED": return "로그인이 잠겼습니다. 15분 후 다시 시도하세요.";
    case "OPERATOR_TOTP_REPLAY": return "이미 사용한 코드입니다. 새로운 OTP로 다시 로그인하세요.";
    case "OPERATOR_PROOF_EXPIRED": return "세션이 만료됐습니다. 다시 로그인하세요.";
    case "CONFIGURATION_REQUIRED": return "인증 연결 설정을 확인해 주세요.";
    case "AUTHENTICATION_UNAVAILABLE": return "인증 서버에 연결할 수 없습니다. 다시 시도하세요.";
    case "PASSWORD_TOO_LONG": return "비밀번호는 UTF-8 기준 72바이트 이하로 입력하세요.";
    default: return "비밀번호 또는 OTP가 올바르지 않습니다. 다시 입력하세요.";
  }
}

export function SelfEntryForm({ expired }: Readonly<{ expired: boolean }>) {
  const [step, setStep] = useState<"password" | "otp">("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(expired ? message("OPERATOR_PROOF_EXPIRED") : "");
  const password = useRef("");
  const otpInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (step === "otp") otpInput.current?.focus(); }, [step]);
  useEffect(() => () => { password.current = ""; }, []);

  function next(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get("password");
    if (typeof value !== "string" || !value) return;
    if (new TextEncoder().encode(value).length > 72) {
      setError(message("PASSWORD_TOO_LONG"));
      return;
    }
    password.current = value;
    form.reset();
    setError("");
    setStep("otp");
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const totp = new FormData(form).get("totp");
    if (typeof totp !== "string" || !/^\d{6}$/.test(totp) || !password.current || busy) return;
    setBusy(true);
    const body = JSON.stringify({ password: password.current, totp });
    password.current = "";
    form.reset();
    try {
      const result = await fetch("/api/self-entry", {
        method: "POST", headers: { "content-type": "application/json" }, body,
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (result.status === 200) {
        window.location.assign("/v2/mail-candidate-review");
        return;
      }
      const data: unknown = await result.json();
      const code = data !== null && typeof data === "object" && "error" in data
        && typeof data.error === "string" ? data.error : "AUTHENTICATION_FAILED";
      setError(message(code));
    } catch { setError(message("AUTHENTICATION_UNAVAILABLE")); }
    finally { setBusy(false); setStep("password"); }
  }
  function back() { password.current = ""; setError(""); setStep("password"); }
  return (
    <section className={`panel ${styles.card}`} aria-labelledby="entry-title">
      <h2 id="entry-title">{step === "password" ? "비밀번호 입력" : "OTP 입력"}</h2>
      <p className={styles.steps}>{step === "password" ? "1 / 2 · 비밀번호" : "2 / 2 · 일회용 인증 코드"}</p>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      {step === "password" ? (
        <form className={styles.form} onSubmit={next}>
          <label className={styles.label}>비밀번호
            <input className={styles.input} name="password" type="password" autoComplete="current-password"
              required maxLength={72} disabled={busy} />
          </label>
          <button className={styles.primary} type="submit" disabled={busy}>다음: OTP 입력</button>
        </form>
      ) : (
        <form className={styles.form} onSubmit={confirm}>
          <label className={styles.label}>일회용 인증 코드 (OTP)
            <input ref={otpInput} className={styles.input} name="totp" type="password" autoComplete="one-time-code"
              inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required disabled={busy} />
          </label>
          <button className={styles.primary} type="submit" disabled={busy}>{busy ? "본인 확인 중" : "CRM 들어가기"}</button>
          <button className={styles.secondary} type="button" onClick={back} disabled={busy}>비밀번호 다시 입력</button>
        </form>
      )}
      <p className={styles.hint}>입력값은 브라우저 저장소에 남기지 않습니다.</p>
      {busy ? <p role="status">본인 확인 중입니다.</p> : null}
    </section>
  );
}
