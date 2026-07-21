import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal Playwright scaffold (T-019).
 *
 * Browser binaries are not committed. First run on a machine:
 *   pnpm --filter @ai-crm/web exec playwright install chromium
 *
 * Default webServer boots Next without API_BASE_URL so /work stays fail-closed.
 * Override with PLAYWRIGHT_BASE_URL to hit an already-running server.
 *
 * pilot-live-loop.spec.ts is excluded here (testIgnore below) — it needs a
 * REAL live API + live-configured Next, run separately via
 * playwright.live.config.ts / `pnpm --filter @ai-crm/web test:e2e:live`.
 */
const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3310);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: /pilot-live-loop\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "on-first-retry",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next dev --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          ...process.env,
          // Force fail-closed /work contract: no fabricated API base in e2e default.
          API_BASE_URL: "",
          NEXT_PUBLIC_API_BASE_URL: "",
          WORKSPACE_ID: "",
          NEXT_PUBLIC_WORKSPACE_ID: "",
        },
      },
});
