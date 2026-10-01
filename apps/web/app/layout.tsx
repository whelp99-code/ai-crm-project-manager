import type { Metadata } from "next";
import type { ReactNode } from "react";
import { enforceOwnerPage } from "./owner-server";
import { OwnerFetchPatch } from "./owner-fetch-patch";

export const metadata: Metadata = {
  title: "AI 업무 운영실",
  description: "기존 고객과 납품 프로젝트를 관리하는 단일 회사용 운영 화면",
};

const styles = `
  :root { color-scheme: light; font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f4f7f5; color: #17221d; font-size: 16px; line-height: 1.45; }
  a { color: #176b47; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline: 3px solid #f0a43a; outline-offset: 3px; }
  .shell { min-height: 100vh; }
  .topbar { background: #153e2d; color: #fff; border-bottom: 4px solid #d7a13f; }
  .topbar-inner, main { width: min(1160px, calc(100% - 24px)); margin: 0 auto; }
  .topbar-inner { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; gap: 8px; min-height: 52px; }
  .brand { font-size: 16px; font-weight: 760; letter-spacing: -.02em; white-space: nowrap; }
  .brand-short { display: none; }
  .owner-nav { display: flex; align-items: center; gap: 2px; margin-left: auto; }
  .owner-nav a, .dev-menu summary { color: #fff; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; padding: 0 8px; font-size: 16px; font-weight: 680; white-space: nowrap; }
  .dev-menu { position: relative; }
  .dev-menu summary { list-style: none; cursor: pointer; color: #dcebe3; }
  .dev-menu summary::-webkit-details-marker { display: none; }
  .dev-menu-panel { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; min-width: 148px; background: #fff; border: 1px solid #ccd7d1; border-radius: 10px; padding: 4px; display: grid; }
  .dev-menu-panel a { color: #17221d; text-decoration: none; min-height: 44px; display: flex; align-items: center; padding: 0 12px; border-radius: 8px; }
  .dev-menu-panel a:hover { background: #f4f7f5; }
  .chip { display: inline-flex; align-items: center; border-radius: 999px; padding: 0 8px; background: #e7eeea; color: #17221d; font-size: 13px; font-weight: 680; line-height: 1.3; min-height: 22px; white-space: nowrap; }
  .chip-in { background: #dceee4; color: #153e2d; }
  .chip-out { background: #f8e6dc; color: #7a341f; }
  main { padding: 12px 0 28px; }
  h1 { margin: 0 0 2px; font-size: 22px; line-height: 1.25; letter-spacing: -.03em; }
  h2 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 0 0 8px; }
  .lead { color: #526159; margin: 0 0 10px; font-size: 14px; line-height: 1.4; }
  .stack { display: grid; gap: 10px; }
  .panel { background: #fff; border: 1px solid #ccd7d1; border-radius: 10px; padding: 12px; }
  .panel-critical { border-left: 6px solid #a53b32; }
  .panel-action { border-left: 6px solid #c68121; }
  .panel-pending { background: #fff9e9; border-color: #dec98d; }
  .meta { color: #5d6b63; font-size: 13px; margin: 0 0 6px; }
  .list { margin: 0; padding-left: 20px; }
  .list li + li { margin-top: 8px; }
  .status-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .status { display: inline-flex; border: 1px solid #7f9388; border-radius: 999px; padding: 3px 10px; font-weight: 680; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .empty { color: #69766f; }
  .error { border: 2px solid #a53b32; background: #fff; padding: 16px; border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #d9e1dd; vertical-align: top; overflow-wrap: anywhere; }
  th { color: #46564d; font-size: 13px; }
  .money-gross { margin: 0 0 4px; font-size: 16px; font-weight: 760; font-variant-numeric: tabular-nums; letter-spacing: -.03em; line-height: 1.2; white-space: nowrap; }
  .money-bits { margin: 0; display: grid; gap: 1px; }
  .money-bits span { display: block; white-space: nowrap; font-size: 13px; color: #5d6b63; font-variant-numeric: tabular-nums; }
  .search { width: 100%; min-height: 44px; font-size: 16px; border: 1px solid #ccd7d1; border-radius: 8px; padding: 0 12px; background: #fff; color: #17221d; }
  .record-list { list-style: none; margin: 4px 0 0; padding: 0; }
  .record-row { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 6px 0; border-bottom: 1px solid #d9e1dd; }
  .record-main { min-width: 0; flex: 1; }
  .record-name { font-size: 16px; font-weight: 680; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .record-sub { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 2px; }
  .record-subtext { color: #46564d; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .record-amount { margin-left: auto; display: flex; align-items: baseline; gap: 1px; font-variant-numeric: tabular-nums; font-weight: 760; font-size: 15px; white-space: nowrap; }
  .won { font-size: 13px; font-weight: 680; color: #46564d; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 640px) {
    .brand-full { display: none; }
    .brand-short { display: inline; }
    .account-table thead, .data-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .account-table, .account-table tbody, .account-table tr, .account-table td,
    .data-table, .data-table tbody, .data-table tr, .data-table td { display: block; width: 100%; }
    .account-table tr, .data-table tr { padding: 12px 0; border-bottom: 1px solid #d9e1dd; }
    .account-table td, .data-table td { border-bottom: 0; padding: 4px 0; }
    .account-table td[data-label]::before, .data-table td[data-label]::before { content: attr(data-label); display: block; color: #46564d; font-size: 13px; font-weight: 680; }
  }
  @media (min-width: 900px) {
    .topbar-inner, main { width: min(1160px, calc(100% - 48px)); }
    h1 { font-size: 28px; }
    main { padding: 24px 0 64px; }
    .money-gross { font-size: 28px; }
  }
`;

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  await enforceOwnerPage();
  return (
    <html lang="ko">
      <head><style>{styles}</style></head>
      <body>
        <OwnerFetchPatch />
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <span className="brand"><span className="brand-full">AI 업무 운영실</span><span className="brand-short">운영실</span></span>
              <nav className="owner-nav" aria-label="주요 화면">
                <a href="/accounts">계정</a>
                <a href="/engagements">프로젝트</a>
                <a href="/finance">재무</a>
                <details className="dev-menu">
                  <summary>개발</summary>
                  <div className="dev-menu-panel">
                    <a href="/work">작업실</a>
                    <a href="/approvals">승인</a>
                    <a href="/monitor">모니터</a>
                    <a href="/pilot">파일럿</a>
                    <a href="/v2">v2</a>
                  </div>
                </details>
              </nav>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
