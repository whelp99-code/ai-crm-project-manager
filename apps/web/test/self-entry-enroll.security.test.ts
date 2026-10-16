import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { writeNewOperatorEnrollment } from "../../api/src/operator-auth-enrollment.js";
import { operatorAuthRecordSchema } from "../../api/src/operator-auth-store.js";
import { enrollThroughCli } from "../app/self-entry-enroll-cli";
import { middleware } from "../middleware";
import { enrollmentAvailability, enrollmentSurfaceAllowed, submitOperatorEnrollment } from "../app/self-entry-enroll";

const fixture = {
  password: "synthetic-web-enroll-password",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  totp: "287082",
};
const now = 59_000;

function post(url: string, body: unknown, origin = new URL(url).origin) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("owner web enrollment", () => {
  it("allows only loopback or the existing https enrollment ports", () => {
    expect(enrollmentSurfaceAllowed(new URL("http://127.0.0.1:3000/login/enroll"))).toBe(true);
    expect(enrollmentSurfaceAllowed(new URL("http://localhost/login/enroll"))).toBe(true);
    expect(enrollmentSurfaceAllowed(new URL("http://[::1]:3000/login/enroll"))).toBe(true);
    expect(enrollmentSurfaceAllowed(new URL("https://crm.example:8446/login/enroll"))).toBe(true);
    expect(enrollmentSurfaceAllowed(new URL("https://crm.example:8447/login/enroll"))).toBe(true);
    expect(enrollmentSurfaceAllowed(new URL("http://crm.example:8446/login/enroll"))).toBe(false);
    expect(enrollmentSurfaceAllowed(new URL("https://crm.example/login/enroll"))).toBe(false);
    expect(enrollmentSurfaceAllowed(new URL("https://crm.example:443/login/enroll"))).toBe(false);
  });

  it("writes the CLI enrollment record once and leaves a second attempt unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      expect(enrollmentAvailability(new URL("http://127.0.0.1:3000/login/enroll"), statePath)).toBe("open");
      const created = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture),
        { statePath, now, write: writeNewOperatorEnrollment },
      );
      const createdText = await created.text();
      expect(created.status).toBe(201);
      expect(createdText).toBe('{"enrolled":true}');
      expect(createdText).not.toContain(fixture.password);
      expect(createdText).not.toContain(fixture.totpSecret);
      const persisted = await readFile(statePath, "utf8");
      expect(persisted).not.toContain(fixture.password);
      const record = operatorAuthRecordSchema.parse(JSON.parse(persisted));
      expect(record).toMatchObject({
        generation: 1, enrolled: true, totpPending: false, totpSecret: fixture.totpSecret,
      });
      expect(record.passwordHash).toMatch(/^\$2b\$12\$/);
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect(enrollmentAvailability(new URL("http://127.0.0.1:3000/login/enroll"), statePath)).toBe("enrolled");
      const again = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture),
        { statePath, now, write: writeNewOperatorEnrollment },
      );
      expect(again.status).toBe(409);
      expect(await again.text()).toBe('{"error":"ALREADY_ENROLLED"}');
      expect(await readFile(statePath, "utf8")).toBe(persisted);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not write from another host, a mismatched origin, or a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      const denied = await submitOperatorEnrollment(
        post("https://crm.example/api/self-entry/enroll", fixture),
        { statePath, now, write: writeNewOperatorEnrollment },
      );
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('{"error":"ENROLLMENT_HOST_DENIED"}');
      const crossSite = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture, "https://evil.example"),
        { statePath, now, write: writeNewOperatorEnrollment },
      );
      expect(crossSite.status).toBe(403);
      const missing = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture),
        { statePath: undefined, now, write: writeNewOperatorEnrollment },
      );
      expect(missing.status).toBe(503);
      expect(await missing.text()).toBe('{"error":"CONFIGURATION_REQUIRED"}');
      await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(enrollmentAvailability(new URL("https://crm.example/login/enroll"), statePath)).toBe("denied");
      expect(enrollmentAvailability(new URL("http://127.0.0.1:3000/login/enroll"), undefined)).toBe("unconfigured");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to open or replace an existing state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    const prior = "{\"marker\":\"preexisting-state\"}\n";
    try {
      await writeFile(statePath, prior, { mode: 0o600 });
      expect(enrollmentAvailability(new URL("https://crm.example:8446/login/enroll"), statePath)).toBe("enrolled");
      const blocked = await submitOperatorEnrollment(
        post("https://crm.example:8447/api/self-entry/enroll", fixture),
        { statePath, now, write: writeNewOperatorEnrollment },
      );
      expect(blocked.status).toBe(409);
      const text = await blocked.text();
      expect(text).toBe('{"error":"ALREADY_ENROLLED"}');
      expect(text).not.toContain("preexisting-state");
      expect(text).not.toContain(fixture.password);
      expect(text).not.toContain(fixture.totpSecret);
      expect(await readFile(statePath, "utf8")).toBe(prior);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("stores a CLI enrollment from the web writer and does not print the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-cli-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      const created = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture),
        { statePath, now, write: enrollThroughCli },
      );
      const text = await created.text();
      expect(created.status).toBe(201);
      expect(text).toBe('{"enrolled":true}');
      expect(text).not.toContain(fixture.password);
      expect(text).not.toContain(fixture.totpSecret);
      const record = operatorAuthRecordSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
      expect(record).toMatchObject({ generation: 1, enrolled: true, totpPending: false });
      expect(record.passwordHash).toMatch(/^\$2b\$12\$/);
      const again = await submitOperatorEnrollment(
        post("http://127.0.0.1:3000/api/self-entry/enroll", fixture),
        { statePath, now, write: enrollThroughCli },
      );
      expect(again.status).toBe(409);
      expect(await again.text()).not.toContain(fixture.password);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves the enrollment screen outside the login wall", async () => {
    const page = await middleware(new NextRequest("http://127.0.0.1:3000/login/enroll"));
    const api = await middleware(new NextRequest("http://127.0.0.1:3000/api/self-entry/enroll"));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(api.headers.get("x-middleware-next")).toBe("1");
  });
});
