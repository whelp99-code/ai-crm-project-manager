/**
 * N-10 (D8): machine-readable OpenAPI 3.x document for the agent/governance
 * surface, built from the app's *actually registered* Fastify routes (via the
 * `onRoute` hook in app.ts) rather than a hand-maintained list. This is the
 * single source that both `GET /api/agent/openapi.json` and the
 * openapi-contract drift test read from: a route that exists but has no
 * annotation below is silently dropped from the document (not hand-drifted
 * text), which is exactly what the drift test in
 * apps/api/test/openapi-contract.test.ts asserts against by independently
 * enumerating registered routes and requiring each to appear here.
 */

export interface RouteInfo {
  method: string;
  path: string;
}

interface RouteAnnotation {
  summary: string;
  requiredHeaders?: string[];
  responses: Record<string, string>;
}

const AGENT_HEADERS_FULL = ["x-workspace-id", "x-principal-id", "Idempotency-Key"];
const AGENT_HEADERS_NO_IDEMPOTENCY = ["x-workspace-id", "x-principal-id"];
const WORKSPACE_ONLY = ["x-workspace-id"];

/** Path suffix relative to the `/api/agent` or `/v1/agent` prefix (both alias
 * to the same handlers — see registerAgentRoutes in app.ts), else undefined. */
function agentSuffix(path: string): string | undefined {
  if (path === "/api/agent" || path === "/v1/agent") return "";
  if (path.startsWith("/api/agent/")) return path.slice("/api/agent".length);
  if (path.startsWith("/v1/agent/")) return path.slice("/v1/agent".length);
  return undefined;
}

const AGENT_ANNOTATIONS: Record<string, Record<string, RouteAnnotation>> = {
  "/commands": {
    POST: {
      summary: "Execute a natural-language agent command (idempotent by Idempotency-Key)",
      requiredHeaders: AGENT_HEADERS_FULL,
      responses: {
        "202": "Accepted — job created/resumed",
        "400": "Validation error (WORKSPACE_REQUIRED, PRINCIPAL_REQUIRED, IDEMPOTENCY_REQUIRED, IDEMPOTENCY_MISMATCH, ...)",
        "401": "Missing/invalid x-api-key when AUTH_API_KEY is configured",
      },
    },
  },
  "/jobs/:id": {
    GET: {
      summary: "Get an agent job snapshot (job + work items + events)",
      requiredHeaders: WORKSPACE_ONLY,
      responses: { "200": "OK", "404": "JOB_NOT_FOUND", "401": "Missing/invalid x-api-key when AUTH_API_KEY is configured" },
    },
  },
  "/jobs/:id/events": {
    GET: {
      summary: "Get job events as JSON, or stream them as SSE (Accept: text/event-stream or ?stream=1)",
      requiredHeaders: WORKSPACE_ONLY,
      responses: { "200": "OK (JSON) or text/event-stream", "404": "JOB_NOT_FOUND" },
    },
  },
  "/jobs/:id/cancel": {
    POST: {
      summary: "Cancel an in-flight agent job",
      requiredHeaders: AGENT_HEADERS_NO_IDEMPOTENCY,
      responses: { "200": "OK", "404": "JOB_NOT_FOUND" },
    },
  },
  "/jobs/:id/work-items/:workItemId/complete": {
    POST: {
      summary: "Complete an agent work item using a consumed governance intent",
      requiredHeaders: AGENT_HEADERS_NO_IDEMPOTENCY,
      responses: { "200": "OK", "400": "Governance/validation error", "404": "Not found" },
    },
  },
};

