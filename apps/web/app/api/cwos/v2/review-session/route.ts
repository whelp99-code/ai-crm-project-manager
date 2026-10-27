import { NextResponse, type NextRequest } from "next/server";
import { isSameOrigin, operatorCookie, ownerReviewRequest } from "../../../../lib/owner-review";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "OWNER_REVIEW_ORIGIN_REQUIRED" }, { status: 403 });
  }
  let input: unknown;
  try { input = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_OWNER_PROOF" }, { status: 400 });
  }
  if (!input || typeof input !== "object" || !("cookie" in input) || !("csrf" in input)
    || typeof input.cookie !== "string" || typeof input.csrf !== "string"
    || !/^cwos_operator_stepup=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.cookie)
    || input.cookie.length > 4096 || !/^[A-Za-z0-9_-]{24,128}$/.test(input.csrf)) {
    return NextResponse.json({ error: "INVALID_OWNER_PROOF" }, { status: 400 });
  }
  // The API verifies the signature, admitted owner, generation and expiry first.
  const validated = await ownerReviewRequest(request, { cookie: input.cookie, method: "GET" });
  if (validated.status !== 200) {
    await validated.body?.cancel();
    return NextResponse.json({ error: "OWNER_PROOF_NOT_ACCEPTED" }, { status: validated.status });
  }
  await validated.body?.cancel();
  const token = input.cookie.slice(operatorCookie.length + 1);
  const payload = token.split(".")[1];
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")); } catch {
    return NextResponse.json({ error: "INVALID_OWNER_PROOF" }, { status: 400 });
  }
  if (!claims || typeof claims !== "object" || !("expiresAt" in claims) || !("csrf" in claims)
    || typeof claims.expiresAt !== "number" || !Number.isFinite(claims.expiresAt)
    || claims.expiresAt <= Date.now() || claims.csrf !== input.csrf) {
    return NextResponse.json({ error: "INVALID_OWNER_PROOF" }, { status: 400 });
  }
  const response = NextResponse.json({ csrf: input.csrf, expiresAt: new Date(claims.expiresAt).toISOString() });
  const hostname = new URL(request.url).hostname;
  response.cookies.set(operatorCookie, token, {
    httpOnly: true, sameSite: "strict", path: "/api/cwos/v2",
    secure: !["localhost", "127.0.0.1", "[::1]"].includes(hostname),
    expires: new Date(claims.expiresAt),
  });
  response.headers.set("cache-control", "no-store");
  return response;
}
