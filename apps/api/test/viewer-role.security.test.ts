import { createRequire } from "node:module";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { FileOperatorAuthStore } from "../src/operator-auth-store.js";
import { operatorPasswordHash, operatorProofSignature, operatorTotpCode } from "../src/operator-auth-crypto.js";
import { OperatorStepUpService } from "../src/operator-step-up.js";
import { parseOperatingConfig } from "../src/ops-boot.js";
import { CustomerWorkOsV2RuntimeManager, InMemoryCwosV2StateStore, type V2PgQueryable } from "../src/customer-work-os-v2-runtime.js";
import { verifySelfEntry, selfEntryConfiguration } from "../../web/app/self-entry-server.js";
import { POST as reviewPost } from "../../web/app/api/cwos/v2/mail-candidate-review/route.js";
import { POST as draftsPost } from "../../web/app/api/cwos/v2/document-drafts/route.js";
import { POST as importPost } from "../../web/app/api/cwos/v2/review-session/route.js";
import { POST as commandPost } from "../../web/app/api/agent/commands/route.js";
import { GET as jobGet } from "../../web/app/api/agent/jobs/[id]/route.js";
import { POST as cancelPost } from "../../web/app/api/agent/jobs/[id]/cancel/route.js";
import { middleware } from "../../web/middleware.js";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { NextRequest } = webRequire("next/server") as {
  NextRequest: new (url: string, init?: RequestInit) => Parameters<typeof reviewPost>[0];
};
const workspaceId = "b1111111-1111-4111-8111-111111111111";
const principalId = "fixture-owner";
const viewerId = "fixture-viewer";
const key = "fixture-api-key-at-least-32-characters";
const sessionSecret = "fixture-session-secret-at-least-32-characters";
const ownerPassword = "fixture-owner-password";
const viewerPassword = "fixture-viewer-password";
const ownerHash = operatorPasswordHash(ownerPassword);
const viewerHash = operatorPasswordHash(viewerPassword);
const ownerTotp = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const viewerTotp = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "crm-viewer-test-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const ownerPath = join(directory, "owner.json"), viewerPath = join(directory, "viewer.json");
  const common = { enrolled: true, totpPending: false };
  writeFileSync(ownerPath, JSON.stringify({ ...common, generation: 1, passwordHash: ownerHash, totpSecret: ownerTotp }), { mode: 0o600 });
  writeFileSync(viewerPath, JSON.stringify({ ...common, generation: 7, passwordHash: viewerHash, totpSecret: viewerTotp, role: "viewer" }), { mode: 0o600 });
  const ownerStore = new FileOperatorAuthStore(ownerPath);
  const viewerStore = new FileOperatorAuthStore(viewerPath, "viewer");
  const auth = new OperatorStepUpService({ workspaceId, principalId, sessionSecret,
    store: ownerStore, viewer: { principalId: viewerId, store: viewerStore },
    now: () => 59_000, cookieSecure: false });
  const store = new InMemoryCwosV2StateStore();
  const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-10-09T00:00:00.000Z");
  const pool: V2PgQueryable = {
    async query<T>() { return { rows: [] as T[], rowCount: 0 }; },
    async withWorkspaceScope<T>(_scope: string, fn: (db: V2PgQueryable) => Promise<T>) {
      return fn({ async query<T>(text: string) {
        const rows = text.includes("cwos_accounts") ? [{ id: "fixture-account", name: "Fixture account" }]
          : text.includes("cwos_engagements") ? [{ id: "fixture-engagement", name: "Fixture engagement", version: 1 }] : [];
        return { rows: rows as T[], rowCount: rows.length };
      } });
    },
  };
  const app = createApp({ authApiKey: key, customerWorkOsV2Profile: "production", customerWorkOsV2Store: store,
    customerWorkOsV2OperatorStepUp: auth, customerWorkOsV2NormalizedProjectionPool: pool,
    customerWorkOsV2ActorBinding: { workspaceId, principalId, kind: "human", stepUpVerified: false } });
  cleanups.push(() => app.close());
  const headers = { "x-api-key": key, "x-workspace-id": workspaceId, "x-principal-id": principalId, "x-principal-kind": "human" };
  const secretPath = join(directory, "session-secret");
  writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
  const env = { CORE5_API_MODE: "human", DATABASE_URL: "postgres://runtime@localhost/fixture",
    ADMIN_DATABASE_URL: "postgres://admin@localhost/fixture", MODEL_GATEWAY_DATABASE_URL: "postgres://model@localhost/fixture",
    WORKSPACE_ID: workspaceId, AUTH_API_KEY: key, CWOS_V2_OPERATOR_WORKSPACE_ID: workspaceId,
    CWOS_V2_OPERATOR_PRINCIPAL_ID: principalId, CWOS_V2_OPERATOR_AUTH_STATE_PATH: ownerPath,
    CWOS_V2_OPERATOR_SESSION_SECRET_FILE: secretPath,
    CWOS_V2_VIEWER_PRINCIPAL_ID: viewerId, CWOS_V2_VIEWER_AUTH_STATE_PATH: viewerPath };
  async function login(role: "owner" | "viewer") {
    const result = await app.inject({ method: "POST", url: "/api/cwos/v2/operator-step-up", headers,
      payload: { password: role === "owner" ? ownerPassword : viewerPassword,
        totp: operatorTotpCode(role === "owner" ? ownerTotp : viewerTotp, 1) } });
    expect(result.statusCode).toBe(200);
    const cookie = String(result.headers["set-cookie"]).split(";")[0] ?? "";
    return { cookie, csrf: result.json<{ csrf: string }>().csrf,
      headers: { ...headers, cookie, "x-csrf-token": result.json<{ csrf: string }>().csrf } };
  }
  async function seed() {
    const actor = { workspaceId, principalId, kind: "human", stepUpVerified: true } as const;
    for (const [command, payload] of [
      ["identity.registerPrincipal", { id: principalId, kind: "human", displayName: "Fixture owner", active: true }],
      ["identity.addMembership", { id: "owner-membership", principalId }],
      ["identity.registerPrincipal", { id: "fixture-writer", kind: "service", displayName: "Fixture writer", active: true }],
      ["identity.addMembership", { id: "writer-membership", principalId: "fixture-writer" }],
      ["mail.candidate.create", { id: "fixture-candidate", provider: "GMAIL", mailbox: "fixture@example.test",
        sourceLocator: "gmail://fixture/1", providerEventId: "fixture-event", subject: "Fixture candidate", bodyDigest: "a".repeat(64) }],
    ] as const) {
      await runtime.command({ workspaceId, actor: command === "mail.candidate.create"
        ? { workspaceId, principalId: "fixture-writer", kind: "service", stepUpVerified: false } : actor,
        expectedVersion: (await runtime.read(workspaceId)).version, idempotencyKey: command + payload.id, command, payload });
    }
  }
  return { auth, app, runtime, store, headers, ownerStore, viewerStore, ownerPath, viewerPath, env, login, seed, directory };
}

