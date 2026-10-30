import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loginDisabledReadAllowed } from "../app/lib/login-disabled";
import { middleware } from "../middleware";
import { GET, POST } from "../app/api/cwos/v2/mail-candidate-review/route";

const loopback = {
  flag: "1",
  apiOrigin: "http://127.0.0.1:3001",
  webOrigin: "http://127.0.0.1:3000",
  workspaceId: "existing-workspace",
  principalId: "existing-owner",
  apiKey: "existing-api-key",
  requestHost: "127.0.0.1:3000",
  forwardedHost: undefined,
};

describe("CRM login disable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stays closed unless the flag and an existing loopback binding are both present", () => {
    expect(loginDisabledReadAllowed({ ...loopback, flag: undefined })).toBe(false);
    expect(loginDisabledReadAllowed({ ...loopback, principalId: "" })).toBe(false);
    expect(loginDisabledReadAllowed({ ...loopback, workspaceId: undefined })).toBe(false);
    expect(loginDisabledReadAllowed({ ...loopback, webOrigin: "https://crm.example.test" })).toBe(false);
    expect(loginDisabledReadAllowed({ ...loopback, forwardedHost: "crm.example.test" })).toBe(false);
    expect(loginDisabledReadAllowed(loopback)).toBe(true);
  });

  it("admits only loopback reads and still requires a session for mutations", async () => {
    vi.stubEnv("CWOS_LOGIN_DISABLED", "1");
    vi.stubEnv("API_BASE_URL", loopback.apiOrigin);
    vi.stubEnv("CRM_WEB_ORIGIN", loopback.webOrigin);
    vi.stubEnv("WORKSPACE_ID", loopback.workspaceId);
    vi.stubEnv("OPERATOR_PRINCIPAL_ID", loopback.principalId);
    vi.stubEnv("AUTH_API_KEY", loopback.apiKey);
    vi.stubEnv("NODE_ENV", "test");
    const admitted = await middleware(new NextRequest("http://127.0.0.1:3000/work", {
      headers: { host: "127.0.0.1:3000" },
    }));
    expect(admitted.headers.get("x-middleware-next")).toBe("1");
    const forwarded = await middleware(new NextRequest("http://127.0.0.1:3000/work", {
      headers: { host: "127.0.0.1:3000", "x-forwarded-host": "crm.example.test" },
    }));
    expect(forwarded.headers.get("location")).toContain("/login");
    const mutation = await middleware(new NextRequest("http://127.0.0.1:3000/api/cwos/v2/mail-candidate-review", {
      method: "POST", headers: { host: "127.0.0.1:3000" },
    }));
    expect(mutation.status).toBe(401);
    expect(mutation.headers.get("x-middleware-next")).toBeNull();
  });

  it("does not open a public binding or create a missing owner", async () => {
    vi.stubEnv("CWOS_LOGIN_DISABLED", "1");
    vi.stubEnv("API_BASE_URL", "https://api.example.test");
    vi.stubEnv("CRM_WEB_ORIGIN", "https://crm.example.test");
    vi.stubEnv("WORKSPACE_ID", loopback.workspaceId);
    vi.stubEnv("OPERATOR_PRINCIPAL_ID", loopback.principalId);
    vi.stubEnv("AUTH_API_KEY", loopback.apiKey);
    vi.stubEnv("NODE_ENV", "test");
    const publicHost = await middleware(new NextRequest("https://crm.example.test/work", {
      headers: { host: "127.0.0.1:3000" },
    }));
    expect(publicHost.headers.get("location")).toBe("https://crm.example.test/login");
    vi.stubEnv("API_BASE_URL", loopback.apiOrigin);
    vi.stubEnv("CRM_WEB_ORIGIN", loopback.webOrigin);
    vi.stubEnv("OPERATOR_PRINCIPAL_ID", "");
    const missingOwner = await middleware(new NextRequest("http://127.0.0.1:3000/work", {
      headers: { host: "127.0.0.1:3000" },
    }));
    expect(missingOwner.headers.get("x-middleware-next")).toBeNull();
  });

  it("rejects client principal injection and does not forward a forged cookie on a disabled-login read", async () => {
    vi.stubEnv("CWOS_LOGIN_DISABLED", "1");
    vi.stubEnv("API_BASE_URL", loopback.apiOrigin);
    vi.stubEnv("CRM_WEB_ORIGIN", loopback.webOrigin);
    vi.stubEnv("WORKSPACE_ID", loopback.workspaceId);
    vi.stubEnv("OPERATOR_PRINCIPAL_ID", loopback.principalId);
    vi.stubEnv("AUTH_API_KEY", loopback.apiKey);
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ workspaceId: loopback.workspaceId, candidates: [] }), { status: 200 });
    });
    const injected = await GET(new NextRequest("http://127.0.0.1:3000/api/cwos/v2/mail-candidate-review", {
      headers: { host: "127.0.0.1:3000", "x-principal-id": "spoof", cookie: "cwos_operator_stepup=v1.forged.forged" },
    }));
    expect(injected.status).toBe(403);
    expect(await injected.json()).toEqual({ error: "ACTOR_BINDING_MISMATCH" });
    expect(calls).toHaveLength(0);
    const read = await GET(new NextRequest("http://127.0.0.1:3000/api/cwos/v2/mail-candidate-review", {
      headers: { host: "127.0.0.1:3000", cookie: "cwos_operator_stepup=v1.forged.forged" },
    }));
    expect(read.status).toBe(200);
    const headers = calls[0]?.headers;
    expect(headers).toMatchObject({ "x-principal-id": loopback.principalId, "x-workspace-id": loopback.workspaceId });
    expect(headers).not.toHaveProperty("cookie");
    const write = await POST(new NextRequest("http://127.0.0.1:3000/api/cwos/v2/mail-candidate-review", {
      method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
    }));
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: "OWNER_SESSION_REQUIRED" });
  });
});
