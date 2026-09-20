import { afterAll, describe, expect, it } from "vitest";
import type { V2Actor } from "@ai-crm/domain/customer-work-os-v2";
import {
  CustomerWorkOsV2RuntimeManager,
  InMemoryCwosV2StateStore,
} from "../src/customer-work-os-v2-runtime.js";
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
