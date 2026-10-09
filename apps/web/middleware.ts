import { NextResponse, type NextRequest } from "next/server";
import { verifySelfEntry } from "./app/self-entry-server";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/api/self-entry") return NextResponse.next();
  const verified = await verifySelfEntry(request.headers.get("cookie") ?? "");
  if (verified.status === 200) return NextResponse.next();
  if (path.startsWith("/api/")) return verified;
  const target = new URL("/login", request.url);
  const body: unknown = await verified.json();
  if (body !== null && typeof body === "object" && "error" in body
    && body.error === "OPERATOR_PROOF_EXPIRED") target.searchParams.set("state", "expired");
  return NextResponse.redirect(target);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
