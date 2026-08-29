import { createApp } from "./app.js";

function positivePort(raw: string | undefined): number {
  const value = Number(raw ?? "3001");
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received ${raw ?? "undefined"}`);
  }
  return value;
}

const host = process.env.HOST?.trim() || "0.0.0.0";
const port = positivePort(process.env.PORT);
const app = createApp();

app.get("/healthz", async () => ({
  ok: true,
  service: "jm-ai-native-customer-work-os",
  version: "2.5.0",
  timestamp: new Date().toISOString(),
}));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutdown requested");
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ error }, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

try {
  await app.listen({ host, port });
  app.log.info({ host, port }, "Customer Work OS API listening");
} catch (error) {
  app.log.error({ error }, "Customer Work OS API failed to start");
  process.exitCode = 1;
  await app.close().catch(() => undefined);
}
