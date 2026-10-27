#!/usr/bin/env bash
set -euo pipefail
# Prepared 2026-10-13 from crm-deploy-1cf5.sh; never run approved mode during PR QA.
# See docs/ops/crm-version-67-20261013.md for the measured baseline and owner steps.
umask 077
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Preparation artifact; no activation without separate operator approval.' \
    'Required: CRM_DEPLOY_APPROVAL=approved CRM_TARGET_SHA=<full40> CRM_WEB_ORIGIN=https://<approved-origin>' \
    'OPERATOR_AUTH_API_BASE_URL=https://<approved-private-identity-origin>' \
    'CWOS_V2_OPERATOR_AUTH_STATE_PATH=<new owner-enrolled bcrypt state>' \
    'Optional: CRM_REPO_ROOT CRM_STATE_ROOT CRM_UNIT_ROOT CRM_NODE_BIN CRM_PNPM_BIN CRM_BUILD_SLOT CRM_PG_IMAGE CRM_PROC_ROOT'
  exit 0
fi
[[ $# == 0 ]] || { printf '%s\n' 'CRM_ARGUMENTS_REJECTED' >&2; exit 64; }
[[ ${CRM_DEPLOY_APPROVAL:-} == approved ]] || {
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=operator_approval_required' >&2
  exit 1
}
[[ ${CRM_TARGET_SHA:-} =~ ^[0-9a-f]{40}$ ]] || {
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=target_sha_required' >&2
  exit 1
}
export CRM_REPO_ROOT=${CRM_REPO_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
NODE=${CRM_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.2/bin/node}
# Both deployment entrypoints serialize the shared units through cleanup.
lock_dir=${CRM_UNIT_ROOT:-$HOME/.config/systemd/user}
mkdir -p -- "$lock_dir"
exec 9>"$lock_dir/.crm-deploy.lock"
if ! flock --nonblock 9; then
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=deployment_in_progress' >&2
  exit 1
fi
exec "$NODE" --input-type=module - <<'NODE'
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { parseEnv } from "node:util";

const target = process.env.CRM_TARGET_SHA;
const masterPin = "1cf5388202c01ce6ddaf2796cbefc10c47e0e4bf";
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
const procRoot = process.env.CRM_PROC_ROOT || "/proc";
const release = join(root, `app-${target.slice(0, 8)}`);
const oldRelease = join(root, "app-e91bb512");
const services = ["core5-api", "core5-web"];
const files = services.map(unit => join(units, `${unit}.service.d/90-crm-release.conf`));
const releaseContracts = {
  target: { pages: ["http://127.0.0.1:4313/login"], nativeAuth: true },
  baseline: { pages: ["http://127.0.0.1:4313/"], nativeAuth: false },
};
let changed = false, createdRelease = false, published = false;
let backupDir, scratch, watcher, startupTimer, restoreContainer, stage = "prerequisites";
let interruptedSignal, rollingBack = false;
const children = new Map();
const terminationTimers = new Map();
const previousEnvironment = new Map();
const databaseNames = ["DATABASE_URL", "ADMIN_DATABASE_URL", "WORKSPACE_ID", "CWOS_V2_OPERATOR_WORKSPACE_ID"];
let previousDatabase;

function startChild(executable, args, options) {
  const child = spawn(executable, args, { ...options, detached: true });
  const closed = new Promise(resolve => child.once("close", resolve));
  const stopped = closed.then(async () => {
    const termination = terminationTimers.get(child);
    if (termination) {
      let groupExists = true;
      try { process.kill(-child.pid, 0); }
      catch (error) { if (error.code !== "ESRCH") throw error; groupExists = false; }
      if (groupExists) await termination.done;
      else clearTimeout(termination.timer);
      terminationTimers.delete(child);
    }
    children.delete(child);
  });
  children.set(child, stopped);
  return child;
}

function terminate(child) {
  if (!child.pid || terminationTimers.has(child)) return;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    complete();
  }, 5_000);
  terminationTimers.set(child, { timer, done });
}

function interrupt(signal) {
  if (rollingBack || published) return;
  interruptedSignal ??= signal;
  for (const child of children.keys()) terminate(child);
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
const onSighup = () => interrupt("SIGHUP");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("SIGHUP", onSighup);

function checkInterrupted() {
  if (interruptedSignal && !rollingBack) throw new Error(`interrupted_${interruptedSignal}`);
}

async function stopChildren() {
  const closed = [...children.values()];
  for (const child of children.keys()) terminate(child);
  await Promise.all(closed);
}

async function command(label, executable, args, options = {}) {
  checkInterrupted();
  stage = label;
  const child = startChild(executable, args, {
    cwd: options.cwd, env: options.env || process.env,
    stdio: [options.inputFd ?? "ignore", options.outputFd ?? "pipe", "pipe"],
  });
  const output = [];
  child.stdout?.on("data", chunk => output.push(chunk));
  // Never print child errors: DSNs, enrollment values and cookies are private.
  child.stderr.on("data", () => {});
  let failure;
  const code = await new Promise(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", resolve);
  });
  checkInterrupted();
  if (failure) throw failure;
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
  const stopped = children.get(watcher);
  if (!stopped) return;
  terminate(watcher);
  await stopped;
}

async function requireActive(label) {
  for (const unit of services) {
    await command(`${label}_${unit.replaceAll("-", "_")}`, "systemctl", ["--user", "is-active", "--quiet", unit]);
  }
}

async function runtimeEnvironment(unit, names) {
  const pid = (await command(`runtime_pid_${unit.replaceAll("-", "_")}`, "systemctl",
    ["--user", "show", unit, "--property=MainPID", "--value"])).toString().trim();
  if (!/^[1-9]\d*$/.test(pid)) throw new Error("runtime_process_unavailable");
  const environment = new Map((await readFile(join(procRoot, pid, "environ"), "utf8")).split("\0")
    .filter(value => value.includes("=")).map(value => {
      const equal = value.indexOf("=");
      return [value.slice(0, equal), value.slice(equal + 1)];
    }));
  return Object.fromEntries(names.map(name => [name, environment.get(name)]));
}

async function verifyEnvironment(unit, expected) {
  const actual = await runtimeEnvironment(unit, Object.keys(expected));
  if (Object.entries(expected).some(([name, value]) => actual[name] !== value)) {
    throw new Error("runtime_environment_mismatch");
  }
}

async function verifyWorkingDirectory(unit, expected) {
  const configured = (await command("runtime_working_directory", "systemctl",
    ["--user", "show", unit, "--property=WorkingDirectory", "--value"])).toString().trim();
  const pid = (await command("runtime_pid", "systemctl",
    ["--user", "show", unit, "--property=MainPID", "--value"])).toString().trim();
  if (!/^[1-9]\d*$/.test(pid)) throw new Error("runtime_process_unavailable");
  if (configured !== expected || await realpath(join(procRoot, pid, "cwd")) !== await realpath(expected)) {
    throw new Error("runtime_working_directory_mismatch");
  }
}

async function requireHttpReady(contract) {
  for (const endpoint of ["http://127.0.0.1:4312/health", "http://127.0.0.1:4312/ready",
    ...contract.pages]) {
    const output = (await command("health", "curl", ["--silent", "--show-error", "--max-time", "10",
      "--retry", "120", "--retry-connrefused", "--retry-delay", "1", "--retry-max-time", "120",
      "--write-out", "\n%{http_code}", endpoint])).toString();
    if (!output.endsWith("\n200")) throw new Error("health_not_200");
  }
}

async function verifyIdentity(origin) {
  for (const [path, expected] of [["/health", "ok"], ["/ready", "ready"]]) {
    const result = (await command("identity_probe", "curl", ["--disable", "--silent", "--show-error",
      "--proto", "=https", "--noproxy", "*", "--max-redirs", "0", "--connect-timeout", "5", "--max-time", "10",
      "--write-out", "\n%{http_code}", `${origin}${path}`])).toString();
    if (!result.endsWith("\n200")) throw new Error("identity_not_ready");
    let body;
    try { body = JSON.parse(result.slice(0, -4)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new Error("identity_not_ready"); }
    if (body?.status !== expected) throw new Error("identity_not_ready");
  }
}

function databaseIdentity(environment) {
  const profiles = Object.fromEntries(databaseNames.slice(0, 2).map(name => {
    let profile;
    try { profile = new URL(environment[name]?.trim()); }
    catch (error) { if (!(error instanceof TypeError)) throw error; throw new Error("database_profile_invalid"); }
    if (!["postgres:", "postgresql:"].includes(profile.protocol) || !profile.hostname
      || !profile.username || !profile.pathname.slice(1)
      || ["host", "hostaddr", "port", "dbname", "database", "user", "username", "service"]
        .some(key => profile.searchParams.has(key))) throw new Error("database_profile_invalid");
    return [name, { host: profile.hostname.toLowerCase(), port: profile.port || "5432",
      dbname: decodeURIComponent(profile.pathname.slice(1)), role: decodeURIComponent(profile.username) }];
  }));
  const api = profiles.DATABASE_URL, admin = profiles.ADMIN_DATABASE_URL;
  const workspace = environment.WORKSPACE_ID?.trim(), operatorWorkspace = environment.CWOS_V2_OPERATOR_WORKSPACE_ID?.trim();
  if (api.host !== admin.host || api.port !== admin.port || api.dbname !== admin.dbname
    || api.role === admin.role || !workspace || workspace !== operatorWorkspace) throw new Error("database_profile_invalid");
  return { ...profiles, WORKSPACE_ID: workspace, CWOS_V2_OPERATOR_WORKSPACE_ID: operatorWorkspace };
}

async function verifyRuntime(environments, directories, contract, expectedDatabase) {
  await requireHttpReady(contract);
  if (contract.nativeAuth) {
    const boundary = (await command("origin_probe", "curl", ["--silent", "--show-error", "--max-time", "10",
      "--write-out", "\n%{http_code}", "-H", `Origin: ${environments[1].CRM_WEB_ORIGIN}`,
      "-H", "Content-Type: application/json", "--data", "{}", "http://127.0.0.1:4313/api/self-entry"])).toString();
    if (!boundary.endsWith("\n400") || JSON.parse(boundary.slice(0, -4)).error !== "INPUT_INVALID") {
      throw new Error("web_origin_not_ready");
    }
  }
  await requireActive("active");
  for (const [index, unit] of services.entries()) {
    await verifyEnvironment(unit, environments[index]);
    await verifyWorkingDirectory(unit, directories[index]);
  }
  const actualDatabase = databaseIdentity(await runtimeEnvironment("core5-api", databaseNames));
  if (JSON.stringify(actualDatabase) !== JSON.stringify(expectedDatabase)) throw new Error("runtime_database_identity_mismatch");
}

async function writeDropin(path, data, mode) {
  const temporary = join(dirname(path), `.crm-dropin-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    const file = await open(temporary, "r+");
    try { await file.chmod(mode); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

async function rollback() {
  if (!changed) return;
  stage = "rollback";
  for (let index = 0; index < files.length; index++) {
    await writeDropin(files[index], await readFile(join(backupDir, `dropin-${index}`)),
      (await lstat(join(backupDir, `dropin-${index}`))).mode & 0o777);
  }
  await command("rollback_reload", "systemctl", ["--user", "daemon-reload"]);
  await command("rollback_restart", "systemctl", ["--user", "restart", "core5-api", "core5-web"]);
  await verifyRuntime([...previousEnvironment.values()],
    services.map((_, index) => join(oldRelease, index ? "apps/web" : "apps/api")), releaseContracts.baseline, previousDatabase);
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
  const expectedDatabase = databaseIdentity(binding);
  const oldAuthPath = parseEnv(await privateText(humanEnv)).CWOS_V2_OPERATOR_AUTH_STATE_PATH;
  const resolvedAuth = await realpath(authPath), resolvedOldAuth = await realpath(oldAuthPath);
  const authStat = await lstat(resolvedAuth), oldAuthStat = await lstat(resolvedOldAuth);
  if (resolvedAuth === resolvedOldAuth || (authStat.dev === oldAuthStat.dev && authStat.ino === oldAuthStat.ino)) {
    throw new Error("legacy_auth_state_must_be_preserved");
  }
  delete binding.CWOS_V2_OPERATOR_STEP_UP_VERIFIED; // Match the existing API drop-in.
  binding.OPERATOR_PRINCIPAL_ID = binding.CWOS_V2_OPERATOR_PRINCIPAL_ID;
  const runtimeValues = [
    { CWOS_V2_OPERATOR_AUTH_STATE_PATH: authPath },
    { CRM_WEB_ORIGIN: origin, OPERATOR_AUTH_API_BASE_URL: identityOrigin,
      OPERATOR_PRINCIPAL_ID: binding.OPERATOR_PRINCIPAL_ID },
  ];
  for (const value of [origin, identityOrigin, authPath]) {
    if (/[\r\n\0]/.test(value)) throw new Error("environment_value_rejected");
  }
  await verifyIdentity(identityOrigin);
  for (const executable of [node, pnpm, ...(slot ? [slot] : [])]) await access(executable);
  const revision = (await command("source_pin", "git", ["-C", repo, "rev-parse", `${target}^{commit}`])).toString().trim();
  if (revision !== target) throw new Error("source_pin_mismatch");
  await command("target_ancestor", "git", ["-C", repo, "merge-base", "--is-ancestor", masterPin, target]);
  await command("baseline_ancestor", "git", ["-C", repo, "merge-base", "--is-ancestor", baseline, target]);
  await command("sql_delta", "git", ["-C", repo, "diff", "--exit-code", baseline, target, "--",
    "packages/persistence/migrations", "apps/api/migrations", "scripts/migrations"]);
  for (const [index, unit] of ["core5-api", "core5-web"].entries()) {
    const current = (await command("baseline_unit", "systemctl", ["--user", "show", unit,
      "--property=WorkingDirectory", "--value"])).toString().trim();
    if (current !== join(oldRelease, index ? "apps/web" : "apps/api")) throw new Error("baseline_changed");
    const text = await readFile(files[index], "utf8");
    if (!/^WorkingDirectory=.*app-e91bb512\/apps\/(api|web)$/m.test(text)) throw new Error("dropin_changed");
    previousEnvironment.set(unit, await runtimeEnvironment(unit, Object.keys(runtimeValues[index])));
  }
  previousDatabase = databaseIdentity(await runtimeEnvironment("core5-api", databaseNames));
  try { await lstat(release); throw new Error("immutable_release_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  scratch = await mkdtemp(join(root, `.prepare-${target.slice(0, 8)}-`));
  await chmod(scratch, 0o700);
  const archive = await command("archive", "git", ["-C", repo, "archive", target]);
  const tar = join(scratch, "source.tar");
  await writeFile(tar, archive, { flag: "wx", mode: 0o600 });
  await mkdir(release, { mode: 0o700 });
  createdRelease = true;
  await command("extract", "tar", ["-xf", tar, "-C", release]);
  await mkdir(join(root, "backups"), { recursive: true, mode: 0o700 });
  backupDir = await mkdtemp(join(root, "backups", `pre-${target.slice(0, 8)}-`));
  await chmod(backupDir, 0o700);
  const database = new URL(binding.ADMIN_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("database_profile_invalid");
  const pgEnv = { ...process.env, PGHOST: expectedDatabase.ADMIN_DATABASE_URL.host, PGPORT: expectedDatabase.ADMIN_DATABASE_URL.port,
    PGDATABASE: expectedDatabase.ADMIN_DATABASE_URL.dbname, PGUSER: expectedDatabase.ADMIN_DATABASE_URL.role,
    PGPASSWORD: decodeURIComponent(database.password), PGSSLMODE: database.searchParams.get("sslmode") || "prefer" };
  const image = process.env.CRM_PG_IMAGE || "postgres:16";
  const dumpPath = join(backupDir, `crm-before-${target.slice(0, 8)}.dump`);
  const dump = await open(dumpPath, "wx", 0o600);
  try {
    await command("pg_dump", "docker", ["run", "--rm", "--network=host",
      ...["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE"].flatMap(key => ["--env", key]),
      image, "pg_dump", "--format=custom", "--no-owner"], { env: pgEnv, outputFd: dump.fd });
  } finally { await dump.close(); }
  const input = await open(dumpPath, "r");
  try {
    const { size } = await input.stat();
    if (!size) throw new Error("empty_dump");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(dumpPath)) {
      checkInterrupted();
      hash.update(chunk);
    }
    await command("dump_catalog", "docker", ["run", "--rm", "-i", image, "pg_restore", "--list"],
      { inputFd: input.fd, outputFd: "ignore" });
    const rolesPath = join(backupDir, "restore-roles.sql");
    const roles = await open(rolesPath, "wx", 0o600);
    try {
      await command("backup_roles", "docker", ["run", "--rm", "--network=host",
        ...["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE"].flatMap(key => ["--env", key]),
        image, "pg_dumpall", "--roles-only", "--no-role-passwords"], { env: pgEnv, outputFd: roles.fd });
    } finally { await roles.close(); }
    const restoreId = randomUUID().replaceAll("-", "");
    restoreContainer = `crm-restore-${restoreId}`;
    const restoreInput = await open(dumpPath, "r");
    try {
      await command("backup_restore", "docker", ["run", "--name", restoreContainer, "--network=none", "-i",
        "--mount", `type=bind,src=${rolesPath},dst=/restore-roles.sql,readonly`, image, "bash", "-ec", `
directory=$(mktemp -d)
chown postgres:postgres "$directory"
trap 'gosu postgres pg_ctl -D "$directory/data" -m immediate -w stop; rm -rf "$directory"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
gosu postgres initdb -D "$directory/data" -U "$1" -A trust --no-locale --encoding=UTF8
gosu postgres pg_ctl -D "$directory/data" -l "$directory/server.log" -o "-c listen_addresses='' -k $directory" -w start
gosu postgres psql -h "$directory" -U "$1" -d postgres -v ON_ERROR_STOP=1 < /restore-roles.sql
gosu postgres pg_restore -h "$directory" -U "$1" -d postgres --exit-on-error --single-transaction --no-owner
`, "restore-backup", `crm_restore_${restoreId}`], { inputFd: restoreInput.fd, outputFd: "ignore" });
    } finally { await restoreInput.close(); }
    process.stdout.write(`CRM_BACKUP_OK bytes=${size} sha256=${hash.digest("hex")}\n`);
  } finally { await input.close(); }
  // The approved baseline..target SQL delta was checked above.
  process.stdout.write("CRM_MIGRATIONS_REQUIRED=0\n");
  const publicBuildKeys = ["NEXT_PUBLIC_API_BASE_URL", "NEXT_PUBLIC_WORKSPACE_ID",
    "NEXT_PUBLIC_OPERATOR_PRINCIPAL_ID", "NEXT_PUBLIC_APPROVER_PRINCIPAL_ID"];
  const buildEnvironment = { HOME: join(scratch, "build-home"), PATH: `${dirname(node)}:${process.env.PATH}`,
    NODE_ENV: "production", CI: "1", ...Object.fromEntries(Object.entries({ ...process.env, ...binding })
      .filter(([key]) => publicBuildKeys.includes(key))) };
  await mkdir(buildEnvironment.HOME, { mode: 0o700 });
  await command("frozen_dependencies", pnpm, ["install", "--frozen-lockfile", "--prod=false"], { cwd: release, env: buildEnvironment });
  // Privileged target validation runs only after the verified pre-target backup.
  await command("target_auth_check", pnpm, ["exec", "tsx", "--eval",
    'import {parseOperatingConfig} from "./apps/api/src/ops-boot.ts"; import {FileOperatorAuthStore} from "./apps/api/src/operator-auth-store.ts"; import {selfEntryConfiguration} from "./apps/web/app/self-entry-server.ts"; const c=parseOperatingConfig(); new FileOperatorAuthStore(c.authStatePath!).read(); if(!selfEntryConfiguration().ready) throw new Error("CONFIGURATION_REQUIRED");'],
    { cwd: release, env: { ...process.env, ...binding, PATH: buildEnvironment.PATH } });
  await command("web_build", slot ? "bash" : pnpm,
    slot ? [slot, pnpm, "--filter", "@ai-crm/web", "build"] : ["--filter", "@ai-crm/web", "build"],
    { cwd: release, env: buildEnvironment });
  const prerender = JSON.parse(await readFile(join(release, "apps/web/.next/prerender-manifest.json"), "utf8"));
  if (prerender.version !== 4 || !prerender.routes || typeof prerender.routes !== "object" || Array.isArray(prerender.routes)) {
    throw new Error("runtime_manifest_invalid");
  }
  if (["/", "/work", "/pilot", "/approvals", "/monitor", "/v2"].some(route => Object.hasOwn(prerender.routes, route))) {
    throw new Error("runtime_page_prerendered");
  }
  for (let index = 0; index < files.length; index++) {
    await copyFile(files[index], join(backupDir, `dropin-${index}`));
    await chmod(join(backupDir, `dropin-${index}`), (await lstat(files[index])).mode & 0o777);
  }
  const runtimeFiles = services.map(unit => join(release, `${unit}.env`));
  for (const [index, path] of runtimeFiles.entries()) {
    const text = Object.entries(runtimeValues[index]).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n";
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  }
  checkInterrupted();
  changed = true; // Arm rollback before the first unit file change.
  for (const [index, file] of files.entries()) {
    checkInterrupted();
    let text = (await readFile(file, "utf8")).replace(/^WorkingDirectory=.*$/m,
      `WorkingDirectory=${JSON.stringify(join(release, index ? "apps/web" : "apps/api"))}`);
    // EnvironmentFile values override Environment=; the final file must win.
    if (!text.endsWith("\n")) text += "\n";
    text += `EnvironmentFile=${JSON.stringify(runtimeFiles[index])}\n`;
    await writeDropin(file, text, (await lstat(file)).mode & 0o777);
    checkInterrupted();
  }
  await command("reload", "systemctl", ["--user", "daemon-reload"]);
  const since = `@${Math.floor(Date.now() / 1000)}`;
  watcher = startChild("journalctl", ["--user", "-u", "core5-api", "-u", "core5-web", "--since", since, "-f", "-o", "cat"],
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
  await verifyRuntime(runtimeValues,
    services.map((_, index) => join(release, index ? "apps/web" : "apps/api")), releaseContracts.target, expectedDatabase);
  checkInterrupted();
  changed = false;
  published = true;
  process.stdout.write(`CRM_1CF5_LIVE release=app-${target.slice(0, 8)} rollback=app-e91bb512 backup=${dumpPath}\n`);
}

try {
  await main();
} catch (error) {
  const failedStage = stage;
  const safeReason = /^(operator_approval_required|production_https_origins_required|owner_enrollment_required|new_bcrypt_enrollment_required|legacy_auth_state_must_be_preserved|environment_value_rejected|source_pin_mismatch|baseline_changed|dropin_changed|immutable_release_exists|private_file_required|database_profile_invalid|empty_dump|startup_timeout|startup_watch_ended|health_not_200|web_origin_not_ready|runtime_process_unavailable|runtime_environment_mismatch|runtime_working_directory_mismatch|runtime_manifest_invalid|runtime_page_prerendered|node22_required|[a-z0-9_]+_exit_(\d+|null))$/;
  const reason = interruptedSignal ? `interrupted_${interruptedSignal}`
    : typeof error?.message === "string" && (safeReason.test(error.message)
      || ["identity_not_ready", "runtime_database_identity_mismatch"].includes(error.message))
      ? error.message : "private_input_or_io_rejected";
  rollingBack = true;
  clearTimeout(startupTimer);
  await stopChildren();
  try { await rollback(); }
  catch { process.stderr.write("ROLLBACK_INCOMPLETE operator_action_required\nCRM_ROLLBACK_FAILED operator_action_required\n"); }
  process.stderr.write(`CRM_DEPLOY_REFUSED_OR_FAILED stage=${failedStage} reason=${reason}\n`);
  process.exitCode = interruptedSignal === "SIGHUP" ? 129 : interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : 1;
} finally {
  clearTimeout(startupTimer);
  await stopChildren();
  for (const cleanup of [
    async () => {
      if (!restoreContainer) return;
      const existing = (await command("restore_cleanup_exists", "docker",
        ["container", "ls", "--all", "--filter", `name=^/${restoreContainer}$`, "--format", "{{.Names}}"])).toString().trim();
      if (existing === restoreContainer) {
        await command("restore_cleanup", "docker", ["rm", "--force", "--volumes", restoreContainer]);
      }
    },
    async () => { if (scratch) await rm(scratch, { recursive: true }); },
    async () => { if (createdRelease && !published && !changed) await rm(release, { recursive: true }); },
  ]) {
    try { await cleanup(); }
    catch {
      process.stderr.write("CRM_CLEANUP_FAILED operator_action_required\n");
      process.exitCode ||= 1;
    }
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
}
NODE
