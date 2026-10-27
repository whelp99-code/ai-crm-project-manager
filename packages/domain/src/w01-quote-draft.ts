import {
  CustomerWorkOsError,
  customerWorkOsPayloadHash,
  type BomLine,
  type Engagement,
  type MoneyKrw,
  type Quote,
} from "./customer-work-os.js";

export interface SourceLinkedBomLine extends BomLine {
  sourceId: string;
}

export interface W01VatEvidence {
  netAmountKrw: MoneyKrw;
  vatAmountKrw: MoneyKrw;
  grossAmountKrw: MoneyKrw;
}

export interface W01PurchaseOrderIdentity {
  customerPoId: string;
  supplierPoId: string;
}

export interface W01QuoteDraft {
  identity: string;
  quote: Quote;
  engagementVersion: number;
  sourceLineIds: string[];
  options: string[];
  templateRef: string;
  templatePreview: { accepted: false; reason: "TEMPLATE_UNVERIFIED" };
  templateObservation?: {
    filename: string;
    sha256: string;
    sheetNames: string[];
    bytes?: number;
    mountedItemId?: string;
    sameHistoricalDocument: false;
    approvalVerified: false;
  };
  vat: W01VatEvidence;
  po: W01PurchaseOrderIdentity;
}

export interface W01QuoteDraftInput {
  engagement: Pick<Engagement, "id" | "workspaceId" | "version">;
  versionLabel: string;
  validUntil: string;
  scope: string;
  lines: SourceLinkedBomLine[];
  options: string[];
  templateRef: string;
  templateObservation?: {
    filename: string;
    sha256: string;
    sheetNames: string[];
    bytes?: number;
    mountedItemId?: string;
    sameHistoricalDocument: false;
    approvalVerified: false;
  };
  vat: W01VatEvidence;
  po: W01PurchaseOrderIdentity;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerWorkOsError("INVALID_INPUT", `${field} is required`);
  return normalized;
}

function integerKrw(value: MoneyKrw, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new CustomerWorkOsError("INVALID_MONEY", `${field} must be an integer KRW string`);
  return BigInt(value);
}

