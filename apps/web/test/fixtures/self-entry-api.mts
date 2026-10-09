import { scryptSync } from "node:crypto";
import { createApp } from "../../../api/src/app.js";
import { OperatorStepUpService } from "../../../api/src/operator-step-up.js";
import type { OperatorAuthRecord } from "../../../api/src/operator-auth-store.js";
import { InMemoryCwosV2StateStore } from "../../../api/src/customer-work-os-v2-runtime.js";

// Owned-loopback fixture only. All material is synthetic and never read from env/files.
const salt = Buffer.alloc(16, 4).toString("base64url");
let record: OperatorAuthRecord = {
  generation: 1, enrolled: true, totpPending: false, passwordSalt: salt,
  passwordHash: scryptSync("self-entry-browser-fixture-password", Buffer.from(salt, "base64url"), 32,
    { N: 16384, r: 8, p: 1 }).toString("base64url"),
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};
const auth = new OperatorStepUpService({
  workspaceId: "self-entry-browser-workspace", principalId: "self-entry-browser-human",
  sessionSecret: "self-entry-browser-fixture-signing-secret-32-plus",
  store: { read: () => structuredClone(record), write: next => { record = structuredClone(next); } },
  now: () => 59_000,
  cookieSecure: false,
});
const app = createApp({
  authApiKey: "self-entry-browser-fixture-api-key-32-plus",
  customerWorkOsV2Profile: "production",
  customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
  customerWorkOsV2OperatorStepUp: auth,
  customerWorkOsV2ActorBinding: {
    workspaceId: auth.workspaceId, principalId: auth.principalId, kind: "human", stepUpVerified: false,
  },
});
const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`CRM_SELF_ENTRY_FIXTURE_READY ${address}\n`);
process.once("SIGTERM", () => { void app.close(); });
process.once("SIGINT", () => { void app.close(); });
