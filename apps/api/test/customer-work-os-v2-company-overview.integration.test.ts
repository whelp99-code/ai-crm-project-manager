import { describe, expect, it } from "vitest";
import {
  createStandaloneCustomerWorkOsV2App,
  type CustomerWorkOsV2ActorBinding,
} from "../src/customer-work-os-v2-routes.js";
import { InMemoryCwosV2StateStore } from "../src/customer-work-os-v2-runtime.js";

const workspaceId = "e1111111-1111-4111-8111-111111111111";
const binding: CustomerWorkOsV2ActorBinding = {
  workspaceId,
  principalId: "w04-local-owner",
  kind: "human",
  stepUpVerified: true,
};
const headers = {
  "x-workspace-id": workspaceId,
  "x-principal-id": binding.principalId,
  "x-principal-kind": "human",
};

describe("GET /api/cwos/v2/company-overview", () => {
  it("uses the authenticated read boundary without step-up and keeps financial values unknown", async () => {
    const app = createStandaloneCustomerWorkOsV2App({
      store: new InMemoryCwosV2StateStore(),
      profile: "test",
      actorBinding: binding,
      now: () => "2026-10-06T00:00:00.000Z",
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/cwos/v2/company-overview",
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        workspaceId,
        asOf: "2026-10-06T00:00:00.000Z",
        authority: "LOCAL_CANDIDATE_ONLY",
        revenue: { status: "UNKNOWN", candidateCount: null, quantityTotals: null },
        purchases: { status: "UNKNOWN", candidateCount: null, quantityTotals: null },
        receivables: { status: "UNKNOWN", candidateCount: null, quantityTotals: null },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a foreign workspace claim and untrusted step-up header", async () => {
    const app = createStandaloneCustomerWorkOsV2App({
      store: new InMemoryCwosV2StateStore(),
      profile: "test",
      actorBinding: binding,
    });
    await app.ready();
    try {
      const foreign = await app.inject({
        method: "GET",
        url: "/api/cwos/v2/company-overview",
        headers: { ...headers, "x-workspace-id": "foreign-workspace" },
      });
      expect(foreign.statusCode).toBe(403);
      expect(foreign.json()).toMatchObject({ error: "ACTOR_BINDING_MISMATCH" });

      const stepUp = await app.inject({
        method: "GET",
        url: "/api/cwos/v2/company-overview",
        headers: { ...headers, "x-step-up": "true" },
      });
      expect(stepUp.statusCode).toBe(403);
      expect(stepUp.json()).toMatchObject({ error: "UNTRUSTED_STEP_UP" });
    } finally {
      await app.close();
    }
  });
});
