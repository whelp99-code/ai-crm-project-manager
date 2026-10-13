import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const decode = value => value.startsWith('"') ? JSON.parse(value) : value;
export function configuration(root, unit) {
  const directory = join(root, "units", `${unit}.service.d`);
  const paths = [join(root, "units", `${unit}.service`),
    ...readdirSync(directory).sort().map(name => join(directory, name))];
  let cwd = "", exec = "";
  let envFiles = [];
  const direct = {};
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.startsWith("WorkingDirectory=")) cwd = decode(line.slice(17));
      if (line.startsWith("ExecStart=")) exec = line.slice(10);
      if (line.startsWith("EnvironmentFile=")) {
        const value = line.slice(16);
        if (!value) envFiles = [];
        else envFiles.push(decode(value));
      }
      if (line.startsWith("Environment=")) {
        const value = decode(line.slice(12));
        const equal = value.indexOf("=");
        if (equal >= 0) direct[value.slice(0, equal)] = value.slice(equal + 1);
      }
    }
  }
  // systemd applies EnvironmentFile values after Environment assignments,
  // regardless of where those assignments appeared in the unit text.
  const environment = { ...direct };
  for (const path of envFiles) Object.assign(environment, parseEnv(readFileSync(path, "utf8")));
  return { cwd, exec, envFiles, environment };
}

export function saveState(root, state) {
  const temporary = join(root, `state-${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, join(root, "state.json"));
}

async function main() {
  const root = process.env.CRM_TEST_ROOT;
  if (!root?.startsWith("/tmp/crm-deploy-test-")) throw new Error("sandbox required");
  const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
  const [name, ...args] = process.argv.slice(2);
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  writeFileSync(join(root, `child-${process.pid}`), name);
  const event = value => {
    const file = join(root, `event-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(value));
  };
  if (name === "pnpm") return 0;
  if (name === "systemctl") {
    const selected = args.filter(arg => arg.startsWith("core5-")).map(arg => arg.replace(/\.service$/, ""));
    event({ name, args });
    if (args.includes("show")) {
      const unit = selected[0];
      const config = configuration(root, unit);
      if (args.includes("--property=WorkingDirectory")) process.stdout.write(config.cwd + "\n");
      else if (args.includes("--property=ExecStart")) process.stdout.write(config.exec + "\n");
      else if (args.includes("--property=MainPID")) process.stdout.write(String(state.units[unit].pid) + "\n");
      else throw new Error("unexpected show property");
      return 0;
    }
    if (args.includes("is-active")) {
      // Deliberately preserve the real ANY-active group behavior.
      return selected.some(unit => state.units[unit].active) ? 0 : 3;
    }
    if (args.includes("daemon-reload")) {
      state.reloads++;
      saveState(root, state);
      return fixture.failReload && state.reloads === 1 ? 23 : 0;
    }
    if (args.includes("restart")) {
      state.generation++;
      for (const [index, unit] of fixture.units.entries()) {
        if (!selected.includes(unit)) continue;
        const config = configuration(root, unit);
        const deployed = config.cwd.includes(fixture.release);
        const environment = { ...config.environment };
        if (deployed && fixture.staleAuth && unit === "core5-api") {
          environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH = fixture.oldAuth;
        }
        if (deployed && fixture.staleReview && unit === "core5-review-ui") {
          environment.CRM_WEB_ORIGIN = "https://old.invalid";
        }
        const dead = fixture.deadUnit === unit && fixture.deadPhase === (deployed ? "deploy" : "rollback");
        const pid = dead ? 0 : 1000 + state.generation * 10 + index;
        state.units[unit] = { active: !dead, pid, environment };
        if (pid) {
          mkdirSync(join(root, "proc", String(pid)), { recursive: true });
          writeFileSync(join(root, "proc", String(pid), "environ"),
            Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\0") + "\0");
        }
      }
      saveState(root, state);
      const deployed = configuration(root, "core5-api").cwd.includes(fixture.release);
      if (fixture.signalAt === "restart" && deployed && !existsSync(join(root, "signal-sent"))) {
        writeFileSync(join(root, "signal-sent"), fixture.signal);
        const keepAlive = watch(root, () => {});
        process.once("SIGTERM", () => {
          writeFileSync(join(root, "interrupted-child-closed"), "closed");
          keepAlive.close();
          process.exit(0);
        });
        process.kill(process.ppid, fixture.signal);
        return new Promise(() => {});
      }
      if (!deployed && fixture.repeatSignal && existsSync(join(root, "signal-sent"))) {
        writeFileSync(join(root, "rollback-signal-sent"), fixture.signal);
        process.kill(process.ppid, fixture.signal);
      }
      return 0;
    }
    throw new Error("unexpected systemctl operation");
  }
  if (name === "journalctl") {
    const selected = args.flatMap((arg, index) => arg === "-u" ? [args[index + 1]] : []);
    let emitted = false;
    const publish = () => {
      const latest = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
      if (emitted || latest.generation === 0) return;
      emitted = true;
      for (const unit of selected) {
        const message = unit === "core5-api" ? "core5 api listening" : "Ready in fixture";
        process.stdout.write(args.includes("json")
          ? JSON.stringify({ _SYSTEMD_USER_UNIT: unit + ".service", MESSAGE: message }) + "\n"
          : message + "\n");
      }
    };
    const subscription = watch(root, (_, file) => { if (file === "state.json") publish(); });
    process.once("SIGTERM", () => { subscription.close(); process.exit(0); });
    publish();
    return new Promise(() => {});
  }
  if (name === "docker") {
    if (args.includes("pg_dump")) {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let remaining = fixture.dumpBytes;
      while (remaining > 0) {
        const count = Math.min(remaining, chunk.length);
        writeSync(1, chunk, 0, count);
        remaining -= count;
      }
      return 0;
    }
    if (args.includes("pg_restore")) {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of process.stdin) { bytes += chunk.length; hash.update(chunk); }
      writeFileSync(join(root, "catalog.json"), JSON.stringify({ bytes, sha256: hash.digest("hex") }));
      return fixture.badCatalog ? 29 : 0;
    }
    throw new Error("unexpected docker operation");
  }
  if (name === "curl") {
    const url = args.at(-1);
    if (url.endsWith("/api/self-entry")) {
      const foreign = args.includes("Origin: https://crm-origin-rejected.invalid");
      process.stdout.write(foreign ? '{"error":"ORIGIN_DENIED"}\n403' : '{"error":"INPUT_INVALID"}\n400');
    } else if (url.endsWith("/api/cwos/v2/mail-candidate-review")) {
      process.stdout.write('{"error":"STEP_UP_REQUIRED"}\n401');
    } else process.stdout.write("{}\n200");
    return 0;
  }
  throw new Error(`unexpected fixture executable: ${basename(name ?? "")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`FIXTURE_COMMAND_FAILED ${error.message}\n`);
    process.exitCode = 1;
  });
}
