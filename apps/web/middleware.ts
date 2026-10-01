import { NextResponse, type NextRequest } from "next/server";
import { OWNER_COOKIE, sessionSignatureLive } from "@ai-crm/owner-auth/page-gate";

export async function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete("x-owner-socket-ip");
  headers.set("x-pathname", request.nextUrl.pathname);
  const enabled = process.env.OWNER_AUTH === "1";
  const path = request.nextUrl.pathname;
  const publicPath = path === "/login" || path === "/health" || path.startsWith("/api/owner/");
  const token = request.cookies.get(OWNER_COOKIE)?.value;
  const secret = process.env.OWNER_SESSION_SECRET;
  const signed = !enabled || publicPath || (Boolean(token && secret) && await sessionSignatureLive(token ?? "", secret ?? "", Date.now()));
  if (signed) return NextResponse.next({ request: { headers } });
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
