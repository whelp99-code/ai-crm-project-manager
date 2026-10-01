import { NextResponse } from "next/server";
import { OwnerAuthService, webLoginPeer } from "@ai-crm/owner-auth";
import { FileOwnerStore } from "@ai-crm/owner-auth/file-store";

function service(): OwnerAuthService {
  const secret = process.env.OWNER_SESSION_SECRET ?? "";
  const statePath = process.env.OWNER_AUTH_STATE_PATH ?? "";
  if (!statePath) throw new Error("OWNER_AUTH_STATE_PATH required");
  return new OwnerAuthService(new FileOwnerStore(statePath), {
    sessionSecret: secret,
    cookieSecure: process.env.OWNER_COOKIE_SECURE === "1",
  });
}

function ipOf(request: Request): string {
  return webLoginPeer(request.headers);
}

export async function postOwner(request: Request, action: "enroll" | "confirm" | "login"): Promise<NextResponse> {
  const body = (await request.json()) as { code?: string; password?: string; totp?: string };
  const auth = service();
  const ip = ipOf(request);
  if (action === "enroll") {
    const result = auth.enroll(body.code ?? "", body.password ?? "", ip);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ otpauth: result.otpauth });
  }
  if (action === "confirm") {
    const result = auth.confirmTotp(body.totp ?? "", ip);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ enrolled: true });
  }
  const result = auth.login(body.password ?? "", body.totp ?? "", ip);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const response = NextResponse.json({ expiresAt: new Date(result.exp).toISOString() });
  for (const cookie of result.setCookie) response.headers.append("set-cookie", cookie);
  return response;
}
