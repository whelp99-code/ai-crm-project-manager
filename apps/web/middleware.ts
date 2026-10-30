import { NextResponse, type NextRequest } from "next/server";
import { selfEntryConfiguration, verifySelfEntry } from "./app/self-entry-server";
import { loginDisabledReadFromEnv } from "./app/lib/login-disabled";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/api/self-entry" || path === "/api/self-entry/logout") return NextResponse.next();
  if ((request.method === "GET" || request.method === "HEAD")
    && loginDisabledReadFromEnv(request.headers.get("host"), request.headers.get("x-forwarded-host"))) {
    return NextResponse.next();
  }
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
