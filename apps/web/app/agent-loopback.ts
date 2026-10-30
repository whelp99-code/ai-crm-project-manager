import { selfEntryConfiguration, verifySelfEntry } from "./self-entry-server";

function denied(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

/** Existing internal data plane. Public and identity origins are not substitutes. */
export function internalLoopbackApiBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.origin !== value || url.protocol !== "http:" || !loopback || url.port.length === 0) return undefined;
    return value.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function sessionCsrf(cookieHeader: string): string | undefined {
  const token = cookieHeader.split(";").map(part => part.trim())
    .find(part => part.startsWith("cwos_operator_stepup="))?.split(".")[1];
  if (!token) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (claims === null || typeof claims !== "object" || !("csrf" in claims) || typeof claims.csrf !== "string"
      || claims.csrf.length < 16) return undefined;
    return claims.csrf;
  } catch {
    return undefined;
  }
}

function boundLoopback():
  | { readonly api: string; readonly workspaceId: string; readonly principalId: string; readonly apiKey: string; readonly webOrigin: string }
  | undefined {
  const configuration = selfEntryConfiguration();
  if (!configuration.ready) return undefined;
  const api = internalLoopbackApiBase(process.env.API_BASE_URL);
  if (!api) return undefined;
  return {
    api, workspaceId: configuration.config.workspaceId, principalId: configuration.config.principalId,
    apiKey: configuration.config.apiKey, webOrigin: configuration.config.webOrigin,
  };
}

async function admitted(request: Request, mutate: boolean): Promise<
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly bound: NonNullable<ReturnType<typeof boundLoopback>> }
> {
  const verified = await verifySelfEntry(request.headers.get("cookie") ?? "");
  if (verified.status !== 200) return { ok: false, response: verified };
  await verified.body?.cancel();
  const bound = boundLoopback();
  if (!bound) return { ok: false, response: denied(503, "LOOPBACK_REQUIRED") };
  if (!mutate) return { ok: true, bound };
  if (request.headers.get("origin") !== bound.webOrigin) return { ok: false, response: denied(403, "ORIGIN_DENIED") };
  const csrf = request.headers.get("x-csrf-token");
  if (!csrf || csrf !== sessionCsrf(request.headers.get("cookie") ?? "")) {
    return { ok: false, response: denied(403, "OPERATOR_CSRF") };
  }
  return { ok: true, bound };
}

function upstreamHeaders(bound: NonNullable<ReturnType<typeof boundLoopback>>, idempotency?: string): Record<string, string> {
  return {
    "x-api-key": bound.apiKey,
    "x-workspace-id": bound.workspaceId,
    "x-principal-id": bound.principalId,
    "content-type": "application/json",
    ...(idempotency ? { "idempotency-key": idempotency } : {}),
  };
}

function jobId(value: string): string | undefined {
  return /^job-[0-9]{1,12}$/.test(value) ? value : undefined;
}

export async function submitAgentCommand(request: Request, transport: typeof fetch = fetch): Promise<Response> {
  const gate = await admitted(request, true);
  if (!gate.ok) return gate.response;
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) return denied(400, "IDEMPOTENCY_REQUIRED");
  let body: unknown;
  try { body = await request.json(); } catch { return denied(400, "INPUT_INVALID"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return denied(400, "INPUT_INVALID");
  const text = "text" in body ? body.text : undefined;
  if (typeof text !== "string" || text.trim().length < 1 || text.length > 500) return denied(400, "INPUT_INVALID");
  const extra = Object.keys(body).filter(name => name !== "text" && name !== "resourceBinding");
  if (extra.length > 0) return denied(400, "INPUT_INVALID");
  let resourceBinding: { resourceType: string; resourceId: string } | undefined;
  if ("resourceBinding" in body && body.resourceBinding !== undefined) {
    const binding = body.resourceBinding;
    if (binding === null || typeof binding !== "object" || Array.isArray(binding)) return denied(400, "INPUT_INVALID");
    if (Object.keys(binding).some(name => name !== "resourceType" && name !== "resourceId")) return denied(400, "INPUT_INVALID");
    const resourceType = "resourceType" in binding ? binding.resourceType : undefined;
    const resourceId = "resourceId" in binding ? binding.resourceId : undefined;
    if (typeof resourceType !== "string" || typeof resourceId !== "string"
      || !/^[A-Za-z0-9_-]{1,80}$/.test(resourceType) || resourceId.trim().length < 1 || resourceId.length > 200) {
      return denied(400, "INPUT_INVALID");
    }
    resourceBinding = { resourceType, resourceId: resourceId.trim() };
  }
  try {
    const upstream = await transport(`${gate.bound.api}/api/agent/commands`, {
      method: "POST", headers: upstreamHeaders(gate.bound, key), redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ text: text.trim(), ...(resourceBinding ? { resourceBinding } : {}) }),
    });
    const payload: unknown = await upstream.json();
    if (upstream.status !== 202 || payload === null || typeof payload !== "object" || !("jobId" in payload)
      || typeof payload.jobId !== "string" || !jobId(payload.jobId)) {
      return denied(upstream.status === 400 ? 400 : 502, "COMMAND_REJECTED");
    }
    return Response.json({ jobId: payload.jobId }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch {
    return denied(502, "LOOPBACK_UNAVAILABLE");
  }
}

export async function readAgentJob(request: Request, id: string, transport: typeof fetch = fetch): Promise<Response> {
  const gate = await admitted(request, false);
  if (!gate.ok) return gate.response;
  const selected = jobId(id);
  if (!selected) return denied(404, "JOB_NOT_FOUND");
  try {
    const upstream = await transport(`${gate.bound.api}/api/agent/jobs/${selected}`, {
      method: "GET", headers: upstreamHeaders(gate.bound), redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const payload: unknown = await upstream.json();
    if (upstream.status !== 200 || payload === null || typeof payload !== "object" || !("job" in payload)
      || payload.job === null || typeof payload.job !== "object" || !("id" in payload.job)
      || payload.job.id !== selected) {
      return denied(upstream.status === 404 ? 404 : 502, "JOB_NOT_FOUND");
    }
    return Response.json(payload, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    return denied(502, "LOOPBACK_UNAVAILABLE");
  }
}

export async function cancelAgentJob(request: Request, id: string, transport: typeof fetch = fetch): Promise<Response> {
  const gate = await admitted(request, true);
  if (!gate.ok) return gate.response;
  const selected = jobId(id);
  if (!selected) return denied(404, "JOB_NOT_FOUND");
  try {
    const upstream = await transport(`${gate.bound.api}/api/agent/jobs/${selected}/cancel`, {
      method: "POST", headers: upstreamHeaders(gate.bound), redirect: "error",
      cache: "no-store", signal: AbortSignal.timeout(10_000), body: "{}",
    });
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      return denied(upstream.status === 404 ? 404 : 502, "CANCEL_REJECTED");
    }
    await upstream.body?.cancel();
    return Response.json({ jobId: selected }, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    return denied(502, "LOOPBACK_UNAVAILABLE");
  }
}
