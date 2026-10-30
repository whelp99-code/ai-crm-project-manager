import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp } from "../../api/src/app.js";
import { InMemoryCwosV2StateStore } from "../../api/src/customer-work-os-v2-runtime.js";
import { operatorPasswordHash } from "../../api/src/operator-auth-crypto.js";
import type { OperatorAuthRecord } from "../../api/src/operator-auth-store.js";
import { OperatorStepUpService } from "../../api/src/operator-step-up.js";
import { internalLoopbackApiBase, readAgentJob, submitAgentCommand } from "../app/agent-loopback";
import { submitSelfEntry } from "../app/self-entry-server";

const password = "synthetic-web-login-password";
const webOrigin = "https://crm.example.test";
const key = "synthetic-api-key-at-least-32-characters";
const workspaceId = "login-workspace";
const principalId = "login-owner";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

const modelClient: ModelClient = {
  async invoke() {
    return {
      structuredOutput: {
        steps: [{
          suggestedCommand: "internal.update", title: "내부 일감", resourceType: "", resourceId: "",
          resourceVersion: 1, payloadJson: "{}",
        }],
      },
      modelVersion: "plan-v1", retentionHonored: true,
    };
  },
};

async function admittedLoopback() {
  let record: OperatorAuthRecord = {
    generation: 1, enrolled: true, totpPending: false, passwordHash: operatorPasswordHash(password),
    totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  };
  const app = createApp({
    authApiKey: key, customerWorkOsV2Profile: "production", modelClient,
    customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false },
    customerWorkOsV2OperatorStepUp: new OperatorStepUpService({
      workspaceId, principalId, sessionSecret: "synthetic-web-session-secret-at-least-32-characters",
      store: { read: () => structuredClone(record), write: next => { record = structuredClone(next); } },
      now: () => 59_000, cookieSecure: false,
    }),
  });
  cleanups.push(() => app.close());
  const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  const source = {
    API_BASE_URL: apiOrigin, CRM_WEB_ORIGIN: webOrigin, WORKSPACE_ID: workspaceId,
    OPERATOR_PRINCIPAL_ID: principalId, AUTH_API_KEY: key, NODE_ENV: "test",
  };
  for (const [name, value] of Object.entries(source)) vi.stubEnv(name, value);
  const login = await submitSelfEntry(new Request(`${webOrigin}/api/self-entry`, {
    method: "POST", headers: { origin: webOrigin, "content-type": "application/json" },
    body: JSON.stringify({ password, totp: "287082" }),
  }));
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const claims = JSON.parse(Buffer.from(cookie.split(".")[1] ?? "", "base64url").toString("utf8")) as { csrf: string };
  return { apiOrigin, cookie, csrf: claims.csrf };
}

describe("normal user work save and requery over internal loopback", () => {
  it("rejects public and unbound API bases", () => {
    expect(internalLoopbackApiBase("https://jm-omachy.alpines-goldeye.ts.net:8449")).toBeUndefined();
    expect(internalLoopbackApiBase("http://100.87.253.57:4312")).toBeUndefined();
    expect(internalLoopbackApiBase("http://127.0.0.1:4312")).toBe("http://127.0.0.1:4312");
  });

  it("saves one internal update and reads the same job back without a browser principal", async () => {
    const session = await admittedLoopback();
    const text = "내부 일감 저장 후 재조회";
    const saved = await submitAgentCommand(new Request(`${webOrigin}/api/agent/commands`, {
      method: "POST",
      headers: {
        origin: webOrigin, cookie: session.cookie, "content-type": "application/json",
        "x-csrf-token": session.csrf, "idempotency-key": "loopback-save-1",
        "x-principal-id": "forged-principal", "x-api-key": "browser-must-not-supply-this",
      },
      body: JSON.stringify({ text }),
    }));
    expect(saved.status).toBe(202);
    const created = await saved.json() as { jobId: string };
    expect(created.jobId).toMatch(/^job-[0-9]+$/);
    const read = await readAgentJob(new Request(`${webOrigin}/api/agent/jobs/${created.jobId}`, {
      headers: { cookie: session.cookie, "x-principal-id": "forged-principal" },
    }), created.jobId);
    expect(read.status).toBe(200);
    const job = await read.json() as { job: { id: string; rawText: string; createdByPrincipalId: string }; workItems: Array<{ suggestedCommand: string }> };
    expect(job.job.id).toBe(created.jobId);
    expect(job.job.rawText).toBe(text);
    expect(job.job.createdByPrincipalId).toBe(principalId);
    expect(job.workItems[0]?.suggestedCommand).toBe("internal.update");
  });
});
