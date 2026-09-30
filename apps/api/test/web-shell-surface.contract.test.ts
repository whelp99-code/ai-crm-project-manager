import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webApp = join(dirname(fileURLToPath(import.meta.url)), "../../web/app");

function read(rel: string): string {
  return readFileSync(join(webApp, rel), "utf8");
}

describe("G003 web shell surface contracts (E2E-S0-01 static)", () => {
  it("work client posts only to agent API with idempotency", () => {
    const src = read("work/work-client.tsx");
    expect(src).toContain("/api/agent/commands");
    expect(src).toContain("/api/agent/jobs/");
    expect(src).toContain("idempotency-key");
    expect(src).not.toMatch(/fetch\([^)]*\/api\/pm\//);
  });

  it("approvals decide binds governance decide (no domain PATCH)", () => {
    const src = read("approvals/decide-client.tsx");
    expect(src).toContain("/api/governance/controls/");
    expect(src).toContain("/decide");
    expect(src).toContain("APPROVE");
    expect(src).toContain("REJECT");
    expect(src).not.toMatch(/\bPATCH\b/);
  });

  it("work page fails closed without API_BASE_URL", () => {
    const src = read("work/page.tsx");
    expect(src).toContain("WorkClient");
    expect(src).toContain("API_BASE_URL");
    expect(src).toContain("작업실을 사용할 수 없습니다");
  });

  it("layout links /accounts, /work and /approvals", () => {
    const src = read("layout.tsx");
    expect(src).toContain('href="/accounts"');
    expect(src).toContain(">계정<");
    expect(src.indexOf(">계정<")).toBeLessThan(src.indexOf(">프로젝트<"));
    expect(src.indexOf(">프로젝트<")).toBeLessThan(src.indexOf(">재무<"));
    expect(src.indexOf(">재무<")).toBeLessThan(src.indexOf(">작업실<"));
    expect(src).toContain('href="/engagements"');
    expect(src).toContain('href="/finance"');
    expect(src).toContain('href="/work"');
    expect(src).toContain('href="/approvals"');
  });

  it("home redirects to the accounts list", () => {
    const page = read("page.tsx");
    expect(page).toContain('redirect("/accounts")');
    expect(page).not.toContain("S1CreateWorkClient");
  });

  it("accounts page reads the read-only accounts API", () => {
    const page = read("accounts/page.tsx");
    expect(page).toContain("/api/cwos/accounts");
    expect(page).toContain("계정 {result.count}");
    expect(page).toContain('data-testid="account-count"');
    expect(page).toContain("AUTH_API_KEY");
  });

  it("create-work client posts only to agent commands with resourceBinding", () => {
    const client = read("s1-create-work-client.tsx");
    expect(client).toContain("/api/agent/commands");
    expect(client).toContain("resourceBinding");
    expect(client).toContain("idempotency-key");
    expect(client).toContain("이 고객으로 일감 만들기");
    expect(client).not.toMatch(/fetch\([^)]*\/api\/pm\//);
    expect(client).not.toMatch(/\bPATCH\b/);
  });
});
