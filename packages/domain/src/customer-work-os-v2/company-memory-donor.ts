/**
 * CRM-only company-memory donor publisher.
 *
 * Maps authenticated CWOS mail-outbox rows into a signed `sb-company` receive
 * envelope. Acknowledgement (PENDING → EMITTED) happens only after exit 0 and a
 * matching workspace / request-digest / operation / candidate / state receipt.
 *
 * Signing material is operator-injected. This module does not invent a shared
 * key with Second Brain. The Mail product adapter is not implemented here.
 */
import { createHash } from "node:crypto";
import {
  type MailOutboxEvent,
  type UnifiedInboxService,
} from "./inbox.js";

const AUTHORITY_DOMAIN = Buffer.from("second-brain/company-memory-authority/v1\0");
const REQUEST_DOMAIN = Buffer.from("second-brain/company-memory-request/v1\0");
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOSED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const MAIL_COMPANY_MEMORY_ADAPTER_STATUS = "not_implemented" as const;

export type CompanyMemoryJson =
  | null
  | boolean
  | number
  | string
  | CompanyMemoryJson[]
  | { [key: string]: CompanyMemoryJson };

export class CompanyMemoryDonorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyMemoryDonorError";
  }
}

export interface CompanyMemoryDonorTrustedContext {
  providerInstanceId: string;
  workspaceId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
  projects: readonly string[];
  policyRevision: string;
  deletionSequence: number;
  deletionSetRoot: string;
}

export interface CompanyMemoryDonorSigner {
  readonly keyId: string;
  sign(message: Uint8Array): Uint8Array;
}

export interface CompanyMemoryCliResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface CompanyMemoryCliTransport {
  invoke(canonicalRequest: Uint8Array): Promise<CompanyMemoryCliResult>;
}

export interface CompanyMemoryDonorSourceRecord {
  workspaceId: string;
  provider: string;
  mailbox: string;
  sourceLocator: string;
  sourceEventId: string;
  content: string;
  parserVersion: string;
  locator: { readonly [key: string]: string | number };
}

export interface CompanyMemoryDonorPending {
  event: MailOutboxEvent;
  source: CompanyMemoryDonorSourceRecord | null;
}

export interface CompanyMemoryDonorOutbox {
  listPending(): readonly CompanyMemoryDonorPending[];
  markEmitted(workspaceId: string, id: string): void;
}

export interface CompanyMemoryDonorRejection {
  id: string;
  code: string;
}

export interface CompanyMemoryDonorTickResult {
  attempted: number;
  emitted: string[];
  pending: string[];
  rejected: CompanyMemoryDonorRejection[];
}

export function canonicalCompanyMemoryBytes(value: unknown): Uint8Array {
  const text = JSON.stringify(canonicalize(value));
  if ([...text].some((character) => character.charCodeAt(0) < 32 && character !== "\t" && character !== "\n" && character !== "\r")) {
    throw new CompanyMemoryDonorError("NON_CANONICAL_CONTROL", "canonical json contains control characters");
  }
  if (text.normalize("NFC") !== text) {
    throw new CompanyMemoryDonorError("NON_CANONICAL_NFC", "canonical json is not NFC");
  }
  return Buffer.from(text, "utf8");
}

export function createMailProductDonorPort(): never {
  throw new CompanyMemoryDonorError(
    "MAIL_ADAPTER_NOT_IMPLEMENTED",
    "Mail company-memory donor adapter is not implemented in CRM; Mail remains a later sequential task",
  );
}

export function createCrmMailOutboxDonorPort(
  inbox: UnifiedInboxService,
  resolveSource: (event: MailOutboxEvent) => CompanyMemoryDonorSourceRecord | null,
): CompanyMemoryDonorOutbox {
  return {
    listPending() {
      return inbox
        .exportState()
        .mailOutbox.filter((event) => event.status === "PENDING")
        .map((event) => ({ event, source: resolveSource(event) }));
    },
    markEmitted(workspaceId: string, id: string) {
      inbox.markMailOutboxEmitted(workspaceId, id);
    },
  };
}

