import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startNativeAuthFixture } from "./native-auth-fixture.js";

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const port = Number(process.argv[portIndex + 1]);
  const directory = process.env.PLAYWRIGHT_FIXTURE_DIRECTORY;
  const webOrigin = process.env.CRM_WEB_ORIGIN;
  if (!Number.isInteger(port) || port < 1 || !directory || !webOrigin) {
    throw new Error("Playwright web server fixture configuration is incomplete");
  }
  const reviewUi = process.env.PLAYWRIGHT_REVIEW_UI === "1";
  const { app, origin } = await startNativeAuthFixture(directory, { mailCandidates: reviewUi });
  let next: ChildProcess | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (next?.pid) {
      next.kill("SIGTERM");
      await new Promise<void>(resolveExit => {
        if (next?.exitCode !== null) return resolveExit();
        next?.once("exit", () => resolveExit());
      });
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("exit", () => { void rm(directory, { recursive: true, force: true }); });

  try {
    next = spawn(process.execPath, [
      resolve(fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url))),
      "dev", "--hostname", "127.0.0.1", "--port", String(port),
    ], {
      cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
      stdio: "inherit",
      env: {
        ...process.env,
        API_BASE_URL: reviewUi ? origin : "",
        CRM_REVIEW_UI: reviewUi ? "1" : "",
        NEXT_PUBLIC_API_BASE_URL: "",
        NEXT_PUBLIC_WORKSPACE_ID: "",
        OPERATOR_AUTH_API_BASE_URL: origin,
        CRM_WEB_ORIGIN: webOrigin,
        WORKSPACE_ID: "playwright-login-workspace",
        OPERATOR_PRINCIPAL_ID: "playwright-login-owner",
        AUTH_API_KEY: "playwright-auth-api-key-for-isolated-tests-only",
      },
    });
  } catch (error) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  next.once("error", error => {
    console.error("Playwright Next server failed to start", error);
    process.exitCode = 1;
    void shutdown();
  });
  next.once("exit", code => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      void shutdown();
    }
  });
}

void main().catch(error => {
  console.error("Playwright auth fixture failed to start", error);
  process.exitCode = 1;
});
