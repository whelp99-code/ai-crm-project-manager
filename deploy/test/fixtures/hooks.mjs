import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";

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
const originalCopy = fs.promises.copyFile;
const originalRename = fs.promises.rename;
const inPhase = data => fixture.atomicPhase === (String(data).includes(fixture.release) ? "forward" : "rollback");
function receipt(point, path, next) {
  fs.writeFileSync(join(root, "atomic-receipt.json"), JSON.stringify({
    point, path: String(path), destination: fixture.apiDropin,
    before: fs.readFileSync(fixture.apiDropin, "utf8"), next: String(next),
    beforeMode: fs.statSync(fixture.apiDropin).mode & 0o777,
  }));
}
async function partialWrite(path, data, options) {
  if (fixture.atomicCrash !== "partial-write" || dirname(String(path)) !== dirname(fixture.apiDropin) || !inPhase(data)) return;
  receipt("partial-write", path, data);
  await originalWrite(path, String(data).slice(0, Math.floor(String(data).length / 2)), ...options);
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
}
function signalPublished(path, data) {
  if (fixture.signalAt === "write" && String(path) === fixture.apiDropin
    && String(data).includes(fixture.release) && !fs.existsSync(join(root, "signal-sent"))) {
    fs.writeFileSync(join(root, "signal-sent"), fixture.signal);
    process.kill(process.pid, fixture.signal);
  }
}
fs.promises.writeFile = async function (path, data, ...options) {
  await partialWrite(path, data, options);
  const result = await originalWrite.call(this, path, data, ...options);
  signalPublished(path, data);
  return result;
};
fs.promises.copyFile = async function (source, destination, ...options) {
  if (String(destination) === fixture.apiDropin) await partialWrite(destination, fs.readFileSync(source), []);
  return originalCopy.call(this, source, destination, ...options);
};
let renameCount = 0;
fs.promises.rename = async function (source, destination) {
  const data = fs.readFileSync(source);
  const crash = String(destination) === fixture.apiDropin && inPhase(data);
  if (crash && fixture.atomicCrash === "before-rename") {
    receipt("before-rename", source, data);
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  if (crash && fixture.atomicCrash === "after-rename") receipt("after-rename", source, data);
  const result = await originalRename.call(this, source, destination);
  fs.writeFileSync(join(root, `event-rename-${process.pid}-${renameCount++}.json`), JSON.stringify({
    name: "rename", args: [String(source), String(destination)], source: String(source), destination: String(destination),
    complete: fs.readFileSync(destination).equals(data), mode: fs.statSync(destination).mode & 0o777,
  }));
  if (crash && fixture.atomicCrash === "after-rename") {
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  }
  signalPublished(destination, data);
  return result;
};
syncBuiltinESMExports();
process.once("exit", () => {
  fs.writeFileSync(join(root, `usage-${process.pid}.json`),
    JSON.stringify({ maxRSS: process.resourceUsage().maxRSS, nodeMajor: Number(process.versions.node.split(".")[0]) }));
});
