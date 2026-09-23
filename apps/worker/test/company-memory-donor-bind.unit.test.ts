import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadCompanyMemoryDonorBind,
  runBoundCompanyMemoryDonorTick,
} from "../src/company-memory-donor-bind.js";

const WORKSPACE = "12345678-1234-4234-8234-123456789abc";
const NOW = new Date("2026-09-23T10:00:00.000Z");
const BIND_SOURCE = fileURLToPath(new URL("../src/company-memory-donor-bind.ts", import.meta.url));
const MAIN_SOURCE = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const AUTHORITY = {
  keyId: "crm-donor-key:1",
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

const SOURCE = {
  workspaceId: WORKSPACE,
  provider: "gmail",
  mailbox: "ops@example.test",
  sourceLocator: "thread/t1",
  sourceEventId: "event-1",
  content: "synthetic crm evidence",
  parserVersion: "crm:mail-outbox:1",
  locator: { kind: "mail_inbox", ordinal: 1 },
};

const EVENT = {
  id: "outbox-inbox-receipt-1",
  workspaceId: WORKSPACE,
  kind: "INBOX_RECEIVED" as const,
  workItemId: null,
  sourceEventId: SOURCE.sourceEventId,
  linkId: null,
  status: "PENDING" as const,
  createdAt: "2026-09-23T09:00:00.000Z",
  version: 1,
};

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  fs.writeFileSync(
    path.join(__dirname, "invoked.json"),
    JSON.stringify({ argv: process.argv.slice(2), raw }),
  );
  const envelope = JSON.parse(raw);
  process.stdout.write(
    JSON.stringify({
      receipt: {
        receipt_id: "cmreceipt:v1:${"b".repeat(64)}",
        receipt_digest: "sha256:${"b".repeat(64)}",
        workspace_id: envelope.authority.workspace_id,
        request_digest: envelope.authority.request_digest,
        operation: envelope.authority.operation,
        candidate_id: envelope.arguments.candidate_id,
        result: { state: "candidate" },
        created_at: "2026-09-23T10:00:00.000Z",
      },
    }) + "\\n",
  );
});
`;

const PERSONAL_SB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "sb-invoked.txt"), "remember\\n");
process.exit(99);
`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "crm-donor-bind-"));
}

function writePem(dir: string): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = join(dir, "donor-ed25519.pem");
  writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
  return file;
}

function writeAuthority(dir: string): string {
  const file = join(dir, "authority.json");
  writeFileSync(file, `${JSON.stringify(AUTHORITY)}\n`);
  return file;
}

function writeConfig(dir: string): string {
  const file = join(dir, "sb-company-config.json");
  writeFileSync(file, `${JSON.stringify({ schema_version: 1, workspace_id: WORKSPACE })}\n`);
  return file;
}

