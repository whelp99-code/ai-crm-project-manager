import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "f2222222-2222-4222-8222-222222222222";
const actor = { workspaceId, principalId: "f2-local-owner", kind: "human", stepUpVerified: true } as const;
const now = () => "2026-10-06T00:00:00.000Z";
const headers = { "x-workspace-id": workspaceId, "x-principal-id": actor.principalId, "x-principal-kind": "human" };

function source(revisionId: string, lines: Array<{
  id: string; text: string; conditional: boolean; kind: "delivery" | "acceptance" | "payment" | "renewal" | null; dueOn: string | null;
}>) {
  const content = ` \n${lines.map(line => line.text).join("\n")}\n `;
  const bytes = Buffer.from(content);
  return {
    workspaceId, sourceId: "f2-local-contract", revisionId, sourceUrl: `contract://local/${revisionId}`,
    observedAt: now(), content, sourceHash: createHash("sha256").update(bytes).digest("hex"),
    clauses: lines.map(line => {
      const startByte = bytes.indexOf(Buffer.from(line.text));
      return { ...line, startByte, endByte: startByte + Buffer.byteLength(line.text) };
    }),
  };
}

const payload = {
  comparisonId: "f2-local-comparison",
  prior: source("rev-1", [
    { id: "accept", text: "Accept by 2026-10-01", conditional: false, kind: "acceptance", dueOn: "2026-10-01" },
    { id: "pay", text: "Pay 30 days if accepted", conditional: true, kind: "payment", dueOn: null },
    { id: "renew", text: "Renew yearly", conditional: false, kind: "renewal", dueOn: null },
  ]),
  next: source("rev-2", [
    { id: "accept", text: "Accept by 2026-10-05", conditional: false, kind: "acceptance", dueOn: "2026-10-05" },
    { id: "pay", text: "Pay 45 days if accepted", conditional: true, kind: "payment", dueOn: null },
    { id: "deliver", text: "Deliver by 2026-11-01", conditional: false, kind: "delivery", dueOn: "2026-11-01" },
  ]),
};

type App = ReturnType<typeof createStandaloneCustomerWorkOsV2App>;
function post(app: App, command: string, expectedVersion: number, key: string, data: unknown) {
  return app.inject({ method: "POST", url: "/api/cwos/v2/commands", headers: { ...headers, "idempotency-key": key },
    payload: { command, expectedVersion, payload: data } });
}
async function seed(app: App) {
  expect((await post(app, "identity.registerPrincipal", 0, "f2-principal", {
    id: actor.principalId, kind: "human", displayName: "F2 Local Owner", active: true,
  })).statusCode).toBe(200);
  expect((await post(app, "identity.addMembership", 1, "f2-member", {
    id: "f2-member", principalId: actor.principalId,
  })).statusCode).toBe(200);
}

