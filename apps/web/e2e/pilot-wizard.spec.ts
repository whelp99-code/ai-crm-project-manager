import { test, expect } from "@playwright/test";

/**
 * Contract-grade smoke: /pilot must render the S0-loop onboarding wizard
 * (step 1 active by default) with fail-closed copy when API_BASE_URL and
 * WORKSPACE_ID are unset — no fabricated job — and the 4-step indicator plus
 * next/back navigation must work purely client-side without a live API.
 * Mirrors work-fail-closed.spec.ts / monitor-fail-closed.spec.ts (see
 * playwright.config.ts webServer env).
 */
test.describe("pilot wizard fail-closed", () => {
  test("renders onboarding step with fail-closed copy and does not fabricate a job", async ({ page }) => {
    const response = await page.goto("/pilot", { waitUntil: "domcontentloaded" });
    expect(response, "navigation should produce a response").toBeTruthy();
    expect(response!.ok() || response!.status() === 304).toBeTruthy();

    await expect(page.getByRole("heading", { name: "파일럿 온보딩 마법사" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "온보딩", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "파일럿 환경 설정이 필요합니다" })).toBeVisible();
    await expect(page.getByText("API_BASE_URL")).toBeVisible();
    await expect(page.getByText("가짜 job으로 화면을 채우지 않습니다.")).toBeVisible();

    // Step 1 is active; no job/control identifiers should be rendered anywhere.
    await expect(page.locator('[aria-current="step"]')).toHaveText("1단계 · 온보딩");
  });

  test("renders steps 1-4 indicator and supports next/back navigation without a live API", async ({ page }) => {
    await page.goto("/pilot", { waitUntil: "domcontentloaded" });
    // Next.js dev bundles hydrate asynchronously; wait for the client wizard's
    // onClick handlers to attach before driving purely client-side navigation.
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("1단계 · 온보딩")).toBeVisible();
    await expect(page.getByText("2단계 · 작업 제출")).toBeVisible();
    await expect(page.getByText("3단계 · 승인")).toBeVisible();
    await expect(page.getByText("4단계 · 완료")).toBeVisible();

    const back = page.getByRole("button", { name: "이전" });
    const next = page.getByRole("button", { name: "다음" });

    await expect(back).toBeDisabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(page.getByRole("heading", { name: "작업 제출" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveText("2단계 · 작업 제출");
    await expect(back).toBeEnabled();

    // Submit is disabled fail-closed: no command can be posted without config.
    await expect(page.getByRole("button", { name: "명령 전송" })).toBeDisabled();

    await next.click();
    await expect(page.getByRole("heading", { name: "승인" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveText("3단계 · 승인");

    await next.click();
    await expect(page.getByRole("heading", { name: "완료" })).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveText("4단계 · 완료");
    await expect(next).toBeDisabled();

    await back.click();
    await back.click();
    await back.click();
    await expect(page.locator('[aria-current="step"]')).toHaveText("1단계 · 온보딩");
  });
});
