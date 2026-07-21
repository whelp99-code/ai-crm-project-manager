import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  PILOT_LIVE_API_BASE_URL,
  PILOT_LIVE_API_PORT,
  PILOT_LIVE_APPROVER_ID,
  PILOT_LIVE_OPERATOR_ID,
  PILOT_LIVE_WEB_BASE_URL,
  PILOT_LIVE_WEB_PORT,
  PILOT_LIVE_WORKSPACE_ID,
} from "./e2e/live-loop-env.js";

/**
 * Second Playwright project (M3 D1/D9): a REAL live-API loop, separate from
 * the default fail-closed `playwright.config.ts`. Two webServers:
 *  1. e2e/live-server.ts — a real @ai-crm/api Fastify app (deterministic
 *     injected modelClient, no network) via `tsx`.
 *  2. `next dev` pointed at that live API through API_BASE_URL/WORKSPACE_ID.
 *
 * Run with: pnpm --filter @ai-crm/web test:e2e:live
 * (cwd must be apps/web so the relative node_modules/.pnpm lookup resolves).
 */
function resolveTsxCliPath(): string {
  const pnpmDir = path.resolve(process.cwd(), "..", "..", "node_modules", ".pnpm");
  const entries = existsSync(pnpmDir) ? readdirSync(pnpmDir) : [];
  const tsxDir = entries.find((entry) => entry.startsWith("tsx@"));
  if (!tsxDir) {
    throw new Error(
      "pilot-live-loop: tsx not found under node_modules/.pnpm — run `pnpm install` at the repo root first.",
    );
  }
  return path.join(pnpmDir, tsxDir, "node_modules", "tsx", "dist", "cli.mjs");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /pilot-live-loop\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: PILOT_LIVE_WEB_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `node ${JSON.stringify(resolveTsxCliPath())} e2e/live-server.ts`,
      url: `${PILOT_LIVE_API_BASE_URL}/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        PILOT_LIVE_API_PORT: String(PILOT_LIVE_API_PORT),
        PILOT_LIVE_WORKSPACE_ID,
        PILOT_LIVE_OPERATOR_ID,
        PILOT_LIVE_APPROVER_ID,
      },
    },
    {
      command: `pnpm exec next dev --port ${PILOT_LIVE_WEB_PORT}`,
      url: PILOT_LIVE_WEB_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        API_BASE_URL: PILOT_LIVE_API_BASE_URL,
        NEXT_PUBLIC_API_BASE_URL: PILOT_LIVE_API_BASE_URL,
        WORKSPACE_ID: PILOT_LIVE_WORKSPACE_ID,
        NEXT_PUBLIC_WORKSPACE_ID: PILOT_LIVE_WORKSPACE_ID,
        OPERATOR_PRINCIPAL_ID: PILOT_LIVE_OPERATOR_ID,
        NEXT_PUBLIC_OPERATOR_PRINCIPAL_ID: PILOT_LIVE_OPERATOR_ID,
        APPROVER_PRINCIPAL_ID: PILOT_LIVE_APPROVER_ID,
        NEXT_PUBLIC_APPROVER_PRINCIPAL_ID: PILOT_LIVE_APPROVER_ID,
      },
    },
  ],
});
