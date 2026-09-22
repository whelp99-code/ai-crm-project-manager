import { test, expect } from "@playwright/test";

const widths = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("C06 follow-up correction closure fixture", () => {
  for (const viewport of widths) {
    test(`${viewport.name} renders the isolated fail-closed fixture`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      const response = await page.goto("/core5-c06", { waitUntil: "domcontentloaded" });
      expect(response, "navigation should produce a response").toBeTruthy();
      expect(response!.ok()).toBeTruthy();

      await expect(page.getByRole("heading", { name: "C06 follow-up / correction / closure" })).toBeVisible();
      await expect(page.getByTestId("mail-work-mapping")).toHaveAttribute("data-mail-id", "mail-c06-001");
      await expect(page.getByTestId("mail-work-mapping")).toHaveAttribute("data-work-id", "work-c06-001");
      await expect(page.getByTestId("correction-reason")).toHaveText("Customer requested corrected delivery window");
      await expect(page.getByTestId("delivery-terminal")).toHaveText("DELIVERY_UNKNOWN");
      await expect(page.getByTestId("customer-work-state")).toHaveText("CLOSED");
      await expect(page.getByTestId("evidence-reference")).toHaveText("evidence://mail-c06-001/delivery-status");
      await expect(page.getByTestId("fail-closed-copy")).toContainText("No delivery claim is inferred");

      await page.screenshot({ path: `/tmp/core5-night-grok/C06-ui/${viewport.name}.png`, fullPage: true });
      await context.close();
    });
  }
});
