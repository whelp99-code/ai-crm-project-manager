import { submitSelfEntry, verifySelfEntry } from "../../self-entry-server";

export async function POST(request: Request): Promise<Response> {
  return submitSelfEntry(request);
}
export async function GET(request: Request): Promise<Response> {
  const cookie = request.headers.get("cookie") ?? "";
  const verified = await verifySelfEntry(cookie);
  if (verified.status !== 200) return verified;
  // Claims are released only after API signature/scope/generation/expiry verification.
  const token = cookie.split(";").map(part => part.trim())
    .find(part => part.startsWith("cwos_operator_stepup="))?.split(".")[1];
  const claims: unknown = JSON.parse(Buffer.from(token ?? "", "base64url").toString("utf8"));
  if (claims === null || typeof claims !== "object" || !("csrf" in claims) || !("expiresAt" in claims)
    || typeof claims.csrf !== "string" || typeof claims.expiresAt !== "number") {
    return Response.json({ error: "SESSION_RESPONSE_INVALID" }, { status: 502 });
  }
  return Response.json({ csrf: claims.csrf, expiresAt: new Date(claims.expiresAt).toISOString() },
    { headers: { "cache-control": "no-store" } });
}
