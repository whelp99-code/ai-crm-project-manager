import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { FinancePackConfig } from "@ai-crm/finance";

const pack: FinancePackConfig = {
  packVersion: 1, chartOfAccounts: [{ code: "1000", name: "Cash", type: "asset" }],
  decimalScale: 0, dayCloseCutoff: "18:00", cutoffBoundary: "inclusive", reconciliationToleranceKrw: "0", requiredConsecutiveDays: 90,
};
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("daily gate server control plane", () => {
  const authorizeFinance = (instance: FastifyInstance, workspaceId = "ws-1", extras: Record<string, unknown> = {}) =>
    instance.inject({
      method: "POST",
      url: "/api/governance/authorize",
      headers: { "x-workspace-id": workspaceId },
      payload: {
        command: "finance.verify",
        resourceId: `finance-${Math.random()}`,
        resourceVersion: 1,
        payload: { amount: "10" },
        requesterPrincipalId: "finance-operator",
        ...extras,
      },
    });

  it("keeps basic work available and applies conservative policy when DailyGate context is absent or caller-forged", async () => {
    app = createApp({ financePack: pack });
    await app.ready();
    const basic = await app.inject({
      method: "POST", url: "/api/governance/authorize", headers: { "x-workspace-id": "ws-1" },
      payload: { command: "internal.update", resourceId: "r-basic", resourceVersion: 1, payload: {}, requesterPrincipalId: "operator" },
    });
    expect(basic.json()).toMatchObject({ requiredControl: "ALLOW" });
    const finance = await authorizeFinance(app, "ws-1", {
      policyTier: "risk_tiered", matrixVersion: 1, evidenceHash: "a".repeat(64), effectiveDate: "2026-01-01",
    });
    expect(finance.statusCode).toBe(201);
    expect(finance.json()).toMatchObject({ requiredControl: "REQUIRE_APPROVAL", control: { kind: "APPROVAL" } });
    const audits = (await app.inject({ method: "GET", url: "/api/governance/audit", headers: { "x-workspace-id": "ws-1" } })).json() as Array<{ kind: string; data: unknown }>;
    expect(audits.findLast((event) => event.kind === "POLICY_DECIDED")?.data).toMatchObject({
      policyTier: "conservative",
      trustedFinanceContext: { machineReason: "FINANCE_CONTEXT_ABSENT", source: "fallback" },
    });
  });

  it("selects eligible then risk-tiered policy only from current server DailyGate evidence", async () => {
    const controlledPack = { ...pack, requiredConsecutiveDays: 1 };
    app = createApp({ financePack: controlledPack, dailyGateControlPlane: {
      async dayFacts({ workspaceId, date }) { return { actor: { id: "controller-1", workspaceId, role: "CONTROLLER", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: `${date}T09:00:00+09:00`, provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: `${date}T09:00:00+09:00`, expiresAt: "2026-01-02T00:00:00.000Z" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: `e-${date}`, evidenceSecret: "test-secret" }; },
      async activationFacts({ workspaceId }) { return { actor: { id: "cfo-1", workspaceId, role: "CFO", kind: "HUMAN", active: true }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, approvalId: "approval-1", approvedAt: "2026-01-01T10:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z", evidenceSecret: "test-secret" }; },
      now: () => new Date("2026-01-01T12:00:00.000Z"),
    } });
    await app.ready();
    const headers = { "x-workspace-id": "ws-1" };
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(201);
    expect((await authorizeFinance(app)).json()).toMatchObject({ requiredControl: "CHECKPOINT", control: { kind: "CHECKPOINT" } });
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(200);
    expect((await authorizeFinance(app)).json()).toMatchObject({ requiredControl: "ALLOW", intent: { trustedContextHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });

  it("falls back with auditable stale and mismatched-date reasons", async () => {
    let now = new Date("2026-01-01T12:00:00.000Z");
    const controlledPack = { ...pack, requiredConsecutiveDays: 1 };
    const boot = async (date: string, expiresAt: string) => {
      const instance = createApp({ financePack: controlledPack, dailyGateControlPlane: {
        async dayFacts({ workspaceId }) { return { actor: { id: "controller-1", workspaceId, role: "CONTROLLER", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: `${date}T09:00:00+09:00`, provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: `${date}T09:00:00+09:00`, expiresAt }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: `e-${date}`, evidenceSecret: "test-secret" }; },
        async activationFacts() { throw new Error("unused"); }, now: () => now,
      } });
      await instance.ready();
      expect((await instance.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers: { "x-workspace-id": "ws-1" }, payload: { date } })).statusCode).toBe(201);
      return instance;
    };
    app = await boot("2025-12-31", "2026-01-02T00:00:00.000Z");
    expect((await authorizeFinance(app)).json()).toMatchObject({ requiredControl: "REQUIRE_APPROVAL" });
    let audits = (await app.inject({ method: "GET", url: "/api/governance/audit", headers: { "x-workspace-id": "ws-1" } })).json() as Array<{ kind: string; data: any }>;
    expect(audits.findLast((event) => event.kind === "POLICY_DECIDED")?.data.trustedFinanceContext.machineReason).toBe("FINANCE_CONTEXT_DATE_MISMATCH");
    await app.close();
    app = await boot("2026-01-01", "2026-01-01T13:00:00.000Z");
    now = new Date("2026-01-01T13:00:01.000Z");
    expect((await authorizeFinance(app)).json()).toMatchObject({ requiredControl: "REQUIRE_APPROVAL" });
    audits = (await app.inject({ method: "GET", url: "/api/governance/audit", headers: { "x-workspace-id": "ws-1" } })).json() as Array<{ kind: string; data: any }>;
    expect(audits.findLast((event) => event.kind === "POLICY_DECIDED")?.data.trustedFinanceContext.machineReason).toBe("FINANCE_CONTEXT_STALE");
  });
  it("derives finance authorization tier only from server daily-gate state and ignores forged request tier fields", async () => {
    const controlledPack = { ...pack, requiredConsecutiveDays: 1 };
    app = createApp({ financePack: controlledPack, dailyGateControlPlane: {
      async dayFacts({ workspaceId, date }) { return { actor: { id: "controller", workspaceId, role: "CONTROLLER", kind: "HUMAN" as const, active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: `${date}T09:00:00+09:00`, provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: `${date}T09:00:00+09:00`, expiresAt: "2027-01-01T00:00:00+09:00" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: "e-1", evidenceSecret: "secret" }; },
      async activationFacts({ workspaceId }) { return { actor: { id: "cfo", workspaceId, role: "CFO", kind: "HUMAN" as const, active: true }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, approvalId: "a-1", approvedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2027-01-01T00:00:00+09:00", evidenceSecret: "secret" }; },
      now: () => new Date("2026-01-01T10:00:00+09:00"),
    } });
    await app.ready();
    const headers = { "x-workspace-id": "ws-1" };
    const authorize = async (payload: Record<string, unknown>) => app!.inject({ method: "POST", url: "/api/governance/authorize", headers, payload: { command: "finance.verify", resourceId: "finance-1", resourceVersion: 1, requesterPrincipalId: "operator", payload: {}, ...payload } });
    expect((await authorize({ tier: "risk_tiered", evidenceHash: "forged" })).json()).toMatchObject({ requiredControl: "REQUIRE_APPROVAL" });
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(200);
    const trusted = await authorize({ tier: "conservative", matrixVersion: 999, evidenceHash: "forged" });
    expect(trusted.statusCode).toBe(201);
    expect(trusted.json()).toMatchObject({ requiredControl: "ALLOW", intent: { trustedContextHash: expect.any(String) } });
  });
  it("fails closed without server-side daily-gate facts and does not accept caller metrics", async () => {
    app = createApp({ financePack: pack });
    await app.ready();
    const response = await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers: { "x-workspace-id": "ws-1" }, payload: { date: "2026-01-01" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "DAILY_GATE_CONTROL_PLANE_UNAVAILABLE" });
  });

  it("uses injected server facts and rejects asserted controller fields", async () => {
    app = createApp({ financePack: pack, dailyGateControlPlane: {
      async dayFacts() { return { actor: { id: "controller-1", workspaceId: "ws-1", role: "CONTROLLER", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: "2026-01-01T09:00:00+09:00", provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2026-01-02T09:00:00+09:00" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: "e-1", evidenceSecret: "test-secret" }; },
      async activationFacts() { throw new Error("unused"); }, now: () => new Date("2026-01-01T10:00:00+09:00"),
    } });
    await app.ready();
    const response = await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers: { "x-workspace-id": "ws-1" }, payload: { date: "2026-01-01", importsCompleted: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_INPUT" });
  });

  it("records server-derived controller evidence, rejects replay, and permits an independent CFO activation", async () => {
    const controlledPack = { ...pack, requiredConsecutiveDays: 1 };
    app = createApp({ financePack: controlledPack, dailyGateControlPlane: {
      async dayFacts({ date }) { return { actor: { id: "controller-1", workspaceId: "ws-1", role: "CONTROLLER", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: `${date}T09:00:00+09:00`, provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2027-01-01T09:00:00+09:00" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: `e-${date}`, evidenceSecret: "test-secret" }; },
      async activationFacts() { return { actor: { id: "cfo-1", workspaceId: "ws-1", role: "CFO", kind: "HUMAN", active: true }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, approvalId: "approval-1", approvedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2027-01-01T09:00:00+09:00", evidenceSecret: "test-secret" }; },
      now: () => new Date("2026-01-01T10:00:00+09:00"),
    } });
    await app.ready();
    const headers = { "x-workspace-id": "ws-1" };
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_REPLAY" });
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01", approverPrincipalId: "forged" } })).json()).toMatchObject({ error: "INVALID_INPUT" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ tier: "eligible" });
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_REPLAY" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ tier: "risk_tiered" });
  });

  it("rejects wrong-role, cross-workspace, and stale controller facts without changing gate state", async () => {
    app = createApp({ financePack: pack, dailyGateControlPlane: {
      async dayFacts() { return { actor: { id: "cfo", workspaceId: "other", role: "CFO", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: "2026-01-01T09:00:00+09:00", provenance: { refs: ["r"], digests: ["a".repeat(64)], observedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2026-01-01T09:01:00+09:00" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: "e", evidenceSecret: "s" }; },
      async activationFacts() { throw new Error("unused"); }, now: () => new Date("2026-01-01T10:00:00+09:00"),
    } });
    await app.ready();
    const headers = { "x-workspace-id": "ws-1" };
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_UNAUTHORIZED_ACTOR" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ streak: 0, tier: "conservative" });
  });

  it("rejects stale controller evidence and self-approval without mutating the eligible state", async () => {
    const controlledPack = { ...pack, requiredConsecutiveDays: 1 };
    let stale = true;
    app = createApp({ financePack: controlledPack, dailyGateControlPlane: {
      async dayFacts({ workspaceId, date }) { return { actor: { id: "principal-1", workspaceId, role: "CONTROLLER", kind: "HUMAN", active: true }, metrics: { importsCompleted: true, entriesBalanced: true, openFinanceExceptions: 0 }, receivedAt: `${date}T09:00:00+09:00`, provenance: { refs: ["import:1"], digests: ["a".repeat(64)], observedAt: `${date}T09:00:00+09:00`, expiresAt: stale ? `${date}T09:01:00+09:00` : "2027-01-01T09:00:00+09:00" }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, evidenceId: `e-${date}`, evidenceSecret: "test-secret" }; },
      async activationFacts({ workspaceId }) { return { actor: { id: "principal-1", workspaceId, role: "CFO", kind: "HUMAN", active: true }, matrixVersion: 1, matrixActive: true, policyVersion: 1, packVersion: 1, approvalId: "self-approval", approvedAt: "2026-01-01T09:00:00+09:00", expiresAt: "2027-01-01T09:00:00+09:00", evidenceSecret: "test-secret" }; },
      now: () => new Date("2026-01-01T10:00:00+09:00"),
    } });
    await app.ready();
    const headers = { "x-workspace-id": "ws-1" };
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_INVALID_PROVENANCE" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ streak: 0, tier: "conservative" });
    stale = false;
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/days", headers, payload: { date: "2026-01-01" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/finance/daily-gate/activate-risk-tier", headers, payload: { date: "2026-01-01" } })).json()).toMatchObject({ error: "DAILY_GATE_INVALID_APPROVAL" });
    expect((await app.inject({ method: "GET", url: "/api/finance/daily-gate", headers })).json()).toMatchObject({ streak: 1, tier: "eligible" });
  });
});
