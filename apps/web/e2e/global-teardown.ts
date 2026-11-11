import { rm } from "node:fs/promises";

export default async function globalTeardown(): Promise<void> {
  if (process.env.PLAYWRIGHT_BASE_URL) return;
  const directory = process.env.PLAYWRIGHT_FIXTURE_DIRECTORY;
  if (directory) await rm(directory, { recursive: true, force: true });
}
