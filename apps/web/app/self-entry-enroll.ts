import { lstatSync } from "node:fs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const HTTPS_PORTS = new Set(["8446", "8447"]);

export function enrollmentSurfaceAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(host)) return true;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return url.protocol === "https:" && HTTPS_PORTS.has(port);
}

export type EnrollmentAvailability = "denied" | "unconfigured" | "enrolled" | "open";

/** Existence of the state path closes the form. The file contents are not read. */
export function enrollmentAvailability(url: URL, statePath: string | undefined): EnrollmentAvailability {
  if (!enrollmentSurfaceAllowed(url)) return "denied";
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

function json(status: number, body: { error: string } | { enrolled: true }): Response {
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
  },
): Promise<Response> {
  const url = new URL(request.url);
  if (!enrollmentSurfaceAllowed(url)) return json(403, { error: "ENROLLMENT_HOST_DENIED" });
  if (request.headers.get("origin") !== url.origin) return json(403, { error: "ENROLLMENT_HOST_DENIED" });
  const availability = enrollmentAvailability(url, options.statePath);
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
