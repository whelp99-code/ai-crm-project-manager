import { afterAll, describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";
import { createApp } from "../src/app.js";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";

const workspaceId = "workspace-v2-auth";
const owner: V2Actor = {
  principalId: "owner-1",
  workspaceId,
  kind: "human",
  stepUpVerified: true,
};

describe("CWOS v2 auth principal binding", () => {
  const app = createStandaloneCustomerWorkOsV2App();

  afterAll(async () => {
    await app.close();
  });

  it("rejects omitted x-principal-kind instead of defaulting to human", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/cwos/v2/state",
      headers: {
        "x-workspace-id": workspaceId,
        "x-principal-id": owner.principalId,
        "x-step-up": "true",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_HEADER" });
  });

  it("rejects bot human-spoof (x-bot-id + kind=human)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/cwos/v2/state",
      headers: {
        "x-workspace-id": workspaceId,
        "x-principal-id": owner.principalId,
        "x-principal-kind": "human",
        "x-bot-id": "slack-bot",
        "x-step-up": "true",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "HUMAN_SPOOF" });
  });

  it("binds registered principal kind and rejects ai claiming human", async () => {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-08-15T00:00:00.000Z");
    await runtime.command({
      workspaceId,
      actor: owner,
      expectedVersion: 0,
      idempotencyKey: "register-owner",
      command: "identity.registerPrincipal",
      payload: {
        id: owner.principalId,
        kind: "human",
        displayName: "Owner",
        active: true,
      },
    });
    await expect(
      runtime.readAuthorized({
        principalId: owner.principalId,
        workspaceId,
        kind: "ai",
        stepUpVerified: false,
      }),
    ).rejects.toMatchObject({ code: "PRINCIPAL_KIND_MISMATCH" });
  });
});

describe("CWOS v2 API-key operator binding", () => {
  const key = "pilot-operator-key";
  const binding = {
    workspaceId: "workspace-pilot-bound",
    principalId: "operator-pilot-bound",
    kind: "human" as const,
    stepUpVerified: true,
  };

  function bootstrapHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      "x-api-key": key,
      "x-workspace-id": binding.workspaceId,
      "x-principal-id": binding.principalId,
      "x-principal-kind": binding.kind,
      "idempotency-key": "pilot-operator-bootstrap",
      "content-type": "application/json",
      ...overrides,
    };
  }

  function bootstrapPayload(principalId = binding.principalId) {
    return {
      command: "identity.registerPrincipal",
      expectedVersion: 0,
      payload: { id: principalId, kind: "human", displayName: "Pilot Operator", active: true },
    };
  }

  async function boundApp() {
    const instance = createApp({
      authApiKey: key,
      customerWorkOsV2ActorBinding: binding,
    });
    await instance.ready();
    return instance;
  }

  it("refuses production boot with an API key but no trusted actor binding", () => {
    expect(() => createApp({
      authApiKey: key,
      customerWorkOsV2Profile: "production",
      customerWorkOsV2Store: new InMemoryCwosV2StateStore(),
    })).toThrowError(/CWOS_V2_ACTOR_BINDING_REQUIRED_IN_PROD/);
  });

  it("requires the API key on CWOS v2 reads", async () => {
    const instance = await boundApp();
    try {
      const response = await instance.inject({
        method: "GET",
        url: "/api/cwos/v2/state",
        headers: bootstrapHeaders({ "x-api-key": "" }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "UNAUTHENTICATED" });
    } finally { await instance.close(); }
  });

  it("rejects a server actor binding without API-key authentication", () => {
    expect(() => createApp({ customerWorkOsV2ActorBinding: binding })).toThrowError(
      /CWOS_V2_ACTOR_BINDING_REQUIRES_API_KEY/,
    );
  });

  it("rejects a forged principal even with the valid API key", async () => {
    const instance = await boundApp();
    try {
      const response = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders({ "x-principal-id": "forged-operator", "x-step-up": "true" }),
        payload: bootstrapPayload("forged-operator"),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });
    } finally { await instance.close(); }
  });

  it("rejects a forged workspace even with the valid API key", async () => {
    const instance = await boundApp();
    try {
      const response = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders({ "x-workspace-id": "workspace-forged" }),
        payload: bootstrapPayload(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });
    } finally { await instance.close(); }
  });

  it("rejects caller-asserted step-up instead of trusting the header", async () => {
    const instance = await boundApp();
    try {
      const response = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders({ "x-step-up": "true" }),
        payload: bootstrapPayload(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "UNTRUSTED_STEP_UP" });
    } finally { await instance.close(); }
  });

  it("does not grant bootstrap step-up when the server binding says false", async () => {
    const instance = createApp({
      authApiKey: key,
      customerWorkOsV2ActorBinding: { ...binding, stepUpVerified: false },
    });
    await instance.ready();
    try {
      const override = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders({ "x-step-up": "true" }),
        payload: bootstrapPayload(),
      });
      expect(override.statusCode).toBe(403);
      expect(override.json()).toMatchObject({ error: "UNTRUSTED_STEP_UP" });

      const response = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders(),
        payload: bootstrapPayload(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "STEP_UP_REQUIRED" });
    } finally { await instance.close(); }
  });

  it("uses the server-side binding for a header-matched bootstrap without x-step-up", async () => {
    const instance = await boundApp();
    try {
      const response = await instance.inject({
        method: "POST",
        url: "/api/cwos/v2/commands",
        headers: bootstrapHeaders(),
        payload: bootstrapPayload(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ runtimeVersion: 1 });
    } finally { await instance.close(); }
  });
});

