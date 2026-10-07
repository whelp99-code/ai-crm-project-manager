import { createOperatingApp, parseOperatingConfig } from "./src/ops-boot.js";

async function main(): Promise<void> {
  const config = parseOperatingConfig();
  const app = createOperatingApp(config);
  await app.listen({ port: config.port, host: "127.0.0.1" });
  console.log(`core5 api listening 127.0.0.1:${config.port} (${config.mode})`);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`core5 api shutting down (${signal})`);
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("core5 api boot failed", error);
  process.exitCode = 1;
});