function signed(overrides: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ workspaceId, principalId: viewerId, role: "viewer", generation: 7,
    authenticatedAt: 59_000, expiresAt: 359_000, csrf: "fixture-csrf-at-least-24-chars", ...overrides })).toString("base64url");
  return `cwos_operator_stepup=v1.${payload}.${operatorProofSignature(payload, sessionSecret)}`;
}

describe("CRM viewer authorization", () => {
  it.each(["GET", "HEAD"])("admits a viewer proof for %s", async method => {
    const f = fixture();
    const proof = await f.login("viewer");
    expect(f.auth.authorize({ cookieHeader: proof.cookie, csrfHeader: undefined, method })).toBe(true);
    const session = await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session", headers: proof.headers });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true, role: "viewer" });
    expect(f.ownerStore.read().generation).toBe(1);
    expect(f.viewerStore.read().generation).toBe(8);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])("rejects viewer %s at the sole authorization gate", method => {
    const f = fixture();
    expect(() => f.auth.authorize({ cookieHeader: signed(), csrfHeader: "fixture-csrf-at-least-24-chars", method }))
      .toThrowError(expect.objectContaining({ code: "VIEWER_WRITE_FORBIDDEN", statusCode: 403 }));
  });

  it("reads business data but rejects all existing human write routes before mutation", async () => {
    const f = fixture();
    await f.seed();
    const proof = await f.login("viewer");
    const before = await f.store.load(workspaceId);
    for (const url of ["/api/cwos/v2/mail-candidate-review", "/api/cwos/v2/document-drafts"]) {
      expect((await f.app.inject({ method: "GET", url, headers: proof.headers })).statusCode).toBe(200);
    }
    for (const url of ["/api/cwos/v2/commands", "/api/cwos/v2/mail-candidate-review", "/api/cwos/v2/document-drafts"]) {
      const denied = await f.app.inject({ method: "POST", url, headers: proof.headers, payload: {} });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "VIEWER_WRITE_FORBIDDEN" });
    }
    expect(await f.store.load(workspaceId)).toEqual(before);
  });

  it("logs a viewer out with 200, revoking only viewer generation and no business rows", async () => {
    const f = fixture();
    await f.seed();
    const owner = await f.login("owner");
    const viewer = await f.login("viewer");
    const ownerBefore = f.ownerStore.read(), viewerBefore = f.viewerStore.read();
    const businessBefore = await f.store.load(workspaceId);
    const badCsrf = await f.app.inject({ method: "POST", url: "/api/cwos/v2/operator-logout",
      headers: { ...viewer.headers, host: "fixture.test", origin: "http://fixture.test", "x-csrf-token": "wrong" } });
    expect(badCsrf.statusCode).toBe(403);
    expect(f.viewerStore.read()).toEqual(viewerBefore);
    const response = await f.app.inject({ method: "POST", url: "/api/cwos/v2/operator-logout",
      headers: { ...viewer.headers, host: "fixture.test", origin: "http://fixture.test" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("Max-Age=0");
    expect(f.viewerStore.read()).toEqual({ ...viewerBefore, generation: viewerBefore.generation + 1 });
    expect(f.ownerStore.read()).toEqual(ownerBefore);
    expect(await f.store.load(workspaceId)).toEqual(businessBefore);
    expect((await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session", headers: viewer.headers })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session", headers: owner.headers })).json())
      .toEqual({ authenticated: true, role: "owner" });
  });

  it.each([{ role: "viewer", principalId }, { role: "owner", principalId: viewerId }])(
    "rejects signed role/principal impersonation $role", async claims => {
      const f = fixture();
      const result = await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session",
        headers: { ...f.headers, cookie: signed(claims) } });
      expect(result.statusCode).toBe(403);
      expect(result.json()).toEqual({ error: "OPERATOR_PROOF_SCOPE" });
    });

  it.each([undefined, "admin", null, 1])("rejects missing or invalid proof role %s with 401", async role => {
    const f = fixture();
    const response = await f.app.inject({ method: "GET", url: "/api/cwos/v2/operator-session",
      headers: { ...f.headers, cookie: signed({ role }) } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "OPERATOR_PROOF_INVALID" });
  });

  it("does not mix the owner and viewer login factors", async () => {
    const f = fixture();
    for (const [password, secret] of [[viewerPassword, ownerTotp], [ownerPassword, viewerTotp]]) {
      const result = await f.app.inject({ method: "POST", url: "/api/cwos/v2/operator-step-up", headers: f.headers,
        payload: { password, totp: operatorTotpCode(secret!, 1) } });
      expect(result.statusCode).toBe(401);
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    expect((await f.login("viewer")).cookie).toContain("cwos_operator_stepup=v1.");
  });

  it("keeps owner login, candidate confirmation and draft save working", async () => {
    const f = fixture();
    await f.seed();
    const owner = await f.login("owner");
    const confirmed = await f.app.inject({ method: "POST", url: "/api/cwos/v2/mail-candidate-review",
      headers: { ...owner.headers, "idempotency-key": "fixture-confirm" },
      payload: { expectedVersion: 5, candidateId: "fixture-candidate", action: "LINK", accountId: "fixture-account" } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ runtimeVersion: 6, review: { outcome: "LINKED" } });
    const terms = { startDate: "2026-01-01", endDate: "2026-12-31", valueKrw: "100", items: null, conditions: null };
    const saved = await f.app.inject({ method: "POST", url: "/api/cwos/v2/document-drafts",
      headers: { ...owner.headers, "idempotency-key": "fixture-draft" }, payload: {
        action: "RENEWAL", expectedVersion: 6, renewalId: "fixture-renewal", revisionId: "fixture-revision", revisionLabel: "Fixture draft",
        source: { kind: "OWNER_INPUT", id: "fixture-contract", reference: "Fixture document", terms }, terms,
      } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ runtimeVersion: 7 });
    expect((await f.runtime.read(workspaceId)).state.renewals?.drafts).toHaveLength(1);
  });
});

