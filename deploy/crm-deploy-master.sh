#!/usr/bin/env bash
set -euo pipefail
# Prepared 2026-10-13 from crm-deploy-1cf5.sh; never run approved mode during PR QA.
# See docs/ops/crm-version-67-20261013.md for the measured baseline and owner steps.
umask 077
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Preparation artifact; no activation without separate operator approval.' \
    'Required: CRM_DEPLOY_APPROVAL=approved CRM_WEB_ORIGIN=https://<approved-origin>' \
    'OPERATOR_AUTH_API_BASE_URL=https://<approved-private-identity-origin>' \
    'CWOS_V2_OPERATOR_AUTH_STATE_PATH=<new owner-enrolled bcrypt state>' \
    'Optional: CRM_REPO_ROOT CRM_STATE_ROOT CRM_UNIT_ROOT CRM_NODE_BIN CRM_PNPM_BIN CRM_BUILD_SLOT CRM_PG_IMAGE'
  exit 0
fi
[[ $# == 0 ]] || { printf '%s\n' 'CRM_ARGUMENTS_REJECTED' >&2; exit 64; }
[[ ${CRM_DEPLOY_APPROVAL:-} == approved ]] || {
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=operator_approval_required' >&2
  exit 1
}
export CRM_REPO_ROOT=${CRM_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
NODE=${CRM_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.2/bin/node}
exec "$NODE" --input-type=module - <<'NODE'
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { parseEnv } from "node:util";

const target = "1cf5388202c01ce6ddaf2796cbefc10c47e0e4bf";
const baseline = "e91bb512a2783918fd0c8b84c9e91660df348d96";
const home = process.env.HOME;
const root = process.env.CRM_STATE_ROOT || join(home, ".local/share/core5");
const repo = process.env.CRM_REPO_ROOT;
const units = process.env.CRM_UNIT_ROOT || join(home, ".config/systemd/user");
const node = process.env.CRM_NODE_BIN || join(home, ".nvm/versions/node/v22.23.2/bin/node");
const pnpm = process.env.CRM_PNPM_BIN || join(dirname(node), "pnpm");
const slot = process.env.CRM_BUILD_SLOT;
const appEnv = process.env.CRM_APP_ENV || join(home, ".config/core5/app.env");
const humanEnv = process.env.CRM_HUMAN_ENV || join(home, ".config/core5/crm/blro-human.env");
const release = join(root, "app-1cf53882");
const oldRelease = join(root, "app-e91bb512");
const files = ["core5-api", "core5-web"].map(unit => join(units, `${unit}.service.d/90-crm-release.conf`));
let changed = false, createdRelease = false, published = false;
let backupDir, scratch, watcher, startupTimer, stage = "prerequisites";

async function command(label, executable, args, options = {}) {
  stage = label;
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env || process.env,
    stdio: [options.input ? "pipe" : "ignore", options.outputFd ?? "pipe", "pipe"],
  });
  const output = [];
  child.stdout?.on("data", chunk => output.push(chunk));
  // Never print child errors: DSNs, enrollment values and cookies are private.
  child.stderr.on("data", () => {});
  if (options.input) child.stdin.end(options.input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${label}_exit_${code}`);
  return Buffer.concat(output);
}

async function privateText(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
      throw new Error("private_file_required");
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function stopWatcher() {
  if (!watcher || watcher.exitCode !== null || watcher.signalCode !== null) return;
  const closed = new Promise(resolve => watcher.once("close", resolve));
  watcher.kill("SIGTERM");
  await closed;
}

async function rollback() {
  if (!changed) return;
  stage = "rollback";
  for (let index = 0; index < files.length; index++) {
    await copyFile(join(backupDir, `dropin-${index}`), files[index]);
    await chmod(files[index], (await lstat(join(backupDir, `dropin-${index}`))).mode & 0o777);
  }
  await command("rollback_reload", "systemctl", ["--user", "daemon-reload"]);
  await command("rollback_restart", "systemctl", ["--user", "restart", "core5-api", "core5-web"]);
  await command("rollback_active", "systemctl", ["--user", "is-active", "--quiet", "core5-api", "core5-web"]);
  changed = false;
  process.stderr.write("CRM_ROLLBACK_OK release=app-e91bb512\n");
}

async function main() {
  if (!process.versions.node.startsWith("22.")) throw new Error("node22_required");
  if (process.env.CRM_DEPLOY_APPROVAL !== "approved") throw new Error("operator_approval_required");
  const origin = process.env.CRM_WEB_ORIGIN;
  const identityOrigin = process.env.OPERATOR_AUTH_API_BASE_URL;
  for (const value of [origin, identityOrigin]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
      throw new Error("production_https_origins_required");
    }
  }
  const authPath = process.env.CWOS_V2_OPERATOR_AUTH_STATE_PATH;
  if (!authPath) throw new Error("owner_enrollment_required");
  const owner = JSON.parse(await privateText(authPath));
  if (!owner.enrolled || owner.totpPending !== false || !/^\$2b\$12\$[./A-Za-z0-9]{53}$/.test(owner.passwordHash)) {
    throw new Error("new_bcrypt_enrollment_required");
  }
  const binding = {
    ...parseEnv(await privateText(appEnv)), ...parseEnv(await privateText(humanEnv)),
    NODE_ENV: "production", CRM_WEB_ORIGIN: origin, OPERATOR_AUTH_API_BASE_URL: identityOrigin,
    CWOS_V2_OPERATOR_AUTH_STATE_PATH: authPath,
  };
  const oldAuthPath = parseEnv(await privateText(humanEnv)).CWOS_V2_OPERATOR_AUTH_STATE_PATH;
  if (authPath === oldAuthPath) throw new Error("legacy_auth_state_must_be_preserved");
  delete binding.CWOS_V2_OPERATOR_STEP_UP_VERIFIED; // Match the existing API drop-in.
  binding.OPERATOR_PRINCIPAL_ID = binding.CWOS_V2_OPERATOR_PRINCIPAL_ID;
  for (const value of [origin, identityOrigin, authPath]) {
    if (/[\r\n\0]/.test(value)) throw new Error("environment_value_rejected");
  }
  for (const executable of [node, pnpm, ...(slot ? [slot] : [])]) await access(executable);
  const revision = (await command("source_pin", "git", ["-C", repo, "rev-parse", `${target}^{commit}`])).toString().trim();
  if (revision !== target) throw new Error("source_pin_mismatch");
  await command("sql_delta", "git", ["-C", repo, "diff", "--exit-code", baseline, target, "--",
    "packages/persistence/migrations", "apps/api/migrations", "scripts/migrations"]);
  for (const [index, unit] of ["core5-api", "core5-web"].entries()) {
    const current = (await command("baseline_unit", "systemctl", ["--user", "show", unit,
      "--property=WorkingDirectory", "--value"])).toString().trim();
    if (current !== join(oldRelease, index ? "apps/web" : "apps/api")) throw new Error("baseline_changed");
    const text = await readFile(files[index], "utf8");
    if (!/^WorkingDirectory=.*app-e91bb512\/apps\/(api|web)$/m.test(text)) throw new Error("dropin_changed");
  }
  try { await lstat(release); throw new Error("immutable_release_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  scratch = await mkdtemp(join(root, ".prepare-1cf5-"));
  await chmod(scratch, 0o700);
  const archive = await command("archive", "git", ["-C", repo, "archive", target]);
  const tar = join(scratch, "source.tar");
  await writeFile(tar, archive, { flag: "wx", mode: 0o600 });
  await mkdir(release, { mode: 0o700 });
  createdRelease = true;
  await command("extract", "tar", ["-xf", tar, "-C", release]);
  const environment = { ...process.env, ...binding, PATH: `${dirname(node)}:${process.env.PATH}` };
  await command("frozen_dependencies", pnpm, ["install", "--frozen-lockfile", "--prod=false"], { cwd: release, env: environment });
  // Read the frozen target's own validators; never create a proof or mutate auth state.
  await command("target_auth_check", pnpm, ["exec", "tsx", "--eval",
    'import {parseOperatingConfig} from "./apps/api/src/ops-boot.ts"; import {FileOperatorAuthStore} from "./apps/api/src/operator-auth-store.ts"; import {selfEntryConfiguration} from "./apps/web/app/self-entry-server.ts"; const c=parseOperatingConfig(); new FileOperatorAuthStore(c.authStatePath!).read(); if(!selfEntryConfiguration().ready) throw new Error("CONFIGURATION_REQUIRED");'],
    { cwd: release, env: environment });
  await command("web_build", slot ? "bash" : pnpm,
    slot ? [slot, pnpm, "--filter", "@ai-crm/web", "build"] : ["--filter", "@ai-crm/web", "build"],
    { cwd: release, env: environment });

  await mkdir(join(root, "backups"), { recursive: true, mode: 0o700 });
  backupDir = await mkdtemp(join(root, "backups/pre-1cf5-"));
  await chmod(backupDir, 0o700);
  const database = new URL(binding.ADMIN_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("database_profile_invalid");
  const pgEnv = { ...process.env, PGHOST: database.hostname, PGPORT: database.port || "5432",
    PGDATABASE: decodeURIComponent(database.pathname.slice(1)), PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password), PGSSLMODE: database.searchParams.get("sslmode") || "prefer" };
  const image = process.env.CRM_PG_IMAGE || "postgres:16";
  const dumpPath = join(backupDir, "crm-before-1cf53882.dump");
  const dump = await open(dumpPath, "wx", 0o600);
  try {
    await command("pg_dump", "docker", ["run", "--rm", "--network=host",
      ...["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE"].flatMap(key => ["--env", key]),
      image, "pg_dump", "--format=custom", "--no-owner"], { env: pgEnv, outputFd: dump.fd });
  } finally { await dump.close(); }
  const dumpBytes = await readFile(dumpPath);
  if (!dumpBytes.length) throw new Error("empty_dump");
  await command("dump_catalog", "docker", ["run", "--rm", "-i", image, "pg_restore", "--list"], { input: dumpBytes });
  process.stdout.write(`CRM_BACKUP_OK bytes=${dumpBytes.length} sha256=${createHash("sha256").update(dumpBytes).digest("hex")}\n`);
  // The pinned e91..1cf5 SQL delta was checked above. Auth enrollment is a file, not SQL.
  process.stdout.write("CRM_MIGRATIONS_REQUIRED=0\n");
  for (let index = 0; index < files.length; index++) {
    await copyFile(files[index], join(backupDir, `dropin-${index}`));
    await chmod(join(backupDir, `dropin-${index}`), (await lstat(files[index])).mode & 0o777);
  }
  changed = true; // Arm rollback before the first unit file change.
  for (const [index, file] of files.entries()) {
    let text = (await readFile(file, "utf8")).replace(/^WorkingDirectory=.*$/m,
      `WorkingDirectory=${JSON.stringify(join(release, index ? "apps/web" : "apps/api"))}`);
    const additions = index ? { CRM_WEB_ORIGIN: origin, OPERATOR_AUTH_API_BASE_URL: identityOrigin,
      OPERATOR_PRINCIPAL_ID: binding.OPERATOR_PRINCIPAL_ID } : { CWOS_V2_OPERATOR_AUTH_STATE_PATH: authPath };
    for (const [key, value] of Object.entries(additions)) text += `Environment=${JSON.stringify(`${key}=${value}`)}\n`;
    await writeFile(file, text, { mode: (await lstat(file)).mode & 0o777 });
  }
  await command("reload", "systemctl", ["--user", "daemon-reload"]);
  const since = `@${Math.floor(Date.now() / 1000)}`;
  watcher = spawn("journalctl", ["--user", "-u", "core5-api", "-u", "core5-web", "--since", since, "-f", "-o", "cat"],
    { stdio: ["ignore", "pipe", "pipe"] });
  let log = "", apiReady = false, webReady = false;
  const ready = new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error("startup_timeout")), 120_000);
    watcher.once("error", reject);
    watcher.once("close", () => reject(new Error("startup_watch_ended")));
    watcher.stderr.on("data", () => {});
    watcher.stdout.on("data", chunk => {
      log = (log + chunk.toString()).slice(-8192);
      apiReady ||= /core5 api listening/.test(log);
      webReady ||= /Ready in/.test(log);
      if (apiReady && webReady) resolve();
    });
  });
  const launched = new Promise((resolve, reject) => {
    watcher.once("spawn", resolve); watcher.once("error", reject);
  });
  await Promise.all([ready, launched.then(() =>
    command("restart", "systemctl", ["--user", "restart", "core5-api", "core5-web"]))]);
  clearTimeout(startupTimer);
  await stopWatcher();
  for (const endpoint of ["http://127.0.0.1:4312/health", "http://127.0.0.1:4312/ready", "http://127.0.0.1:4313/login"]) {
    const output = (await command("health", "curl", ["--silent", "--show-error", "--max-time", "10",
      "--write-out", "\n%{http_code}", endpoint])).toString();
    if (!output.endsWith("\n200")) throw new Error("health_not_200");
  }
  const boundary = (await command("origin_probe", "curl", ["--silent", "--show-error", "--max-time", "10",
    "--write-out", "\n%{http_code}", "-H", `Origin: ${origin}`, "-H", "Content-Type: application/json",
    "--data", "{}", "http://127.0.0.1:4313/api/self-entry"])).toString();
  if (!boundary.endsWith("\n400") || JSON.parse(boundary.slice(0, -4)).error !== "INPUT_INVALID") {
    throw new Error("web_origin_not_ready");
  }
  await command("active", "systemctl", ["--user", "is-active", "--quiet", "core5-api", "core5-web"]);
  changed = false;
  published = true;
  process.stdout.write(`CRM_1CF5_LIVE release=app-1cf53882 rollback=app-e91bb512 backup=${dumpPath}\n`);
}

try {
  await main();
} catch (error) {
  const failedStage = stage;
  const safeReason = /^(operator_approval_required|production_https_origins_required|owner_enrollment_required|new_bcrypt_enrollment_required|legacy_auth_state_must_be_preserved|environment_value_rejected|source_pin_mismatch|baseline_changed|dropin_changed|immutable_release_exists|private_file_required|database_profile_invalid|empty_dump|startup_timeout|startup_watch_ended|health_not_200|web_origin_not_ready|node22_required|[a-z_]+_exit_(\d+|null))$/;
  const reason = typeof error?.message === "string" && safeReason.test(error.message)
    ? error.message : "private_input_or_io_rejected";
  clearTimeout(startupTimer);
  await stopWatcher();
  try { await rollback(); }
  catch { process.stderr.write("CRM_ROLLBACK_FAILED operator_action_required\n"); }
  process.stderr.write(`CRM_DEPLOY_REFUSED_OR_FAILED stage=${failedStage} reason=${reason}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(startupTimer);
  await stopWatcher();
  if (scratch) await rm(scratch, { recursive: true });
  if (createdRelease && !published && !changed) await rm(release, { recursive: true });
}
NODE
