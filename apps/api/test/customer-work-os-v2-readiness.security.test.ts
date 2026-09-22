import { afterEach, describe, expect, it } from "vitest";
import { createStandaloneCustomerWorkOsV2App } from "../src/customer-work-os-v2-routes.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("CWOS v2 operating readiness", () => {
  it("refuses production memory fallback", () => {
    process.env.NODE_ENV = "production";
    expect(() => createStandaloneCustomerWorkOsV2App()).toThrowError(/CWOS_STORAGE_REQUIRED_IN_PROD/);
  });

  it("reports safe storage and probe metadata without secrets in test memory mode", async () => {
    process.env.NODE_ENV = "test";
    const app = createStandaloneCustomerWorkOsV2App();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/cwos/v2/readiness",
        headers: {
          "x-workspace-id": "workspace-readiness",
          "x-principal-id": "owner",
          "x-principal-kind": "human",
          "x-step-up": "true",
        },
      });
      expect(response.statusCode).toBe(200);
      const payload = response.json() as Record<string, unknown>;
      expect(payload.storageMode).toBe("memory");
      expect(payload.dbProbe).toBe("not_configured");
      expect(payload.schemaVersion).toBeNull();
      expect(payload.recentProcessingState).toBe("idle");
      expect(JSON.stringify(payload)).not.toContain("DATABASE_URL");
    } finally {
      await app.close();
    }
  });
});
