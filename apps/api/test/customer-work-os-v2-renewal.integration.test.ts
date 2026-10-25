import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createStandaloneCustomerWorkOsV2App,
  type CustomerWorkOsV2ActorBinding,
} from "../src/customer-work-os-v2-routes.js";
import { CustomerWorkOsV2Platform, type CustomerWorkOsV2State, type V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "e3333333-3333-4333-8333-333333333333";
const binding: CustomerWorkOsV2ActorBinding = {
  workspaceId,
  principalId: "w05-local-owner",
  kind: "human",
  stepUpVerified: true,
};
const headers = {
  "x-workspace-id": workspaceId,
  "x-principal-id": binding.principalId,
  "x-principal-kind": "human",
};

function contentFields(content: string, clauses: Array<[string, string]>) {
  const bytes = Buffer.from(content, "utf8");
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  return {
    content,
    citations: clauses.map(([clauseId, text]) => {
      const startByte = bytes.indexOf(Buffer.from(text, "utf8"));
      if (startByte < 0) throw new Error(`fixture clause not found: ${clauseId}`);
      return {
        clauseId,
        startByte,
        endByte: startByte + Buffer.byteLength(text, "utf8"),
        text,
        sourceHash,
      };
    }),
  };
}

function renewalPayload(input: {
  renewalId: string;
  revisionId: string;
  revisionLabel: string;
  observedAt: string;
  expiresOn: string | null;
  noticePeriodDays: number | null;
  unknownTerms: string[];
  content: string;
  clauses: Array<[string, string]>;
}) {
  return {
    renewalId: input.renewalId,
    revisionId: input.revisionId,
    revisionLabel: input.revisionLabel,
    observedAt: input.observedAt,
    expiresOn: input.expiresOn,
    noticePeriodDays: input.noticePeriodDays,
    unknownTerms: input.unknownTerms,
    ...contentFields(input.content, input.clauses),
  };
}

async function post(
  app: ReturnType<typeof createStandaloneCustomerWorkOsV2App>,
  command: string,
  expectedVersion: number,
  idempotencyKey: string,
  payload: unknown,
) {
  return app.inject({
    method: "POST",
    url: "/api/cwos/v2/commands",
    headers: { ...headers, "idempotency-key": idempotencyKey },
    payload: { command, expectedVersion, payload },
  });
}

describe("Customer Work OS v2 renewal revision fixture", () => {
  it("preserves exact cited content, expiry/notice revisions, and UNKNOWN terms", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({
      store,
      profile: "test",
      actorBinding: binding,
      now: () => "2026-10-06T00:00:00.000Z",
    });
    await app.ready();
    try {
      const principal = await post(app, "identity.registerPrincipal", 0, "w05-principal", {
        id: binding.principalId,
        kind: "human",
        displayName: "W05 Local Owner",
        active: true,
      });
      expect(principal.statusCode).toBe(200);
      const membership = await post(app, "identity.addMembership", 1, "w05-membership", {
        id: "w05-membership",
        principalId: binding.principalId,
      });
      expect(membership.statusCode).toBe(200);

      const v1Content = "Renewal term: 2027-01-31. Notice period: 30 days. Fee status: UNKNOWN.";
      const v1Payload = renewalPayload({
        renewalId: "w05-local-renewal",
        revisionId: "w05-local-revision-1",
        revisionLabel: "v1",
        observedAt: "2026-10-06T09:00:00+09:00",
        expiresOn: "2027-01-31",
        noticePeriodDays: 30,
        unknownTerms: ["renewal fee approval"],
        content: v1Content,
        clauses: [
          ["expiry", "2027-01-31"],
          ["notice", "Notice period: 30 days"],
          ["fee", "Fee status: UNKNOWN"],
        ],
      });
      const v1 = await post(app, "w05.renewalRevision", 2, "w05-v1", v1Payload);
      expect(v1.statusCode).toBe(200);

      const v2Content = "Renewal term: 2027-02-28. Notice period: 45 days. Fee status: UNKNOWN.";
      const v2Payload = renewalPayload({
        renewalId: "w05-local-renewal",
        revisionId: "w05-local-revision-2",
        revisionLabel: "v2",
        observedAt: "2026-10-07T10:30:00-07:00",
        expiresOn: "2027-02-28",
        noticePeriodDays: 45,
        unknownTerms: ["renewal fee approval"],
        content: v2Content,
        clauses: [
          ["expiry", "2027-02-28"],
          ["notice", "Notice period: 45 days"],
          ["fee", "Fee status: UNKNOWN"],
        ],
      });
      const v2 = await post(app, "w05.renewalRevision", v1.json().runtimeVersion, "w05-v2", v2Payload);
      expect(v2.statusCode).toBe(200);
      const conflictingReplay = await post(app, "w05.renewalRevision", v2.json().runtimeVersion, "w05-v2-conflict", {
        ...renewalPayload({
          renewalId: "w05-local-renewal",
          revisionId: "w05-local-revision-2",
          revisionLabel: "v2",
          observedAt: "2026-10-07T10:30:00-07:00",
          expiresOn: "2027-02-28",
          noticePeriodDays: 45,
          unknownTerms: ["renewal fee approval"],
          content: "Renewal term: 2027-02-28. Notice period: 46 days. Fee status: UNKNOWN.",
          clauses: [
            ["expiry", "2027-02-28"],
            ["notice", "Notice period: 46 days"],
            ["fee", "Fee status: UNKNOWN"],
          ],
        }),
      });
      expect(conflictingReplay.statusCode).toBe(409);
      expect(conflictingReplay.json()).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });

      const state = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      expect(state.statusCode).toBe(200);
      const draft = state.json().state.renewals.drafts.find((item: { id: string }) => item.id === "w05-local-renewal");
      expect(draft.revisions.map((item: { revisionLabel: string; expiresOn: string; noticePeriodDays: number }) => [
        item.revisionLabel,
        item.expiresOn,
        item.noticePeriodDays,
      ])).toEqual([
        ["v1", "2027-01-31", 30],
        ["v2", "2027-02-28", 45],
      ]);
      expect(draft.revisions[0].content).toBe(v1Content);
      expect(draft.revisions[0].sourceHash).toBe(v1Payload.citations[0]?.sourceHash);
      expect(draft.revisions[0].citations.map((item: { text: string }) => item.text)).toEqual([
        "2027-01-31",
        "Notice period: 30 days",
        "Fee status: UNKNOWN",
      ]);
      expect(draft.revisions[0].unknownTerms).toEqual(["renewal fee approval"]);
      expect(draft.receipts.every((receipt: { approvalStatus: string }) => receipt.approvalStatus === "NOT_APPROVED")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid offset timestamp and a citation that does not match content bytes", async () => {
    const app = createStandaloneCustomerWorkOsV2App({
      store: new InMemoryCwosV2StateStore(),
      profile: "test",
      actorBinding: binding,
    });
    await app.ready();
    try {
      await post(app, "identity.registerPrincipal", 0, "w05-edge-principal", {
        id: binding.principalId,
        kind: "human",
        displayName: "W05 Local Owner",
        active: true,
      });
      await post(app, "identity.addMembership", 1, "w05-edge-membership", {
        id: "w05-edge-membership",
        principalId: binding.principalId,
      });
      const content = "Expiry 2027-01-31";
      const measured = contentFields(content, [["expiry", "2027-01-31"]]);
      const invalidTime = await post(app, "w05.renewalRevision", 2, "w05-invalid-time", {
        renewalId: "w05-edge-renewal",
        revisionId: "w05-edge-revision-1",
        revisionLabel: "v1",
        observedAt: "2026-10-06T09:00:00",
        expiresOn: "2027-01-31",
        noticePeriodDays: null,
        unknownTerms: ["notice period"],
        ...measured,
      });
      expect(invalidTime.statusCode).toBe(400);
      expect(invalidTime.json()).toMatchObject({ error: "EXPLICIT_OFFSET_REQUIRED" });

      const invalidCalendar = await post(app, "w05.renewalRevision", 2, "w05-invalid-calendar", {
        renewalId: "w05-edge-renewal",
        revisionId: "w05-edge-revision-calendar",
        revisionLabel: "v1",
        observedAt: "2026-10-06T09:00:00Z",
        expiresOn: "2027-02-29",
        noticePeriodDays: null,
        unknownTerms: ["notice period"],
        ...measured,
      });
      expect(invalidCalendar.statusCode).toBe(400);
      expect(invalidCalendar.json()).toMatchObject({ error: "INVALID_DATE" });

      const mismatch = await post(app, "w05.renewalRevision", 2, "w05-invalid-citation", {
        renewalId: "w05-edge-renewal",
        revisionId: "w05-edge-revision-1",
        revisionLabel: "v1",
        observedAt: "2026-10-06T09:00:00Z",
        expiresOn: "2027-01-31",
        noticePeriodDays: null,
        unknownTerms: ["notice period"],
        ...measured,
        citations: [{ ...measured.citations[0], text: "2027-02-31" }],
      });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toMatchObject({ error: "CITATION_CONTENT_MISMATCH" });
      const state = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      expect(state.json().state.renewals.drafts).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("W05 boundary rejects only a mismatched citation hash without writes and accepts the valid control", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({
      store, profile: "test", actorBinding: binding, now: () => "2026-10-06T00:00:00.000Z",
    });
    await app.ready();
    try {
      expect((await post(app, "identity.registerPrincipal", 0, "hash-principal", {
        id: binding.principalId, kind: "human", displayName: "Hash Owner", active: true,
      })).statusCode).toBe(200);
      expect((await post(app, "identity.addMembership", 1, "hash-membership", {
        id: "hash-membership", principalId: binding.principalId,
      })).statusCode).toBe(200);
      const payload = renewalPayload({
        renewalId: "hash-renewal", revisionId: "hash-revision", revisionLabel: "v1",
        observedAt: "2026-10-06T09:00:00+09:00", expiresOn: null, noticePeriodDays: null,
        unknownTerms: ["expiry", "notice period"], content: "갱신 조건 UNKNOWN", clauses: [["terms", "갱신 조건 UNKNOWN"]],
      });
      const before = await store.load(workspaceId);
      if (!before) throw new Error("bootstrapped envelope required");
      const auditBefore = store.auditLog(workspaceId);
      const badPayload = {
        ...payload,
        citations: payload.citations.map(citation => ({
          ...citation, sourceHash: citation.sourceHash === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
        })),
      };
      expect(badPayload.citations.map(({ sourceHash, ...citation }) => citation))
        .toEqual(payload.citations.map(({ sourceHash, ...citation }) => citation));
      const rejected = await post(app, "w05.renewalRevision", before.version, "hash-invalid", badPayload);
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: "CITATION_HASH_MISMATCH" });
      expect(await store.load(workspaceId)).toEqual(before);
      expect(store.auditLog(workspaceId)).toEqual(auditBefore);
      const valid = await post(app, "w05.renewalRevision", before.version, "hash-valid", payload);
      expect(valid.statusCode).toBe(200);
      const expectedHash = createHash("sha256").update(payload.content, "utf8").digest("hex");
      expect(valid.json().result).toMatchObject({ sourceHash: expectedHash, approvalStatus: "NOT_APPROVED" });
      const after = await store.load(workspaceId);
      expect(after?.state.renewals?.drafts[0]?.revisions[0]).toMatchObject({
        content: payload.content, sourceHash: expectedHash, citations: payload.citations,
        expiresOn: null, noticePeriodDays: null, unknownTerms: payload.unknownTerms,
      });
      expect(after?.state.renewals?.drafts[0]?.receipts[0]).toMatchObject({
        status: "INTERNAL_CANDIDATE", approvalStatus: "NOT_APPROVED",
      });
      expect(after?.version).toBe(before.version + 1);
      expect(after?.idempotency.some(receipt => receipt.key === "hash-invalid")).toBe(false);
      expect(store.auditLog(workspaceId)).toHaveLength(auditBefore.length + 1);
    } finally {
      await app.close();
    }
  });

  it("W05 boundary hydrates an old snapshot without renewals and preserves a subsequent revision round trip", () => {
    const now = "2026-10-06T00:00:00.000Z";
    const owner: V2Actor = { ...binding };
    const original = new CustomerWorkOsV2Platform(workspaceId, () => now);
    original.identity.registerPrincipal({
      id: owner.principalId, workspaceId, kind: "human", displayName: "Snapshot Owner", active: true,
      oidcIssuer: null, oidcSubject: null,
    }, owner);
    original.identity.addMembership({
      id: "snapshot-membership", workspaceId, principalId: owner.principalId, status: "ACTIVE",
    }, owner);
    const exported = original.exportState();
    const legacy = structuredClone(exported);
    delete legacy.renewals;
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(exported).filter(key => key !== "renewals").sort());
    const serialized = JSON.stringify(legacy);
    const restored = new CustomerWorkOsV2Platform(workspaceId, () => now);
    restored.hydrateState(JSON.parse(serialized) as CustomerWorkOsV2State);
    expect(restored.exportState().renewals).toEqual({ schemaVersion: 1, drafts: [] });
    expect(restored.exportState()).toEqual(exported);
    const payload = renewalPayload({
      renewalId: "legacy-renewal", revisionId: "legacy-revision", revisionLabel: "v1",
      observedAt: "2026-10-06T09:00:00+09:00", expiresOn: null, noticePeriodDays: null,
      unknownTerms: ["expiry", "notice period"], content: "갱신 조건 UNKNOWN", clauses: [["terms", "갱신 조건 UNKNOWN"]],
    });
    const draft = restored.renewals.recordRevision({ ...payload, workspaceId }, owner, now);
    const sourceHash = createHash("sha256").update(payload.content, "utf8").digest("hex");
    expect(draft.version).toBe(1);
    expect(draft.revisions).toHaveLength(1);
    expect(draft.revisions[0]).toMatchObject({
      ...payload, workspaceId, observedAt: now, sourceHash, version: 1, recordedByPrincipalId: owner.principalId,
    });
    expect(draft.receipts).toEqual([{
      revisionId: payload.revisionId, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "INTERNAL_CANDIDATE", approvalStatus: "NOT_APPROVED", createdAt: now,
    }]);
    const recorded = restored.exportState();
    expect({ ...recorded, renewals: exported.renewals }).toEqual(exported);
    const reopened = new CustomerWorkOsV2Platform(workspaceId, () => now);
    reopened.hydrateState(JSON.parse(JSON.stringify(recorded)) as CustomerWorkOsV2State);
    expect(reopened.exportState()).toEqual(recorded);
    expect(reopened.exportState().renewals?.drafts).toEqual([draft]);
    expect(JSON.stringify(legacy)).toBe(serialized);
  });

  it("semantically replays an internal receipt after 501 transport keys and manager reconstruction", async () => {
    const workspaceIdForReplay = "e4444444-4444-4444-8444-444444444444";
    const owner: V2Actor = {
      principalId: "w05-replay-owner",
      workspaceId: workspaceIdForReplay,
      kind: "human",
      stepUpVerified: true,
    };
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    await runtime.command({
      workspaceId: workspaceIdForReplay,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "w05-replay-principal",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "W05 Replay Owner", active: true },
    });
    await runtime.command({
      workspaceId: workspaceIdForReplay,
      actor: owner,
      expectedVersion: 1,
      idempotencyKey: "w05-replay-membership",
      command: "identity.addMembership",
      payload: { id: "w05-replay-membership", principalId: owner.principalId },
    });
    const sourceContent = "Expiry 2027-01-31; notice 30 days; fee unknown.";
    const originalPayload = renewalPayload({
      renewalId: "w05-renewal-replay",
      revisionId: "w05-semantic-revision-1",
      revisionLabel: "v1",
      observedAt: "2026-10-06T09:00:00Z",
      expiresOn: "2027-01-31",
      noticePeriodDays: 30,
      unknownTerms: ["renewal fee"],
      content: sourceContent,
      clauses: [
        ["expiry", "2027-01-31"],
        ["notice", "notice 30 days"],
        ["fee", "fee unknown"],
      ],
    });
    const first = await runtime.command({
      workspaceId: workspaceIdForReplay,
      actor: owner,
      expectedVersion: 2,
      idempotencyKey: "w05-transport-original",
      command: "w05.renewalRevision",
      payload: originalPayload,
    });
    let version = first.envelope.version;
    for (let index = 0; index < 501; index += 1) {
      const nextPayload = renewalPayload({
        renewalId: "w05-renewal-replay",
        revisionId: `w05-semantic-revision-${index + 2}`,
        revisionLabel: `v${index + 2}`,
        observedAt: "2026-10-06T09:00:00Z",
        expiresOn: "2027-01-31",
        noticePeriodDays: 30,
        unknownTerms: ["renewal fee"],
        content: sourceContent,
        clauses: [
          ["expiry", "2027-01-31"],
          ["notice", "notice 30 days"],
          ["fee", "fee unknown"],
        ],
      });
      const next = await runtime.command({
        workspaceId: workspaceIdForReplay,
        actor: owner,
        expectedVersion: version,
        idempotencyKey: `w05-transport-${index}`,
        command: "w05.renewalRevision",
        payload: nextPayload,
      });
      version = next.envelope.version;
    }
    const beforeReplay = await runtime.read(workspaceIdForReplay);
    const draftBefore = beforeReplay.state.renewals?.drafts.find((item) => item.id === "w05-renewal-replay");
    expect(beforeReplay.idempotency.some((item) => item.key === "w05-transport-original")).toBe(false);
    const reopened = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-06T00:00:00.000Z");
    const replay = await reopened.command({
      workspaceId: workspaceIdForReplay,
      actor: owner,
      expectedVersion: beforeReplay.version,
      idempotencyKey: "w05-transport-original",
      command: "w05.renewalRevision",
      payload: originalPayload,
    });
    const draftAfter = replay.envelope.state.renewals?.drafts.find((item) => item.id === "w05-renewal-replay");
    expect(draftAfter?.version).toBe(draftBefore?.version);
    expect(draftAfter?.revisions).toHaveLength(draftBefore?.revisions.length ?? 0);
    expect(draftAfter?.receipts[0]?.approvalStatus).toBe("NOT_APPROVED");
    expect(draftAfter?.receipts[0]?.status).toBe("INTERNAL_CANDIDATE");
  });
});
