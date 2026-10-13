#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Preparation artifact; no activation without separate operator approval.' \
    'Required: CRM_DEPLOY_APPROVAL=approved CRM_TARGET_SHA=<full40>' \
    'CRM_WEB_ORIGIN=https://<approved-origin> CRM_REVIEW_WEB_ORIGIN=https://<approved-review-origin>' \
    'OPERATOR_AUTH_API_BASE_URL=https://<approved-private-identity-origin>' \
    'CWOS_V2_OPERATOR_AUTH_STATE_PATH=<new owner-enrolled bcrypt state>' \
    'Optional: CRM_REPO_ROOT CRM_STATE_ROOT CRM_UNIT_ROOT CRM_APP_ENV CRM_HUMAN_ENV' \
    'CRM_NODE_BIN CRM_PNPM_BIN CRM_BUILD_SLOT CRM_PG_IMAGE CRM_LEGACY_REVIEW_ROOT CRM_PROC_ROOT'
  exit 0
fi
[[ $# == 0 ]] || { printf '%s\n' 'CRM_ARGUMENTS_REJECTED' >&2; exit 64; }
if [[ ${CRM_DEPLOY_APPROVAL:-} != approved ]]; then
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=operator_approval_required' >&2
  exit 1
fi
if [[ ! ${CRM_TARGET_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=target_sha_required' >&2
  exit 1
fi
NODE=${CRM_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.2/bin/node}
if [[ ! -x $NODE ]]; then
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=node22_required' >&2
  exit 1
fi
node_version=$("$NODE" -p 'process.versions.node') || {
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=node22_required' >&2
  exit 1
}
[[ $node_version == 22.* ]] || {
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=node22_required' >&2
  exit 1
}
# Share the unit lock with crm-deploy-master.sh through rollback and cleanup.
lock_dir=${CRM_UNIT_ROOT:-$HOME/.config/systemd/user}
mkdir -p -- "$lock_dir"
exec 9>"$lock_dir/.crm-deploy.lock"
if ! flock --nonblock 9; then
  printf '%s\n' 'CRM_DEPLOY_REFUSED_OR_FAILED stage=prerequisites reason=deployment_in_progress' >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export CRM_SCRIPT_REPO_DEFAULT=$(cd -- "$script_dir/.." && pwd)
exec "$NODE" --input-type=module - <<'NODE'
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { parseEnv } from "node:util";

const target = process.env.CRM_TARGET_SHA;
const baseline = "e91bb512a2783918fd0c8b84c9e91660df348d96";
const masterPin = "1cf5388202c01ce6ddaf2796cbefc10c47e0e4bf";
const home = process.env.HOME;
const root = process.env.CRM_STATE_ROOT || join(home, ".local/share/core5");
const repo = process.env.CRM_REPO_ROOT || process.env.CRM_SCRIPT_REPO_DEFAULT;
const units = process.env.CRM_UNIT_ROOT || join(home, ".config/systemd/user");
const node = process.env.CRM_NODE_BIN || join(home, ".nvm/versions/node/v22.23.2/bin/node");
const pnpm = process.env.CRM_PNPM_BIN || join(dirname(node), "pnpm");
const slot = process.env.CRM_BUILD_SLOT || "";
const appEnv = process.env.CRM_APP_ENV || join(home, ".config/core5/app.env");
const humanEnv = process.env.CRM_HUMAN_ENV || join(home, ".config/core5/crm/blro-human.env");
const procRoot = process.env.CRM_PROC_ROOT || "/proc";
const legacyReview = process.env.CRM_LEGACY_REVIEW_ROOT || join(home, "orca/projects/shipping-harness/ci/core5");
const release = join(root, `app-${target.slice(0, 8)}`);
const reviewEntry = join(release, "apps/web/node_modules/next/dist/bin/next");
const reviewCommand = [node, reviewEntry, "start", "-H", "127.0.0.1", "-p", "4174"];
const oldRelease = join(root, "app-e91bb512");
const apiDropin = join(units, "core5-api.service.d/90-crm-release.conf");
const webDropin = join(units, "core5-web.service.d/90-crm-release.conf");
const reviewDropin = join(units, "core5-review-ui.service.d/92-crm-release.conf");
const reviewMigrate = join(units, "core5-review-ui.service.d/91-migrate.conf");
const services = ["core5-api", "core5-web", "core5-review-ui"];
const snapshots = [
  { name: "api90", path: apiDropin, required: true },
  { name: "web90", path: webDropin, required: true },
  { name: "review92", path: reviewDropin, required: false },
];
const foreignOrigin = "https://crm-origin-rejected.invalid";
let changed = false, createdRelease = false, published = false, rollbackFailed = false;
let backupDir, scratch, startupTimer, migrateHash, previousReviewExecution, restoreContainer, stage = "prerequisites";
const watchers = [];
const previousEnvironment = new Map();
let interruptedSignal, rollingBack = false;
const children = new Map();
const terminationTimers = new Map();

function startChild(executable, args, options) {
  const child = spawn(executable, args, { ...options, detached: true });
  const closed = new Promise(resolve => child.once("close", resolve));
  children.set(child, closed);
  void closed.then(() => {
    clearTimeout(terminationTimers.get(child));
    terminationTimers.delete(child);
    children.delete(child);
  });
  return child;
}

function terminate(child) {
  if (!child.pid || terminationTimers.has(child)) return;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  terminationTimers.set(child, setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }, 5_000));
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

function httpsOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

async function httpResult(url, args = []) {
  const output = (await command("health", "curl", ["--silent", "--show-error", "--max-time", "10",
    "--write-out", "\n%{http_code}", ...args, url])).toString();
  const nl = output.lastIndexOf("\n");
  return { body: output.slice(0, nl), status: output.slice(nl + 1) };
}

function errorCode(body, status, expectedStatus, expectedError, reason) {
  if (status !== expectedStatus) throw new Error(reason);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error(reason); }
  if (parsed.error !== expectedError) throw new Error(reason);
}

async function stopWatchers() {
  await Promise.all(watchers.map(async watcher => {
    if (watcher.exitCode !== null || watcher.signalCode !== null) return;
    const closed = new Promise(resolve => watcher.once("close", resolve));
    terminate(watcher);
    await closed;
  }));
}

async function restoreSnapshot(item) {
  const meta = await readFile(join(backupDir, `${item.name}.meta`), "utf8");
  if (meta.startsWith("absent")) {
    await rm(item.path, { force: true });
    return;
  }
  const mode = Number.parseInt(meta, 8);
  await copyFile(join(backupDir, item.name), item.path);
  await chmod(item.path, mode);
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

async function requireHttpReady() {
  for (const endpoint of ["http://127.0.0.1:4312/health", "http://127.0.0.1:4312/ready",
    "http://127.0.0.1:4313/login", "http://127.0.0.1:4174/login"]) {
    if ((await httpResult(endpoint, ["--retry", "120", "--retry-connrefused",
      "--retry-delay", "1", "--retry-max-time", "120"])).status !== "200") throw new Error("health_not_200");
  }
}

function executionSpec(value) {
  const match = /^\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=/.exec(value.trim());
  if (!match) throw new Error("runtime_execution_mismatch");
  return `${match[1]}\n${match[2]}`;
}

async function verifyReviewExecution(expected) {
  const actual = (await command("runtime_review_exec", "systemctl",
    ["--user", "show", "core5-review-ui", "--property=ExecStart", "--value"])).toString();
  if (executionSpec(actual) !== expected) throw new Error("runtime_execution_mismatch");
}

async function verifyRuntime(environments, directories, execution) {
  await requireHttpReady();
  for (const [port, index] of [[4313, 1], [4174, 2]]) {
    const allowed = environments[index].CRM_WEB_ORIGIN;
    const invalid = await httpResult(`http://127.0.0.1:${port}/api/self-entry`, ["-H", `Origin: ${allowed}`,
      "-H", "Content-Type: application/json", "--data", "{}"]);
    errorCode(invalid.body, invalid.status, "400", "INPUT_INVALID", "web_origin_not_ready");
    const denied = await httpResult(`http://127.0.0.1:${port}/api/self-entry`, ["-H", `Origin: ${foreignOrigin}`,
      "-H", "Content-Type: application/json", "--data", "{}"]);
    errorCode(denied.body, denied.status, "403", "ORIGIN_DENIED", "origin_rejection_failed");
    const reviewUnauth = await httpResult(`http://127.0.0.1:${port}/api/cwos/v2/mail-candidate-review`,
      ["-H", `Origin: ${allowed}`]);
    errorCode(reviewUnauth.body, reviewUnauth.status, "401", "STEP_UP_REQUIRED", "candidate_api_not_401");
  }
  const candidate = await httpResult("http://127.0.0.1:4312/api/cwos/v2/mail-candidate-review");
  if (candidate.status !== "401") throw new Error("candidate_api_not_401");

  await requireActive("active");
  for (const [index, unit] of services.entries()) {
    await verifyEnvironment(unit, environments[index]);
    await verifyWorkingDirectory(unit, directories[index]);
  }
  await verifyReviewExecution(execution);
}

async function rollback() {
  if (!changed) return;
  stage = "rollback";
  for (const item of snapshots) await restoreSnapshot(item);
  await command("rollback_reload", "systemctl", ["--user", "daemon-reload"]);
  await command("rollback_restart", "systemctl", ["--user", "restart", "core5-api", "core5-web", "core5-review-ui"]);
  await verifyRuntime([...previousEnvironment.values()],
    services.map((_, index) => index === 2 ? legacyReview : join(oldRelease, index ? "apps/web" : "apps/api")),
    previousReviewExecution);
  changed = false;
  process.stderr.write("CRM_ROLLBACK_OK release=app-e91bb512\n");
}

async function markRollbackFailed() {
  rollbackFailed = true;
  process.stderr.write("ROLLBACK_INCOMPLETE operator_action_required\nCRM_ROLLBACK_FAILED operator_action_required\n");
  const marker = join(root, "CRM_ROLLBACK_FAILED");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(marker, "CRM_ROLLBACK_FAILED operator_action_required\n", { mode: 0o600 });
}

function watchUnit(unit, pattern) {
  let pending = "";
  let matched = false;
  const child = startChild("journalctl", ["--user", "-u", unit, "--since", `@${Math.floor(Date.now() / 1000)}`,
    "-f", "-o", "json"], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  watchers.push(child);
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => { if (!matched) reject(new Error("startup_watch_ended")); });
    child.stdout.on("data", chunk => {
      pending = (pending + chunk.toString("utf8")).slice(-16384);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const owner = record._SYSTEMD_USER_UNIT;
        if (owner && owner !== `${unit}.service`) continue;
        const message = typeof record.MESSAGE === "string" ? record.MESSAGE : "";
        if (pattern.test(message)) { matched = true; resolve(); }
      }
    });
  });
  return { spawned, ready };
}

async function main() {
  if (!process.versions.node.startsWith("22.")) throw new Error("node22_required");
  if (process.env.CRM_DEPLOY_APPROVAL !== "approved") throw new Error("operator_approval_required");
  if (!/^[0-9a-f]{40}$/.test(target ?? "")) throw new Error("target_sha_required");
  const origin = process.env.CRM_WEB_ORIGIN;
  const reviewOrigin = process.env.CRM_REVIEW_WEB_ORIGIN;
  const identityOrigin = process.env.OPERATOR_AUTH_API_BASE_URL;
  if (!httpsOrigin(origin) || !httpsOrigin(reviewOrigin) || !httpsOrigin(identityOrigin)) {
    throw new Error("production_https_origins_required");
  }
  const authPath = process.env.CWOS_V2_OPERATOR_AUTH_STATE_PATH;
  if (!authPath || /[\r\n\0]/.test(authPath)) throw new Error("owner_enrollment_required");
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
  const resolvedAuth = await realpath(authPath), resolvedOldAuth = await realpath(oldAuthPath);
  const authStat = await lstat(resolvedAuth), oldAuthStat = await lstat(resolvedOldAuth);
  if (resolvedAuth === resolvedOldAuth || (authStat.dev === oldAuthStat.dev && authStat.ino === oldAuthStat.ino)) {
    throw new Error("legacy_auth_state_must_be_preserved");
  }
  delete binding.CWOS_V2_OPERATOR_STEP_UP_VERIFIED;
  binding.OPERATOR_PRINCIPAL_ID = binding.CWOS_V2_OPERATOR_PRINCIPAL_ID;
  const runtimeValues = [
    { CWOS_V2_OPERATOR_AUTH_STATE_PATH: authPath },
    { CRM_WEB_ORIGIN: origin, OPERATOR_AUTH_API_BASE_URL: identityOrigin,
      OPERATOR_PRINCIPAL_ID: binding.OPERATOR_PRINCIPAL_ID },
    { CRM_WEB_ORIGIN: reviewOrigin, OPERATOR_AUTH_API_BASE_URL: identityOrigin,
      OPERATOR_PRINCIPAL_ID: binding.OPERATOR_PRINCIPAL_ID, CRM_REVIEW_UI: "1",
      PATH: `${dirname(node)}:/usr/bin:/bin` },
  ];
  if (/\s/.test(node) || /\s/.test(pnpm)) throw new Error("path_whitespace_rejected");
  for (const executable of [node, pnpm, ...(slot ? [slot] : [])]) await access(executable);
  let revision;
  try {
    revision = (await command("source_pin", "git", ["-C", repo, "rev-parse", `${target}^{commit}`])).toString().trim();
  } catch { throw new Error("source_pin_mismatch"); }
  if (revision !== target) throw new Error("source_pin_mismatch");
  try {
    await command("target_ancestor", "git", ["-C", repo, "merge-base", "--is-ancestor", masterPin, target]);
    await command("baseline_ancestor", "git", ["-C", repo, "merge-base", "--is-ancestor", baseline, target]);
  } catch { throw new Error("target_not_descendant"); }
  let page;
  try {
    page = (await command("target_marker", "git", ["-C", repo, "show", `${target}:apps/web/app/page.tsx`])).toString();
  } catch { throw new Error("target_marker_missing"); }
  if (!page.includes("CRM_REVIEW_UI")) throw new Error("target_marker_missing");
  try {
    await command("sql_delta", "git", ["-C", repo, "diff", "--exit-code", baseline, target, "--",
      "packages/persistence/migrations", "apps/api/migrations", "scripts/migrations"]);
  } catch (error) {
    if (String(error?.message).startsWith("sql_delta_exit_")) throw new Error("sql_delta_refused");
    throw error;
  }
  for (const [index, unit] of ["core5-api", "core5-web"].entries()) {
    const current = (await command("baseline_unit", "systemctl", ["--user", "show", unit,
      "--property=WorkingDirectory", "--value"])).toString().trim();
    if (current !== join(oldRelease, index ? "apps/web" : "apps/api")) throw new Error("baseline_changed");
    const text = await readFile(index ? webDropin : apiDropin, "utf8");
    if (!/^WorkingDirectory=.*app-e91bb512\/apps\/(api|web)$/m.test(text)) throw new Error("dropin_changed");
  }
  const reviewWd = (await command("review_baseline", "systemctl", ["--user", "show", "core5-review-ui",
    "--property=WorkingDirectory", "--value"])).toString().trim();
  const reviewExec = (await command("review_exec", "systemctl", ["--user", "show", "core5-review-ui",
    "--property=ExecStart", "--value"])).toString();
  if (reviewWd !== legacyReview || !reviewExec.includes("review-server.mjs")) throw new Error("review_baseline_changed");
  previousReviewExecution = executionSpec(reviewExec);
  try {
    const migrate = await readFile(reviewMigrate);
    migrateHash = createHash("sha256").update(migrate).digest("hex");
    const text = migrate.toString("utf8");
    if (!/^ExecStart=$/m.test(text) || !text.includes("review-server.mjs")) throw new Error("review_baseline_changed");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const webEnvironment = await runtimeEnvironment("core5-web", ["API_BASE_URL"]);
  if (!webEnvironment.API_BASE_URL) throw new Error("review_config_missing");
  // Copy a named effective value into the private file, never a raw unit line.
  runtimeValues[2].API_BASE_URL = webEnvironment.API_BASE_URL;
  for (const [index, unit] of services.entries()) {
    previousEnvironment.set(unit, await runtimeEnvironment(unit, Object.keys(runtimeValues[index])));
  }
  try { await lstat(release); throw new Error("immutable_release_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "backups"), { recursive: true, mode: 0o700 });
  scratch = await mkdtemp(join(root, `.prepare-${target.slice(0, 8)}-`));
  await chmod(scratch, 0o700);
  const archive = await command("archive", "git", ["-C", repo, "archive", target]);
  const tar = join(scratch, "source.tar");
  await writeFile(tar, archive, { flag: "wx", mode: 0o600 });
  await mkdir(release, { mode: 0o700 });
  createdRelease = true;
  await command("extract", "tar", ["-xf", tar, "-C", release]);
  backupDir = await mkdtemp(join(root, "backups", `pre-${target.slice(0, 8)}-`));
  await chmod(backupDir, 0o700);
  const database = new URL(binding.ADMIN_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("database_profile_invalid");
  const pgEnv = { ...process.env, PGHOST: database.hostname, PGPORT: database.port || "5432",
    PGDATABASE: decodeURIComponent(database.pathname.slice(1)), PGUSER: decodeURIComponent(database.username),
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
  const buildArgs = ["--filter", "@ai-crm/web", "build"];
  await command("web_build", slot ? "bash" : pnpm, slot ? [slot, pnpm, ...buildArgs] : buildArgs, { cwd: release, env: buildEnvironment });
  const prerender = JSON.parse(await readFile(join(release, "apps/web/.next/prerender-manifest.json"), "utf8"));
  if (prerender.version !== 4 || !prerender.routes || typeof prerender.routes !== "object" || Array.isArray(prerender.routes)) {
    throw new Error("runtime_manifest_invalid");
  }
  if (["/", "/work", "/pilot", "/approvals", "/monitor", "/v2"].some(route => Object.hasOwn(prerender.routes, route))) {
    throw new Error("runtime_page_prerendered");
  }
  await access(reviewEntry, constants.R_OK);
  for (const item of snapshots) {
    try {
      const stat = await lstat(item.path);
      if (!stat.isFile()) throw new Error(item.required ? "dropin_changed" : "review_baseline_changed");
      await copyFile(item.path, join(backupDir, item.name));
      const mode = stat.mode & 0o777;
      await chmod(join(backupDir, item.name), mode);
      await writeFile(join(backupDir, `${item.name}.meta`), `${mode.toString(8)}\n`, { mode: 0o600 });
    } catch (error) {
      if (error?.code === "ENOENT" && !item.required) {
        await writeFile(join(backupDir, `${item.name}.meta`), "absent\n", { mode: 0o600 });
        continue;
      }
      throw error;
    }
  }
  const runtimeFiles = services.map(unit => join(release, `${unit}.env`));
  for (const [index, path] of runtimeFiles.entries()) {
    const text = Object.entries(runtimeValues[index]).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n";
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  }
  checkInterrupted();
  changed = true;
  const reviewLines = [
    "[Service]",
    `EnvironmentFile=`,
    `EnvironmentFile=${JSON.stringify(appEnv)}`,
    `EnvironmentFile=${JSON.stringify(humanEnv)}`,
    `EnvironmentFile=${JSON.stringify(runtimeFiles[2])}`,
    `WorkingDirectory=${JSON.stringify(join(release, "apps/web"))}`,
    "ExecStart=",
    `ExecStart=${reviewCommand.map(value => JSON.stringify(value)).join(" ")}`,
    "",
  ];
  await mkdir(dirname(reviewDropin), { recursive: true, mode: 0o755 });
  for (const [index, file] of [apiDropin, webDropin].entries()) {
    checkInterrupted();
    let text = (await readFile(file, "utf8")).replace(/^WorkingDirectory=.*$/m,
      `WorkingDirectory=${JSON.stringify(join(release, index ? "apps/web" : "apps/api"))}`);
    if (!text.endsWith("\n")) text += "\n";
    text += `EnvironmentFile=${JSON.stringify(runtimeFiles[index])}\n`;
    await writeFile(file, text, { mode: (await lstat(file)).mode & 0o777 });
    checkInterrupted();
  }
  await writeFile(reviewDropin, reviewLines.join("\n"), { mode: 0o644 });
  await chmod(reviewDropin, 0o644);
  checkInterrupted();
  if (migrateHash) {
    const again = createHash("sha256").update(await readFile(reviewMigrate)).digest("hex");
    if (again !== migrateHash) throw new Error("review_baseline_changed");
  }
  await command("reload", "systemctl", ["--user", "daemon-reload"]);
  const plans = [
    watchUnit("core5-api", /core5 api listening/),
    watchUnit("core5-web", /Ready in/),
    watchUnit("core5-review-ui", /Ready in/),
  ];
  const timeout = new Promise((_, reject) => {
    startupTimer = setTimeout(() => reject(new Error("startup_timeout")), 120_000);
  });
  const readyAll = Promise.all(plans.map(plan => plan.ready));
  await Promise.all([Promise.race([readyAll, timeout]),
    Promise.all(plans.map(plan => plan.spawned)).then(() =>
      command("restart", "systemctl", ["--user", "restart", "core5-api", "core5-web", "core5-review-ui"]))]);
  clearTimeout(startupTimer);
  await stopWatchers();
  await verifyRuntime(runtimeValues,
    services.map((_, index) => join(release, index ? "apps/web" : "apps/api")),
    `${node}\n${reviewCommand.join(" ")}`);
  checkInterrupted();
  changed = false;
  published = true;
  process.stdout.write(`CRM_REVIEW_UI_LIVE release=app-${target.slice(0, 8)} rollback=app-e91bb512 review=127.0.0.1:4174 backup=${dumpPath}\n`);
}

try {
  await main();
} catch (error) {
  const failedStage = stage;
  const safeReason = /^(operator_approval_required|production_https_origins_required|owner_enrollment_required|new_bcrypt_enrollment_required|legacy_auth_state_must_be_preserved|environment_value_rejected|source_pin_mismatch|target_sha_required|target_marker_missing|target_not_descendant|sql_delta_refused|baseline_changed|dropin_changed|review_baseline_changed|review_config_missing|immutable_release_exists|private_file_required|database_profile_invalid|empty_dump|startup_timeout|startup_watch_ended|health_not_200|web_origin_not_ready|origin_rejection_failed|candidate_api_not_401|runtime_process_unavailable|runtime_environment_mismatch|runtime_working_directory_mismatch|runtime_execution_mismatch|runtime_manifest_invalid|runtime_page_prerendered|path_whitespace_rejected|node22_required|[a-z0-9_]+_exit_(\d+|null))$/;
  const reason = interruptedSignal ? `interrupted_${interruptedSignal}`
    : typeof error?.message === "string" && safeReason.test(error.message) ? error.message : "private_input_or_io_rejected";
  rollingBack = true;
  clearTimeout(startupTimer);
  await stopChildren();
  try { await rollback(); }
  catch { try { await markRollbackFailed(); } catch { process.stderr.write("ROLLBACK_INCOMPLETE operator_action_required\nCRM_ROLLBACK_FAILED operator_action_required\n"); } }
  process.stderr.write(`CRM_DEPLOY_REFUSED_OR_FAILED stage=${failedStage} reason=${reason}\n`);
  process.exitCode = interruptedSignal === "SIGHUP" ? 129 : interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : 1;
} finally {
  clearTimeout(startupTimer);
  await stopChildren();
  try {
    if (restoreContainer) await command("restore_cleanup", "docker", ["rm", "--force", "--volumes", restoreContainer]);
    if (scratch) await rm(scratch, { recursive: true });
    if (createdRelease && !published && !changed && !rollbackFailed) await rm(release, { recursive: true });
  } catch {
    process.stderr.write("CRM_CLEANUP_FAILED operator_action_required\n");
    process.exitCode = 1;
  }
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
}
NODE