export async function publishCompanyMemoryDonor(input: {
  context: CompanyMemoryDonorTrustedContext;
  signer: CompanyMemoryDonorSigner;
  transport: CompanyMemoryCliTransport;
  outbox: CompanyMemoryDonorOutbox;
  now: Date;
}): Promise<CompanyMemoryDonorTickResult> {
  const context = validatedContext(input.context);
  const signer = validatedSigner(input.signer);
  const issuedAt = formatInstant(input.now);
  const expiresAt = formatInstant(new Date(input.now.getTime() + 60_000));
  const pendingRows = input.outbox.listPending();
  const emitted: string[] = [];
  const pending: string[] = [];
  const rejected: CompanyMemoryDonorRejection[] = [];

  for (const row of pendingRows) {
    const outcome = await publishOne({
      context,
      signer,
      transport: input.transport,
      outbox: input.outbox,
      row,
      issuedAt,
      expiresAt,
    });
    if (outcome.status === "emitted") {
      emitted.push(row.event.id);
    } else {
      pending.push(row.event.id);
      rejected.push({ id: row.event.id, code: outcome.code });
    }
  }

  return { attempted: pendingRows.length, emitted, pending, rejected };
}

function canonicalize(value: unknown): CompanyMemoryJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CompanyMemoryDonorError("NON_CANONICAL_JSON", "non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: { [key: string]: CompanyMemoryJson } = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  throw new CompanyMemoryDonorError("NON_CANONICAL_JSON", "unsupported json value");
}

function canonicalWorkspaceId(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!CANONICAL_UUID.test(normalized)) {
    throw new CompanyMemoryDonorError("COMPANY_WORKSPACE_REQUIRED", "workspace_id must be a canonical UUID");
  }
  return normalized;
}

function closedId(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!CLOSED_ID.test(normalized)) {
    throw new CompanyMemoryDonorError("COMPANY_AUTHORITY_REQUIRED", `${field} is not a closed identifier`);
  }
  return normalized;
}

function requiredText(value: string, field: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) {
    throw new CompanyMemoryDonorError("INVALID_INPUT", `${field} is required`);
  }
  return normalized;
}

function formatInstant(value: Date): string {
  const iso = value.toISOString();
  if (iso.length !== 24 || !iso.endsWith("Z") || !Number.isFinite(value.getTime())) {
    throw new CompanyMemoryDonorError("INSTANT_INVALID", "now must be a UTC millisecond instant");
  }
  return iso;
}

function validatedContext(context: CompanyMemoryDonorTrustedContext): CompanyMemoryDonorTrustedContext {
  const workspaceId = canonicalWorkspaceId(context.workspaceId);
  if (!Number.isSafeInteger(context.deletionSequence) || context.deletionSequence < 0) {
    throw new CompanyMemoryDonorError("COMPANY_AUTHORITY_REQUIRED", "deletion_sequence must be a non-negative integer");
  }
  if (!DIGEST.test(context.deletionSetRoot)) {
    throw new CompanyMemoryDonorError("COMPANY_AUTHORITY_REQUIRED", "deletion_set_root must be a sha256 digest");
  }
  return {
    providerInstanceId: closedId(context.providerInstanceId, "provider_instance_id"),
    workspaceId,
    principalId: requiredText(context.principalId, "principal_id"),
    agentId: closedId(context.agentId, "agent_id"),
    sessionId: closedId(context.sessionId, "session_id"),
    projects: context.projects.map((project, index) => requiredText(project, `projects[${index}]`)),
    policyRevision: closedId(context.policyRevision, "policy_revision"),
    deletionSequence: context.deletionSequence,
    deletionSetRoot: context.deletionSetRoot,
  };
}

function validatedSigner(signer: CompanyMemoryDonorSigner): CompanyMemoryDonorSigner {
  closedId(signer.keyId, "signing_key_id");
  return signer;
}

