/** Edge-safe session check. No node: imports so Next middleware can load it. */

export const OWNER_COOKIE = "core5_owner";

function b64urlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sessionSignatureLive(token: string, secret: string, nowMs: number): Promise<boolean> {
  return sessionTokenActive(token, secret, nowMs, readGen(token) ?? Number.NaN);
}

function readGen(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { gen?: number };
    return typeof parsed.gen === "number" ? parsed.gen : undefined;
  } catch {
    return undefined;
  }
}

export async function sessionTokenActive(
  token: string,
  secret: string,
  nowMs: number,
  generation: number,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return false;
  const expected = bytesToB64url(await hmac(secret, parts[1]));
  if (expected.length !== parts[2].length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as { exp?: number; gen?: number };
    return typeof parsed.exp === "number" && parsed.exp > nowMs && parsed.gen === generation;
  } catch {
    return false;
  }
}

export async function pageAllowsEdge(input: {
  enabled: boolean;
  pathname: string;
  token: string | undefined;
  secret: string | undefined;
  nowMs: number;
  generation: number | undefined;
}): Promise<boolean> {
  if (!input.enabled) return true;
  if (input.pathname === "/login" || input.pathname === "/health" || input.pathname.startsWith("/api/owner/")) return true;
  if (!input.token || !input.secret || input.generation === undefined) return false;
  return sessionTokenActive(input.token, input.secret, input.nowMs, input.generation);
}
