import { createServer } from "node:http";
import { privateStepUpClient } from "../../src/private-step-up-client.js";

// Isolated executable fixture only: all POSTs go to this owned loopback server.
const mock = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume without logging */ }
  response.writeHead(200, { "set-cookie": "proof=mock-pty-proof-sentinel" });
  response.end('{"token":"mock-pty-proof-sentinel"}');
});
await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
const address = mock.address();
if (!address || typeof address === "string") throw new Error("MOCK_ADDRESS_REQUIRED");
try {
  await privateStepUpClient({
    endpoint: new URL("https://mock.invalid/api/cwos/v2/operator-step-up"),
    workspaceId: "isolated-mock-workspace", principalId: "isolated-mock-owner",
    input: process.stdin, output: process.stdout,
  }, async (_url, init) => fetch(`http://127.0.0.1:${address.port}/mock-only`, init));
  console.log("MOCK_PTY_FINISHED");
} catch {
  console.error("MOCK_PTY_FAILED");
  process.exitCode = 1;
} finally {
  mock.closeAllConnections();
  await new Promise<void>(resolve => mock.close(() => resolve()));
}