describe("CWOS v2 dedicated machine binding", () => {
  const machineBinding = {
    workspaceId,
    principalId: "ai-1",
    kind: "ai" as const,
  };
  const key = "pilot-operator-key";
  const headers = {
    "x-api-key": key,
    "x-workspace-id": workspaceId,
    "x-principal-id": machineBinding.principalId,
    "x-principal-kind": machineBinding.kind,
  };

  async function machineApp(kind: "ai" | "service" = "ai", readOnly = false) {
    const store = new InMemoryCwosV2StateStore();
    const runtime = new CustomerWorkOsV2RuntimeManager(store, () => "2026-08-15T00:00:00.000Z");
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 0, idempotencyKey: "machine-test-bootstrap",
      command: "identity.registerPrincipal",
      payload: { id: owner.principalId, kind: "human", displayName: "Owner", active: true },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 1, idempotencyKey: "machine-test-owner-membership",
      command: "identity.addMembership",
      payload: { id: "membership-owner-1", principalId: owner.principalId },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 2, idempotencyKey: "machine-test-register",
      command: "identity.registerPrincipal",
      payload: { id: machineBinding.principalId, kind, displayName: "Machine", active: true },
    });
    await runtime.command({
      workspaceId, actor: owner, expectedVersion: 3, idempotencyKey: "machine-test-membership",
      command: "identity.addMembership",
      payload: { id: "membership-ai-1", principalId: machineBinding.principalId },
    });
    const app = createApp({
      authApiKey: key,
      customerWorkOsV2Store: store,
      customerWorkOsV2MachineBinding: { ...machineBinding, kind, readOnly },
    });
    await app.ready();
    return app;
  }

  it("rejects simultaneous operator and machine authority", () => {
    expect(() => createApp({
      authApiKey: key, customerWorkOsV2MachineBinding: machineBinding,
      customerWorkOsV2ActorBinding: { ...owner, kind: "human" },
    })).toThrowError(/CWOS_V2_BINDING_CONFLICT/);
  });

  it("requires authenticated configuration for a machine binding", () => {
    expect(() => createApp({ customerWorkOsV2MachineBinding: machineBinding }))
      .toThrowError(/CWOS_V2_ACTOR_BINDING_REQUIRES_API_KEY/);
  });

  it.each(["ai", "service"] as const)("reads as the registered %s without human impersonation", async (kind) => {
    const app = await machineApp(kind);
    try {
      const response = await app.inject({
        method: "GET", url: "/api/cwos/v2/state", headers: { ...headers, "x-principal-kind": kind, "x-bot-id": "slack-bot" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ version: 4 });
    } finally { await app.close(); }
  });

  it.each(["ai", "service"] as const)("limits the read-only %s binding to reads", async (kind) => {
    const app = await machineApp(kind, true);
    const readerHeaders = { ...headers, "x-principal-kind": kind };
    try {
      const before = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers: readerHeaders });
      expect(before.statusCode).toBe(200);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const denied = await app.inject({
          method, url: "/api/cwos/v2/commands",
          headers: { ...readerHeaders, "idempotency-key": "machine-forbidden-register" },
          payload: {
            command: "identity.registerPrincipal", expectedVersion: 4,
            payload: { id: "forged-operator", kind: "human", displayName: "Forged", active: true },
          },
        });
        expect(denied.statusCode).toBe(403);
        expect(denied.json()).toMatchObject({ error: "MACHINE_READ_ONLY" });
      }
      const after = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers: readerHeaders });
      expect(after.json()).toEqual(before.json());
      const head = await app.inject({ method: "HEAD", url: "/api/cwos/v2/state", headers: readerHeaders });
      expect(head.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it.each([
    { "x-principal-id": owner.principalId, "x-principal-kind": "human" },
    { "x-workspace-id": "workspace-forged" },
    { "x-principal-id": "forged-operator" },
  ])("rejects forged claims on a machine-authenticated request: %j", async (claim) => {
    const app = await machineApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers: { ...headers, ...claim } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });
    } finally { await app.close(); }
  });

  it("rejects caller-asserted machine step-up", async () => {
    const app = await machineApp();
    try {
      const response = await app.inject({
        method: "GET", url: "/api/cwos/v2/state", headers: { ...headers, "x-step-up": "true" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "UNTRUSTED_STEP_UP" });
    } finally { await app.close(); }
  });

  it("refuses legacy routes for the machine credential", async () => {
    const app = await machineApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/finance/balances", headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "MACHINE_ROUTE_DENIED" });
    } finally { await app.close(); }
  });

  it("cannot register a principal through a machine command or mutate state", async () => {
    const app = await machineApp();
    try {
      const before = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      const response = await app.inject({
        method: "POST", url: "/api/cwos/v2/commands",
        headers: { ...headers, "idempotency-key": "machine-forbidden-register" },
        payload: {
          command: "identity.registerPrincipal", expectedVersion: 4,
          payload: { id: "forged-operator", kind: "human", displayName: "Forged", active: true },
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "HUMAN_REQUIRED" });
      const after = await app.inject({ method: "GET", url: "/api/cwos/v2/state", headers });
      expect(after.json()).toEqual(before.json());
    } finally { await app.close(); }
  });
});
