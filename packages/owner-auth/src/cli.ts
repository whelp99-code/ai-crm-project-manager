import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OwnerAuthService } from "./index.js";
import { FileOwnerStore } from "./file-store.js";

/**
 * One-time enrollment code. Prints the code and a session secret file.
 * No default password. Does not listen on a port.
 */
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  const value = idx === -1 ? undefined : process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const statePath = arg("--state") ?? process.env.OWNER_AUTH_STATE_PATH;
const envOut = arg("--env-out");
if (!statePath || !envOut) {
  console.error("usage: owner-enroll-cli --state <owner-auth.json> --env-out <owner-auth.env>");
  process.exit(2);
}

const secret = randomBytes(32).toString("base64url");
const service = new OwnerAuthService(new FileOwnerStore(statePath), { sessionSecret: secret });
const issued = service.issueEnrollmentCode();
mkdirSync(dirname(envOut), { recursive: true, mode: 0o700 });
writeFileSync(
  envOut,
  `OWNER_AUTH=1\nOWNER_SESSION_SECRET=${secret}\nOWNER_AUTH_STATE_PATH=${statePath}\n# Set OWNER_COOKIE_SECURE=1 only behind HTTPS. Leave unset on the current HTTP tailnet.\n`,
  { mode: 0o600 },
);
chmodSync(envOut, 0o600);
console.log(`enrollment_code=${issued.code}`);
console.log(`enrollment_expires=${issued.expiresAt}`);
console.log(`env_file=${envOut}`);
console.log("Put env_file values into the API and web process env. Do not commit that file.");
