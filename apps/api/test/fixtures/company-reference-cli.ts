import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCompanyMemoryBytes, type NormalizedArchiveReference } from "@ai-crm/domain/customer-work-os-v2";
import {
  NATIVE_REFERENCE_PARSER, nativeReferenceLocator,
} from "../../src/customer-work-os-v2-reference-publisher.js";

/** Owned company-only CLI fixtures; no direct SB database writer or personal profile. */
export async function companyReferenceCli(reference: NormalizedArchiveReference, bytes: Uint8Array) {
  const source = "/home/jm/orca/projects/second-brain-app";
  for (const [path, expected] of [
    ["sb/company_memory_sources.py", "618b6cab6fcf67874fdd5fe0cd3a22994980ffea023ca3c0b9c71b99c12e5424"],
    ["tests/test_company_memory_read_profile.py", "751e44f6d5b1367c42c06532768a8925cc7a6ffe47bdbf111b96ae70d2da5e51"],
  ]) {
    assert(path && expected);
    assert.equal(createHash("sha256").update(await readFile(join(source, path))).digest("hex"), expected);
  }
  const root = await mkdtemp(join(tmpdir(), "crm-rs-local-"));
  const sources = join(root, "sources"), company = join(root, "company"), personal = join(root, "personal");
  const configPath = join(root, "config.json"), original = join(sources, "original.json");
  const keys = generateKeyPairSync("ed25519");
  const context = {
    providerInstanceId: "provider:crm-rs-fixture", workspaceId: reference.workspaceId,
    principalId: "principal:crm-rs-service", agentId: "agent:crm-rs", sessionId: "session:crm-rs",
    projects: ["project:fixture"], policyRevision: "policy:fixture",
    deletionSequence: 0, deletionSetRoot: `sha256:${"a".repeat(64)}`,
  };
  const signer = { keyId: "fixture-key:crm-rs", sign: (message: Uint8Array) => sign(null, message, keys.privateKey) };
  const binding = {
    path: original, source_system: "crm", source_event_id: reference.id,
    parser_version: NATIVE_REFERENCE_PARSER,
    content_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
  const config = {
    schema_version: 1, company_database: join(company, "company.sqlite"), personal_data_roots: [personal],
    provider_instance_id: context.providerInstanceId, workspace_id: context.workspaceId,
    principal_id: context.principalId, agent_id: context.agentId, session_id: context.sessionId,
    projects: context.projects, policy_revision: context.policyRevision,
    deletion_sequence: context.deletionSequence, deletion_set_root: context.deletionSetRoot,
    trusted_keys: { [signer.keyId]: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") },
    source_profile: { schema_version: 1, source_roots: [sources], bindings: { [nativeReferenceLocator(reference)]: binding } },
  };
  const save = () => writeFile(configPath, canonicalCompanyMemoryBytes(config), { mode: 0o600 });
  const calls: { request: Uint8Array; stdout: Uint8Array; exitCode: number }[] = [];
  const invoke = (request: Uint8Array): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> =>
    new Promise((resolve, reject) => {
      const child = spawn(join(source, ".venv/bin/sb-company"), ["--config", configPath], {
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SB_CONFIG: join(root, "unused-personal.toml") },
      });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("close", code => {
        clearTimeout(deadline);
        const result = { exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
        if (result.exitCode !== 0) console.log("RS_LOCAL_CLI_DENIAL", result.stderr.toString());
        calls.push({ request: Buffer.from(request), stdout: result.stdout, exitCode: result.exitCode });
        resolve(result);
      });
      child.stdin.end(request);
    });
  try {
    for (const dir of [sources, company, personal]) await mkdir(dir, { mode: 0o700 });
    await writeFile(original, bytes, { mode: 0o400 });
    await save();
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return {
    context, signer, transport: { invoke }, config, binding, save, calls,
    async read(candidateId: string) {
      const args = { candidate_id: candidateId }, now = new Date();
      const requestDigest = `sha256:${createHash("sha256")
        .update("second-brain/company-memory-request/v1\0")
        .update(canonicalCompanyMemoryBytes({ operation: "read", arguments: args })).digest("hex")}`;
      const unsigned = {
        schema_version: 1, provider_instance_id: context.providerInstanceId,
        workspace_id: context.workspaceId, principal_id: context.principalId, agent_id: context.agentId,
        session_id: context.sessionId, projects: context.projects, policy_revision: context.policyRevision,
        deletion_sequence: context.deletionSequence, deletion_set_root: context.deletionSetRoot,
        purpose: "company_memory_read", operation: "read", request_digest: requestDigest,
        issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
        nonce: `read:${createHash("sha256").update(candidateId).digest("hex")}`, signing_key_id: signer.keyId,
      };
      const signature = signer.sign(Buffer.concat([
        Buffer.from("second-brain/company-memory-authority/v1\0"), canonicalCompanyMemoryBytes(unsigned),
      ])).toString("base64url");
      const result = await invoke(canonicalCompanyMemoryBytes({ arguments: args, authority: { ...unsigned, signature } }));
      assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString());
      return JSON.parse(Buffer.from(result.stdout).toString()).receipt.result;
    },
    async verifyOriginal() {
      assert.deepEqual(await readFile(original), Buffer.from(bytes));
      assert.deepEqual(await readdir(personal), []);
    },
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}
