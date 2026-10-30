import type { NextRequest } from "next/server";
import { proxyOwnerReview } from "../../../../lib/owner-review";

export const GET = (request: NextRequest) => proxyOwnerReview(request, { method: "GET" });
export const POST = (request: NextRequest) => proxyOwnerReview(request, { method: "POST" });
