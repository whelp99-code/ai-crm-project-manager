const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

function requestHostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 1 ? host.slice(1, end) : host;
  }
  return host.split(":")[0] ?? host;
}

export interface LoginDisabledReadInput {
  readonly flag: string | undefined;
  readonly apiOrigin: string | undefined;
  readonly webOrigin: string | undefined;
  readonly workspaceId: string | undefined;
  readonly principalId: string | undefined;
  readonly apiKey: string | undefined;
  readonly requestHost: string | undefined;
  readonly forwardedHost: string | undefined;
}

/** Uses the existing server binding. A missing owner is not created, and forwarded hosts are not trusted. */
export function loginDisabledReadAllowed(input: LoginDisabledReadInput): boolean {
  if (input.flag !== "1") return false;
  if (!input.workspaceId?.trim() || !input.principalId?.trim() || !input.apiKey?.trim()) return false;
  if (!input.apiOrigin || !input.webOrigin || !input.requestHost) return false;
  if (input.forwardedHost && input.forwardedHost.toLowerCase() !== input.requestHost.toLowerCase()) return false;
  try {
    const api = new URL(input.apiOrigin);
    const web = new URL(input.webOrigin);
    if (api.origin !== input.apiOrigin || web.origin !== input.webOrigin) return false;
    if (api.username || api.password || web.username || web.password) return false;
    if ((api.protocol !== "http:" && api.protocol !== "https:")
      || (web.protocol !== "http:" && web.protocol !== "https:")) return false;
    if (!isLoopbackHost(api.hostname) || !isLoopbackHost(web.hostname)) return false;
    return isLoopbackHost(requestHostname(input.requestHost));
  } catch {
    return false;
  }
}

export function loginDisabledReadFromEnv(
  requestHost: string | null | undefined,
  forwardedHost: string | null | undefined = undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return loginDisabledReadAllowed({
    flag: source.CWOS_LOGIN_DISABLED,
    apiOrigin: source.OPERATOR_AUTH_API_BASE_URL || source.API_BASE_URL,
    webOrigin: source.CRM_WEB_ORIGIN,
    workspaceId: source.WORKSPACE_ID,
    principalId: source.OPERATOR_PRINCIPAL_ID,
    apiKey: source.AUTH_API_KEY || source.API_AUTH_TOKEN,
    requestHost: requestHost ?? undefined,
    forwardedHost: forwardedHost ?? undefined,
  });
}
