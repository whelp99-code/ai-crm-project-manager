import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActionType } from "@ai-crm/contracts";
import {
  CONNECTOR_CAPABILITY,
  ConnectorDispatcher,
  ConnectorDomainError,
  assertNoConnectorCapability,
  type RemoteRegistryEntry,
} from "../src/index.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, "../../..");

function walk(dir: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * These tests never contact a real provider or network. They assert the MVP
 * connector boundary is a runtime dead end, and that no package in the monorepo
 * has smuggled in an outbound HTTP/provider-SDK dependency or a ModelClient
 * reference outside the two places allowed to hold one.
 */

describe("ConnectorDispatcher: remote dispatch is always rejected", () => {
  const dispatcher = new ConnectorDispatcher();

  const representativeActionTypes: ActionType[] = [
    "CUSTOMER_SEND",
    "PAYMENT_EXECUTE",
    "INVOICE_ISSUE",
    "DELETE_RECORD",
    "MODEL_INVOKE",
  ];

  it.each(representativeActionTypes)("rejects a remote entry for %s", (actionType) => {
    const entry: RemoteRegistryEntry = {
      operationId: `op-${actionType}`,
      actionType,
      effect: "remote",
    };
    expect(() => dispatcher.dispatch(entry)).toThrow(ConnectorDomainError);
    try {
      dispatcher.dispatch(entry);
      expect.unreachable("dispatch must always throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorDomainError);
      expect((error as ConnectorDomainError).code).toBe("CONNECTOR_DISABLED");
    }
  });
});

describe("CONNECTOR_CAPABILITY: frozen and fully disabled", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(CONNECTOR_CAPABILITY)).toBe(true);
  });

  it("declares no remote write capability", () => {
    expect(CONNECTOR_CAPABILITY.remoteWrite).toBe(false);
  });

  it("declares no provider credential capability", () => {
    expect(CONNECTOR_CAPABILITY.providerCredential).toBe(false);
  });

  it("declares no egress", () => {
    expect(CONNECTOR_CAPABILITY.egress).toBe("none");
  });

  it("assertNoConnectorCapability does not throw while capabilities remain disabled", () => {
    expect(() => assertNoConnectorCapability()).not.toThrow();
  });

  it("cannot be mutated at runtime (strict-mode assignment throws)", () => {
    "use strict";
    expect(() => {
      // @ts-expect-error intentional runtime mutation attempt against a frozen object
      CONNECTOR_CAPABILITY.remoteWrite = true;
    }).toThrow(TypeError);
  });
});

