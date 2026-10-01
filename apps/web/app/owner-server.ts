import { cookies } from "next/headers";

/** Forwards the owner session when the browser already has one. No-op otherwise. */
export async function withOwnerCookie(init: RequestInit = {}): Promise<RequestInit> {
  const jar = await cookies();
  const serialized = jar.toString();
  if (!serialized) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("cookie", serialized);
  return { ...init, headers };
}
