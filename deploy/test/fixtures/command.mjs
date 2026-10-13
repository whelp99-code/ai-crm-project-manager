import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, watch, writeFileSync, writeSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const decode = value => value.startsWith('"') ? JSON.parse(value) : value;
function environmentWords(value) {
  const words = [];
  let word = "", quote = "", escaped = false;
  for (const character of value) {
    if (escaped) { word += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character)) { if (word) words.push(word); word = ""; }
    else word += character;
  }
  if (quote || escaped) throw new Error("invalid fixture Environment quoting");
  if (word) words.push(word);
  return words;
}

export function configuration(root, unit) {
  const directory = join(root, "units", `${unit}.service.d`);
  const paths = [join(root, "units", `${unit}.service`),
    ...readdirSync(directory).filter(name => name.endsWith(".conf")).sort().map(name => join(directory, name))];
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
        if (!line.slice(12).trim()) {
          for (const key of Object.keys(direct)) delete direct[key];
        }
        for (const value of environmentWords(line.slice(12))) {
          const equal = value.indexOf("=");
          if (equal >= 0) direct[value.slice(0, equal)] = value.slice(equal + 1);
        }
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
  const contender = process.env.CRM_TEST_CONTENDER === "1";
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  writeFileSync(join(root, `child-${process.pid}`), name);
  const event = value => {
    const file = join(root, `event-${process.pid}.json`);
    writeFileSync(file, JSON.stringify({ ...value, contender }));
  };
  if (name === "stubborn-descendant") {
    process.on("SIGTERM", () => writeFileSync(join(root, "descendant-ignored-term"), "ignored"));
    watch(root, () => {});
    if (process.send) process.send("READY");
    else process.stdout.write("READY\n");
    return new Promise(() => {});
  }
  if (name === "git") {
    event({ name, args });
    if (args[0] !== "-C" || args[1] !== join(root, "source")) throw new Error("sandbox Git only");
    const [operation, ...values] = args.slice(2);
    const commits = [fixture.target, fixture.contenderTarget,
      "1cf5388202c01ce6ddaf2796cbefc10c47e0e4bf", "e91bb512a2783918fd0c8b84c9e91660df348d96"];
    if (operation === "rev-parse" && values.length === 1) {
      const revision = values[0].replace(/\^\{commit\}$/, "");
      if (!commits.includes(revision)) return 128;
      process.stdout.write((fixture.sourceMismatch ? "0".repeat(40) : revision) + "\n");
      return 0;
    }
    if (operation === "merge-base" && values[0] === "--is-ancestor"
      && commits.includes(values[1]) && commits.includes(values[2])) return fixture.sourceUnrelated ? 1 : 0;
    if (operation === "diff" && values[0] === "--exit-code"
      && commits.includes(values[1]) && commits.includes(values[2])) return fixture.sqlDelta ? 1 : 0;
    if (operation === "show" && commits.includes(values[0].split(":")[0])
      && values[0].endsWith(":apps/web/app/page.tsx")) {
      process.stdout.write(readFileSync(join(root, "source/apps/web/app/page.tsx")));
      return 0;
    }
    if (operation === "archive" && commits.includes(values[0])) {
      const child = spawn("tar", ["-cf", "-", "-C", join(root, "source"), "."], { stdio: ["ignore", "inherit", "inherit"] });
      return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    }
    throw new Error("unexpected fixture Git operation");
  }
  if (name === "pnpm") {
    const build = args[0] === "install" || args.includes("build");
    const exposed = Object.keys(process.env).filter(key => /DATABASE|PGHOST|PGPASSWORD|API_KEY|SECRET|TOKEN|AUTH_STATE/.test(key));
    event({ name, args, build, exposed, backupValidated: existsSync(join(root, "restore.json")),
      publicApiBase: process.env.NEXT_PUBLIC_API_BASE_URL ?? null });
    if (fixture.mutateDb && build && exposed.length) {
      state.dbVersion++;
      saveState(root, state);
    }
    mkdirSync(join(process.cwd(), "apps/web/node_modules/next/dist/bin"), { recursive: true });
    writeFileSync(join(process.cwd(), "apps/web/node_modules/next/dist/bin/next"), "// fixture Next entry\n");
    if (args.includes("build")) {
      mkdirSync(join(process.cwd(), "apps/web/.next"), { recursive: true });
      writeFileSync(join(process.cwd(), "apps/web/.next/prerender-manifest.json"), JSON.stringify({
        version: 4, routes: fixture.staticRoute ? { [fixture.staticRoute]: {} } : {},
      }));
    }
    return 0;
  }
  if (name === "systemctl") {
    const selected = args.filter(arg => arg.startsWith("core5-")).map(arg => arg.replace(/\.service$/, ""));
    event({ name, args });
    if (args.includes("show")) {
      const unit = selected[0];
      const config = configuration(root, unit);
      if (args.includes("--property=WorkingDirectory")) process.stdout.write(config.cwd + "\n");
      else if (args.includes("--property=ExecStart")) {
        const rollback = state.generation > 0 && !config.cwd.includes(fixture.release);
        const words = environmentWords(rollback && fixture.rollbackExec ? `${process.execPath} wrong-server.mjs` : config.exec);
        process.stdout.write(`{ path=${words[0]} ; argv[]=${words.join(" ")} ; ignore_errors=no ; start_time=generation-${state.generation} ; pid=${state.units[unit].pid} }\n`);
      }
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
      if (!contender) state.primaryReloads = (state.primaryReloads ?? 0) + 1;
      saveState(root, state);
      return fixture.failReload && !contender && state.primaryReloads === 1 ? 23 : 0;
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
        if (!deployed && fixture.rollbackEnvironmentUnit === unit) {
          if (unit === "core5-api") environment.CWOS_V2_OPERATOR_AUTH_STATE_PATH = fixture.newAuth;
          else environment.CRM_WEB_ORIGIN = "https://wrong.invalid";
        }
        const dead = fixture.deadUnit === unit && fixture.deadPhase === (deployed ? "deploy" : "rollback");
        const pid = dead ? 0 : 1000 + state.generation * 10 + index;
        state.units[unit] = { active: !dead, pid, environment };
        if (pid) {
          mkdirSync(join(root, "proc", String(pid)), { recursive: true });
          writeFileSync(join(root, "proc", String(pid), "environ"),
            Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\0") + "\0");
          const stale = deployed ? fixture.staleCwdUnit === unit : fixture.rollbackCwdUnit === unit;
          const processCwd = stale ? (deployed ? fixture.originalCwds[unit] : join(fixture.release, "apps", unit === "core5-api" ? "api" : "web")) : config.cwd;
          symlinkSync(processCwd, join(root, "proc", String(pid), "cwd"));
        }
      }
      saveState(root, state);
      const deployed = configuration(root, "core5-api").cwd.includes(fixture.release);
      if (fixture.signalAt === "restart" && deployed && !existsSync(join(root, "signal-sent"))) {
        writeFileSync(join(root, "signal-sent"), fixture.signal);
        const keepAlive = watch(root, () => {});
        if (fixture.stubborn || fixture.leaderExitsFirst) {
          if (fixture.stubborn) {
            process.on("SIGTERM", () => writeFileSync(join(root, "parent-ignored-term"), "ignored"));
          } else {
            process.once("SIGTERM", () => {
              writeFileSync(join(root, "leader-exited-first"), String(process.pid));
              process.exit(0);
            });
          }
          const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "stubborn-descendant"],
            { stdio: fixture.leaderExitsFirst ? ["ignore", "ignore", "ignore", "ipc"] : ["ignore", "pipe", "pipe"] });
          await new Promise((resolve, reject) => {
            descendant.once("error", reject);
            if (fixture.leaderExitsFirst) descendant.once("message", resolve);
            else descendant.stdout.once("data", () => resolve());
          });
          if (fixture.leaderExitsFirst) descendant.disconnect();
        } else {
          process.once("SIGTERM", () => {
            writeFileSync(join(root, "interrupted-child-closed"), "closed");
            keepAlive.close();
            process.exit(0);
          });
        }
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
    event({ name, args });
    if (fixture.realPg && (args.includes("pg_dump") || args.includes("pg_dumpall"))) {
      if (args.includes("pg_dump")) writeFileSync(join(root, "dump-snapshot.json"), JSON.stringify({ dbVersion: state.dbVersion }));
      await pipeline(createReadStream(args.includes("pg_dump") ? fixture.realPg.dumpPath : fixture.realPg.rolesPath), process.stdout);
      return 0;
    }
    if (fixture.realPg && args.includes("pg_restore")) {
      const child = spawn(join(fixture.realPg.bin, "pg_restore"), args.slice(args.indexOf("pg_restore") + 1),
        { stdio: "inherit" });
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      writeFileSync(join(root, "catalog.json"), JSON.stringify({ native: true, code }));
      return code;
    }
    if (args.includes("pg_dumpall")) {
      process.stdout.write("CREATE ROLE fixture_source;\n");
      return 0;
    }
    if (args.includes("restore-backup")) {
      writeFileSync(join(root, "restore-container"), args[args.indexOf("--name") + 1]);
      if (fixture.realPg) {
        const mount = args[args.indexOf("--mount") + 1];
        const rolePath = mount.slice("type=bind,src=".length, mount.indexOf(",dst="));
        // Adapt only Docker's uid/mount transport; run the shipped restore
        // commands against the real, task-owned PostgreSQL major version.
        const script = args[args.indexOf("-ec") + 1]
          .replaceAll("gosu postgres ", "")
          .replace('chown postgres:postgres "$directory"', ":")
          .replaceAll("/restore-roles.sql", rolePath)
          + `\npsql -h "$directory" -U "$1" -d postgres -Atc 'SELECT count(*)::text || chr(58) || sum(id)::text FROM restore_probe' > ${JSON.stringify(join(root, "restore-proof"))}`;
        const child = spawn("bash", ["-ec", script, "restore-backup", args.at(-1)], {
          stdio: "inherit",
          env: { ...process.env, PATH: `${fixture.realPg.bin}:/usr/bin:/bin`, TMPDIR: root },
        });
        const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        writeFileSync(join(root, "restore.json"), JSON.stringify({ native: true, code,
          proof: existsSync(join(root, "restore-proof")) ? readFileSync(join(root, "restore-proof"), "utf8").trim() : null }));
        return code;
      }
      if (fixture.signalAt === "restore") {
        const subscription = watch(root, () => {});
        process.once("SIGTERM", () => { subscription.close(); process.exit(0); });
        process.kill(process.ppid, fixture.signal);
        return new Promise(() => {});
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of process.stdin) { bytes += chunk.length; hash.update(chunk); }
      writeFileSync(join(root, "restore.json"), JSON.stringify({ bytes, sha256: hash.digest("hex") }));
      return fixture.badRestore ? 29 : 0;
    }
    if (args[0] === "rm") {
      writeFileSync(join(root, "restore-container-removed"), args.at(-1));
      return 0;
    }
    if (args.includes("pg_dump")) {
      if (fixture.contend && !contender) {
        await new Promise(resolve => {
          const release = join(root, "dump-release");
          const subscription = watch(root, (_, file) => {
            if (file === "dump-release" && existsSync(release)) { subscription.close(); resolve(); }
          });
          writeFileSync(join(root, "dump-held"), "held");
        });
      }
      writeFileSync(join(root, "dump-snapshot.json"), JSON.stringify({ dbVersion: state.dbVersion }));
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
    const rollback = state.generation > 0 && !configuration(root, "core5-api").cwd.includes(fixture.release);
    event({ name, args, rollback });
    if (rollback && fixture.rollbackUnavailableUrl === url) {
      process.stdout.write("\n000");
      return 7;
    }
    if (rollback && (fixture.coldRollback && url.startsWith("http://127.0.0.1:4312/")
      || fixture.coldRollbackUrls?.includes(url))
      && !url.endsWith(fixture.rollbackHttpFailure ?? "\0")) {
      const requests = [];
      const server = createServer((request, response) => {
        requests.push(request.url);
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end("{}");
      });
      const listen = () => new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      let port = 0, refused = false, listening, output = "", diagnostics = "";
      const headersPath = join(root, `http-${process.pid}.headers`);
      try {
        await listen();
        port = server.address().port;
        await new Promise(resolve => server.close(resolve));
        // Do not simulate curl retries. Bind only after native curl actually
        // observes the Type=simple connection-refused window.
        const curl = spawn("/usr/bin/curl", ["--verbose", "--dump-header", headersPath,
          ...args.slice(0, -1), `http://127.0.0.1:${port}${new URL(url).pathname}`],
        { stdio: ["ignore", "pipe", "pipe"] });
        curl.stdout.on("data", chunk => { output += chunk; });
        curl.stderr.on("data", chunk => {
          diagnostics += chunk;
          if (!listening && /Failed to connect|Connection refused/.test(diagnostics)) {
            refused = true;
            listening = listen();
          }
        });
        const code = await new Promise((resolve, reject) => {
          curl.once("error", reject);
          curl.once("close", resolve);
        });
        await listening;
        event({ name, args, rollback, realHttp: { port, refused, requests, code,
          headers: readFileSync(headersPath, "utf8"), output } });
        process.stdout.write(output);
        return code;
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
      }
    }
    const httpFailure = rollback ? fixture.rollbackHttpFailure : fixture.deployHttpFailure;
    if (httpFailure && url.endsWith(httpFailure)) {
      process.stdout.write('{"error":"not_ready"}\n503');
      return 0;
    }
    if (rollback && fixture.rollbackBoundaryFailure === url) {
      process.stdout.write("{}\n200");
      return 0;
    }
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
