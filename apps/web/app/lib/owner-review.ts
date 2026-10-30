import { NextResponse, type NextRequest } from "next/server";
import { loginDisabledReadFromEnv } from "./login-disabled";

export const operatorCookie = "cwos_operator_stepup";

export function isSameOrigin(request: NextRequest): boolean {
  // Next's internal request URL may use localhost even when the browser used
  // 127.0.0.1. Compare the browser Origin to the actual HTTP request authority.
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.get("host")
      && parsed.protocol === new URL(request.url).protocol;
  } catch {
    return false;
  }
}

const CLIENT_IDENTITY_HEADERS = [
  "x-principal-id", "x-workspace-id", "x-principal-kind", "x-api-key", "x-step-up", "x-bot-id",
  "x-owner-id", "x-app-id", "owner", "app_id",
] as const;

export function clientIdentityInjected(request: NextRequest): boolean {
  return CLIENT_IDENTITY_HEADERS.some(name => {
    const value = request.headers.get(name);
    return value !== null && value.trim() !== "";
  });
}

export async function ownerReviewRequest(
  request: NextRequest,
  options: { readonly cookie?: string; readonly method: "GET" | "POST"; readonly body?: string; readonly resource?: "document-drafts"; readonly search?: string },
): Promise<Response> {
  const base = process.env.API_BASE_URL;
  const workspace = process.env.WORKSPACE_ID;
  const principal = process.env.OPERATOR_PRINCIPAL_ID;
  const key = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (!base || !workspace || !principal || !key) {
    return NextResponse.json({ error: "OWNER_REVIEW_CONFIGURATION_REQUIRED" }, { status: 503 });
  }
  const headers: Record<string, string> = {
    "x-api-key": key, "x-workspace-id": workspace,
    "x-principal-id": principal, "x-principal-kind": "human",
    "content-type": "application/json",
    ...(options.cookie ? { cookie: options.cookie } : {}),
  };
  const csrf = request.headers.get("x-csrf-token");
  const idempotency = request.headers.get("idempotency-key");
  if (csrf) headers["x-csrf-token"] = csrf;
  if (idempotency) headers["idempotency-key"] = idempotency;
  try {
    return await fetch(`${base.replace(/\/+$/, "")}/api/cwos/v2/${options.resource ?? "mail-candidate-review"}${options.search ?? ""}`, {
      method: options.method, headers, cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10_000),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  } catch {
    return NextResponse.json({ error: "OWNER_REVIEW_API_UNAVAILABLE" }, { status: 503 });
  }
}

export async function proxyOwnerReview(
  request: NextRequest,
  options: { readonly method: "GET" | "POST"; readonly resource?: "document-drafts"; readonly search?: string },
): Promise<NextResponse> {
  if (clientIdentityInjected(request)) {
    return NextResponse.json({ error: "ACTOR_BINDING_MISMATCH" }, { status: 403 });
  }
  if (options.method === "POST" && !isSameOrigin(request)) {
    return NextResponse.json({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" }, { status: 403 });
  }
  const proof = request.cookies.get(operatorCookie)?.value;
  const readWithoutLogin = options.method === "GET"
    && loginDisabledReadFromEnv(request.headers.get("host"), request.headers.get("x-forwarded-host"));
  if (!proof && !readWithoutLogin) {
    return NextResponse.json({ error: "OWNER_SESSION_REQUIRED" }, { status: 401 });
  }
  const response = await ownerReviewRequest(request, {
    method: options.method,
    ...(proof && !readWithoutLogin ? { cookie: `${operatorCookie}=${proof}` } : {}),
    ...(options.resource ? { resource: options.resource } : {}),
    ...(options.search ? { search: options.search } : {}),
    ...(options.method === "POST" ? { body: await request.text() } : {}),
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