function buildDraft(input: W01QuoteDraftInput): W01QuoteDraft {
  const workspaceId = required(input.engagement.workspaceId, "engagement.workspaceId");
  const engagementId = required(input.engagement.id, "engagement.id");
  if (!Number.isInteger(input.engagement.version) || input.engagement.version < 1) {
    throw new CustomerWorkOsError("INVALID_INPUT", "engagement.version must be a positive integer");
  }
  const versionLabel = required(input.versionLabel, "versionLabel");
  const templateRef = required(input.templateRef, "templateRef");
  const customerPoId = required(input.po.customerPoId, "po.customerPoId");
  const supplierPoId = required(input.po.supplierPoId, "po.supplierPoId");
  if (customerPoId === supplierPoId) {
    throw new CustomerWorkOsError("PO_IDENTITY_COLLISION", "customer and supplier PO identities must differ");
  }
  if (input.lines.length === 0) throw new CustomerWorkOsError("EMPTY_BOM", "quote requires source-linked BOM lines");
  if (!Array.isArray(input.options) || input.options.some((item) => typeof item !== "string")) {
    throw new CustomerWorkOsError("INVALID_INPUT", "options must be a string array");
  }
  const sourceIds = new Set<string>();
  const lineIds = new Set<string>();
  let totalCost = 0n;
  let totalPrice = 0n;
  const bomLines: BomLine[] = [];
  const sourceLineIds: string[] = [];
  for (const line of input.lines) {
    const sourceId = required(line.sourceId, "line.sourceId");
    const lineId = required(line.id, "line.id");
    if (sourceIds.has(sourceId) || lineIds.has(lineId)) {
      throw new CustomerWorkOsError("DUPLICATE_ID", `duplicate source-linked line: ${sourceId}`);
    }
    sourceIds.add(sourceId);
    lineIds.add(lineId);
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new CustomerWorkOsError("INVALID_QUANTITY", `${lineId} quantity must be a positive integer`);
    }
    totalCost += integerKrw(line.unitCostKrw, `${lineId} unit cost`) * BigInt(line.quantity);
    totalPrice += integerKrw(line.unitPriceKrw, `${lineId} unit price`) * BigInt(line.quantity);
    sourceLineIds.push(sourceId);
    const stored: BomLine = {
      id: lineId,
      productId: required(line.productId, "line.productId"),
      description: line.description,
      quantity: line.quantity,
      unitCostKrw: line.unitCostKrw,
      unitPriceKrw: line.unitPriceKrw,
    };
    if (line.vendorAccountId !== undefined) stored.vendorAccountId = required(line.vendorAccountId, "line.vendorAccountId");
    bomLines.push(stored);
  }
  const net = integerKrw(input.vat.netAmountKrw, "vat.netAmountKrw");
  const tax = integerKrw(input.vat.vatAmountKrw, "vat.vatAmountKrw");
  const gross = integerKrw(input.vat.grossAmountKrw, "vat.grossAmountKrw");
  if (net + tax !== gross) throw new CustomerWorkOsError("VAT_MISMATCH", "gross amount must equal net plus VAT");
  if (net !== totalPrice) throw new CustomerWorkOsError("VAT_MISMATCH", "VAT net must equal the quote price total");
  const options = [...input.options];
  const po = { customerPoId, supplierPoId };
  const vat = {
    netAmountKrw: net.toString(),
    vatAmountKrw: tax.toString(),
    grossAmountKrw: gross.toString(),
  };
  let templateObservation: NonNullable<W01QuoteDraft["templateObservation"]> | undefined;
  if (input.templateObservation) {
    const filename = required(input.templateObservation.filename, "templateObservation.filename");
    const sha256 = required(input.templateObservation.sha256, "templateObservation.sha256");
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CustomerWorkOsError("INVALID_INPUT", "template sha256 must be 64 hex characters");
    const sheetNames = input.templateObservation.sheetNames.map((name) => required(name, "templateObservation.sheetName"));
    if (sheetNames.length === 0) throw new CustomerWorkOsError("INVALID_INPUT", "template observation requires sheet names");
    if (input.templateObservation.sameHistoricalDocument !== false || input.templateObservation.approvalVerified !== false) {
      throw new CustomerWorkOsError("TEMPLATE_UNVERIFIED", "mounted file measurement is not historical identity or approval");
    }
    const mountedItemId = input.templateObservation.mountedItemId;
    templateObservation = {
      filename,
      sha256,
      sheetNames,
      sameHistoricalDocument: false,
      approvalVerified: false,
      ...(input.templateObservation.bytes === undefined ? {} : { bytes: input.templateObservation.bytes }),
      ...(mountedItemId === undefined ? {} : { mountedItemId: required(mountedItemId, "templateObservation.mountedItemId") }),
    };
  }
  const identity = customerWorkOsPayloadHash({
    workspaceId,
    engagementId,
    engagementVersion: input.engagement.version,
    versionLabel,
    sourceLineIds,
    options,
    templateRef,
    templateObservation,
    vat,
    po,
  });
  const quote: Quote = {
    id: identity,
    workspaceId,
    engagementId,
    versionLabel,
    status: "DRAFT",
    validUntil: required(input.validUntil, "validUntil"),
    bomLines,
    scope: required(input.scope, "scope"),
    exclusions: [],
    totalCostKrw: totalCost.toString(),
    totalPriceKrw: totalPrice.toString(),
    grossProfitKrw: (totalPrice - totalCost).toString(),
    marginBps: totalPrice <= 0n ? 0 : Number(((totalPrice - totalCost) * 10_000n) / totalPrice),
    version: 1,
  };
  return {
    identity,
    quote,
    engagementVersion: input.engagement.version,
    sourceLineIds,
    options,
    templateRef,
    templatePreview: { accepted: false, reason: "TEMPLATE_UNVERIFIED" },
    ...(templateObservation ? { templateObservation } : {}),
    vat,
    po,
  };
}

export function buildW01QuoteDraft(input: W01QuoteDraftInput): W01QuoteDraft {
  return buildDraft(input);
}

