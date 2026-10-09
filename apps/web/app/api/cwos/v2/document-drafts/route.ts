import { NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, operatorCookie, ownerReviewRequest } from "../../../../lib/owner-review";

async function proxy(request: NextRequest, method: "GET" | "POST") {
  if (method === "POST" && !isSameOrigin(request)) {
    return NextResponse.json({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" }, { status: 403 });
  }
  const proof = request.cookies.get(operatorCookie)?.value;
  if (!proof) return NextResponse.json({ error: "OWNER_SESSION_REQUIRED" }, { status: 401 });
  const response = await ownerReviewRequest(request, {
    cookie: `${operatorCookie}=${proof}`, method, resource: "document-drafts",
    ...(method === "GET" ? { search: request.nextUrl.search } : {}),
    ...(method === "POST" ? { body: await request.text() } : {}),
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const GET = (request: NextRequest) => proxy(request, "GET");
export const POST = (request: NextRequest) => proxy(request, "POST");
