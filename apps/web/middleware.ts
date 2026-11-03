import { NextResponse, type NextRequest } from "next/server";
import { selfEntryConfiguration, verifySelfEntry } from "./app/self-entry-server";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/login/enroll"
    || path === "/api/self-entry" || path === "/api/self-entry/logout"
    || path === "/api/self-entry/enroll") return NextResponse.next();
  const configuration = selfEntryConfiguration();
  const verified = await verifySelfEntry(request.headers.get("cookie") ?? "", configuration);
  if (verified.status === 200) return NextResponse.next();
  if (path.startsWith("/api/")) return verified;
  const target = new URL("/login", configuration.ready ? configuration.config.webOrigin : request.url);
  const body: unknown = await verified.json();
  if (body !== null && typeof body === "object" && "error" in body
    && body.error === "OPERATOR_PROOF_EXPIRED") target.searchParams.set("state", "expired");
  return NextResponse.redirect(target);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