export function readMountedTemplateMeasurement(input: {
  filename: string;
  bytes: number;
  sha256: string;
  sheetNames: string[];
  mountedItemId: string;
  historicalCandidateId: string;
}): NonNullable<W01QuoteDraftInput["templateObservation"]> {
  const mountedItemId = required(input.mountedItemId, "mountedItemId");
  const historicalCandidateId = required(input.historicalCandidateId, "historicalCandidateId");
  if (mountedItemId === historicalCandidateId) {
    throw new CustomerWorkOsError("TEMPLATE_UNVERIFIED", "mounted id is not the historical candidate");
  }
  if (!Number.isInteger(input.bytes) || input.bytes < 1) throw new CustomerWorkOsError("INVALID_INPUT", "template bytes must be a positive integer");
  const sha256 = required(input.sha256, "sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CustomerWorkOsError("INVALID_INPUT", "template sha256 must be 64 hex characters");
  return {
    filename: required(input.filename, "filename"),
    sha256,
    sheetNames: input.sheetNames.map((name) => required(name, "sheetName")),
    bytes: input.bytes,
    mountedItemId,
    sameHistoricalDocument: false,
    approvalVerified: false,
  };
}

export function renderQuoteDraftPreview(draft: W01QuoteDraft): {
  accepted: false;
  versionLabel: string;
  engagementVersion: number;
  sheetNames: string[];
  options: string[];
  vat: W01VatEvidence;
  po: W01PurchaseOrderIdentity;
  mounted?: { itemId: string; bytes?: number; sameHistoricalDocument: false; approvalVerified: false };
} {
  const observation = draft.templateObservation;
  return {
    accepted: false,
    versionLabel: draft.quote.versionLabel,
    engagementVersion: draft.engagementVersion,
    sheetNames: [...(observation?.sheetNames ?? [])],
    options: [...draft.options],
    vat: { ...draft.vat },
    po: { ...draft.po },
    ...(observation?.mountedItemId
      ? {
          mounted: {
            itemId: observation.mountedItemId,
            ...(observation.bytes === undefined ? {} : { bytes: observation.bytes }),
            sameHistoricalDocument: false as const,
            approvalVerified: false as const,
          },
        }
      : {}),
  };
}

export interface W01QuoteDraftStore {
  rows: Map<string, W01QuoteDraft>;
  idempotency: Map<string, { requestHash: string; rowKey: string }>;
}

export function createW01QuoteDraftStore(): W01QuoteDraftStore {
  return { rows: new Map(), idempotency: new Map() };
}

export class W01QuoteDraftAdapter {
  private readonly rows: Map<string, W01QuoteDraft>;
  private readonly idempotency: Map<string, { requestHash: string; rowKey: string }>;

  constructor(store: W01QuoteDraftStore = createW01QuoteDraftStore()) {
    this.rows = store.rows;
    this.idempotency = store.idempotency;
  }

  draft(input: W01QuoteDraftInput, idempotencyKey: string): W01QuoteDraft {
    const key = required(idempotencyKey, "idempotencyKey");
    const draft = buildDraft(input);
    return this.persist(draft, key, customerWorkOsPayloadHash(input));
  }

  persist(draft: W01QuoteDraft, idempotencyKey: string, requestHash: string): W01QuoteDraft {
    const idemKey = `${draft.quote.workspaceId}:${idempotencyKey}`;
    const prior = this.idempotency.get(idemKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new CustomerWorkOsError("IDEMPOTENCY_CONFLICT", "idempotency key was used for another request");
      }
      const stored = this.rows.get(prior.rowKey);
      if (!stored) throw new CustomerWorkOsError("NOT_FOUND", "idempotent draft row is missing");
      return structuredClone(stored);
    }
    const rowKey = `${draft.quote.workspaceId}:${draft.identity}`;
    const existing = this.rows.get(rowKey);
    if (existing) return structuredClone(existing);
    const stored = structuredClone(draft);
    this.rows.set(rowKey, stored);
    this.idempotency.set(idemKey, { requestHash, rowKey });
    return structuredClone(stored);
  }

  rowsFor(workspaceId: string): W01QuoteDraft[] {
    return [...this.rows.values()]
      .filter((row) => row.quote.workspaceId === workspaceId)
      .map((row) => structuredClone(row));
  }
}
