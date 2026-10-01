import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { OWNER_COOKIE } from "@ai-crm/owner-auth";
import { pageSessionAllows } from "@ai-crm/owner-auth/page-session";

/** Forwards the owner session when the browser already has one. No-op otherwise. */
export async function withOwnerCookie(init: RequestInit = {}): Promise<RequestInit> {
  const jar = await cookies();
  const serialized = jar.toString();
  if (!serialized) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", serialized);
  return { ...init, headers };
}

/** Rejects a copied cookie after logout or a newer login. Reads generation from the state file. */
export async function enforceOwnerPage(): Promise<void> {
  if (process.env.OWNER_AUTH !== "1") return;
  const path = (await headers()).get("x-pathname") ?? "";
  if (!path || path === "/login" || path.startsWith("/api/owner")) return;
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  const ok = await pageSessionAllows({
    enabled: true,
    pathname: path,
    token,
    secret: process.env.OWNER_SESSION_SECRET,
    nowMs: Date.now(),
    statePath: process.env.OWNER_AUTH_STATE_PATH,
  });
  if (!ok) redirect("/login");
}
