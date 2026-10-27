import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { createApp } from "../src/app.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "isolated-blro";
const principalId = "isolated-jarvis-reader";
const key = "isolated-jarvis-reader-key";
const listPath = "/api/cwos/v2/mail-candidates";
const headers = { "x-api-key": key, "x-workspace-id": workspaceId,
  "x-principal-id": principalId, "x-principal-kind": "service" };

async function fixture(seed = true, active = true, member = true) {
  const store = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
  for (const workspace of [workspaceId, "isolated-other"]) {
    const owner: V2Actor = { workspaceId: workspace, principalId: "owner", kind: "human", stepUpVerified: true };
    for (const [command, payload] of [
      ["identity.registerPrincipal", { id: "owner", kind: "human", displayName: "Owner", active: true }],
      ["identity.addMembership", { id: "owner-member", principalId: "owner" }],
      ["identity.registerPrincipal", { id: "mail-writer", kind: "service", displayName: "Writer", active: true }],
      ["identity.addMembership", { id: "writer-member", principalId: "mail-writer" }],
      ["identity.registerPrincipal", { id: principalId, kind: "service", displayName: "JARVIS reader", active }],
      ...(member ? [["identity.addMembership", { id: "jarvis-member", principalId }]] as const : []),
    ] as const) {
      await runtime.command({ workspaceId: workspace, actor: owner, expectedVersion: (await runtime.read(workspace)).version,
        idempotencyKey: command + payload.id, command, payload });
    }
    if (seed) {
      await runtime.command({ workspaceId: workspace, actor: { workspaceId: workspace, principalId: "mail-writer",
        kind: "service", stepUpVerified: false }, expectedVersion: (await runtime.read(workspace)).version,
        idempotencyKey: "seed-candidate", command: "mail.candidate.create", payload: {
          id: `candidate-${workspace}`, provider: "GMAIL", mailbox: "mail@example.test",
          sourceLocator: `gmail://${workspace}`, providerEventId: workspace, subject: `Proposal ${workspace}`,
          bodyDigest: "a".repeat(64),
        } });
    }
  }
  const app = createApp({ authApiKey: key, customerWorkOsV2Profile: "test", customerWorkOsV2Store: store,
    customerWorkOsV2MachineBinding: { workspaceId, principalId, kind: "service", readOnly: true, mailCandidateReadOnly: true } });
  await app.ready();
  return { app, runtime };
}

describe("JARVIS candidate-only reader", () => {
  it("lists only bound workspace candidates without exposing or mutating business state", async () => {
    const f = await fixture();
    try {
      const before = await f.runtime.read(workspaceId);
      const r = await f.app.inject({ method: "GET", url: listPath, headers });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ workspaceId, count: 1, candidates: [{
        id: `candidate-${workspaceId}`, confirmed: false, status: "CANDIDATE",
        freshness: "producer_unverified", createdAt: "2026-10-09T00:00:00.000Z",
      }] });
      expect(r.json()).not.toHaveProperty("state");
      expect(await f.runtime.read(workspaceId)).toEqual(before);
    } finally { await f.app.close(); }
  });

  it("omits mailbox, source identifiers and subject from candidate responses", async () => {
    const f = await fixture();
    try {
      const stored = (await f.runtime.read(workspaceId)).state.inbox.mailCandidates?.[0];
      expect(stored).toMatchObject({ mailbox: "mail@example.test", sourceLocator: `gmail://${workspaceId}`,
        providerEventId: workspaceId, subject: `Proposal ${workspaceId}` });
      const r = await f.app.inject({ method: "GET", url: listPath, headers });
      expect(r.statusCode).toBe(200);
      const candidate = r.json<{ candidates: Record<string, unknown>[] }>().candidates[0];
      expect(candidate).toBeDefined();
      expect(candidate).not.toHaveProperty("mailbox");
      expect(candidate).not.toHaveProperty("sourceLocator");
      expect(candidate).not.toHaveProperty("providerEventId");
      expect(candidate).not.toHaveProperty("subject");
      expect(candidate).not.toHaveProperty("bodyDigest");
      expect(candidate).not.toHaveProperty("createdByPrincipalId");
    } finally { await f.app.close(); }
  });

  it("returns only the bound candidate count", async () => {
    const f = await fixture();
    try {
      const r = await f.app.inject({ method: "GET", url: `${listPath}/count`, headers });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ workspaceId, count: 1 });
    } finally { await f.app.close(); }
  });

  it("returns an empty list and zero count when there are no candidates", async () => {
    const f = await fixture(false);
    try {
      const r = await f.app.inject({ method: "GET", url: listPath, headers });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ workspaceId, count: 0, candidates: [] });
    } finally { await f.app.close(); }
  });

  it.each([
    ["POST", listPath], ["PATCH", `${listPath}/candidate-id`], ["DELETE", `${listPath}/candidate-id`],
    ["POST", `${listPath}/candidate-id/confirm`], ["GET", `${listPath}/candidate-id`],
    ["GET", "/api/cwos/v2/state"], ["GET", "/api/cwos/v2/company-overview"],
    ["GET", "/api/cwos/v2/normalized-projections/plan-id"], ["GET", "/api/cwos/accounts"],
    ["POST", "/api/cwos/v2/commands"], ["POST", "/api/cwos/v2/operator-step-up"],
  ] as const)("denies %s %s without state mutation", async (method, url) => {
    const f = await fixture();
    try {
      const before = await f.runtime.read(workspaceId);
      const r = await f.app.inject({ method, url, headers });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: "MAIL_CANDIDATE_READ_ONLY" });
      expect(await f.runtime.read(workspaceId)).toEqual(before);
    } finally { await f.app.close(); }
  });

  it.each([listPath, `${listPath}/count`])("rejects foreign workspace claims on %s", async url => {
    const f = await fixture();
    try {
      const r = await f.app.inject({ method: "GET", url, headers: { ...headers, "x-workspace-id": "isolated-other" } });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });
    } finally { await f.app.close(); }
  });

  it.each([
    { "x-principal-id": "mail-writer" }, { "x-principal-kind": "human" }, { "x-step-up": "true" },
  ])("rejects forged identity or step-up claims %j", async claim => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: "GET", url: listPath, headers: { ...headers, ...claim } })).statusCode).toBe(403);
    } finally { await f.app.close(); }
  });

  it("rejects a wrong key before reading candidates", async () => {
    const f = await fixture();
    try {
      expect((await f.app.inject({ method: "GET", url: listPath,
        headers: { ...headers, "x-api-key": "wrong-key" } })).statusCode).toBe(401);
    } finally { await f.app.close(); }
  });

  it.each([[false, false, "PRINCIPAL_REQUIRED"], [true, false, "MEMBERSHIP_REQUIRED"]] as const)(
    "requires an active principal and membership (%s, %s)", async (active, member, error) => {
    const f = await fixture(true, active, member);
    try {
      const r = await f.app.inject({ method: "GET", url: listPath, headers });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error });
    } finally { await f.app.close(); }
  });

  it.each([
    { kind: "service", readOnly: false },
    { kind: "ai", readOnly: true },
    { kind: "service", readOnly: true, mailAccountMasterRead: true },
    { kind: "service", readOnly: true, mailCandidateCreateOnly: true },
  ] as const)("rejects mixed or non-service candidate readers %j", binding => {
    expect(() => createApp({ authApiKey: key, customerWorkOsV2MachineBinding: {
      workspaceId, principalId, ...binding, mailCandidateReadOnly: true,
    } })).toThrow(/CANDIDATE.*BINDING_INVALID/);
  });
});
