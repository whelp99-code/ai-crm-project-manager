import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

process.env.PLAYWRIGHT_REVIEW_UI = "1";
const port = process.env.PLAYWRIGHT_WEB_PORT;
// NextURL canonicalizes loopback redirects to localhost.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  ...base,
  testMatch: "review-ui-candidates.scenario.ts",
  globalTeardown: process.env.PLAYWRIGHT_BASE_URL ? undefined : base.globalTeardown,
  use: { ...devices["Desktop Chrome"], baseURL },
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: `pnpm exec tsx e2e/playwright-web-server.ts --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...process.env, PLAYWRIGHT_REVIEW_UI: "1", CRM_WEB_ORIGIN: baseURL },
  },
});
