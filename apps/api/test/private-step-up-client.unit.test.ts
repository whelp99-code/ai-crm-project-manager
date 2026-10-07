import { createServer } from "node:http";
import type { ReadStream, WriteStream } from "node:tty";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { privateStepUpClient } from "../src/private-step-up-client.js";

const key = "isolated-mock-key-sentinel";
const password = "isolated-mock-password-sentinel";
const otp = "918273";
const proof = "isolated-mock-cookie-token-sentinel";
const secrets = [key, password, otp, proof];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function terminal(values = [key, password, otp]) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(raw: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  const modes: boolean[] = [];
  input.setRawMode = raw => { input.isRaw = raw; modes.push(raw); };
  let screen = "";
  let cursor = 0;
  const output = {
    isTTY: true,
    write(text: string) {
      screen += text;
      if (text.endsWith("(hidden): ")) {
        // Emulate terminal echo: dropping raw mode would expose the secret.
        const value = values[cursor++] ?? "";
        if (!input.isRaw) screen += value;
        for (const byte of Buffer.from(`${value}\r`)) input.write(Buffer.from([byte]));
      }
      return true;
    },
  } as unknown as WriteStream;
  return { input: input as unknown as ReadStream, output, modes, screen: () => screen };
}

const endpoint = new URL("https://admitted.example.invalid/api/cwos/v2/operator-step-up");
describe("source-only private input client against isolated mock", () => {
  it("sends correct hidden input only to owned loopback mock; never prints response proof", async () => {
    let received: unknown;
    let receivedKey: unknown;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = JSON.parse(body);
      receivedKey = req.headers["x-api-key"];
      res.writeHead(200, { "set-cookie": `private-proof=${proof}`, "content-type": "application/json" });
      res.end(JSON.stringify({ csrf: proof, token: proof }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MOCK_ADDRESS_REQUIRED");
    const mock = new URL(`http://127.0.0.1:${address.port}/mock-only`);
    const tty = terminal();
    await privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...tty,
    }, async (_url, init) => fetch(mock, init));
    expect(received).toEqual({ password, totp: otp });
    expect(receivedKey).toBe(key);
    expect(tty.modes).toEqual([true, false, true, false, true, false]);
    for (const value of secrets) expect(tty.screen()).not.toContain(value);
  });

  it("sanitizes transport errors and restores raw mode after cancellation", async () => {
    const tty = terminal();
    const error = await privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...tty,
    }, async () => { throw new Error(secrets.join(" ")); }).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    for (const value of secrets) {
      expect(String(error)).not.toContain(value);
      expect(tty.screen()).not.toContain(value);
    }
    const cancelled = terminal(["\u0003"]);
    await expect(privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...cancelled,
    })).rejects.toThrow("PRIVATE_AUTH_FAILED_OR_CANCELLED");
    expect(cancelled.modes).toEqual([true, false]);
  });

  it("preserves split UTF8 hidden input without echo", async () => {
    const unicodePassword = "mock-한글-password";
    const tty = terminal([key, unicodePassword, otp]);
    await privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...tty,
    }, async (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ password: unicodePassword, totp: otp });
      return new Response(null, { status: 200 });
    });
    expect(tty.screen()).not.toContain(unicodePassword);
  });

  it("refuses plaintext, credentials in URL, redirect targets and piped input", async () => {
    for (const url of ["http://127.0.0.1:4312/api/cwos/v2/operator-step-up",
      "https://user:pass@example.invalid/api/cwos/v2/operator-step-up",
      `${endpoint}?token=not-allowed`]) {
      await expect(privateStepUpClient({
        endpoint: new URL(url), workspaceId: "mock-workspace", principalId: "mock-owner", ...terminal(),
      })).rejects.toThrow("VERIFIED_HTTPS_ENDPOINT_REQUIRED");
    }
    const tty = terminal();
    await expect(privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...tty,
    }, async (_url, init) => {
      expect(init.redirect).toBe("manual");
      return new Response(proof, { status: 302, headers: { location: "https://elsewhere.invalid/" } });
    })).rejects.toThrow("PRIVATE_AUTH_FAILED_OR_CANCELLED");
    const piped = terminal();
    Object.assign(piped.input, { isTTY: false });
    await expect(privateStepUpClient({
      endpoint, workspaceId: "mock-workspace", principalId: "mock-owner", ...piped,
    })).rejects.toThrow("PRIVATE_AUTH_FAILED_OR_CANCELLED");
  });
});
