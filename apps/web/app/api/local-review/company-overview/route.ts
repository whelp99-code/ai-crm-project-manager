import { NextResponse, type NextRequest } from "next/server";
import { isLocalReviewAllowed } from "../../../lib/local-review-guard";

// Hostname is not peer-IP or owner-session authentication. When opting in, run
// Next bound to loopback, e.g. `next dev --hostname 127.0.0.1`.
export async function GET(request: NextRequest) {
  if (!isLocalReviewAllowed({
    optIn: process.env.CWOS_LOCAL_REVIEW,
    nodeEnv: process.env.NODE_ENV,
    hostname: new URL(`http://${request.headers.get("host")}`).hostname,
  })) {
    return NextResponse.json({ error: "LOCAL_REVIEW_UNAVAILABLE" }, { status: 404 });
  }

  const apiBase = process.env.API_BASE_URL;
  const workspaceId = process.env.WORKSPACE_ID;
  const principalId = process.env.OPERATOR_PRINCIPAL_ID;
  if (!apiBase || !workspaceId || !principalId) {
    return NextResponse.json({ error: "LOCAL_REVIEW_CONFIGURATION_REQUIRED" }, { status: 503 });
  }

  const headers: Record<string, string> = {
    "x-workspace-id": workspaceId,
    "x-principal-id": principalId,
    "x-principal-kind": "human",
  };
  const apiKey = process.env.AUTH_API_KEY ?? process.env.API_AUTH_TOKEN;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/cwos/v2/company-overview`, {
    headers,
    cache: "no-store",
  });
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