const GOVERNANCE_ANNOTATIONS: Record<string, Record<string, RouteAnnotation>> = {
  "/api/governance/authorize": {
    POST: {
      summary: "Authorize a governed command, opening a control (and, for auto-approved paths, an intent)",
      requiredHeaders: WORKSPACE_ONLY,
      responses: { "201": "Created", "400": "Validation error" },
    },
  },
  "/api/governance/controls": {
    GET: { summary: "List governance controls", requiredHeaders: WORKSPACE_ONLY, responses: { "200": "OK" } },
  },
  "/api/governance/controls/:controlId": {
    GET: { summary: "Get a governance control", requiredHeaders: WORKSPACE_ONLY, responses: { "200": "OK", "404": "Not found" } },
  },
  "/api/governance/controls/:controlId/decide": {
    POST: {
      summary: "Approve or reject a pending governance control",
      requiredHeaders: WORKSPACE_ONLY,
      responses: { "200": "OK", "400": "INVALID_DECISION" },
    },
  },
  "/api/governance/controls/:controlId/consume": {
    POST: {
      summary: "Consume an approved control into a single-use governance intent",
      requiredHeaders: WORKSPACE_ONLY,
      responses: { "201": "Created" },
    },
  },
  "/api/governance/audit": {
    GET: { summary: "List governance audit events", requiredHeaders: WORKSPACE_ONLY, responses: { "200": "OK" } },
  },
  "/api/governance/audit/verify": {
    GET: { summary: "Verify the governance audit hash chain", requiredHeaders: WORKSPACE_ONLY, responses: { "200": "OK" } },
  },
};

const TOP_LEVEL_ANNOTATIONS: Record<string, Record<string, RouteAnnotation>> = {
  "/health": { GET: { summary: "Liveness probe", responses: { "200": "OK" } } },
  "/ready": { GET: { summary: "Readiness probe", responses: { "200": "Ready", "503": "Not ready" } } },
  "/metrics": { GET: { summary: "Operational counters", responses: { "200": "OK" } } },
  "/api/agent/openapi.json": {
    GET: { summary: "This machine-readable OpenAPI 3.x document", responses: { "200": "OK" } },
  },
};

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function pathParamNames(path: string): string[] {
  const out: string[] = [];
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path))) out.push(match[1] ?? "");
  return out;
}

function findAnnotation(path: string, method: string): RouteAnnotation | undefined {
  const suffix = agentSuffix(path);
  if (suffix !== undefined && AGENT_ANNOTATIONS[suffix]?.[method]) return AGENT_ANNOTATIONS[suffix][method];
  if (GOVERNANCE_ANNOTATIONS[path]?.[method]) return GOVERNANCE_ANNOTATIONS[path][method];
  if (TOP_LEVEL_ANNOTATIONS[path]?.[method]) return TOP_LEVEL_ANNOTATIONS[path][method];
  return undefined;
}

/**
 * Builds the OpenAPI 3.x document strictly from `routes` (the live Fastify
 * route table, see the `onRoute` hook in app.ts). A registered route with no
 * annotation above is intentionally omitted rather than hand-described —
 * that's what makes the drift test meaningful: forgetting to annotate a new
 * agent/governance route makes it vanish from the document, not silently
 * pass.
 */
export function buildOpenApiDocument(routes: RouteInfo[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    if (method === "HEAD" || method === "OPTIONS") continue;
    const annotation = findAnnotation(route.path, method);
    if (!annotation) continue;
    const openApiPath = toOpenApiPath(route.path);
    const dedupeKey = `${method} ${openApiPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const params = pathParamNames(route.path);
    const operation: Record<string, unknown> = {
      summary: annotation.summary,
      parameters: [
        ...params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
        ...(annotation.requiredHeaders ?? []).map((name) => ({
          name,
          in: "header",
          required: true,
          schema: { type: "string" },
        })),
      ],
      responses: Object.fromEntries(
        Object.entries(annotation.responses).map(([code, description]) => [code, { description }]),
      ),
    };
    paths[openApiPath] = paths[openApiPath] ?? {};
    paths[openApiPath][method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "AI-CRM Agent & Governance API",
      version: "1.0.0",
      description:
        "Machine-readable surface for /api/agent (and the /v1/agent alias), /api/governance, /health, /ready, /metrics. " +
        "Pilot-grade: rate-limit headers on POST /api/agent/commands (and /v1 alias) are an in-process, per-workspace counter, not a distributed limiter.",
    },
    paths,
  };
}
