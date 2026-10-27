export interface LocalReviewGuardInput {
  optIn: string | undefined;
  nodeEnv: string | undefined;
  hostname: string;
}

export function isLocalReviewAllowed(input: LocalReviewGuardInput): boolean {
  const hostname = input.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return input.optIn === "1" &&
    input.nodeEnv !== "production" &&
    ["localhost", "127.0.0.1", "::1"].includes(hostname);
}