function writeExecutable(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function completeEnv(dir: string): Record<string, string> {
  const command = writeExecutable(dir, "sb-company", STUB);
  writeExecutable(dir, "sb", PERSONAL_SB);
  return {
    COMPANY_MEMORY_SB_COMPANY: command,
    COMPANY_MEMORY_SB_COMPANY_CONFIG: writeConfig(dir),
    COMPANY_MEMORY_SIGNING_KEY_FILE: writePem(dir),
    COMPANY_MEMORY_AUTHORITY_FILE: writeAuthority(dir),
  };
}

function pendingOutbox() {
  const emitted: string[] = [];
  return {
    emitted,
    listPending() {
      if (emitted.includes(EVENT.id)) return [];
      return [{ event: EVENT, source: SOURCE }];
    },
    markEmitted(_workspaceId: string, id: string) {
      emitted.push(id);
    },
  };
}

function pendingPgRow() {
  return {
    id: EVENT.id,
    workspace_id: WORKSPACE,
    kind: EVENT.kind,
    work_item_id: EVENT.workItemId,
    source_event_id: EVENT.sourceEventId,
    link_id: EVENT.linkId,
    status: EVENT.status,
    created_at: EVENT.createdAt,
    version: EVENT.version,
    provider: SOURCE.provider,
    mailbox: SOURCE.mailbox,
    source_locator: SOURCE.sourceLocator,
    resolved_source_event_id: SOURCE.sourceEventId,
  };
}

function fakeCwosQueryable(options: {
  missingTable?: boolean;
  queryError?: Error;
  rows?: Record<string, unknown>[];
}) {
  const statements: string[] = [];
  const updates: unknown[][] = [];
  return {
    statements,
    updates,
    async query(text: string, params?: unknown[]) {
      statements.push(text);
      if (options.queryError) throw options.queryError;
      if (text.includes("to_regclass")) {
        return {
          rows: [{ outbox_reg: options.missingTable ? null : "cwos_v2_mail_outbox" }],
          rowCount: 1,
        };
      }
      if (/\bupdate\b/i.test(text)) {
        updates.push([...(params ?? [])]);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("cwos_v2_mail_outbox")) {
        return { rows: options.rows ?? [], rowCount: (options.rows ?? []).length };
      }
      throw new Error(`unexpected donor outbox sql: ${text}`);
    },
  };
}

describe("worker company-memory donor bind", () => {
  it("stays disabled when donor env is absent", async () => {
    expect(loadCompanyMemoryDonorBind({})).toEqual({ enabled: false });
    const skipped = await runBoundCompanyMemoryDonorTick({});
    expect(skipped).toEqual({ skipped: true });
  });

  it("fails closed when donor env is incomplete or unknown", () => {
    const dir = tempDir();
    try {
      const command = writeExecutable(dir, "sb-company", STUB);
      expect(() =>
        loadCompanyMemoryDonorBind({ COMPANY_MEMORY_SB_COMPANY: command }),
      ).toThrowError(/COMPANY_MEMORY_ENV_INCOMPLETE/);
      expect(existsSync(join(dir, "invoked.json"))).toBe(false);

      const complete = completeEnv(dir);
      expect(() =>
        loadCompanyMemoryDonorBind({ ...complete, COMPANY_MEMORY_FOO: "1" }),
      ).toThrowError(/COMPANY_MEMORY_ENV_INCOMPLETE/);

      expect(() =>
        loadCompanyMemoryDonorBind({
          ...complete,
          COMPANY_MEMORY_SIGNING_KEY_FILE: join(dir, "missing.pem"),
        }),
      ).toThrowError(/COMPANY_MEMORY_ENV_INCOMPLETE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects personal sb and does not invoke it", () => {
    const dir = tempDir();
    try {
      const env = completeEnv(dir);
      env.COMPANY_MEMORY_SB_COMPANY = join(dir, "sb");
      expect(() => loadCompanyMemoryDonorBind(env)).toThrowError(/COMPANY_MEMORY_COMMAND_INVALID/);
      expect(existsSync(join(dir, "sb-invoked.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ticks the isolated sb-company command with key files and marks outbox emitted", async () => {
    const dir = tempDir();
    try {
      const env = completeEnv(dir);
      const bind = loadCompanyMemoryDonorBind(env);
      expect(bind.enabled).toBe(true);
      if (!bind.enabled) throw new Error("expected enabled bind");
      expect(bind.command.endsWith("/sb-company")).toBe(true);

      const outbox = pendingOutbox();
      const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW, outbox });
      expect(ran.skipped).toBe(false);
      if (ran.skipped) throw new Error("expected donor tick");
      expect(ran.result.emitted).toEqual(["outbox-inbox-receipt-1"]);
      expect(ran.result.pending).toEqual([]);
      expect(outbox.emitted).toEqual(["outbox-inbox-receipt-1"]);

      const invoked = JSON.parse(readFileSync(join(dir, "invoked.json"), "utf8")) as {
        argv: string[];
        raw: string;
      };
      expect(invoked.argv).toEqual(["--config", env.COMPANY_MEMORY_SB_COMPANY_CONFIG]);
      const envelope = JSON.parse(invoked.raw) as {
        arguments: { source_system: string };
        authority: { workspace_id: string; operation: string };
      };
      expect(Object.keys(envelope).sort()).toEqual(["arguments", "authority"]);
      expect(envelope.arguments.source_system).toBe("crm");
      expect(envelope.authority.workspace_id).toBe(WORKSPACE);
      expect(envelope.authority.operation).toBe("receive");
      expect(existsSync(join(dir, "sb-invoked.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an empty outbox when donor env is complete and DATABASE_URL is absent", async () => {
    const dir = tempDir();
    try {
      const env = completeEnv(dir);
      const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW });
      expect(ran.skipped).toBe(false);
      if (ran.skipped) throw new Error("expected donor tick");
      expect(ran.result).toEqual({ attempted: 0, emitted: [], pending: [], rejected: [] });
      expect(existsSync(join(dir, "invoked.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when DATABASE_URL is set but CWOS outbox cannot be bound", async () => {
    const dir = tempDir();
    try {
      const env: Record<string, string> = {
        ...completeEnv(dir),
        DATABASE_URL: "postgres://unit.test/crm",
      };
      await expect(runBoundCompanyMemoryDonorTick(env, { now: NOW })).rejects.toThrowError(
        /COMPANY_MEMORY_OUTBOX_UNAVAILABLE/,
      );
      expect(existsSync(join(dir, "invoked.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when CWOS mail outbox schema is unavailable", async () => {
    const dir = tempDir();
    try {
      const env: Record<string, string> = {
        ...completeEnv(dir),
        DATABASE_URL: "postgres://unit.test/crm",
      };
      const queryable = fakeCwosQueryable({ missingTable: true });
      await expect(
        runBoundCompanyMemoryDonorTick(env, { now: NOW, queryable }),
      ).rejects.toThrowError(/COMPANY_MEMORY_OUTBOX_UNAVAILABLE/);
      expect(existsSync(join(dir, "invoked.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ticks pending CWOS mail outbox rows from PG when DATABASE_URL is bound", async () => {
    const dir = tempDir();
    try {
      const env: Record<string, string> = {
        ...completeEnv(dir),
        DATABASE_URL: "postgres://unit.test/crm",
      };
      const queryable = fakeCwosQueryable({ rows: [pendingPgRow()] });
      const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW, queryable });
      expect(ran.skipped).toBe(false);
      if (ran.skipped) throw new Error("expected donor tick");
      expect(ran.result.attempted).toBe(1);
      expect(ran.result.emitted).toEqual(["outbox-inbox-receipt-1"]);
      expect(ran.result.pending).toEqual([]);
      expect(queryable.updates).toEqual([[WORKSPACE, "outbox-inbox-receipt-1"]]);

      const invoked = JSON.parse(readFileSync(join(dir, "invoked.json"), "utf8")) as {
        argv: string[];
        raw: string;
      };
      expect(invoked.argv).toEqual(["--config", env.COMPANY_MEMORY_SB_COMPANY_CONFIG]);
      const envelope = JSON.parse(invoked.raw) as {
        arguments: { source_system: string; source_event_id: string };
        authority: { workspace_id: string; operation: string };
      };
      expect(envelope.arguments.source_system).toBe("crm");
      expect(envelope.arguments.source_event_id).toBe(SOURCE.sourceEventId);
      expect(envelope.authority.workspace_id).toBe(WORKSPACE);
      expect(envelope.authority.operation).toBe("receive");
      expect(existsSync(join(dir, "sb-invoked.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not bind personal memory APIs and is wired into the worker process", () => {
    const bindSource = readFileSync(BIND_SOURCE, "utf8");
    const mainSource = readFileSync(MAIN_SOURCE, "utf8");
    expect(bindSource).not.toMatch(/sb remember|\/api\/remember|sb_remember|sb_search|personal vault/i);
    expect(mainSource).not.toMatch(/sb remember|\/api\/remember|sb_remember|sb_search/i);
    expect(mainSource).toContain("loadCompanyMemoryDonorBind");
    expect(mainSource).toContain("runBoundCompanyMemoryDonorTick");
    expect(mainSource).toMatch(/runBoundCompanyMemoryDonorTick\([\s\S]*queryable/);
    expect(mainSource).toContain("outboxNotifier");
  });
});
