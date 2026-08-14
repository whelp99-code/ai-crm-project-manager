import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerDurableCustomerWorkOsRoutes } from "../src/customer-work-os-routes-durable.js";
import { StaticCustomerWorkOsIdentityResolver, type CustomerWorkOsIdentity } from "../src/customer-work-os-identity.js";
import { InMemoryCustomerWorkOsSnapshotStore } from "../src/customer-work-os-runtime.js";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

function resolver() {
  const rows = new Map<string, CustomerWorkOsIdentity>();
  const add = (identity: CustomerWorkOsIdentity) => rows.set(`${identity.workspaceId}\u0000${identity.principalId}`, identity);
  add({ workspaceId: WS_A, principalId: "human-a", kind: "HUMAN", role: "owner", active: true });
  add({ workspaceId: WS_A, principalId: "ai-a", kind: "AI", role: "finance_guardian", active: true });
  add({ workspaceId: WS_A, principalId: "inactive-a", kind: "HUMAN", role: "owner", active: false });
  add({ workspaceId: WS_B, principalId: "human-b", kind: "HUMAN", role: "owner", active: true });
  return new StaticCustomerWorkOsIdentityResolver(rows);
}

async function app() {
  const instance = Fastify();
  await registerDurableCustomerWorkOsRoutes(instance, { store: new InMemoryCustomerWorkOsSnapshotStore(), identityResolver: resolver(), now: () => "2026-08-14T00:00:00Z" });
  await instance.ready();
  return instance;
}

describe("Customer Work OS trusted identity", () => {
  const apps: Awaited<ReturnType<typeof app>>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((item) => item.close())));

  it("rejects missing, inactive and cross-workspace principal bindings", async () => {
    const instance = await app(); apps.push(instance);
    const base = { method: "GET" as const, url: "/api/cwos/cockpit" };
    expect((await instance.inject({ ...base, headers: { "x-workspace-id": WS_A } })).statusCode).toBe(400);
    expect((await instance.inject({ ...base, headers: { "x-workspace-id": WS_A, "x-principal-id": "inactive-a" } })).statusCode).toBe(400);
    expect((await instance.inject({ ...base, headers: { "x-workspace-id": WS_A, "x-principal-id": "human-b" } })).statusCode).toBe(400);
  });

  it("allows an active human in the bound workspace", async () => {
    const instance = await app(); apps.push(instance);
    const response = await instance.inject({ method: "GET", url: "/api/cwos/cockpit", headers: { "x-workspace-id": WS_A, "x-principal-id": "human-a" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().activeEngagementCount).toBe(0);
  });

  it("blocks AI principals from final business mutations", async () => {
    const instance = await app(); apps.push(instance);
    const response = await instance.inject({
      method: "POST",
      url: "/api/cwos/accounts",
      headers: { "x-workspace-id": WS_A, "x-principal-id": "ai-a", "idempotency-key": "ai-write" },
      payload: { id: "customer", name: "위조 고객", kinds: ["customer"], status: "active" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("HUMAN_AUTHORITY_REQUIRED");
  });

  it("does not expose workspace A data through a workspace B principal", async () => {
    const instance = await app(); apps.push(instance);
    const created = await instance.inject({ method: "POST", url: "/api/cwos/accounts", headers: { "x-workspace-id": WS_A, "x-principal-id": "human-a", "idempotency-key": "create-a" }, payload: { id: "a", name: "고객 A", kinds: ["customer"], status: "active" } });
    expect(created.statusCode).toBe(201);
    const report = await instance.inject({ method: "GET", url: "/api/cwos/cockpit", headers: { "x-workspace-id": WS_B, "x-principal-id": "human-b" } });
    expect(report.statusCode).toBe(200);
    expect(report.json().activeEngagementCount).toBe(0);
  });
});
