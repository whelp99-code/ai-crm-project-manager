import { defineConfig, devices } from "@playwright/test";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOwnedFixtureControl, requireExternalFixtureDirectory } from "./e2e/fixture-control";

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
async function ephemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate Playwright web port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? await ephemeralPort());
process.env.PLAYWRIGHT_WEB_PORT = String(port);
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? `http://127.0.0.1:${port}`;
const runId = process.env.PLAYWRIGHT_RUN_ID ?? String(process.pid);
if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("PLAYWRIGHT_RUN_ID is invalid");
process.env.PLAYWRIGHT_RUN_ID = runId;
const fixtureDirectory = externalBaseURL
  ? requireExternalFixtureDirectory(externalBaseURL, process.env.PLAYWRIGHT_FIXTURE_DIRECTORY)
  : join(tmpdir(), `crm-playwright-auth-${runId}`);
if (!externalBaseURL) process.env.PLAYWRIGHT_FIXTURE_DIRECTORY = fixtureDirectory;
if (externalBaseURL) await readOwnedFixtureControl(fixtureDirectory, externalBaseURL);

export default defineConfig({
  testDir: "./e2e",
  testIgnore: /pilot-live-loop\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "on-first-retry",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm exec tsx e2e/playwright-web-server.ts --port ${port}`,
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
          PLAYWRIGHT_FIXTURE_DIRECTORY: fixtureDirectory,
          CRM_WEB_ORIGIN: baseURL,
        },
      },
});