describe("viewer boot isolation", () => {
  it("supports owner-only boot and both viewer settings together", () => {
    const f = fixture();
    expect(parseOperatingConfig(f.env).viewer).toEqual({ principalId: viewerId, authStatePath: f.viewerPath });
    const { CWOS_V2_VIEWER_AUTH_STATE_PATH: _path, CWOS_V2_VIEWER_PRINCIPAL_ID: _principal, ...ownerOnly } = f.env;
    expect(parseOperatingConfig(ownerOnly).viewer).toBeUndefined();
    expect(() => parseOperatingConfig({ ...ownerOnly, CWOS_V2_VIEWER_PRINCIPAL_ID: viewerId })).toThrow(/CONFIG_REQUIRED/);
    expect(() => parseOperatingConfig({ ...ownerOnly, CWOS_V2_VIEWER_AUTH_STATE_PATH: f.viewerPath })).toThrow(/CONFIG_REQUIRED/);
  });
  it("rejects equal principals, equal paths, and hard links to the same auth file", () => {
    const f = fixture();
    expect(() => parseOperatingConfig({ ...f.env, CWOS_V2_VIEWER_PRINCIPAL_ID: principalId })).toThrow(/VIEWER_NOT_DISTINCT/);
    expect(() => parseOperatingConfig({ ...f.env, CWOS_V2_VIEWER_AUTH_STATE_PATH: f.ownerPath })).toThrow(/VIEWER_NOT_DISTINCT/);
    const alias = join(f.directory, "owner-hardlink.json");
    linkSync(f.ownerPath, alias);
    expect(() => parseOperatingConfig({ ...f.env, CWOS_V2_VIEWER_AUTH_STATE_PATH: alias })).toThrow(/VIEWER_NOT_DISTINCT/);
  });
  it("requires the viewer record role and keeps owner records role-free", () => {
    const f = fixture();
    expect(() => new FileOperatorAuthStore(f.viewerPath)).toThrow();
    expect(() => new FileOperatorAuthStore(f.ownerPath, "viewer")).toThrow();
    expect(() => parseOperatingConfig({ ...f.env, CWOS_V2_VIEWER_AUTH_STATE_PATH: f.ownerPath })).toThrow();
  });
});

