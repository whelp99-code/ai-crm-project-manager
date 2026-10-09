import { describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import { createApp } from "../src/app.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "isolated-blro-workspace";
const principalId = "isolated-mail-writer";
const key = "isolated-candidate-writer-key";
const now = "2026-10-09T00:00:00.000Z";
const owner: V2Actor = { workspaceId, principalId: "isolated-owner", kind: "human", stepUpVerified: true };
const payload = { expectedVersion: 4, provider: "GMAIL", mailbox: "mail@example.test",
  sourceLocator: "gmail://isolated-message", providerEventId: "isolated-message",
  subject: "Isolated proposal", bodyDigest: "a".repeat(64) };
const headers = { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": principalId,
  "x-principal-kind": "service", "idempotency-key": "candidate-create", "content-type": "application/json" };

async function fixture(readOnly = false) {
  const store = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(store, () => now);
  for (const [command, input] of [
    ["identity.registerPrincipal", { id: owner.principalId, kind: "human", displayName: "Owner", active: true }],
    ["identity.addMembership", { id: "owner-member", principalId: owner.principalId }],
    ["identity.registerPrincipal", { id: principalId, kind: "service", displayName: "Candidate writer", active: true }],
    ["identity.addMembership", { id: "writer-member", principalId }],
  ] as const) {
    const current = await runtime.read(workspaceId);
    await runtime.command({ workspaceId, actor: owner, expectedVersion: current.version,
      idempotencyKey: command + input.id, command, payload: input });
  }
  const app = createApp({ authApiKey: key, customerWorkOsV2Profile: "test", customerWorkOsV2Store: store,
    customerWorkOsV2MachineBinding: { workspaceId, principalId, kind: "service",
      ...(readOnly ? { readOnly: true } : { mailCandidateCreateOnly: true }) } });
  await app.ready();
  return { app, runtime, store };
}

describe("MR candidate-only writer", () => {
  it("creates only an immutable candidate with201 through native CAS, without changing business data", async () => {
    const f = await fixture();
    try {
      const before = await f.runtime.read(workspaceId);
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers, payload });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ runtimeVersion: 5, candidate: { status: "CANDIDATE",
        confirmed: false, freshness: "producer_unverified", createdByPrincipalId: principalId, version: 1 } });
      expect(response.json()).not.toHaveProperty("state");
      const after = await f.runtime.read(workspaceId);
      expect(after.state.inbox.mailCandidates).toHaveLength(1);
      const { mailCandidates, ...unchangedInbox } = after.state.inbox;
      expect(mailCandidates).toHaveLength(1);
      const { mailCandidates: previousCandidates, ...oldInbox } = before.state.inbox;
      expect(previousCandidates).toEqual([]);
      expect(unchangedInbox).toEqual(oldInbox);
      expect({ ...after.state, inbox: before.state.inbox }).toEqual(before.state);
    } finally { await f.app.close(); }
  });

  it("stores optional source metadata without changing writer authority", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers,
        payload: { ...payload, senderCompany: "Acme", summary: "Proposal attached",
          receivedAt: "2026-10-08T00:00:00.000Z", evidenceUrl: "https://example.test/source" } });
      expect(response.statusCode).toBe(201);
      expect(response.json().candidate).toMatchObject({ senderCompany: "Acme", summary: "Proposal attached",
        receivedAt: "2026-10-08T00:00:00.000Z", evidenceUrl: "https://example.test/source",
        status: "CANDIDATE", confirmed: false });
    } finally { await f.app.close(); }
  });

  it.each([
    ["PUT", "/api/cwos/v2/mail-candidates"],
    ["PATCH", "/api/cwos/v2/mail-candidates/candidate-id"],
    ["DELETE", "/api/cwos/v2/mail-candidates/candidate-id"],
    ["POST", "/api/cwos/v2/mail-candidates/candidate-id/confirm"],
    ["POST", "/api/cwos/v2/commands"],
    ["POST", "/api/cwos/accounts"],
    ["GET", "/api/cwos/v2/state"],
    ["GET", "/api/cwos/accounts"],
  ] as const)("denies %s %s without state mutation", async (method, url) => {
    const f = await fixture();
    try {
      const before = await f.runtime.read(workspaceId);
      const response = await f.app.inject({ method, url, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "MAIL_CANDIDATE_CREATE_ONLY" });
      expect(await f.runtime.read(workspaceId)).toEqual(before);
    } finally { await f.app.close(); }
  });

  it.each([
    { "x-workspace-id": "another-workspace" },
    { "x-principal-id": "another-principal" },
    { "x-principal-kind": "human" },
    { "x-step-up": "true" },
  ])("rejects altered identity claims: %j", async (claim) => {
    const f = await fixture();
    try {
      const before = await f.runtime.read(workspaceId);
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates",
        headers: { ...headers, ...claim }, payload });
      expect(response.statusCode).toBe(403);
      expect(await f.runtime.read(workspaceId)).toEqual(before);
    } finally { await f.app.close(); }
  });

  it("rejects a different workspace in the payload", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers,
        payload: { ...payload, workspaceId: "another-workspace" } });
      expect(response.statusCode).toBe(403);
      expect((await f.runtime.read(workspaceId)).version).toBe(4);
    } finally { await f.app.close(); }
  });

  it("keeps the existing read-only account unable to create candidates", async () => {
    const f = await fixture(true);
    try {
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "MACHINE_READ_ONLY" });
      expect((await f.runtime.read(workspaceId)).version).toBe(4);
    } finally { await f.app.close(); }
  });

  it("rejects wrong credentials before candidate creation", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates",
        headers: { ...headers, "x-api-key": "wrong-key" }, payload });
      expect(response.statusCode).toBe(401);
      expect((await f.runtime.read(workspaceId)).version).toBe(4);
    } finally { await f.app.close(); }
  });

  it("rejects caller-supplied confirmation and business mutations", async () => {
    const f = await fixture();
    try {
      const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers,
        payload: { ...payload, confirmed: true, status: "APPROVED", accountId: "existing-account" } });
      expect(response.statusCode).toBe(400);
      expect((await f.runtime.read(workspaceId)).version).toBe(4);
    } finally { await f.app.close(); }
  });

  it("replays creation without updating the candidate and rejects changed source content", async () => {
    const f = await fixture();
    try {
      const created = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers, payload });
      const replay = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates", headers, payload });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(created.json());
      expect((await f.runtime.read(workspaceId)).version).toBe(5);
      const conflict = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidates",
        headers: { ...headers, "idempotency-key": "different-key" },
        payload: { ...payload, expectedVersion: 5, subject: "Changed" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: "CANDIDATE_CONFLICT" });
      expect((await f.runtime.read(workspaceId)).version).toBe(5);
    } finally { await f.app.close(); }
  });

  it.each([
    { readOnly: true, kind: "service" },
    { readOnly: false, kind: "ai" },
  ] as const)("rejects a mixed or non-service writer binding: %j", ({ readOnly, kind }) => {
    expect(() => createApp({ authApiKey: key, customerWorkOsV2MachineBinding: {
      workspaceId, principalId, kind, readOnly, mailCandidateCreateOnly: true,
    } })).toThrow(/CWOS_V2_MAIL_CANDIDATE_BINDING_INVALID/);
  });
});
