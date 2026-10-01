import { NextResponse, type NextRequest } from "next/server";
import { OWNER_COOKIE, pageAllowsEdge } from "@ai-crm/owner-auth/page-gate";

export async function middleware(request: NextRequest) {
  const allowed = await pageAllowsEdge({
    enabled: process.env.OWNER_AUTH === "1",
    pathname: request.nextUrl.pathname,
    token: request.cookies.get(OWNER_COOKIE)?.value,
    secret: process.env.OWNER_SESSION_SECRET,
    nowMs: Date.now(),
  });
  if (allowed) return NextResponse.next();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
