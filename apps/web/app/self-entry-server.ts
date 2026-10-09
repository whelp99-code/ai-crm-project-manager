const CONFIG_KEYS = [
  "CRM_SELF_ENTRY_API_ORIGIN",
  "CRM_SELF_ENTRY_WEB_ORIGIN",
  "CRM_SELF_ENTRY_WORKSPACE_ID",
  "CRM_SELF_ENTRY_PRINCIPAL_ID",
  "CRM_SELF_ENTRY_API_KEY",
  "CRM_SELF_ENTRY_SESSION_MAX_AGE_SECONDS",
] as const;

export interface SelfEntryConfig {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly apiKey: string;
  readonly maxAgeSeconds: number;
  readonly localDevelopment: boolean;
}

export type SelfEntryConfiguration =
  | { readonly ready: true; readonly config: SelfEntryConfig }
  | { readonly ready: false; readonly missing: readonly string[] };

function permittedOrigin(value: string, localDevelopment: boolean): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:"
        || (localDevelopment && url.protocol === "http:"
          && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)));
  } catch {
    return false;
  }
}

/** Only explicit server configuration; no file reader, enrollment or operating defaults. */
export function selfEntryConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): SelfEntryConfiguration {
  const missing = CONFIG_KEYS.filter(key => !source[key]?.trim());
  if (missing.length) return { ready: false, missing };
  const apiOrigin = source.CRM_SELF_ENTRY_API_ORIGIN ?? "";
  const webOrigin = source.CRM_SELF_ENTRY_WEB_ORIGIN ?? "";
  const workspaceId = source.CRM_SELF_ENTRY_WORKSPACE_ID ?? "";
  const principalId = source.CRM_SELF_ENTRY_PRINCIPAL_ID ?? "";
  const apiKey = source.CRM_SELF_ENTRY_API_KEY ?? "";
  const maxAgeSeconds = Number(source.CRM_SELF_ENTRY_SESSION_MAX_AGE_SECONDS);
  const localDevelopment = source.NODE_ENV === "development" || source.NODE_ENV === "test";
  if (!permittedOrigin(apiOrigin, localDevelopment) || !permittedOrigin(webOrigin, localDevelopment)
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300) {
    return { ready: false, missing: CONFIG_KEYS };
  }
  return { ready: true, config: { apiOrigin, webOrigin, workspaceId, principalId, apiKey, maxAgeSeconds, localDevelopment } };
}

function response(status: number, body: Readonly<Record<string, unknown>>, cookie?: string): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) },
  });
}

function operatorCookie(header: string): string | undefined {
  return header.split(";").map(part => part.trim())
    .find(part => /^cwos_operator_stepup=[A-Za-z0-9._-]+$/.test(part));
}

function headers(config: SelfEntryConfig, cookie?: string): Readonly<Record<string, string>> {
  return {
    "x-api-key": config.apiKey,
    "x-workspace-id": config.workspaceId,
    "x-principal-id": config.principalId,
    "x-principal-kind": "human",
    ...(cookie ? { cookie } : {}),
  };
}

const DENIAL_CODES = new Set([
  "OPERATOR_UNAUTHENTICATED", "OPERATOR_TOTP_REPLAY", "OPERATOR_RATE_LIMITED",
  "OPERATOR_PROOF_REQUIRED", "OPERATOR_PROOF_INVALID", "OPERATOR_PROOF_EXPIRED",
  "OPERATOR_PROOF_SCOPE", "ACTOR_BINDING_MISMATCH", "STEP_UP_REQUIRED",
]);

async function denial(upstream: Response): Promise<Response> {
  let code = "AUTHENTICATION_FAILED";
  try {
    const body: unknown = await upstream.json();
    if (typeof body === "object" && body !== null && "error" in body
      && typeof body.error === "string" && DENIAL_CODES.has(body.error)) code = body.error;
  } catch {
    // no-excuse-ok: catch — untrusted upstream bodies must never reach users or logs.
  }
  const status = [401, 403, 429].includes(upstream.status) ? upstream.status : 502;
  return response(status, { error: code });
}

/** The browser stages input; only this final request invokes the existing password/TOTP gate. */
export async function submitSelfEntry(
  request: Request,
  configuration: SelfEntryConfiguration = selfEntryConfiguration(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (!configuration.ready) return response(503, { error: "CONFIGURATION_REQUIRED", missing: configuration.missing });
  const { config } = configuration;
  if (request.headers.get("origin") !== config.webOrigin) return response(403, { error: "ORIGIN_DENIED" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return response(400, { error: "INPUT_INVALID" });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return response(400, { error: "INPUT_INVALID" }); }
  if (typeof body !== "object" || body === null || !("password" in body) || !("totp" in body)
    || typeof body.password !== "string" || body.password.length < 1 || body.password.length > 200
    || typeof body.totp !== "string" || !/^\d{6}$/.test(body.totp)
    || Object.keys(body).some(key => !["password", "totp"].includes(key))) {
    return response(400, { error: "INPUT_INVALID" });
  }
  try {
    const upstream = await transport(`${config.apiOrigin}/api/cwos/v2/operator-step-up`, {
      method: "POST",
      headers: { ...headers(config), "content-type": "application/json" },
      body: JSON.stringify({ password: body.password, totp: body.totp }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (upstream.status !== 200) return denial(upstream);
    const cookie = upstream.headers.get("set-cookie");
    const match = cookie?.match(/^cwos_operator_stepup=([A-Za-z0-9._-]+); Path=\/api\/cwos\/v2; HttpOnly; SameSite=Strict; Max-Age=(\d+)(; Secure)?$/);
    const maxAge = Number(match?.[2]);
    if (!match?.[1] || !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > config.maxAgeSeconds
      || (!config.localDevelopment && !match[3])) {
      return response(502, { error: "SESSION_RESPONSE_INVALID" });
    }
    // Reuse the same signed scoped proof on this web origin; no second authentication/session system.
    const webCookie = `cwos_operator_stepup=${match[1]}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${match[3] ?? ""}`;
    return response(200, { authenticated: true }, webCookie);
  } catch {
    // no-excuse-ok: catch — transport errors may contain credentials; return only a fixed code.
    return response(502, { error: "AUTHENTICATION_UNAVAILABLE" });
  }
}

export async function verifySelfEntry(
  cookieHeader: string,
  configuration: SelfEntryConfiguration = selfEntryConfiguration(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (!configuration.ready) return response(503, { error: "CONFIGURATION_REQUIRED", missing: configuration.missing });
  const cookie = operatorCookie(cookieHeader);
  if (!cookie) return response(401, { error: "OPERATOR_PROOF_REQUIRED" });
  try {
    const upstream = await transport(`${configuration.config.apiOrigin}/api/cwos/v2/operator-session`, {
      method: "GET",
      headers: headers(configuration.config, cookie),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (upstream.status !== 200) return denial(upstream);
    const body: unknown = await upstream.json();
    if (typeof body !== "object" || body === null || !("authenticated" in body)
      || body.authenticated !== true || Object.keys(body).length !== 1) {
      return response(502, { error: "SESSION_RESPONSE_INVALID" });
    }
    return response(200, { authenticated: true });
  } catch {
    // no-excuse-ok: catch — no server body, proof, cookie or transport error is exposed.
    return response(502, { error: "AUTHENTICATION_UNAVAILABLE" });
  }
}