describe("web viewer write boundaries", () => {
  it("hides viewer confirmation, revert, session-file, draft-save and source-link controls", async () => {
    const React = webRequire("react");
    const { renderToStaticMarkup } = webRequire("react-dom/server");
    vi.stubGlobal("React", React);
    const state = vi.fn(React.useState);
    vi.doMock(webRequire.resolve("react"), () => ({ ...React, useState: state }));
    cleanups.push(() => { vi.doUnmock(webRequire.resolve("react")); });
    const { MailCandidateReviewClient } = await import("../../web/app/v2/mail-candidate-review/review-client.js");
    const { DocumentDraftClient } = await import("../../web/app/v2/quote-renewal/draft-client.js");
    const { RenewalEditor } = await import("../../web/app/v2/quote-renewal/renewal-editor.js");
    const candidate = { id: "fixture-candidate", summary: "Fixture mail", senderCompany: null,
      receivedAt: null, createdAt: "2026-10-09T00:00:00Z", evidenceUrl: null, sourceLocator: "gmail://fixture", history: [] };
    const reviewData = { workspaceId, runtimeVersion: 1, accounts: [], candidates: [
      { ...candidate, review: null }, { ...candidate, id: "reviewed", review: { id: "review", outcome: "DISCARDED", reason: "SPAM" } },
    ] };
    const draftData = { runtimeVersion: 1, engagements: [], quoteDrafts: [], contracts: [], renewalDrafts: [] };
    for (const role of ["owner", "viewer"] as const) {
      state.mockImplementationOnce(() => [reviewData, vi.fn()]);
      const mail = renderToStaticMarkup(React.createElement(MailCandidateReviewClient, { role }));
      state.mockImplementationOnce(() => [draftData, vi.fn()]);
      const drafts = renderToStaticMarkup(React.createElement(DocumentDraftClient, { role }));
      const renewal = renderToStaticMarkup(React.createElement(RenewalEditor, { role, contracts: [], drafts: [],
        runtimeVersion: 1, csrf: "fixture-csrf", onSaved: async () => {}, onCompare: () => {}, compareBusy: false }));
      state.mockImplementationOnce(React.useState).mockImplementationOnce(() => [{
        kind: "OWNER_INPUT", id: "fixture-source", version: null, reference: "Fixture document",
        terms: { startDate: null, endDate: null, valueKrw: null, items: null, conditions: null },
      }, vi.fn()]);
      const renewalDraft = renderToStaticMarkup(React.createElement(RenewalEditor, { role, contracts: [], drafts: [],
        runtimeVersion: 1, csrf: "fixture-csrf", onSaved: async () => {}, onCompare: () => {}, compareBusy: false }));
      for (const label of [">확정</button>", ">되돌리기</button>", "type=\"file\""]) {
        expect(mail.includes(label), `${role} mail control ${label}`).toBe(role === "owner");
      }
      expect(drafts.includes(">견적·발주 초안 만들기</button>")).toBe(role === "owner");
      expect(renewal.includes(">계약 자료 연결</button>")).toBe(role === "owner");
      expect(renewalDraft.includes(">재계약 초안 만들기</button>")).toBe(role === "owner");
    }
  });

  it.each(["review", "drafts", "import", "command", "cancel"])("denies %s before any upstream fetch", async route => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const request = new NextRequest("https://fixture.test/api/test", { method: "POST",
      headers: { cookie: signed(), host: "fixture.test", origin: "https://fixture.test", "content-type": "application/json" }, body: "{}" });
    const result = route === "review" ? await reviewPost(request) : route === "drafts" ? await draftsPost(request)
      : route === "import" ? await importPost(request) : route === "command" ? await commandPost(request)
        : await cancelPost(request, { params: Promise.resolve({ id: "job-1" }) });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "VIEWER_WRITE_FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("denies imported viewer proof even without a current cookie", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await importPost(new NextRequest("https://fixture.test/api/cwos/v2/review-session", { method: "POST",
      headers: { host: "fixture.test", origin: "https://fixture.test", "content-type": "application/json" },
      body: JSON.stringify({ cookie: signed(), csrf: "fixture-csrf-at-least-24-chars" }) }));
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "VIEWER_WRITE_FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each(["POST", "PATCH", "PUT", "DELETE"])("denies viewer %s on the jobs route in middleware without upstream", async method => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await middleware(new NextRequest("https://fixture.test/api/agent/jobs/job-1", {
      method, headers: { cookie: signed() },
    }));
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "VIEWER_WRITE_FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("continues to permit viewer job reads after authenticated session verification", async () => {
    for (const [name, value] of Object.entries({ API_BASE_URL: "http://127.0.0.1:4312", CRM_WEB_ORIGIN: "https://fixture.test",
      WORKSPACE_ID: workspaceId, OPERATOR_PRINCIPAL_ID: principalId, AUTH_API_KEY: key, NODE_ENV: "test" })) vi.stubEnv(name, value);
    const fetchSpy = vi.fn().mockResolvedValueOnce(Response.json({ authenticated: true, role: "viewer" }))
      .mockResolvedValueOnce(Response.json({ job: { id: "job-1" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await jobGet(new Request("https://fixture.test/api/agent/jobs/job-1", { headers: { cookie: signed() } }),
      { params: Promise.resolve({ id: "job-1" }) });
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });
  it.each([
    { authenticated: true }, { authenticated: true, role: "admin" }, { authenticated: true, role: "viewer", extra: true },
  ])("rejects malformed upstream session shape %j", async body => {
    const config = selfEntryConfiguration({ API_BASE_URL: "http://127.0.0.1:4312", CRM_WEB_ORIGIN: "https://fixture.test",
      WORKSPACE_ID: workspaceId, OPERATOR_PRINCIPAL_ID: principalId, AUTH_API_KEY: key, NODE_ENV: "test" });
    const result = await verifySelfEntry(signed(), config, vi.fn().mockResolvedValue(Response.json(body)));
    expect(result.status).toBe(502);
  });
});
