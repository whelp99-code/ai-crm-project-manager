import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function workerEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.DATABASE_URL;
  delete env.ADMIN_DATABASE_URL;
  delete env.AI_CRM_DATABASE_URL;
  delete env.AI_CRM_TEST_DATABASE_URL;
  return env;
}

function startWorker(extraEnvironment: Record<string, string> = {}) {
  return spawn("pnpm", ["--filter", "@ai-crm/worker", "start"], {
    cwd: repositoryRoot,
    env: workerEnvironment(extraEnvironment),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectOutput(
  child: ReturnType<typeof startWorker>,
): Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null }> {
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ output, code, signal }));
  });
}

describe("worker package start script", () => {
  it("executes the TypeScript source in in-memory one-shot mode", async () => {
    const child = startWorker({ WORKER_NOW_ISO: "2026-08-17T00:00:00.000Z" });
    const { output, code, signal } = await collectOutput(child);

    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(output).toContain("worker.tick_complete");
    expect(output).toContain('"durable":false');
  });

  it("honors WORKER_INTERVAL_MS and remains terminable with SIGTERM", async () => {
    const child = startWorker({ WORKER_INTERVAL_MS: "25", WORKER_NOW_ISO: "2026-08-17T00:00:00.000Z" });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`worker did not start:\n${output}`)), 10_000);
      const onOutput = () => {
        if (output.includes("worker.interval_start")) {
          clearTimeout(timeout);
          child.stdout.off("data", onOutput);
          child.stderr.off("data", onOutput);
          resolve();
        }
      };
      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);
    });

    expect(output).toContain("worker.interval_start");
    expect(output).toContain('"intervalMs":25');
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    // pnpm may expose SIGTERM directly or translate it to the conventional
    // 128 + signal-number exit code; either means the script did not mask it.
    expect(signal === "SIGTERM" || code === 143).toBe(true);
  }, 15_000);
});