function workspaceDecision(
  contextWorkspaceId: string,
  eventWorkspaceId: string,
  sourceWorkspaceId: string | undefined,
): { ok: true } | { ok: false; code: "COMPANY_WORKSPACE_REQUIRED" | "COMPANY_WORKSPACE_MISMATCH" } {
  try {
    const eventWorkspace = canonicalWorkspaceId(eventWorkspaceId);
    if (eventWorkspace !== contextWorkspaceId) return { ok: false, code: "COMPANY_WORKSPACE_MISMATCH" };
    if (sourceWorkspaceId === undefined) return { ok: true };
    const sourceWorkspace = canonicalWorkspaceId(sourceWorkspaceId);
    if (sourceWorkspace !== contextWorkspaceId) return { ok: false, code: "COMPANY_WORKSPACE_MISMATCH" };
    return { ok: true };
  } catch (error) {
    if (error instanceof CompanyMemoryDonorError && error.code === "COMPANY_WORKSPACE_REQUIRED") {
      return { ok: false, code: "COMPANY_WORKSPACE_REQUIRED" };
    }
    throw error;
  }
}

function candidateId(source: CompanyMemoryDonorSourceRecord): string {
  return `crm:v1:${source.workspaceId}:${source.provider}:${source.mailbox}:${source.sourceLocator}:${source.sourceEventId}`;
}

function receiveArguments(source: CompanyMemoryDonorSourceRecord): { [key: string]: CompanyMemoryJson } {
  const locator: { [key: string]: string | number } = {};
  for (const [key, value] of Object.entries(source.locator)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      locator[requiredText(key, "locator.key")] = value;
      continue;
    }
    if (typeof value !== "string") {
      throw new CompanyMemoryDonorError("INVALID_INPUT", "locator values must be strings or finite numbers");
    }
    locator[requiredText(key, "locator.key")] = requiredText(value, "locator.value");
  }
  return {
    candidate_id: candidateId(source),
    source_system: "crm",
    source_locator: requiredText(source.sourceLocator, "source_locator"),
    source_event_id: requiredText(source.sourceEventId, "source_event_id"),
    content: requiredText(source.content, "content"),
    parser_version: requiredText(source.parserVersion, "parser_version"),
    locator,
  };
}

function requestDigest(operation: "receive", argumentsValue: { [key: string]: CompanyMemoryJson }): string {
  const digest = createHash("sha256")
    .update(REQUEST_DOMAIN)
    .update(canonicalCompanyMemoryBytes({ arguments: argumentsValue, operation }))
    .digest("hex");
  return `sha256:${digest}`;
}

function nonceFor(eventId: string): string {
  const cleaned = eventId.normalize("NFC").replace(/[^A-Za-z0-9._:-]/g, ":");
  const nonce = `crm:${cleaned}`;
  if (CLOSED_ID.test(nonce) && nonce.length <= 128) return nonce;
  return `crm:${createHash("sha256").update(eventId).digest("hex")}`;
}

