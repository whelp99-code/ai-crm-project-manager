import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";

export type FixtureControlCode =
  | "DIRECTORY_REQUIRED"
  | "MISSING"
  | "OWNERSHIP"
  | "ORIGIN_MISMATCH"
  | "INVALID";

export class FixtureControlError extends Error {
  readonly code: FixtureControlCode;

  constructor(code: FixtureControlCode, message: string) {
    super(message);
    this.name = "FixtureControlError";
    this.code = code;
  }
}

export interface FixtureControl {
  readonly origin: string;
  readonly webOrigin: string;
  readonly controlSecret: string;
  readonly password: string;
  readonly totp: string;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function loopbackOrigin(value: string, label: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new FixtureControlError("INVALID", `${label} must be an HTTP loopback origin`);
  }
  const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost";
  if (origin.origin !== value || origin.protocol !== "http:" || !loopback || origin.port.length === 0) {
    throw new FixtureControlError("INVALID", `${label} must be an HTTP loopback origin`);
  }
  return value;
}

function assertOwned(stat: Stats, mode: number, label: string): void {
  if (stat.isSymbolicLink()) {
    throw new FixtureControlError("OWNERSHIP", `${label} must not be a symbolic link`);
  }
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid) {
    throw new FixtureControlError("OWNERSHIP", `${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o777) !== mode) {
    throw new FixtureControlError("OWNERSHIP", `${label} must be mode ${mode.toString(8)}`);
  }
}

export function parseFixtureControl(value: unknown): FixtureControl {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureControlError("INVALID", "native auth fixture control data must be an object");
  }
  if (!("origin" in value) || !("webOrigin" in value) || !("controlSecret" in value)
    || !("password" in value) || !("totp" in value)
    || typeof value.origin !== "string" || typeof value.webOrigin !== "string"
    || typeof value.controlSecret !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(value.controlSecret)
    || typeof value.password !== "string" || value.password.length < 1
    || typeof value.totp !== "string" || !/^\d{6}$/.test(value.totp)) {
    throw new FixtureControlError("INVALID", "native auth fixture control data is invalid");
  }
  return {
    origin: loopbackOrigin(value.origin, "fixture API origin"),
    webOrigin: loopbackOrigin(value.webOrigin, "fixture web origin"),
    controlSecret: value.controlSecret,
    password: value.password,
    totp: value.totp,
  };
}

export function requireExternalFixtureDirectory(baseURL: string, directory: string | undefined): string {
  loopbackOrigin(baseURL, "PLAYWRIGHT_BASE_URL");
  if (directory) return directory;
  throw new FixtureControlError(
    "DIRECTORY_REQUIRED",
    "PLAYWRIGHT_BASE_URL disables the managed fixture server. Set PLAYWRIGHT_FIXTURE_DIRECTORY to the mode-0700 control directory written by that owned server. Refusing to synthesize a directory or attempt operator login.",
  );
}

export async function readOwnedFixtureControl(
  directory: string,
  expectedWebOrigin?: string,
): Promise<FixtureControl> {
  let directoryStat: Stats;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (isEnoent(error)) {
      throw new FixtureControlError("MISSING", `fixture control directory is missing: ${directory}`);
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    throw new FixtureControlError("OWNERSHIP", "fixture control path must be a directory");
  }
  assertOwned(directoryStat, 0o700, "fixture control directory");
  const controlPath = `${directory}/auth-control.json`;
  let fileStat: Stats;
  try {
    fileStat = await lstat(controlPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new FixtureControlError("MISSING", `fixture control file is missing: ${controlPath}`);
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    throw new FixtureControlError("OWNERSHIP", "auth-control.json must be a regular file");
  }
  assertOwned(fileStat, 0o600, "auth-control.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(controlPath, "utf8"));
  } catch {
    throw new FixtureControlError("INVALID", "auth-control.json is not valid JSON");
  }
  const control = parseFixtureControl(parsed);
  if (expectedWebOrigin !== undefined && control.webOrigin !== expectedWebOrigin) {
    throw new FixtureControlError(
      "ORIGIN_MISMATCH",
      "auth-control.json webOrigin does not match PLAYWRIGHT_BASE_URL; refusing operator login",
    );
  }
  return control;
}