describe("dependency confinement: no outbound HTTP/provider-SDK dependency anywhere in the workspace", () => {
  const FORBIDDEN_DEPS = [
    "openai",
    "@anthropic-ai/sdk",
    "@google/generative-ai",
    "axios",
    "node-fetch",
    "got",
    "undici",
    "request",
    "superagent",
  ];

  const packageJsonPaths = [
    ...walk(join(repoRoot, "packages"), (p) => p.endsWith("package.json")),
    ...walk(join(repoRoot, "apps"), (p) => p.endsWith("package.json")),
  ].filter((p) => !p.includes(`${join("node_modules")}`));

  it("finds at least one package.json to check (sanity guard against a vacuous test)", () => {
    expect(packageJsonPaths.length).toBeGreaterThan(0);
  });

  it.each(packageJsonPaths.map((p) => [relative(repoRoot, p), p] as const))(
    "%s declares no forbidden outbound dependency",
    (_label, fullPath) => {
      const pkg = JSON.parse(readFileSync(fullPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const declared = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ];
      const offenders = declared.filter((dep) => FORBIDDEN_DEPS.includes(dep));
      expect(offenders).toEqual([]);
    },
  );
});

describe("model-client confinement: ModelClient stays inside model-gateway and its API-side injection point", () => {
  const ALLOWED_MODEL_CLIENT_DIRS = [
    join("packages", "model-gateway", "src"),
    join("apps", "api", "src"),
  ];

  const srcFiles = [
    ...walk(join(repoRoot, "packages"), (p) => p.endsWith(".ts") && p.includes("/src/")),
    ...walk(join(repoRoot, "apps"), (p) => p.endsWith(".ts") && p.includes("/src/")),
  ];

  it("finds at least one src file to check (sanity guard against a vacuous test)", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("only files under packages/model-gateway/src or apps/api/src reference ModelClient", () => {
    const offenders = srcFiles
      .filter((full) => /ModelClient/.test(readFileSync(full, "utf8")))
      .map((full) => relative(repoRoot, full))
      .filter((rel) => !ALLOWED_MODEL_CLIENT_DIRS.some((allowed) => rel.startsWith(`${allowed}${"/"}`)));
    expect(offenders).toEqual([]);
  });

  it("the allowed locations really do reference ModelClient (guards against the allowlist going stale)", () => {
    const referencing = srcFiles
      .filter((full) => /ModelClient/.test(readFileSync(full, "utf8")))
      .map((full) => relative(repoRoot, full));
    expect(referencing.length).toBeGreaterThan(0);
    for (const rel of referencing) {
      expect(ALLOWED_MODEL_CLIENT_DIRS.some((allowed) => rel.startsWith(`${allowed}${"/"}`))).toBe(true);
    }
  });
});

describe("SEC-02: no model provider SDK imports outside packages/model-gateway", () => {
  /**
   * package.json confinement is covered above ("dependency confinement").
   * This block adds source-level import/require checks so a bare import of a
   * provider SDK cannot land outside the gateway. packages/model-gateway/src is
   * the only allowlisted home for such imports; today the gateway only defines
   * the ModelClient interface and holds no SDK.
   */
  const PROVIDER_SDK_IMPORT_RE =
    /\b(?:from|import)\s+["'](?:openai|@anthropic-ai(?:\/[^"']*)?|anthropic|@google\/generative-ai|@google-cloud\/aiplatform|@azure\/openai)(?:\/[^"']*)?["']|\brequire\s*\(\s*["'](?:openai|@anthropic-ai(?:\/[^"']*)?|anthropic|@google\/generative-ai|@google-cloud\/aiplatform|@azure\/openai)(?:\/[^"']*)?["']\s*\)/;

  const ALLOWED_PROVIDER_SDK_PREFIX = join("packages", "model-gateway", "src");

  const srcFiles = [
    ...walk(join(repoRoot, "packages"), (p) => (p.endsWith(".ts") || p.endsWith(".js")) && p.includes("/src/")),
    ...walk(join(repoRoot, "apps"), (p) => (p.endsWith(".ts") || p.endsWith(".js")) && p.includes("/src/")),
  ];

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("finds at least one src file to check (sanity guard against a vacuous test)", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("no source file outside packages/model-gateway/src imports a model provider SDK", () => {
    const offenders: string[] = [];
    for (const full of srcFiles) {
      const rel = relative(repoRoot, full);
      if (rel.startsWith(`${ALLOWED_PROVIDER_SDK_PREFIX}/`) || rel.startsWith(`${ALLOWED_PROVIDER_SDK_PREFIX}\\`)) {
        continue;
      }
      const codeOnly = stripComments(readFileSync(full, "utf8"));
      if (PROVIDER_SDK_IMPORT_RE.test(codeOnly)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("SEC-03: model-gateway must not import @ai-crm/connectors or connectors paths", () => {
  const modelGatewayRoot = join(repoRoot, "packages", "model-gateway");
  const gatewaySrcFiles = walk(
    join(modelGatewayRoot, "src"),
    (p) => p.endsWith(".ts") || p.endsWith(".js"),
  );

  const CONNECTOR_IMPORT_RE =
    /\b(?:from|import)\s+["'](?:@ai-crm\/connectors(?:\/[^"']*)?|[^"']*packages\/connectors[^"']*)["']|\brequire\s*\(\s*["'](?:@ai-crm\/connectors(?:\/[^"']*)?|[^"']*packages\/connectors[^"']*)["']\s*\)/;

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("finds model-gateway source files (sanity guard)", () => {
    expect(gatewaySrcFiles.length).toBeGreaterThan(0);
  });

  it("packages/model-gateway/src has no import of @ai-crm/connectors or connectors paths", () => {
    const offenders: string[] = [];
    for (const full of gatewaySrcFiles) {
      const codeOnly = stripComments(readFileSync(full, "utf8"));
      if (CONNECTOR_IMPORT_RE.test(codeOnly)) {
        offenders.push(relative(repoRoot, full));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("packages/model-gateway/package.json does not depend on @ai-crm/connectors", () => {
    const manifest = JSON.parse(readFileSync(join(modelGatewayRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(declared).not.toContain("@ai-crm/connectors");
  });
});

describe("SEC-04: CONNECTOR_CAPABILITY remains fully disabled (cross-ref)", () => {
  /**
   * Canonical assertions live in "CONNECTOR_CAPABILITY: frozen and fully disabled"
   * above. This thin cross-ref keeps the SEC-04 test id discoverable without
   * duplicating the full matrix.
   */
  it("remoteWrite=false, providerCredential=false, egress=none", () => {
    expect(CONNECTOR_CAPABILITY.remoteWrite).toBe(false);
    expect(CONNECTOR_CAPABILITY.providerCredential).toBe(false);
    expect(CONNECTOR_CAPABILITY.egress).toBe("none");
    expect(() => assertNoConnectorCapability()).not.toThrow();
  });
});
