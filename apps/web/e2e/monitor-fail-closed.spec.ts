import { test, expect } from "@playwright/test";
import { loginOwner } from "./auth-fixture.js";

/**
 * Contract-grade smoke: /monitor must render fail-closed copy when
 * API_BASE_URL (and its NEXT_PUBLIC_ alias) are unset. Mirrors
 * work-fail-closed.spec.ts (see playwright.config.ts webServer env).
 */
test.describe("monitor page fail-closed", () => {
  test("renders unavailable copy without API_BASE_URL", async ({ page }) => {
    await loginOwner(page);
    const response = await page.goto("/monitor", { waitUntil: "domcontentloaded" });
    expect(response, "navigation should produce a response").toBeTruthy();
    expect(response!.ok() || response!.status() === 304).toBeTruthy();

    await expect(page.getByRole("heading", { name: "모니터를 사용할 수 없습니다" })).toBeVisible();
    await expect(page.getByText("API_BASE_URL")).toBeVisible();
    await expect(page.getByText("가짜 지표로 화면을 채우지 않습니다.")).toBeVisible();
  });
});