function signedRequest(input: {
  context: CompanyMemoryDonorTrustedContext;
  signer: CompanyMemoryDonorSigner;
  argumentsValue: { [key: string]: CompanyMemoryJson };
  eventId: string;
  issuedAt: string;
  expiresAt: string;
}): { request: Uint8Array; digest: string; candidateId: string } {
  const argumentsValue = input.argumentsValue;
  const digest = requestDigest("receive", argumentsValue);
  const candidate = argumentsValue.candidate_id;
  if (typeof candidate !== "string") {
    throw new CompanyMemoryDonorError("INVALID_INPUT", "candidate_id is required");
  }
  const unsigned: { [key: string]: CompanyMemoryJson } = {
    schema_version: 1,
    provider_instance_id: input.context.providerInstanceId,
    workspace_id: input.context.workspaceId,
    principal_id: input.context.principalId,
    agent_id: input.context.agentId,
    session_id: input.context.sessionId,
    projects: [...input.context.projects],
    policy_revision: input.context.policyRevision,
    purpose: "company_memory_receive",
    operation: "receive",
    request_digest: digest,
    deletion_sequence: input.context.deletionSequence,
    deletion_set_root: input.context.deletionSetRoot,
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    nonce: nonceFor(input.eventId),
    signing_key_id: input.signer.keyId,
  };
  const signature = input.signer.sign(Buffer.concat([AUTHORITY_DOMAIN, canonicalCompanyMemoryBytes(unsigned)]));
  if (signature.byteLength !== 64) {
    throw new CompanyMemoryDonorError("COMPANY_AUTHORITY_REQUIRED", "Ed25519 signature must be 64 bytes");
  }
  const encoded = Buffer.from(signature).toString("base64url");
  if (encoded.includes("=")) {
    throw new CompanyMemoryDonorError("COMPANY_AUTHORITY_REQUIRED", "signature must be unpadded base64url");
  }
  const request = canonicalCompanyMemoryBytes({
    arguments: argumentsValue,
    authority: { ...unsigned, signature: encoded },
  });
  return { request, digest, candidateId: candidate };
}

function parseReceipt(stdout: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(stdout).toString("utf8").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const receipt = (parsed as { receipt?: unknown }).receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
    return receipt as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function receiptMatches(
  receipt: Record<string, unknown>,
  expected: {
    workspaceId: string;
    requestDigest: string;
    operation: "receive";
    candidateId: string;
    state: "candidate";
  },
): boolean {
  const result = receipt.result;
  const state =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { state?: unknown }).state
      : undefined;
  return (
    receipt.workspace_id === expected.workspaceId &&
    receipt.request_digest === expected.requestDigest &&
    receipt.operation === expected.operation &&
    receipt.candidate_id === expected.candidateId &&
    state === expected.state
  );
}

async function publishOne(input: {
  context: CompanyMemoryDonorTrustedContext;
  signer: CompanyMemoryDonorSigner;
  transport: CompanyMemoryCliTransport;
  outbox: CompanyMemoryDonorOutbox;
  row: CompanyMemoryDonorPending;
  issuedAt: string;
  expiresAt: string;
}): Promise<{ status: "emitted" } | { status: "pending"; code: string }> {
  const event = input.row.event;
  if (event.status === "EMITTED") return { status: "emitted" };

  const workspace = workspaceDecision(input.context.workspaceId, event.workspaceId, input.row.source?.workspaceId);
  if (!workspace.ok) return { status: "pending", code: workspace.code };
  if (!input.row.source) return { status: "pending", code: "COMPANY_SOURCE_REQUIRED" };

  let request: Uint8Array;
  let digest: string;
  let candidate: string;
  try {
    const built = signedRequest({
      context: input.context,
      signer: input.signer,
      argumentsValue: receiveArguments(input.row.source),
      eventId: event.id,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    request = built.request;
    digest = built.digest;
    candidate = built.candidateId;
  } catch (error) {
    const code = error instanceof CompanyMemoryDonorError ? error.code : "COMPANY_REQUEST_INVALID";
    return { status: "pending", code };
  }

  let result: CompanyMemoryCliResult;
  try {
    result = await input.transport.invoke(request);
  } catch {
    return { status: "pending", code: "COMPANY_TRANSPORT_FAILED" };
  }
  if (result.exitCode !== 0) return { status: "pending", code: "COMPANY_RECEIPT_REQUIRED" };

  const receipt = parseReceipt(result.stdout);
  if (
    !receipt ||
    !receiptMatches(receipt, {
      workspaceId: input.context.workspaceId,
      requestDigest: digest,
      operation: "receive",
      candidateId: candidate,
      state: "candidate",
    })
  ) {
    return { status: "pending", code: "COMPANY_RECEIPT_MISMATCH" };
  }

  input.outbox.markEmitted(event.workspaceId, event.id);
  return { status: "emitted" };
}
