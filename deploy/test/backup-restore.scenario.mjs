import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeployment, exists, readJson } from "./fixtures/deployment.mjs";

const bin = process.env.CRM_TEST_PG_BIN;
if (!bin) throw new Error("CRM_TEST_PG_BIN must name an installed PostgreSQL 16 bin directory");
const profile = process.argv[2];
if (!["master", "review"].includes(profile)) throw new Error("profile must be master or review");
const root = await mkdtemp(join(tmpdir(), "crm-restore-proof-"));
const data = join(root, "source");
const socket = join(root, "socket");
const environment = { ...process.env, PGHOST: socket, PGPORT: "5432", PGUSER: "postgres", PGDATABASE: "postgres" };
const run = (name, args) => new Promise((resolve, reject) => {
  const child = spawn(join(bin, name), args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(`${name} exit${code}: ${stderr}`)));
});
let started = false;
try {
  await mkdir(socket);
  await run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-locale"]);
  await run("pg_ctl", ["-D", data, "-l", join(root, "server.log"),
    "-o", `-c listen_addresses='' -k ${socket}`, "-w", "start"]);
  started = true;
  await run("psql", ["-v", "ON_ERROR_STOP=1", "-c", `
    CREATE ROLE backup_reader;
    CREATE TABLE restore_probe (id integer PRIMARY KEY, payload text NOT NULL);
    INSERT INTO restore_probe SELECT i, repeat(md5(i::text), 16) FROM generate_series(1,2000) i;
    ALTER TABLE restore_probe ENABLE ROW LEVEL SECURITY;
    CREATE POLICY probe_read ON restore_probe FOR SELECT TO backup_reader USING (true);
    GRANT SELECT ON restore_probe TO backup_reader;
  `]);
  const dump = join(root, "valid.dump");
  const corrupt = join(root, "truncated.dump");
  const roles = join(root, "roles.sql");
  await run("pg_dump", ["--format=custom", "--compress=0", "--no-owner", "--file", dump]);
  await run("pg_dumpall", ["--roles-only", "--no-role-passwords", "--file", roles]);
  await copyFile(dump, corrupt);
  await truncate(corrupt, Math.floor((await stat(corrupt)).size / 2));
  await run("pg_restore", ["--list", corrupt]);
  console.log("CATALOG_READABLE_TRUNCATED_DATA");
  const settings = profile === "master" ? {} : {
    script: "deploy/crm-deploy-review-ui.sh",
    target: "f1fde1cf73c013a17e606b98c0076ae289af8740",
    units: ["core5-api", "core5-web", "core5-review-ui"],
  };
  for (const [kind, dumpPath, valid] of [["truncated", corrupt, false], ["valid", dump, true]]) {
    await withDeployment({ ...settings, realPg: { bin, dumpPath, rolesPath: roles } }, result => {
      assert.equal(result.code, valid ? 0 : 1, result.stderr);
      assert.equal(result.stdout.includes("CRM_BACKUP_OK"), valid);
      assert.equal(readJson(join(result.root, "catalog.json")).code, 0);
      const restored = readJson(join(result.root, "restore.json"));
      assert.equal(restored.native, true);
      assert.equal(restored.code === 0, valid);
      assert.equal(restored.proof, valid ? "2000:2001000" : null);
      if (!valid) {
        assert.equal(result.events.some(event => event.name === "pnpm"), false);
        assert.equal(result.events.some(event => event.args.includes("daemon-reload")), false);
      }
      assert.equal(exists(join(result.root, "restore-container-removed")), true);
      console.log(JSON.stringify({ profile, kind, restored: valid, proof: restored.proof, pass: true }));
    });
  }
  console.log(`REAL_RESTORE_PASS profile=${profile}`);
} finally {
  if (started) await run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(root, { recursive: true, force: true });
}
