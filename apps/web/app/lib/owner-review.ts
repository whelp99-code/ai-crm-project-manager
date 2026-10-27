import { NextResponse, type NextRequest } from "next/server";

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

export async function ownerReviewRequest(
  request: NextRequest,
  options: { readonly cookie: string; readonly method: "GET" | "POST"; readonly body?: string; readonly resource?: "document-drafts"; readonly search?: string },
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
    cookie: options.cookie, "content-type": "application/json",
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
