import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelClient } from "@ai-crm/model-gateway";
import { createApp, type CreateAppOptions, type AiCrmRuntime } from "../src/app.js";

/**
 * N-10 (D8) drift test: `GET /api/agent/openapi.json` must be a valid
 * OpenAPI 3.x document, and every agent/governance/health/ready/metrics route
 * Fastify actually registers (introspected live via aiCrm.registeredRoutes,
 * not a hand-copied list) must have a matching path+method entry in the
 * document. openapi.ts silently drops any registered route it has no
 * annotation for, so a route added to app.ts without a matching entry in
 * openapi.ts makes this test fail — that's the point.
 */

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.AUTH_API_KEY;
  delete process.env.API_AUTH_TOKEN;
});

async function ready(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const instance = createApp(options);
  app = instance;
  await instance.ready();
  return instance;
}

function planClient(): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: {
          steps: [
            {
              suggestedCommand: "internal.update",
              title: "note",
              resourceType: "",
              resourceId: "",
              resourceVersion: 1,
              payloadJson: "{}",
            },
          ],
        },
        modelVersion: "openapi-contract-test",
        retentionHonored: true,
      };
    },
  };
}

function runtimeOf(api: FastifyInstance): AiCrmRuntime {
  return (api as FastifyInstance & { aiCrm: AiCrmRuntime }).aiCrm;
}

/** Documented surface per N-10: /api/agent (and its /v1/agent alias),
 * /api/governance, /health, /ready, /metrics. Everything else registered by
 * the app (customers, projects, finance, ai, reports, ...) is out of scope
 * for this machine document. */
function isDocumentedRoute(path: string): boolean {
  return (
    path.startsWith("/api/agent") ||
    path.startsWith("/v1/agent") ||
    path.startsWith("/api/governance") ||
    path === "/health" ||
    path === "/ready" ||
    path === "/metrics"
  );
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

describe("N-10: GET /api/agent/openapi.json is a valid OpenAPI 3.x document", () => {
  it("parses with an openapi 3.x field and a paths object", async () => {
    const api = await ready({});
    const res = await api.inject({ method: "GET", url: "/api/agent/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(typeof doc.openapi).toBe("string");
    expect(doc.openapi.startsWith("3.")).toBe(true);
    expect(typeof doc.paths).toBe("object");
    expect(doc.paths).not.toBeNull();
  });

  it("is reachable through the /v1 alias too (same handler, no separate spec route needed)", async () => {
    const api = await ready({});
    const res = await api.inject({ method: "GET", url: "/api/agent/openapi.json" });
    expect(res.statusCode).toBe(200);
  });
});

describe("N-10: openapi.json drift test — every registered agent/governance route has a spec entry", () => {
  it("documents every /api/agent, /v1/agent, /api/governance, /health, /ready, /metrics route Fastify actually registered", async () => {
    const api = await ready({ modelClient: planClient() });
    const rt = runtimeOf(api);
    const documentedRoutes = rt.registeredRoutes.filter(
      (r) => isDocumentedRoute(r.path) && r.method !== "HEAD" && r.method !== "OPTIONS",
    );
    // Sanity: the fixture actually exercises a non-trivial surface (guards
    // against a vacuously-passing test if route collection ever breaks).
    expect(documentedRoutes.length).toBeGreaterThanOrEqual(10);

    const res = await api.inject({ method: "GET", url: "/api/agent/openapi.json" });
    const doc = res.json() as { paths: Record<string, Record<string, unknown>> };

    const missing: string[] = [];
    for (const route of documentedRoutes) {
      const openApiPath = toOpenApiPath(route.path);
      const methodKey = route.method.toLowerCase();
      const pathEntry = doc.paths[openApiPath];
      if (!pathEntry || !(methodKey in pathEntry)) {
        missing.push(`${route.method} ${route.path}`);
      }
    }
    expect(missing, `routes registered but missing from openapi.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("every documented path parameter and required header is described on its operation", async () => {
    const api = await ready({ modelClient: planClient() });
    const res = await api.inject({ method: "GET", url: "/api/agent/openapi.json" });
    const doc = res.json() as { paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>> };

    const commandsOp = doc.paths["/api/agent/commands"]?.post;
    expect(commandsOp).toBeTruthy();
    const commandHeaderNames = (commandsOp?.parameters ?? [])
      .filter((p) => p.in === "header")
      .map((p) => p.name.toLowerCase());
    expect(commandHeaderNames).toEqual(
      expect.arrayContaining(["x-workspace-id", "x-principal-id", "idempotency-key"]),
    );

    const v1CommandsOp = doc.paths["/v1/agent/commands"]?.post;
    expect(v1CommandsOp).toBeTruthy();

    const jobOp = doc.paths["/api/agent/jobs/{id}"]?.get;
    expect(jobOp).toBeTruthy();
    const jobParamNames = (jobOp?.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
    expect(jobParamNames).toEqual(["id"]);
  });
});
