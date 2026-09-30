import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "AI 업무 운영실",
  description: "기존 고객과 납품 프로젝트를 관리하는 단일 회사용 운영 화면",
};

const styles = `
  :root { color-scheme: light; font-family: Inter, Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f7f5; color: #17221d; font-size: 16px; line-height: 1.65; }
  a { color: #176b47; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible { outline: 3px solid #f0a43a; outline-offset: 3px; }
  .shell { min-height: 100vh; }
  .topbar { background: #153e2d; color: #fff; border-bottom: 4px solid #d7a13f; }
  .topbar-inner, main { width: min(1160px, calc(100% - 32px)); margin: 0 auto; }
  .topbar-inner { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; gap: 24px; }
  .brand { font-size: 21px; font-weight: 760; letter-spacing: -.02em; }
  .context { color: #dcebe3; font-size: 14px; }
  main { padding: 34px 0 64px; }
  h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 42px); line-height: 1.2; letter-spacing: -.035em; }
  h2 { margin: 0 0 16px; font-size: 20px; }
  p { margin: 0 0 12px; }
  .lead { color: #526159; margin-bottom: 30px; }
  .stack { display: grid; gap: 18px; }
  .panel { background: #fff; border: 1px solid #ccd7d1; border-radius: 10px; padding: 22px; }
  .panel-critical { border-left: 6px solid #a53b32; }
  .panel-action { border-left: 6px solid #c68121; }
  .panel-pending { background: #fff9e9; border-color: #dec98d; }
  .meta { color: #5d6b63; font-size: 14px; }
  .list { margin: 0; padding-left: 20px; }
  .list li + li { margin-top: 8px; }
  .status-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .status { display: inline-flex; border: 1px solid #7f9388; border-radius: 999px; padding: 3px 10px; font-weight: 680; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
  .empty { color: #69766f; }
  .error { border: 2px solid #a53b32; background: #fff; padding: 24px; border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #d9e1dd; vertical-align: top; }
  th { color: #46564d; font-size: 14px; }
  @media (max-width: 640px) { .topbar-inner { align-items: flex-start; flex-direction: column; } .panel { padding: 18px; } }
`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <head><style>{styles}</style></head>
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <span className="brand">AI 업무 운영실</span>
              <span className="context">
                <a href="/accounts" style={{ color: "#dcebe3" }}>계정</a>
                {" · "}
                <a href="/work" style={{ color: "#dcebe3" }}>작업실</a>
                {" · "}
                <a href="/approvals" style={{ color: "#dcebe3" }}>승인</a>
                {" · "}
                <a href="/monitor" style={{ color: "#dcebe3" }}>모니터</a>
                {" · "}
                <a href="/pilot" style={{ color: "#dcebe3" }}>파일럿</a>
                {" · "}
                <a href="/v2" style={{ color: "#dcebe3" }}>v2</a>
              </span>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