describe("native F2 local comparison", () => {
  it("preserves exact revisions, deleted and conditional clauses and unapproved obligation candidates", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({ store, profile: "test", actorBinding: actor, now });
    await app.ready();
    try {
      await seed(app);
      const response = await post(app, "f2.compareRevisions", 2, "f2-compare", payload);
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toMatchObject({ approved: false, sent: false, sourceVerified: false });
      expect(response.json().result).not.toHaveProperty("prior");
      expect(response.json().result).not.toHaveProperty("findings");
      expect(response.json().result).toMatchObject({
        comparisonId: payload.comparisonId, priorSourceHash: payload.prior.sourceHash, nextSourceHash: payload.next.sourceHash,
      });
      const manager = new CustomerWorkOsV2RuntimeManager(store, now);
      const reopened = await manager.readAuthorized(actor);
      const comparison = reopened.state.contractComparisons?.comparisons[0];
      expect(comparison?.prior.content).toBe(payload.prior.content);
      expect(comparison?.next.sourceHash).toBe(payload.next.sourceHash);
      expect(comparison?.findings.map(item => [item.id, item.changes, item.proposedDeadlineStatus])).toEqual([
        ["accept", ["date_changed", "interpretation_changed"], "OVERDUE"], ["deliver", ["added"], "UPCOMING"],
        ["pay", ["number_changed"], "UNKNOWN"], ["renew", ["deleted"], "UNKNOWN"],
      ]);
      expect(comparison?.findings.every(item => item.interpretation === "UNCONFIRMED")).toBe(true);
      expect(comparison?.findings.every(item => item.deadlineStatus === "UNKNOWN")).toBe(true);
      expect(comparison?.findings.find(item => item.id === "pay")?.next?.proposal.conditional).toBe(true);
      expect(comparison?.findings.find(item => item.id === "renew")?.prior?.text).toBe("Renew yearly");
      const replay = await post(app, "f2.compareRevisions", 0, "f2-compare", payload);
      expect(replay.json().result).toEqual(response.json().result);
      expect((await manager.readAuthorized(actor)).version).toBe(3);
      for (const alias of [{ ...payload, comparisonId: "f2-alias" },
        { ...payload, comparisonId: "f2-reversed", prior: payload.next, next: payload.prior }]) {
        const denied = await post(app, "f2.compareRevisions", 3, alias.comparisonId, alias);
        expect(denied.statusCode).toBe(409);
        expect(denied.json()).toMatchObject({ error: "IDEMPOTENCY_CONFLICT" });
      }
    } finally { await app.close(); }
  });

  it("fails closed for source tampering, foreign scope, stale CAS and missing step-up without changing state", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({ store, profile: "test", actorBinding: actor, now });
    await app.ready();
    try {
      await seed(app);
      const manager = new CustomerWorkOsV2RuntimeManager(store, now);
      const before = await manager.readAuthorized(actor);
      for (const [error, invalid] of [
        ["CITATION_HASH_MISMATCH", { ...payload, prior: { ...payload.prior, sourceHash: "0".repeat(64) } }],
        ["CROSS_WORKSPACE", { ...payload, next: { ...payload.next, workspaceId: "other-workspace" } }],
        ["CITATION_CONTENT_MISMATCH", { ...payload, next: { ...payload.next, clauses: payload.next.clauses.map(c => ({ ...c, text: `${c.text}!` })) } }],
        ["EXPLICIT_OFFSET_REQUIRED", { ...payload, next: { ...payload.next, observedAt: "2026-10-06T00:00:00" } }],
        ["INVALID_DATE", { ...payload, next: { ...payload.next, clauses: payload.next.clauses.map(c => ({ ...c, dueOn: "2026-02-30" })) } }],
      ]) {
        const denied = await post(app, "f2.compareRevisions", 2, JSON.stringify(invalid), invalid);
        expect(denied.json()).toMatchObject({ error });
      }
      expect((await post(app, "f2.compareRevisions", 0, "f2-stale", payload)).statusCode).toBe(409);
      await expect(manager.command({ workspaceId, actor: { ...actor, stepUpVerified: false },
        command: "f2.compareRevisions", expectedVersion: 2, idempotencyKey: "f2-no-step", payload,
      })).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
      const foreignRead = await app.inject({ method: "GET", url: "/api/cwos/v2/state",
        headers: { ...headers, "x-workspace-id": "other-workspace" } });
      expect(foreignRead.statusCode).toBe(403);
      expect(foreignRead.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });
      expect(await manager.readAuthorized(actor)).toEqual(before);
    } finally { await app.close(); }
  });

  it("keeps one semantic candidate after 501 keys and restart, rejects source rewrites and commits one CAS winner", async () => {
    const store = new InMemoryCwosV2StateStore();
    const app = createStandaloneCustomerWorkOsV2App({ store, profile: "test", actorBinding: actor, now });
    await app.ready();
    try {
      await seed(app);
      const first = await post(app, "f2.compareRevisions", 2, "f2-original", payload);
      expect(first.statusCode).toBe(200);
      const manager = new CustomerWorkOsV2RuntimeManager(store, now);
      let version = first.json().runtimeVersion;
      for (let i = 0; i < 501; i++) {
        const replay = await manager.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: version,
          idempotencyKey: `f2-later-${i}`, payload });
        expect(replay.result).toEqual(first.json().result);
        version = replay.envelope.version;
      }
      const reopened = new CustomerWorkOsV2RuntimeManager(store, now);
      const before = await reopened.readAuthorized(actor);
      expect(before.idempotency.some(item => item.key === "f2-original")).toBe(false);
      const replay = await reopened.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: version,
        idempotencyKey: "f2-original", payload });
      expect(replay.result).toEqual(first.json().result);
      expect(replay.envelope.state.contractComparisons?.comparisons).toHaveLength(1);
      version = replay.envelope.version;
      const changed = { ...payload, comparisonId: "f2-rewrite",
        next: source("rev-2", [{ id: "pay", text: "Pay 99 days", conditional: false, kind: "payment", dueOn: null }]) };
      await expect(reopened.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: version,
        idempotencyKey: "f2-rewrite", payload: changed })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect((await reopened.readAuthorized(actor)).version).toBe(version);
      const results = await Promise.allSettled([reopened, new CustomerWorkOsV2RuntimeManager(store, now)].map((runtime, i) =>
        runtime.command({ workspaceId, actor, command: "f2.compareRevisions", expectedVersion: version,
          idempotencyKey: `f2-cas-${i}`, payload: { comparisonId: `f2-cas-${i}`, prior: payload.next,
            next: source(`rev-${i + 3}`, [{ id: "deliver", text: "Deliver by 2026-12-01", conditional: false, kind: "delivery", dueOn: "2026-12-01" }]) } })));
      expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(item => item.status === "rejected").map(item => item.reason)).toEqual([
        expect.objectContaining({ code: "CONCURRENT_MODIFICATION" }),
      ]);
      expect((await reopened.readAuthorized(actor)).state.contractComparisons?.comparisons).toHaveLength(2);
    } finally { await app.close(); }
  });

  it("keeps false caller semantics unconfirmed and exposes simultaneous source and interpretation changes", async () => {
    const app = createStandaloneCustomerWorkOsV2App({ store: new InMemoryCwosV2StateStore(), profile: "test", actorBinding: actor, now });
    await app.ready();
    try {
      await seed(app);
      const data = { comparisonId: "f2-proposals",
        prior: source("rev-1", [{ id: "pay", text: "If accepted pay 30 by 2026-10-01", conditional: true, kind: "payment", dueOn: "2026-10-01" }]),
        next: source("rev-2", [{ id: "pay", text: "If approved pay 45 by 2026-10-05", conditional: false, kind: "delivery", dueOn: "2026-10-05" }]),
      };
      const response = await post(app, "f2.compareRevisions", 2, "f2-false-semantics", data);
      expect(response.statusCode).toBe(200);
      const state = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      expect(state.statusCode).toBe(200);
      expect(state.json().state.contractComparisons.comparisons[0].findings[0]).toMatchObject({
        changes: ["date_changed", "number_changed", "text_changed", "condition_changed", "interpretation_changed"],
        interpretation: "UNCONFIRMED", deadlineStatus: "UNKNOWN", proposedDeadlineStatus: "OVERDUE",
        next: { text: data.next.clauses[0]?.text, proposal: { status: "UNCONFIRMED", origin: "CALLER_PROPOSAL", conditional: false, kind: "delivery" } },
      });
    } finally { await app.close(); }
  });
});
