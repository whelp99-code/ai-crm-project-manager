import { lstatSync } from "node:fs";

/** tailscale serve forwards 8446 to 4313 and 8447 to 4312. Both are tailnet paths. */
export const TAILSCALE_BACKEND_PORTS = new Set([4312, 4313]);
/** Not forwarded by tailscale serve. The enrollment process binds 127.0.0.1 only. */
export const ENROLLMENT_BIND_HOST = "127.0.0.1";
export const ENROLLMENT_BIND_PORT = 4321;
export const ENROLLMENT_ORIGIN = `http://${ENROLLMENT_BIND_HOST}:${ENROLLMENT_BIND_PORT}`;

const LOOPBACK_REMOTE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export type EnrollmentListener = {
  localPort: number;
  remoteAddress: string;
};

export function enrollmentListener(socket: {
  localPort?: number;
  remoteAddress?: string | null | undefined;
}): EnrollmentListener | undefined {
  if (typeof socket.localPort !== "number" || !Number.isInteger(socket.localPort)) return undefined;
  if (!socket.remoteAddress) return undefined;
  return { localPort: socket.localPort, remoteAddress: socket.remoteAddress };
}

/** Allow only the dedicated loopback listener. Host, Origin and the request URL are not consulted. */
export function enrollmentSurfaceAllowed(listener: EnrollmentListener | undefined): boolean {
  if (!listener) return false;
  if (TAILSCALE_BACKEND_PORTS.has(listener.localPort)) return false;
  if (listener.localPort !== ENROLLMENT_BIND_PORT) return false;
  return LOOPBACK_REMOTE.has(listener.remoteAddress);
}

export type EnrollmentAvailability = "denied" | "unconfigured" | "enrolled" | "open";

/** Existence of the state path closes the form. The file contents are not read. */
export function enrollmentAvailability(
  listener: EnrollmentListener | undefined,
  statePath: string | undefined,
): EnrollmentAvailability {
  if (!enrollmentSurfaceAllowed(listener)) return "denied";
  if (!statePath) return "unconfigured";
  try {
    const info = lstatSync(statePath);
    if (info.isFile() || info.isSymbolicLink()) return "enrolled";
    return "unconfigured";
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    return code === "ENOENT" ? "open" : "unconfigured";
  }
}

function json(status: number, body: { error: string } | { enrolled: true } | { open: boolean }): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function alreadyEnrolled(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ALREADY_ENROLLED";
}

export async function submitOperatorEnrollment(
  request: Request,
  options: {
    statePath: string | undefined;
    now: number;
    write: (statePath: string, input: unknown, now: number) => void;
    listener: EnrollmentListener | undefined;
  },
): Promise<Response> {
  if (!enrollmentSurfaceAllowed(options.listener)) return json(403, { error: "ENROLLMENT_HOST_DENIED" });
  if (request.headers.get("origin") !== ENROLLMENT_ORIGIN) return json(403, { error: "ENROLLMENT_HOST_DENIED" });
  const availability = enrollmentAvailability(options.listener, options.statePath);
  if (availability === "unconfigured") return json(503, { error: "CONFIGURATION_REQUIRED" });
  if (availability === "enrolled") return json(409, { error: "ALREADY_ENROLLED" });
  const raw = await request.text();
  if (raw.length > 4096) return json(422, { error: "OPERATOR_ENROLLMENT_REJECTED" });
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return json(422, { error: "OPERATOR_ENROLLMENT_REJECTED" }); }
  if (!options.statePath) return json(503, { error: "CONFIGURATION_REQUIRED" });
  try {
    options.write(options.statePath, input, options.now);
  } catch (error) {
    if (alreadyEnrolled(error)) return json(409, { error: "ALREADY_ENROLLED" });
    return json(422, { error: "OPERATOR_ENROLLMENT_REJECTED" });
  }
  return json(201, { enrolled: true });
}

export function publicEnrollmentDenied(): Response {
  return json(403, { error: "ENROLLMENT_HOST_DENIED" });
}
