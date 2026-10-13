import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { configuration, saveState } from "./command.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const commands = fileURLToPath(new URL("./command.mjs", import.meta.url));
const hooks = fileURLToPath(new URL("./hooks.mjs", import.meta.url));
export const readText = path => readFileSync(path, "utf8");
export const readJson = path => JSON.parse(readText(path));
export const exists = existsSync;

export async function withDeployment(options, inspect) {
  const root = mkdtempSync(join(tmpdir(), "crm-deploy-test-"));
  const target = options.target ?? "1cf5388202c01ce6ddaf2796cbefc10c47e0e4bf";
  const node = options.deployNode ?? process.env.CRM_DEPLOY_TEST_NODE ?? process.execPath;
  const units = options.units ?? ["core5-api", "core5-web"];
  const release = join(root, "state", `app-${target.slice(0, 8)}`);
  const oldAuth = join(root, "legacy.json");
  const newAuth = join(root, "new owner.json");
  const appEnv = join(root, "app.env");
  const humanEnv = join(root, "human.env");
  const dropins = units.map(unit => join(root, "units", `${unit}.service.d`,
    unit === "core5-review-ui" ? "92-crm-release.conf" : "90-crm-release.conf"));
  const fixture = { ...options, target, units, release, oldAuth, newAuth, apiDropin: dropins[0],
    dumpBytes: options.dumpBytes ?? 1024 * 1024 };
  const processes = [];
  let subscription;
  const terminate = pid => {
    try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const launch = (executable, args, env) => {
    const child = spawn(executable, args, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env });
    processes.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const outcome = new Promise((accept, reject) => {
      const deadline = setTimeout(() => { terminate(child.pid); reject(new Error("deployment fixture deadline")); }, 30_000);
      child.once("error", error => { clearTimeout(deadline); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(deadline); accept({ code, signal, stdout, stderr }); });
    });
    return { child, outcome };
  };
  try {
    mkdirSync(join(root, "state"));
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, "source/apps/web/app"), { recursive: true });
    mkdirSync(join(root, "source/apps/api"), { recursive: true });
    writeFileSync(join(root, "source/apps/web/app/page.tsx"), "export const CRM_REVIEW_UI = true;\n");
    writeFileSync(appEnv, "ADMIN_DATABASE_URL=postgresql://fixture@127.0.0.1/fixture\nCRM_WEB_ORIGIN=https://old.invalid\n", { mode: 0o600 });
    writeFileSync(humanEnv, `CWOS_V2_OPERATOR_AUTH_STATE_PATH=${JSON.stringify(oldAuth)}\nCWOS_V2_OPERATOR_PRINCIPAL_ID=fixture\n`, { mode: 0o600 });
    writeFileSync(newAuth, JSON.stringify({ enrolled: true, totpPending: false, passwordHash: "$2b$12$" + ".".repeat(53) }), { mode: 0o600 });
    const originals = {};
    for (const [index, unit] of units.entries()) {
      mkdirSync(join(root, "units", `${unit}.service.d`), { recursive: true });
      const cwd = unit === "core5-review-ui" ? join(root, "legacy-review")
        : join(root, "state/app-e91bb512/apps", index ? "web" : "api");
      writeFileSync(join(root, "units", `${unit}.service`),
        `[Service]\nWorkingDirectory=${cwd}\nEnvironmentFile=${appEnv}\nExecStart=${node} review-server.mjs\n`);
      if (unit !== "core5-review-ui") {
        const environment = unit === "core5-web" && options.webEnvironment
          ? options.webEnvironment : "Environment=API_BASE_URL=http://127.0.0.1:4312\nEnvironment=OPERATOR_PRINCIPAL_ID=fixture";
        originals[unit] = `[Service]\nWorkingDirectory=${cwd}\nEnvironmentFile=${humanEnv}\n${environment}${options.noFinalNewline ? "" : "\n"}`;
        writeFileSync(dropins[index], originals[unit], { mode: 0o640 });
      }
    }
    writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture));
    const state = { generation: 0, reloads: 0, units: {} };
    for (const [index, unit] of units.entries()) {
      const pid = 1000 + index;
      const environment = configuration(root, unit).environment;
      state.units[unit] = { pid, active: true, environment };
      mkdirSync(join(root, "proc", String(pid)), { recursive: true });
      writeFileSync(join(root, "proc", String(pid), "environ"),
        Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\0") + "\0");
    }
    saveState(root, state);
    for (const name of ["git", "systemctl", "journalctl", "docker", "curl", "pnpm"]) {
      writeFileSync(join(root, "bin", name),
        `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(commands)} ${name} "$@"\n`, { mode: 0o755 });
    }
    const humanBefore = readText(humanEnv), ownerBefore = readText(newAuth);
    const env = { HOME: root, PATH: `${root}/bin:/usr/bin:/bin`, NODE_OPTIONS: `--import=${hooks}`,
        CRM_TEST_ROOT: root, CRM_DEPLOY_APPROVAL: "approved", CRM_TARGET_SHA: target,
        CRM_NODE_BIN: node, CRM_PNPM_BIN: join(root, "bin/pnpm"),
        CRM_REPO_ROOT: join(root, "source"), CRM_STATE_ROOT: join(root, "state"), CRM_UNIT_ROOT: join(root, "units"),
        CRM_PROC_ROOT: join(root, "proc"), CRM_LEGACY_REVIEW_ROOT: join(root, "legacy-review"),
        CRM_APP_ENV: appEnv, CRM_HUMAN_ENV: humanEnv,
        CWOS_V2_OPERATOR_AUTH_STATE_PATH: newAuth,
        CRM_WEB_ORIGIN: "https://web.invalid", CRM_REVIEW_WEB_ORIGIN: "https://review.invalid",
        OPERATOR_AUTH_API_BASE_URL: "https://identity.invalid" };
    const held = options.contend ? new Promise(resolve => {
      subscription = watch(root, (_, file) => {
        if (file === "dump-held") { subscription.close(); resolve(); }
      });
    }) : null;
    const script = resolve(repo, options.script ?? "deploy/crm-deploy-master.sh");
    const primary = launch("bash", [script], env);
    let contender, lockHeld;
    const lock = join(root, "units/.crm-deploy.lock");
    if (options.contend) {
      await Promise.race([held, primary.outcome.then(result => {
        throw new Error(`primary stopped before concurrency checkpoint: ${result.code} ${result.stderr}`);
      })]);
      lockHeld = (await launch("flock", ["--nonblock", lock, "true"], env).outcome).code === 1;
      try {
        contender = await launch("bash", [resolve(repo, options.contenderScript ?? script)],
          { ...env, CRM_TEST_CONTENDER: "1", CRM_TARGET_SHA: options.contenderTarget ?? target }).outcome;
      } finally { writeFileSync(join(root, "dump-release"), "continue"); }
    }
    const outcome = await primary.outcome;
    const lockReleased = options.contend
      ? (await launch("flock", ["--nonblock", lock, "true"], env).outcome).code === 0 : undefined;
    const events = readdirSync(root).filter(name => name.startsWith("event-")).map(name => readJson(join(root, name)));
    const usageFile = join(root, `usage-${primary.child.pid}.json`);
    const liveOwnedProcesses = readdirSync(root).filter(name => name.startsWith("child-")).filter(name => {
      try { process.kill(-Number(name.slice(6)), 0); return true; }
      catch (error) { if (error.code !== "ESRCH") throw error; return false; }
    }).length;
    const expectedHash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let remaining = fixture.dumpBytes; remaining > 0; remaining -= chunk.length) {
      expectedHash.update(chunk.subarray(0, Math.min(remaining, chunk.length)));
    }
    await inspect({ ...outcome, root, release, dropins, units, originals, events,
      contender, lockHeld, lockReleased, liveOwnedProcesses,
      oldAuth, newAuth, humanEnv, humanBefore, ownerBefore,
      state: readJson(join(root, "state.json")),
      usage: existsSync(usageFile) ? readJson(usageFile) : null,
      expectedHash: expectedHash.digest("hex"), configuration: unit => configuration(root, unit) });
  } finally {
    subscription?.close();
    for (const child of processes) if (child.pid) terminate(child.pid);
    for (const file of readdirSync(root).filter(name => name.startsWith("child-"))) {
      terminate(Number(file.slice(6)));
    }
    rmSync(root, { recursive: true, force: true });
  }
}
