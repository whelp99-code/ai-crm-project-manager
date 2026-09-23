import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CompanyMemoryDonorError,
  MAIL_COMPANY_MEMORY_ADAPTER_STATUS,
  canonicalCompanyMemoryBytes,
  createCrmMailOutboxDonorPort,
  createMailProductDonorPort,
  publishCompanyMemoryDonor,
  type CompanyMemoryCliTransport,
  type CompanyMemoryDonorSourceRecord,
  type CompanyMemoryDonorTrustedContext,
} from "../src/customer-work-os-v2/company-memory-donor.js";
import { CustomerWorkOsV2Platform } from "../src/customer-work-os-v2/index.js";

const WORKSPACE = "12345678-1234-4234-8234-123456789abc";
const OTHER_WORKSPACE = "22345678-1234-4234-8234-123456789abc";
const NOW = new Date("2026-09-23T10:00:00.000Z");
const AUTHORITY_DOMAIN = Buffer.from("second-brain/company-memory-authority/v1\0");
const REQUEST_DOMAIN = Buffer.from("second-brain/company-memory-request/v1\0");
const DONOR_SOURCE = fileURLToPath(
  new URL("../src/customer-work-os-v2/company-memory-donor.ts", import.meta.url),
);

const CONTEXT: CompanyMemoryDonorTrustedContext = {
  providerInstanceId: "provider:crm",
  workspaceId: WORKSPACE,
  principalId: "principal:crm-donor",
  agentId: "agent:crm-donor",
  sessionId: "session:crm-donor",
  projects: ["project:company"],
  policyRevision: "policy:1",
  deletionSequence: 2,
  deletionSetRoot: `sha256:${"a".repeat(64)}`,
};

const SOURCE: CompanyMemoryDonorSourceRecord = {
  workspaceId: WORKSPACE,
  provider: "gmail",
  mailbox: "ops@example.test",
  sourceLocator: "thread/t1",
  sourceEventId: "event-1",
  content: "synthetic crm evidence",
  parserVersion: "crm:mail-outbox:1",
  locator: { kind: "mail_inbox", ordinal: 1 },
};

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    signer: {
      keyId: "crm-donor-key:1",
      sign(message: Uint8Array): Uint8Array {
        return sign(null, message, privateKey);
      },
    },
  };
}

interface CapturingTransport extends CompanyMemoryCliTransport {
  requests: Uint8Array[];
  rememberCalls: unknown[];
  remember(input: unknown): void;
}

