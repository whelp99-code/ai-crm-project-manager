import { expect, test } from "@playwright/test";

test.describe("owner document draft proxy", () => {
  test("refuses document data without an owner cookie", async ({ request }) => {
    const response = await request.get("/api/cwos/v2/document-drafts");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "OWNER_SESSION_REQUIRED" });
  });

  test("refuses cross-origin draft writes before forwarding credentials", async ({ request }) => {
    const response = await request.post("/api/cwos/v2/document-drafts", {
      headers: { origin: "https://other.example.test" }, data: { action: "QUOTE", expectedVersion: 0 },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" });
  });

  test("shows owner proof guidance rather than editable drafts without proof", async ({ page }) => {
    await page.goto("/v2/quote-renewal");
    await expect(page.getByRole("heading", { name: "견적·발주와 재계약", exact: true })).toBeVisible();
    await expect(page.locator("p[role=alert]")).toContainText("owner 인증");
    await expect(page.getByRole("button", { name: "견적·발주 초안 만들기", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("운영 인증의 cookie·csrf JSON")).toBeVisible();
  });
});
