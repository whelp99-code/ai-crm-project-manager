import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { writeNewOperatorEnrollment } from "../../api/src/operator-auth-enrollment.js";
import { operatorAuthRecordSchema } from "../../api/src/operator-auth-store.js";
import { GET, POST } from "../app/api/self-entry/enroll/route";
import { enrollmentHttpResponse } from "../app/enrollment-listener";
import { enrollThroughCli } from "../app/self-entry-enroll-cli";
import { middleware } from "../middleware";
import {
  ENROLLMENT_BIND_PORT, ENROLLMENT_ORIGIN, enrollmentAvailability, enrollmentSurfaceAllowed,
  submitOperatorEnrollment, type EnrollmentListener,
} from "../app/self-entry-enroll";

const fixture = {
  password: "synthetic-web-enroll-password",
  totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  totp: "287082",
};
const now = 59_000;
const dedicated: EnrollmentListener = { localPort: ENROLLMENT_BIND_PORT, remoteAddress: "127.0.0.1" };
const tailnetProxy: EnrollmentListener = { localPort: 4313, remoteAddress: "127.0.0.1" };

function post(url: string, body: unknown, origin = new URL(url).origin) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("owner web enrollment", () => {
  it("allows only the dedicated loopback listener, not a tailscale backend port", () => {
    expect(enrollmentSurfaceAllowed(dedicated)).toBe(true);
    expect(enrollmentSurfaceAllowed({ localPort: ENROLLMENT_BIND_PORT, remoteAddress: "::1" })).toBe(true);
    expect(enrollmentSurfaceAllowed(tailnetProxy)).toBe(false);
    expect(enrollmentSurfaceAllowed({ localPort: 4312, remoteAddress: "127.0.0.1" })).toBe(false);
    expect(enrollmentSurfaceAllowed({ localPort: 8446, remoteAddress: "127.0.0.1" })).toBe(false);
    expect(enrollmentSurfaceAllowed({ localPort: 8447, remoteAddress: "127.0.0.1" })).toBe(false);
    expect(enrollmentSurfaceAllowed({ localPort: ENROLLMENT_BIND_PORT, remoteAddress: "100.87.253.57" })).toBe(false);
    expect(enrollmentSurfaceAllowed(undefined)).toBe(false);
  });

  it("rejects a proxied 8446 request whose socket is 127.0.0.1 on port 4313", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      const spoofed = new Request("http://localhost/api/self-entry/enroll", {
        method: "POST",
        headers: {
          host: "localhost",
          origin: ENROLLMENT_ORIGIN,
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: JSON.stringify(fixture),
      });
      const denied = await submitOperatorEnrollment(spoofed, {
        statePath, now, write: writeNewOperatorEnrollment, listener: tailnetProxy,
      });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('{"error":"ENROLLMENT_HOST_DENIED"}');
      const through8446 = await enrollmentHttpResponse(
        tailnetProxy,
        post("https://crm.example:8446/api/self-entry/enroll", fixture, "https://crm.example:8446"),
        { statePath, now },
      );
      expect(through8446.status).toBe(403);
      const publicRoute = await POST(spoofed);
      expect(publicRoute.status).toBe(403);
      expect(await publicRoute.text()).not.toContain(fixture.password);
      expect((await GET(new Request("http://127.0.0.1:4313/api/self-entry/enroll", {
        headers: { host: "localhost" },
      }))).status).toBe(403);
      await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(enrollmentAvailability(tailnetProxy, statePath)).toBe("denied");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("writes the CLI enrollment record once on the dedicated listener and leaves a second attempt unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      expect(enrollmentAvailability(dedicated, statePath)).toBe("open");
      const created = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath, now, write: writeNewOperatorEnrollment, listener: dedicated },
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
      expect(enrollmentAvailability(dedicated, statePath)).toBe("enrolled");
      const again = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath, now, write: writeNewOperatorEnrollment, listener: dedicated },
      );
      expect(again.status).toBe(409);
      expect(await again.text()).toBe('{"error":"ALREADY_ENROLLED"}');
      expect(await readFile(statePath, "utf8")).toBe(persisted);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not write from a mismatched origin or a missing path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      const crossSite = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture, "https://evil.example"),
        { statePath, now, write: writeNewOperatorEnrollment, listener: dedicated },
      );
      expect(crossSite.status).toBe(403);
      const missing = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath: undefined, now, write: writeNewOperatorEnrollment, listener: dedicated },
      );
      expect(missing.status).toBe(503);
      expect(await missing.text()).toBe('{"error":"CONFIGURATION_REQUIRED"}');
      await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(enrollmentAvailability(dedicated, undefined)).toBe("unconfigured");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to open or replace an existing state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-"));
    const statePath = join(dir, "operator-auth.json");
    const prior = "{\"marker\":\"preexisting-state\"}\n";
    try {
      await writeFile(statePath, prior, { mode: 0o600 });
      expect(enrollmentAvailability(dedicated, statePath)).toBe("enrolled");
      const blocked = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath, now, write: writeNewOperatorEnrollment, listener: dedicated },
      );
      expect(blocked.status).toBe(409);
      const text = await blocked.text();
      expect(text).toBe('{"error":"ALREADY_ENROLLED"}');
      expect(text).not.toContain("preexisting-state");
      expect(text).not.toContain(fixture.password);
      expect(text).not.toContain(fixture.totpSecret);
      const proxied = await submitOperatorEnrollment(
        post("https://crm.example:8446/api/self-entry/enroll", fixture),
        { statePath, now, write: writeNewOperatorEnrollment, listener: tailnetProxy },
      );
      expect(proxied.status).toBe(403);
      expect(await readFile(statePath, "utf8")).toBe(prior);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("stores a CLI enrollment from the dedicated listener and does not print the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-web-enroll-cli-"));
    const statePath = join(dir, "operator-auth.json");
    try {
      const created = await submitOperatorEnrollment(
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath, now, write: enrollThroughCli, listener: dedicated },
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
        post(`${ENROLLMENT_ORIGIN}/api/self-entry/enroll`, fixture),
        { statePath, now, write: enrollThroughCli, listener: dedicated },
      );
      expect(again.status).toBe(409);
      expect(await again.text()).not.toContain(fixture.password);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves the closed enrollment notice outside the login wall", async () => {
    const page = await middleware(new NextRequest("http://127.0.0.1:4313/login/enroll", {
      headers: { host: "localhost" },
    }));
    const api = await middleware(new NextRequest("https://crm.example:8446/api/self-entry/enroll"));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(api.headers.get("x-middleware-next")).toBe("1");
  });
});
