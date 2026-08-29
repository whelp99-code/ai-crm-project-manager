import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ path: string[] }> };

function configuration(): {
  apiBase: string;
  workspaceId: string;
  principalId: string;
  apiToken: string;
} {
  const apiBase = process.env.API_BASE_URL?.trim();
  const workspaceId = process.env.WORKSPACE_ID?.trim();
  const principalId = (process.env.OPERATOR_PRINCIPAL_ID ?? process.env.DEMO_PRINCIPAL_ID)?.trim();
  const apiToken = (process.env.API_AUTH_TOKEN ?? process.env.AUTH_API_KEY)?.trim();
  if (!apiBase || !workspaceId || !principalId || !apiToken) {
    throw new Error("API_BASE_URL, WORKSPACE_ID, OPERATOR_PRINCIPAL_ID and API_AUTH_TOKEN are required");
  }
  return { apiBase, workspaceId, principalId, apiToken };
}

async function proxy(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const config = configuration();
    const { path } = await context.params;
    const target = new URL(`/api/cwos/${path.map(encodeURIComponent).join("/")}`, config.apiBase);
    target.search = request.nextUrl.search;

    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${config.apiToken}`,
      "x-workspace-id": config.workspaceId,
      "x-principal-id": config.principalId,
      "x-principal-kind": "human",
      "x-step-up": "true",
    });
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);

    const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      cache: "no-store",
      redirect: "manual",
    });

    const responseHeaders = new Headers({
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    });
    const returnedIdempotencyKey = response.headers.get("idempotency-key");
    if (returnedIdempotencyKey) responseHeaders.set("idempotency-key", returnedIdempotencyKey);

    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CWOS proxy failed";
    return NextResponse.json({ error: "CWOS_PROXY_UNAVAILABLE", message }, { status: 503 });
  }
}

export function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return proxy(request, context);
}

export function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return proxy(request, context);
}

export function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return proxy(request, context);
}

export function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return proxy(request, context);
}

export function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return proxy(request, context);
}
