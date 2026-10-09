import { rm } from "node:fs/promises";

export default async function globalTeardown(): Promise<void> {
  const directory = process.env.PLAYWRIGHT_FIXTURE_DIRECTORY;
  if (directory) await rm(directory, { recursive: true, force: true });
}
