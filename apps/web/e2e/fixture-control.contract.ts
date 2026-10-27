import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FixtureControlError,
  readOwnedFixtureControl,
  requireExternalFixtureDirectory,
} from "./fixture-control";

const secret = "a".repeat(48);
const control = {
  origin: "http://127.0.0.1:4010",
  webOrigin: "http://127.0.0.1:4011",
  controlSecret: secret,
  password: "synthetic-control-password",
  totp: "000000",
};

async function expectCode(action: () => Promise<unknown>, code: FixtureControlError["code"]): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof FixtureControlError);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

const root = await mkdtemp(join(tmpdir(), "crm-fixture-control-"));
try {
  await expectCode(
    () => readOwnedFixtureControl(join(root, "missing")),
    "MISSING",
  );
  assert.throws(
    () => requireExternalFixtureDirectory("http://127.0.0.1:9", undefined),
    (error: unknown) => error instanceof FixtureControlError && error.code === "DIRECTORY_REQUIRED",
  );

  const mismatchedMode = join(root, "mode");
  await mkdir(mismatchedMode, { mode: 0o700 });
  await chmod(mismatchedMode, 0o700);
  await writeFile(join(mismatchedMode, "auth-control.json"), JSON.stringify(control), { mode: 0o644 });
  await chmod(join(mismatchedMode, "auth-control.json"), 0o644);
  await expectCode(() => readOwnedFixtureControl(mismatchedMode, control.webOrigin), "OWNERSHIP");

  const mismatchedOrigin = join(root, "origin");
  await mkdir(mismatchedOrigin, { mode: 0o700 });
  await chmod(mismatchedOrigin, 0o700);
  await writeFile(join(mismatchedOrigin, "auth-control.json"), JSON.stringify(control), { mode: 0o600 });
  await chmod(join(mismatchedOrigin, "auth-control.json"), 0o600);
  await expectCode(
    () => readOwnedFixtureControl(mismatchedOrigin, "http://127.0.0.1:4099"),
    "ORIGIN_MISMATCH",
  );

  const owned = join(root, "owned");
  await mkdir(owned, { mode: 0o700 });
  await chmod(owned, 0o700);
  await writeFile(join(owned, "auth-control.json"), JSON.stringify(control), { mode: 0o600 });
  await chmod(join(owned, "auth-control.json"), 0o600);
  const accepted = await readOwnedFixtureControl(owned, control.webOrigin);
  assert.equal(accepted.origin, control.origin);
  assert.equal(accepted.webOrigin, control.webOrigin);
  assert.equal(accepted.controlSecret, secret);
  console.log("fixture-control contract: missing, ownership, origin mismatch, and owned control passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
