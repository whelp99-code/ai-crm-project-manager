import { createHash } from "node:crypto";
import {
  canonicalCompanyMemoryBytes, CompanyMemoryDonorError,
  type CompanyMemoryCliTransport, type CompanyMemoryDonorSigner,
  type CompanyMemoryDonorTrustedContext, type NormalizedArchiveReference,
} from "@ai-crm/domain/customer-work-os-v2";
import { v2Hash } from "./customer-work-os-v2-runtime.js";

export const NATIVE_REFERENCE_PARSER = "crm:normalized-archive:1";
const authorityDomain = Buffer.from("second-brain/company-memory-authority/v1\0");
const requestDomain = Buffer.from("second-brain/company-memory-request/v1\0");
export interface NativeReferenceReceipt {
  readonly receipt_id: string;
  readonly receipt_digest: string;
  readonly workspace_id: string;
  readonly request_digest: string;
  readonly operation: "receive";
  readonly candidate_id: string;
  readonly result: { readonly state: "candidate" };
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanyMemoryDonorError("COMPANY_SOURCE_BINDING_MISMATCH", "expected source or receipt object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** Locator describes the immutable source revision, never its publication event kind. */
export function nativeReferenceLocator(reference: NormalizedArchiveReference): string {
  return `cwos:v2:${reference.workspaceId}:${reference.planId}:${reference.planVersion}:${reference.sourceDigest}`;
}

/** Only matching installed-CLI receipts may advance the caller's native acknowledgement. */
export async function publishNativeArchiveReference(input: {
  readonly reference: NormalizedArchiveReference;
  readonly sourceBytes: Uint8Array;
  readonly context: CompanyMemoryDonorTrustedContext;
  readonly signer: CompanyMemoryDonorSigner;
  readonly transport: CompanyMemoryCliTransport;
  readonly eventId: string;
  readonly now: Date;
  readonly acknowledge: (receipt: NativeReferenceReceipt) => Promise<void>;
}): Promise<NativeReferenceReceipt> {
  const source: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.sourceBytes));
  const projection = object(source);
  const reference = input.reference;
  if (input.context.workspaceId !== reference.workspaceId || projection.workspaceId !== reference.workspaceId) {
    throw new CompanyMemoryDonorError("COMPANY_WORKSPACE_MISMATCH", "source and caller workspace must match");
  }
  if (reference.approved !== false || projection.authority !== "ARCHIVE_PROJECTION_ONLY" ||
      projection.planId !== reference.planId ||
      projection.planVersion !== reference.planVersion || v2Hash(source) !== reference.sourceDigest) {
    throw new CompanyMemoryDonorError("COMPANY_SOURCE_BINDING_MISMATCH", "native reference must bind the original archive");
  }
  const argumentsValue = {
    candidate_id: `crm:v2:${reference.workspaceId}:${reference.id}`,
    source_system: "crm", source_locator: nativeReferenceLocator(reference),
    source_event_id: reference.id, parser_version: NATIVE_REFERENCE_PARSER,
    content_digest: `sha256:${createHash("sha256").update(input.sourceBytes).digest("hex")}`,
    locator: {
      kind: "normalized_archive_reference", authority: "ARCHIVE_PROJECTION_ONLY",
      approved: "false", plan_id: reference.planId, plan_version: reference.planVersion,
      source_digest: reference.sourceDigest,
    },
  };
  const requestDigest = `sha256:${createHash("sha256").update(requestDomain)
    .update(canonicalCompanyMemoryBytes({ operation: "receive", arguments: argumentsValue })).digest("hex")}`;
  const unsigned = {
    schema_version: 1, provider_instance_id: input.context.providerInstanceId,
    workspace_id: reference.workspaceId, principal_id: input.context.principalId,
    agent_id: input.context.agentId, session_id: input.context.sessionId,
    projects: [...input.context.projects], policy_revision: input.context.policyRevision,
    purpose: "company_memory_receive", operation: "receive", request_digest: requestDigest,
    deletion_sequence: input.context.deletionSequence, deletion_set_root: input.context.deletionSetRoot,
    issued_at: input.now.toISOString(), expires_at: new Date(input.now.getTime() + 60_000).toISOString(),
    nonce: `crm:${createHash("sha256").update(input.eventId).digest("hex")}`,
    signing_key_id: input.signer.keyId,
  };
  const signature = Buffer.from(input.signer.sign(Buffer.concat([
    authorityDomain, canonicalCompanyMemoryBytes(unsigned),
  ]))).toString("base64url");
  const reply = await input.transport.invoke(canonicalCompanyMemoryBytes({
    arguments: argumentsValue, authority: { ...unsigned, signature },
  }));
  if (reply.exitCode !== 0) {
    throw new CompanyMemoryDonorError("COMPANY_RECEIPT_REQUIRED", "installed CLI denied the request");
  }
  const response = object(JSON.parse(Buffer.from(reply.stdout).toString("utf8")));
  const received = object(response.receipt);
  const result = object(received.result);
  if (typeof received.receipt_id !== "string" || typeof received.receipt_digest !== "string" ||
      received.workspace_id !== reference.workspaceId || received.request_digest !== requestDigest ||
      received.operation !== "receive" || result.state !== "candidate" ||
      received.candidate_id !== argumentsValue.candidate_id) {
    throw new CompanyMemoryDonorError("COMPANY_RECEIPT_MISMATCH", "receipt does not bind this source request");
  }
  const receipt: NativeReferenceReceipt = {
    receipt_id: received.receipt_id, receipt_digest: received.receipt_digest,
    workspace_id: reference.workspaceId, request_digest: requestDigest,
    operation: "receive", candidate_id: argumentsValue.candidate_id, result: { state: "candidate" },
  };
  await input.acknowledge(receipt);
  return receipt;
}
