import { readFileSync } from "node:fs";
import { pageAllowsEdge } from "./page-gate.js";

export function readGeneration(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { generation?: unknown };
    return typeof parsed.generation === "number" ? parsed.generation : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

/** Page render gate. Stale generation (logout or a newer login) is denied. */
export async function pageSessionAllows(input: {
  enabled: boolean;
  pathname: string;
  token: string | undefined;
  secret: string | undefined;
  nowMs: number;
  statePath: string | undefined;
}): Promise<boolean> {
  const generation = input.statePath ? readGeneration(input.statePath) : undefined;
  return pageAllowsEdge({ ...input, generation });
}
