const CONFIG_KEYS = [
  "API_BASE_URL", "CRM_WEB_ORIGIN", "WORKSPACE_ID", "OPERATOR_PRINCIPAL_ID", "AUTH_API_KEY",
] as const;

export interface SelfEntryConfig {
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly apiKey: string;
  readonly localDevelopment: boolean;
}
export type SelfEntryConfiguration =
  | { readonly ready: true; readonly config: SelfEntryConfig }
  | { readonly ready: false };

function permittedOrigin(value: string, local: boolean): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:" || (local && url.protocol === "http:"
        && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)));
  } catch { return false; }
}

/** Uses the existing server-owned CRM binding, never a browser-supplied identity. */
export function selfEntryConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): SelfEntryConfiguration {
  if (CONFIG_KEYS.some(key => !source[key]?.trim())) return { ready: false };
  const apiOrigin = source.API_BASE_URL ?? "";
  const webOrigin = source.CRM_WEB_ORIGIN ?? "";
  const localDevelopment = source.NODE_ENV === "development" || source.NODE_ENV === "test";
  if (!permittedOrigin(apiOrigin, localDevelopment) || !permittedOrigin(webOrigin, localDevelopment)) {
    return { ready: false };
  }
  return { ready: true, config: {
    apiOrigin, webOrigin, localDevelopment, workspaceId: source.WORKSPACE_ID ?? "",
    principalId: source.OPERATOR_PRINCIPAL_ID ?? "", apiKey: source.AUTH_API_KEY ?? "",
  } };
}

function response(status: number, body: Readonly<Record<string, unknown>>, cookie?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (cookie) {
    headers.append("set-cookie", cookie);
    // Remove an old imported narrow-path proof so it cannot shadow the fresh session.
    headers.append("set-cookie", "cwos_operator_stepup=; Path=/api/cwos/v2; HttpOnly; SameSite=Strict; Max-Age=0");
  }
  return Response.json(body, { status, headers });
}
function operatorCookie(header: string): string | undefined {
  return header.split(";").map(part => part.trim())
    .find(part => /^cwos_operator_stepup=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(part));
}
function headers(config: SelfEntryConfig, cookie?: string): Readonly<Record<string, string>> {
  return {
    "x-api-key": config.apiKey, "x-workspace-id": config.workspaceId,
    "x-principal-id": config.principalId, "x-principal-kind": "human",
    ...(cookie ? { cookie } : {}),
  };
}
const DENIAL_CODES = new Set([
  "OPERATOR_UNAUTHENTICATED", "OPERATOR_TOTP_REPLAY", "OPERATOR_RATE_LIMITED",
  "OPERATOR_PROOF_INVALID", "OPERATOR_PROOF_EXPIRED", "OPERATOR_PROOF_SCOPE",
  "ACTOR_BINDING_MISMATCH", "STEP_UP_REQUIRED",
]);
async function denial(upstream: Response): Promise<Response> {
  let code = "AUTHENTICATION_FAILED";
  try {
    const body: unknown = await upstream.json();
    if (body !== null && typeof body === "object" && "error" in body
      && typeof body.error === "string" && DENIAL_CODES.has(body.error)) code = body.error;
  } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  return response([401, 403, 429].includes(upstream.status) ? upstream.status : 502, { error: code });
}

/** Both factors are verified by the existing atomic API gate, never by the UI. */
export async function submitSelfEntry(request: Request,
  configuration: SelfEntryConfiguration = selfEntryConfiguration(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (!configuration.ready) return response(503, { error: "CONFIGURATION_REQUIRED" });
  const { config } = configuration;
  if (request.headers.get("origin") !== config.webOrigin) return response(403, { error: "ORIGIN_DENIED" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return response(400, { error: "INPUT_INVALID" });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return response(400, { error: "INPUT_INVALID" }); }
  if (body === null || typeof body !== "object" || !("password" in body) || !("totp" in body)
    || typeof body.password !== "string" || body.password.length < 1 || body.password.length > 200
    || typeof body.totp !== "string" || !/^\d{6}$/.test(body.totp)
    || Object.keys(body).some(key => !["password", "totp"].includes(key))) {
    return response(400, { error: "INPUT_INVALID" });
  }
  try {
    const upstream = await transport(`${config.apiOrigin}/api/cwos/v2/operator-step-up`, {
      method: "POST", headers: { ...headers(config), "content-type": "application/json" },
      body: JSON.stringify({ password: body.password, totp: body.totp }),
      redirect: "error", signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if (upstream.status !== 200) return denial(upstream);
    const cookie = upstream.headers.get("set-cookie");
    const match = cookie?.match(/^cwos_operator_stepup=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+); Path=\/api\/cwos\/v2; HttpOnly; SameSite=Strict; Max-Age=(\d+)(; Secure)?$/);
    const maxAge = Number(match?.[2]);
    if (!match?.[1] || !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 300
      || (!config.localDevelopment && !match[3])) {
      return response(502, { error: "SESSION_RESPONSE_INVALID" });
    }
    await upstream.body?.cancel();
    return response(200, { authenticated: true },
      `cwos_operator_stepup=${match[1]}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${match[3] ?? ""}`);
  } catch {
    // Boundary: transport errors can contain credentials and must never reach output.
    return response(502, { error: "AUTHENTICATION_UNAVAILABLE" });
  }
}

export async function verifySelfEntry(cookieHeader: string,
  configuration: SelfEntryConfiguration = selfEntryConfiguration(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (!configuration.ready) return response(503, { error: "CONFIGURATION_REQUIRED" });
  const cookie = operatorCookie(cookieHeader);
  if (!cookie) return response(401, { error: "STEP_UP_REQUIRED" });
  try {
    const upstream = await transport(`${configuration.config.apiOrigin}/api/cwos/v2/operator-session`, {
      method: "GET", headers: headers(configuration.config, cookie), redirect: "error",
      signal: AbortSignal.timeout(10_000), cache: "no-store",
    });
    if (upstream.status !== 200) return denial(upstream);
    const body: unknown = await upstream.json();
    if (body === null || typeof body !== "object" || !("authenticated" in body)
      || body.authenticated !== true || Object.keys(body).length !== 1) {
      return response(502, { error: "SESSION_RESPONSE_INVALID" });
    }
    return response(200, { authenticated: true });
  } catch { return response(502, { error: "AUTHENTICATION_UNAVAILABLE" }); }
}
