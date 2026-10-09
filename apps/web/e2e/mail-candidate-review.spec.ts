import { expect, test } from "@playwright/test";
import { loginOwner, ownerCookie } from "./auth-fixture.js";

test.describe("owner mail candidate review proxy", () => {
  test("refuses candidate data without an owner cookie", async ({ request }) => {
    const response = await request.get("/api/cwos/v2/mail-candidate-review");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "STEP_UP_REQUIRED" });
  });

  test("refuses cross-origin mutations before forwarding credentials", async ({ page, request }) => {
    await loginOwner(page);
    const response = await request.post("/api/cwos/v2/mail-candidate-review", {
      headers: { origin: "https://other.example.test", cookie: await ownerCookie(page) },
      data: { expectedVersion: 0, candidateId: "candidate", action: "DISCARD", reason: "SPAM" },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" });
  });

  test("refuses malformed session import without setting a cookie", async ({ page, request, baseURL }) => {
    if (!baseURL) throw new Error("test requires a configured browser origin");
    await loginOwner(page);
    const response = await request.post("/api/cwos/v2/review-session", {
      headers: { origin: new URL(baseURL).origin, cookie: await ownerCookie(page) },
      data: { cookie: "arbitrary-owner-claim", csrf: "forged" },
    });
    expect(response.status()).toBe(400);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });

  test("shows the domain API fail-closed state instead of candidate actions", async ({ page }) => {
    await loginOwner(page);
    const response = await page.goto("/v2/mail-candidate-review");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "메일 후보 검토", exact: true })).toBeVisible();
    await expect(page.locator("p[role=alert]")).toContainText("API 설정과 연결을 확인해 주세요");
    await expect(page.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("운영 세션 증명 파일")).toHaveCount(0);
  });
});
