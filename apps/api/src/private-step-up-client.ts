import type { ReadStream, WriteStream } from "node:tty";
import { StringDecoder } from "node:string_decoder";

export type PrivateInput = ReadStream;
export type PrivateOutput = WriteStream;

async function hiddenLine(input: PrivateInput, output: PrivateOutput, prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("PRIVATE_TTY_REQUIRED");
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const decoder = new StringDecoder("utf8");
      const cleanup = () => {
        input.off("data", data);
        input.off("end", ended);
        input.off("error", ended);
      };
      const ended = () => { cleanup(); reject(new Error("PRIVATE_INPUT_CANCELLED")); };
      const data = (chunk: Buffer | string) => {
        for (const char of typeof chunk === "string" ? chunk : decoder.write(chunk)) {
          if (char === "\u0003" || char === "\u0004") { ended(); return; }
          if (char === "\r" || char === "\n") {
            cleanup();
            output.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      input.on("data", data);
      input.once("end", ended);
      input.once("error", ended);
      output.write(prompt);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
  }
}

/** Source-only draft. No env/files, credential argv, cookie jar or deployment wiring. */
export async function privateStepUpClient(options: {
  endpoint: URL;
  workspaceId: string;
  principalId: string;
  input: PrivateInput;
  output: PrivateOutput;
}, transport: (url: URL, init: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const { endpoint, input, output } = options;
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== "/api/cwos/v2/operator-step-up") {
    throw new Error("VERIFIED_HTTPS_ENDPOINT_REQUIRED");
  }
  if (!options.workspaceId || !options.principalId) throw new Error("ADMITTED_BINDING_REQUIRED");
  try {
    const key = await hiddenLine(input, output, "API key (hidden): ");
    const password = await hiddenLine(input, output, "Password (hidden): ");
    const totp = await hiddenLine(input, output, "OTP (hidden): ");
    if (!key || !password || !/^\d{6}$/.test(totp)) throw new Error("PRIVATE_INPUT_INVALID");
    const response = await transport(endpoint, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json", "x-api-key": key,
        "x-workspace-id": options.workspaceId, "x-principal-id": options.principalId,
        "x-principal-kind": "human",
      },
      body: JSON.stringify({ password, totp }),
    });
    // Never print server bodies, cookies, proof tokens or transport errors.
    await response.body?.cancel();
    if (response.status !== 200) throw new Error("PRIVATE_AUTH_FAILED");
    output.write("Authentication accepted; response proof discarded.\n");
  } catch {
    throw new Error("PRIVATE_AUTH_FAILED_OR_CANCELLED");
  }
}
