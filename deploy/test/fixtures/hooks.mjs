import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const root = process.env.CRM_TEST_ROOT;
if (!root?.startsWith("/tmp/crm-deploy-test-")) throw new Error("sandbox required");
const fixture = JSON.parse(fs.readFileSync(join(root, "fixture.json"), "utf8"));
const originalKill = process.kill;
process.kill = function (pid, signal) {
  if (pid < 0 && (signal === "SIGTERM" || signal === "SIGKILL")) {
    fs.writeFileSync(join(root, `kill-${process.pid}-${-pid}-${signal}.json`),
      JSON.stringify({ pid, signal, at: performance.now() }));
  }
  return originalKill.call(this, pid, signal);
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  child.once("exit", (code, signal) => fs.writeFileSync(join(root, `exit-${child.pid}.json`), JSON.stringify({ code, signal })));
  return child;
};
const originalWrite = fs.promises.writeFile;
fs.promises.writeFile = async function (path, data, ...options) {
  const result = await originalWrite.call(this, path, data, ...options);
  if (fixture.signalAt === "write" && String(path) === fixture.apiDropin
    && String(data).includes(fixture.release) && !fs.existsSync(join(root, "signal-sent"))) {
    fs.writeFileSync(join(root, "signal-sent"), fixture.signal);
    process.kill(process.pid, fixture.signal);
  }
  return result;
};
syncBuiltinESMExports();
process.once("exit", () => {
  fs.writeFileSync(join(root, `usage-${process.pid}.json`),
    JSON.stringify({ maxRSS: process.resourceUsage().maxRSS, nodeMajor: Number(process.versions.node.split(".")[0]) }));
});
