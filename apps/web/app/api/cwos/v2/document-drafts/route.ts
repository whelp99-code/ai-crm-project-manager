import type { NextRequest } from "next/server";
import { proxyOwnerReview } from "../../../../lib/owner-review";

export const GET = (request: NextRequest) => proxyOwnerReview(request, {
  method: "GET", resource: "document-drafts", search: request.nextUrl.search,
});
export const POST = (request: NextRequest) => proxyOwnerReview(request, { method: "POST", resource: "document-drafts" });
