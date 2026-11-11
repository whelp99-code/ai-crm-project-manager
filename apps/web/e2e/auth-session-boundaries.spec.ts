import { expect, test } from "@playwright/test";
import { loginOwner, ownerCookie } from "./auth-fixture";

test("native browser login requires Origin and CSRF logout and rejects the old proof", async ({ page, request, baseURL }, testInfo) => {
  if (!baseURL) throw new Error("native browser QA needs its configured origin");
  const origin = new URL(baseURL).origin;
  await page.setViewportSize({ width: 1440, height: 900 });
  const candidateResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/cwos/v2/mail-candidate-review");
  await loginOwner(page);
  await candidateResponse;
  await expect(page.getByRole("heading", { name: "메일 후보 검토", exact: true })).toBeVisible();
  await expect(page.locator("p[role=alert]")).toBeVisible();
  await expect(page.getByLabel("운영 세션 증명 파일")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("owner-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("owner-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cookie = await ownerCookie(page);
  const details = await page.request.get("/api/self-entry");
  expect(details.status()).toBe(200);
  const body: unknown = await details.json();
  if (body === null || typeof body !== "object" || !("csrf" in body) || typeof body.csrf !== "string") {
    throw new Error("authenticated session details need their native CSRF token");
  }
  const rejectedHeaders: Record<string, string>[] = [
    { cookie, "x-csrf-token": body.csrf },
    { cookie, origin },
    { cookie, origin: "https://other.example.test", "x-csrf-token": body.csrf },
  ];
  for (const headers of rejectedHeaders) {
    const denied = await request.post("/api/self-entry/logout", { headers });
    expect(denied.status()).toBe(403);
    expect((await page.request.get("/api/self-entry")).status()).toBe(200);
  }
  const logout = await page.request.post("/api/self-entry/logout", {
    headers: { origin, "x-csrf-token": body.csrf },
  });
  expect(logout.status()).toBe(200);
  expect(logout.headers()["set-cookie"]).toContain("Max-Age=0");
  expect((await request.get("/api/self-entry", { headers: { cookie } })).status()).toBe(401);
  await page.goto("/work");
  await expect(page).toHaveURL(/\/login/);
});
