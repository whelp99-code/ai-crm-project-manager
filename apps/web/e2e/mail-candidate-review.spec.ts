import { expect, test } from "@playwright/test";

test.describe("owner mail candidate review proxy", () => {
  test("refuses candidate data without an owner cookie", async ({ request }) => {
    const response = await request.get("/api/cwos/v2/mail-candidate-review");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "OWNER_SESSION_REQUIRED" });
  });

  test("refuses cross-origin mutations before forwarding credentials", async ({ request }) => {
    const response = await request.post("/api/cwos/v2/mail-candidate-review", {
      headers: { origin: "https://other.example.test" },
      data: { expectedVersion: 0, candidateId: "candidate", action: "DISCARD", reason: "SPAM" },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" });
  });

  test("refuses malformed session import without setting a cookie", async ({ request, baseURL }) => {
    if (!baseURL) throw new Error("test requires a configured browser origin");
    const response = await request.post("/api/cwos/v2/review-session", {
      headers: { origin: new URL(baseURL).origin },
      data: { cookie: "arbitrary-owner-claim", csrf: "forged" },
    });
    expect(response.status()).toBe(400);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });

  test("shows a session gate instead of candidate actions without proof", async ({ page }) => {
    await page.goto("/v2/mail-candidate-review");
    await expect(page.getByRole("heading", { name: "메일 후보 검토", exact: true })).toBeVisible();
    await expect(page.locator("p[role=alert]")).toContainText("owner 세션");
    await expect(page.getByRole("button", { name: "확정", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("운영 세션 증명 파일")).toBeVisible();
  });
});
