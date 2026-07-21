import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionType } from "@ai-crm/contracts";
import {
  ModelGateway,
  ModelGatewayError,
  defaultRedactor,
  type ModelClient,
  type ModelClientResponse,
  type ModelInvocationRequest,
  type StructuredOutputSchema,
} from "../src/index.js";

const GATEWAY_PRINCIPAL = "principal-model-gateway";

const outputSchema: StructuredOutputSchema = {
  schemaVersion: "risk.v1",
  root: {
    kind: "object",
    fields: {
      riskLevel: { kind: "enum", values: ["low", "medium", "high"] },
      rationale: { kind: "string", maxLength: 200 },
    },
  },
};

function client(response: Partial<ModelClientResponse> = {}): ModelClient {
  return {
    async invoke() {
      return {
        structuredOutput: { riskLevel: "medium", rationale: "schedule slip observed" },
        modelVersion: "provider-model-9",
        retentionHonored: true,
        ...response,
      };
    },
  };
}

function resolveModelOp(): ActionType {
  return "MODEL_INVOKE";
}

function gateway(c: ModelClient = client(), resolve: (id: string) => ActionType = resolveModelOp): ModelGateway {
  let now = 1_000;
  return new ModelGateway(c, {
    servicePrincipalId: GATEWAY_PRINCIPAL,
    resolveOperation: resolve,
    clock: () => (now += 5),
  });
}

function request(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    workspaceId: "ws-1",
    operationId: "op.model.risk",
    principalId: GATEWAY_PRINCIPAL,
    promptVersion: "p.v1",
    modelVersion: "provider-model-9",
    prompt: "assess risk for customer a@b.com id 12345678",
    outputSchema,
    correlationId: "corr-1",
    requestedRetention: "zero-retention",
    ...overrides,
  };
}

describe("ModelGateway — non-effect inference boundary (ADR-010)", () => {
  it("returns validated structured output and records a redacted invocation", async () => {
    const gw = gateway();
    const result = await gw.invoke(request());
    expect(result.structuredOutput).toEqual({ riskLevel: "medium", rationale: "schedule slip observed" });
    expect(result.invocation).toMatchObject({
      workspaceId: "ws-1",
      actionType: "MODEL_INVOKE",
      outputSchemaVersion: "risk.v1",
      retentionMode: "zero-retention",
      principalId: GATEWAY_PRINCIPAL,
    });
    // No raw prompt/response persisted — digests only.
    expect(result.invocation.redactedPromptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.invocation.responseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.invocation)).not.toContain("a@b.com");
    expect(JSON.stringify(result.invocation)).not.toContain("12345678");
    expect(result.invocation.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("redacts PII (email, RRN, long digit runs) before egress", async () => {
    const seen: string[] = [];
    const gw = gateway({
      async invoke(req) {
        seen.push(req.redactedPrompt);
        return { structuredOutput: { riskLevel: "low", rationale: "ok" }, modelVersion: "m", retentionHonored: true };
      },
    });
    await gw.invoke(request({ prompt: "email a@b.com rrn 900101-1234567 acct 123456789" }));
    expect(seen[0]).toBe("email [REDACTED_EMAIL] rrn [REDACTED_RRN] acct [REDACTED_NUM]");
    expect(defaultRedactor("id 42 short")).toBe("id 42 short");
  });

  it("records the true retention mode when the provider cannot honor zero-retention", async () => {
    const gw = gateway(client({ retentionHonored: false }));
    const result = await gw.invoke(request({ requestedRetention: "zero-retention" }));
    expect(result.invocation.retentionMode).toBe("retain");
  });

  it("rejects schema-violating structured output (free text can never become a command)", async () => {
    const gw = gateway(client({ structuredOutput: { riskLevel: "catastrophic", rationale: "x" } }));
    await expect(gw.invoke(request())).rejects.toMatchObject({ code: "SCHEMA_VIOLATION" });

    const extra = gateway(client({ structuredOutput: { riskLevel: "low", rationale: "x", command: "DELETE" } }));
    await expect(extra.invoke(request())).rejects.toMatchObject({ code: "SCHEMA_VIOLATION" });
  });

  it("refuses any principal other than the dedicated gateway principal", async () => {
    const gw = gateway();
    await expect(gw.invoke(request({ principalId: "principal-api" }))).rejects.toMatchObject({ code: "PRINCIPAL_DENIED" });
  });

  it("refuses an operation that does not resolve to non-effect MODEL_INVOKE", async () => {
    const gw = gateway(client(), () => "LEDGER_POST");
    await expect(gw.invoke(request())).rejects.toMatchObject({ code: "NON_MODEL_OPERATION" });
  });

  it("denies cross-workspace invocation reads", async () => {
    const gw = gateway();
    const { invocation } = await gw.invoke(request());
    expect(() => gw.getInvocation("ws-2", invocation.id)).toThrowError(/another workspace/);
    expect(gw.listInvocations("ws-2")).toEqual([]);
  });

  it("has no effect/connector capability in its source or dependencies", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    // Inspect actual import specifiers, not prose in doc comments.
    const importSpecifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const forbidden of [
      "@ai-crm/connectors",
      "@ai-crm/connector-dispatcher",
      "@ai-crm/governance",
      "node:http",
      "node:https",
      "node:net",
      "undici",
      "axios",
    ]) {
      expect(importSpecifiers).not.toContain(forbidden);
    }
    // No effect-dispatch call is made from this boundary.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["leaseIntent(", "startDispatch(", "finishIntent("]) {
      expect(codeOnly).not.toContain(forbidden);
    }
    const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    // The only dependency is the shared contracts package; no provider SDK, no governance/effect package.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@ai-crm/contracts"]);
    expect(ModelGatewayError).toBeTypeOf("function");
  });
});
