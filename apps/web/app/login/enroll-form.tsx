"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./self-entry-form.module.css";

function message(code: string): string {
  switch (code) {
    case "ALREADY_ENROLLED": return "이미 등록되어 있습니다. 다시 등록하려면 운영자가 인증 파일을 바꾸는 초기화 절차가 필요합니다.";
    case "CONFIGURATION_REQUIRED": return "등록 경로가 설정되지 않았습니다.";
    case "ENROLLMENT_HOST_DENIED": return "이 주소에서는 등록할 수 없습니다.";
    case "PASSWORD_MISMATCH": return "비밀번호 확인이 일치하지 않습니다.";
    case "AUTHENTICATION_UNAVAILABLE": return "등록 요청을 보내지 못했습니다. 다시 시도하세요.";
    default: return "등록하지 못했습니다. 비밀번호와 OTP를 다시 확인하세요.";
  }
}

export function EnrollForm() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const password = useRef("");
  const secret = useRef("");
  useEffect(() => () => { password.current = ""; secret.current = ""; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || done) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const nextPassword = data.get("password");
    const confirm = data.get("confirm");
    const totpSecret = data.get("totpSecret");
    const totp = data.get("totp");
    if (typeof nextPassword !== "string" || typeof confirm !== "string"
      || typeof totpSecret !== "string" || typeof totp !== "string") return;
    if (nextPassword !== confirm) {
      setError(message("PASSWORD_MISMATCH"));
      return;
    }
    password.current = nextPassword;
    secret.current = totpSecret;
    form.reset();
    const body = JSON.stringify({ password: password.current, totpSecret: secret.current, totp });
    password.current = "";
    secret.current = "";
    setBusy(true);
    setError("");
    try {
      const result = await fetch("/api/self-entry/enroll", {
        method: "POST", headers: { "content-type": "application/json" }, body,
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (result.status === 201) {
        setDone(true);
        return;
      }
      const payload: unknown = await result.json();
      const code = payload !== null && typeof payload === "object" && "error" in payload
        && typeof payload.error === "string" ? payload.error : "OPERATOR_ENROLLMENT_REJECTED";
      setError(message(code));
    } catch { setError(message("AUTHENTICATION_UNAVAILABLE")); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <section className={`panel ${styles.card}`} role="status">
        <h2>등록되었습니다</h2>
        <p>다음 OTP부터 로그인하세요. 이 화면은 다시 열리지 않습니다.</p>
      </section>
    );
  }

  return (
    <section className={`panel ${styles.card}`} aria-labelledby="enroll-title">
      <h2 id="enroll-title">운영자 등록</h2>
      <p className={styles.steps}>비밀번호와 OTP 비밀을 이 브라우저에서만 등록합니다.</p>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      <form className={styles.form} onSubmit={submit} autoComplete="off">
        <label className={styles.label}>비밀번호
          <input className={styles.input} name="password" type="password" autoComplete="new-password"
            required minLength={12} maxLength={72} disabled={busy} />
        </label>
        <label className={styles.label}>비밀번호 확인
          <input className={styles.input} name="confirm" type="password" autoComplete="new-password"
            required minLength={12} maxLength={72} disabled={busy} />
        </label>
        <label className={styles.label}>OTP 비밀키
          <input className={styles.input} name="totpSecret" type="password" autoComplete="off"
            required minLength={32} maxLength={32} disabled={busy} spellCheck={false} />
        </label>
        <label className={styles.label}>현재 OTP
          <input className={styles.input} name="totp" type="password" autoComplete="one-time-code"
            inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required disabled={busy} />
        </label>
        <button className={styles.primary} type="submit" disabled={busy}>{busy ? "등록 중" : "등록"}</button>
      </form>
      <p className={styles.hint}>입력값은 브라우저 저장소에 남기지 않습니다. 한 번 등록되면 이 화면은 다시 열리지 않습니다.</p>
    </section>
  );
}
