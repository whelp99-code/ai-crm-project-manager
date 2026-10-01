"use client";

import { useState } from "react";

export default function LoginPage() {
  const [mode, setMode] = useState<"enroll" | "confirm" | "login">("login");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(path: string, body: Record<string, string>) {
    setMessage(null);
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { error?: string; otpauth?: string };
    if (!response.ok) {
      setMessage(payload.error ?? `HTTP ${response.status}`);
      return payload;
    }
    return payload;
  }

  return (
    <section className="panel" aria-labelledby="login-title">
      <h1 id="login-title">소유자 로그인</h1>
      <p className="lead">기본 비밀번호는 없습니다. CLI가 발급한 1회용 코드로만 등록합니다.</p>
      <div className="status-row">
        <button type="button" onClick={() => setMode("enroll")}>등록</button>
        <button type="button" onClick={() => setMode("confirm")}>TOTP 확인</button>
        <button type="button" onClick={() => setMode("login")}>로그인</button>
      </div>
      {mode === "enroll" ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("/api/owner/enroll", { code, password }).then((payload) => {
              if (payload.otpauth) {
                setOtpauth(payload.otpauth);
                setMode("confirm");
              }
            });
          }}
        >
          <label>등록 코드<input className="search" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" /></label>
          <label>새 비밀번호 (12자 이상)<input className="search" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
          <button type="submit">등록</button>
        </form>
      ) : null}
      {mode === "confirm" ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("/api/owner/enroll/confirm", { totp }).then((payload) => {
              if (!payload.error) setMode("login");
            });
          }}
        >
          {otpauth ? <p className="meta">인증 앱에 이 주소를 등록하세요: {otpauth}</p> : null}
          <label>TOTP 6자리<input className="search" value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label>
          <button type="submit">확인</button>
        </form>
      ) : null}
      {mode === "login" ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("/api/owner/login", { password, totp }).then((payload) => {
              if (!payload.error) window.location.assign("/accounts");
            });
          }}
        >
          <label>비밀번호<input className="search" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          <label>TOTP<input className="search" value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label>
          <button type="submit">로그인</button>
        </form>
      ) : null}
      {message ? <p className="error">{message}</p> : null}
    </section>
  );
}