function capturingTransport(options?: {
  exitCode?: number;
  mutate?: (receipt: Record<string, unknown>) => Record<string, unknown>;
  stdout?: Uint8Array;
}): CapturingTransport {
  const requests: Uint8Array[] = [];
  const rememberCalls: unknown[] = [];
  return {
    requests,
    rememberCalls,
    remember(input: unknown): void {
      rememberCalls.push(input);
    },
    async invoke(canonicalRequest: Uint8Array) {
      requests.push(canonicalRequest);
      if (options?.stdout) {
        return { exitCode: options.exitCode ?? 0, stdout: options.stdout, stderr: new Uint8Array() };
      }
      if (options?.exitCode !== undefined && options.exitCode !== 0) {
        return {
          exitCode: options.exitCode,
          stdout: new Uint8Array(),
          stderr: Buffer.from('{"error":"COMPANY_AUTHORITY_REQUIRED"}'),
        };
      }
      const envelope = JSON.parse(Buffer.from(canonicalRequest).toString("utf8")) as {
        arguments: { candidate_id: string };
        authority: { workspace_id: string; request_digest: string; operation: string };
      };
      const receipt: Record<string, unknown> = {
        receipt_id: `cmreceipt:v1:${"b".repeat(64)}`,
        receipt_digest: `sha256:${"b".repeat(64)}`,
        workspace_id: envelope.authority.workspace_id,
        request_digest: envelope.authority.request_digest,
        operation: envelope.authority.operation,
        candidate_id: envelope.arguments.candidate_id,
        result: { state: "candidate" },
        created_at: "2026-09-23T10:00:00.000Z",
      };
      const body = { receipt: options?.mutate ? options.mutate(receipt) : receipt };
      return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify(body)}\n`), stderr: new Uint8Array() };
    },
  };
}

function seedInbox(): CustomerWorkOsV2Platform {
  const platform = new CustomerWorkOsV2Platform(WORKSPACE);
  platform.inbox.receiveMail(
    {
      id: "receipt-1",
      workspaceId: WORKSPACE,
      provider: SOURCE.provider,
      mailbox: SOURCE.mailbox,
      sourceLocator: SOURCE.sourceLocator,
      providerEventId: "m1",
      receivedAt: "2026-09-23T09:00:00.000Z",
      event: {
        id: SOURCE.sourceEventId,
        workspaceId: WORKSPACE,
        source: "GMAIL",
        providerEventId: "m1",
        occurredAt: "2026-09-23T09:00:00.000Z",
        subject: "synthetic",
        bodyDigest: "sha256:body",
        sender: "ops@example.test",
        promptInjectionSuspected: false,
      },
    },
    "2026-09-23T09:00:00.000Z",
  );
  return platform;
}

describe("CRM company-memory donor publisher", () => {
  it("builds a signed workspace-scoped receive request and marks outbox emitted only after matching receipt", async () => {
    const { publicKey, signer } = createSigner();
    const platform = seedInbox();
    const transport = capturingTransport();
    const result = await publishCompanyMemoryDonor({
      context: CONTEXT,
      signer,
      transport,
      outbox: createCrmMailOutboxDonorPort(platform.inbox, () => SOURCE),
      now: NOW,
    });

    expect(result.emitted).toEqual(["outbox-inbox-receipt-1"]);
    expect(result.pending).toEqual([]);
    expect(transport.requests).toHaveLength(1);
    expect(platform.inbox.exportState().mailOutbox[0]?.status).toBe("EMITTED");

    const envelope = JSON.parse(Buffer.from(transport.requests[0]!).toString("utf8")) as {
      arguments: Record<string, unknown>;
      authority: Record<string, unknown>;
    };
    expect(Object.keys(envelope).sort()).toEqual(["arguments", "authority"]);
    expect(envelope.authority.workspace_id).toBe(WORKSPACE);
    expect(envelope.authority.operation).toBe("receive");
    expect(envelope.authority.purpose).toBe("company_memory_receive");
    expect(envelope.arguments.source_system).toBe("crm");
    expect(envelope.arguments.source_locator).toBe(SOURCE.sourceLocator);
    expect(envelope.arguments.source_event_id).toBe(SOURCE.sourceEventId);

    const unsigned = { ...envelope.authority };
    const signature = unsigned.signature;
    delete unsigned.signature;
    expect(typeof signature).toBe("string");
    expect(String(signature).includes("=")).toBe(false);
    const message = Buffer.concat([AUTHORITY_DOMAIN, canonicalCompanyMemoryBytes(unsigned)]);
    expect(verify(null, message, publicKey, Buffer.from(String(signature), "base64url"))).toBe(true);

    const digestBody = { arguments: envelope.arguments, operation: "receive" };
    const expectedDigest = `sha256:${createHash("sha256")
      .update(Buffer.concat([REQUEST_DOMAIN, canonicalCompanyMemoryBytes(digestBody)]))
      .digest("hex")}`;
    expect(envelope.authority.request_digest).toBe(expectedDigest);
  });

  it("rejects missing or wrong workspace without invoking sb-company", async () => {
    const { signer } = createSigner();
    const platform = seedInbox();

    await expect(
      publishCompanyMemoryDonor({
        context: { ...CONTEXT, workspaceId: "ws-1" },
        signer,
        transport: capturingTransport(),
        outbox: createCrmMailOutboxDonorPort(platform.inbox, () => SOURCE),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "COMPANY_WORKSPACE_REQUIRED" });
    expect(platform.inbox.exportState().mailOutbox[0]?.status).toBe("PENDING");

    const wrongTransport = capturingTransport();
    const wrong = await publishCompanyMemoryDonor({
      context: { ...CONTEXT, workspaceId: OTHER_WORKSPACE },
      signer,
      transport: wrongTransport,
      outbox: createCrmMailOutboxDonorPort(platform.inbox, () => SOURCE),
      now: NOW,
    });
    expect(wrongTransport.requests).toEqual([]);
    expect(wrong.emitted).toEqual([]);
    expect(wrong.rejected.map((item) => item.code)).toContain("COMPANY_WORKSPACE_MISMATCH");
    expect(platform.inbox.exportState().mailOutbox[0]?.status).toBe("PENDING");

    const missingTransport = capturingTransport();
    const missingSource: CompanyMemoryDonorSourceRecord = { ...SOURCE, workspaceId: "" };
    const missing = await publishCompanyMemoryDonor({
      context: CONTEXT,
      signer,
      transport: missingTransport,
      outbox: createCrmMailOutboxDonorPort(platform.inbox, () => missingSource),
      now: NOW,
    });
    expect(missingTransport.requests).toEqual([]);
    expect(missing.emitted).toEqual([]);
    expect(missing.rejected.map((item) => item.code)).toContain("COMPANY_WORKSPACE_REQUIRED");
    expect(platform.inbox.exportState().mailOutbox[0]?.status).toBe("PENDING");
  });

  it("does not write personal memory", async () => {
    const source = readFileSync(DONOR_SOURCE, "utf8");
    expect(source).not.toMatch(/sb remember|\/api\/remember|sb_remember|sb_search|personal vault/i);

    const { signer } = createSigner();
    const platform = seedInbox();
    const transport = capturingTransport();
    await publishCompanyMemoryDonor({
      context: CONTEXT,
      signer,
      transport,
      outbox: createCrmMailOutboxDonorPort(platform.inbox, () => SOURCE),
      now: NOW,
    });
    expect(transport.rememberCalls).toEqual([]);
    expect(transport.requests).toHaveLength(1);
    const envelope = JSON.parse(Buffer.from(transport.requests[0]!).toString("utf8")) as {
      arguments: unknown;
      authority: unknown;
    };
    expect(envelope).toEqual(
      expect.objectContaining({
        arguments: expect.any(Object),
        authority: expect.any(Object),
      }),
    );
  });

  it("is idempotent on the CRM outbox and leaves rows pending without a matching receipt", async () => {
    const { signer } = createSigner();
    const platform = seedInbox();
    const transport = capturingTransport();
    const outbox = createCrmMailOutboxDonorPort(platform.inbox, () => SOURCE);
    const input = { context: CONTEXT, signer, transport, outbox, now: NOW };

    const first = await publishCompanyMemoryDonor(input);
    const second = await publishCompanyMemoryDonor(input);
    expect(first.emitted).toEqual(["outbox-inbox-receipt-1"]);
    expect(second.emitted).toEqual([]);
    expect(second.attempted).toBe(0);
    expect(transport.requests).toHaveLength(1);
    expect(platform.inbox.exportState().mailOutbox[0]?.status).toBe("EMITTED");

    const pendingPlatform = seedInbox();
    const failed = capturingTransport({ exitCode: 2 });
    const denied = await publishCompanyMemoryDonor({
      context: CONTEXT,
      signer,
      transport: failed,
      outbox: createCrmMailOutboxDonorPort(pendingPlatform.inbox, () => SOURCE),
      now: NOW,
    });
    expect(denied.emitted).toEqual([]);
    expect(denied.pending).toEqual(["outbox-inbox-receipt-1"]);
    expect(pendingPlatform.inbox.exportState().mailOutbox[0]?.status).toBe("PENDING");

    const mismatchPlatform = seedInbox();
    const mismatched = capturingTransport({
      mutate: (receipt) => ({ ...receipt, workspace_id: OTHER_WORKSPACE }),
    });
    const mismatch = await publishCompanyMemoryDonor({
      context: CONTEXT,
      signer,
      transport: mismatched,
      outbox: createCrmMailOutboxDonorPort(mismatchPlatform.inbox, () => SOURCE),
      now: NOW,
    });
    expect(mismatch.emitted).toEqual([]);
    expect(mismatchPlatform.inbox.exportState().mailOutbox[0]?.status).toBe("PENDING");
  });

  it("does not implement the Mail product adapter", () => {
    expect(MAIL_COMPANY_MEMORY_ADAPTER_STATUS).toBe("not_implemented");
    let code: string | undefined;
    try {
      createMailProductDonorPort();
    } catch (error) {
      code = error instanceof CompanyMemoryDonorError ? error.code : undefined;
    }
    expect(code).toBe("MAIL_ADAPTER_NOT_IMPLEMENTED");
  });
});
