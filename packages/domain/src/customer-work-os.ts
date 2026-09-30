export class CustomerWorkOsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerWorkOsError";
  }
}

export type MoneyKrw = string;
export type EngagementStage =
  | "INQUIRY"
  | "DISCOVERY"
  | "PROPOSAL"
  | "NEGOTIATION"
  | "CONTRACTED"
  | "DELIVERY"
  | "ACCEPTANCE"
  | "BILLING"
  | "COLLECTION"
  | "CLOSED"
  | "ON_HOLD"
  | "LOST"
  | "CANCELLED";

export interface Account {
  id: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  kinds: Array<"customer" | "partner" | "vendor" | "manufacturer" | "outsourcer" | "other">;
  status: "active" | "inactive" | "at_risk";
  sourceRef?: string;
  version: number;
}

export interface Contact {
  id: string;
  workspaceId: string;
  accountId: string;
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  stakeholderRole?: "practitioner" | "technical" | "procurement" | "decision_maker" | "influencer" | "opponent";
  roles?: string[];
  relationship?: "unknown" | "new" | "active" | "trusted" | "at_risk";
  version: number;
}

export interface Engagement {
  id: string;
  workspaceId: string;
  projectKey: string;
  name: string;
  type: "inquiry" | "opportunity" | "consulting" | "delivery" | "support" | "maintenance" | "renewal" | "internal";
  stage: EngagementStage;
  sourceStage?: string | null;
  health: "normal" | "warning" | "critical";
  ownerPrincipalId: string;
  startDate?: string;
  targetDate?: string;
  wonQuoteId?: string;
  contractId?: string;
  deliveryProjectId?: string;
  terminalReason?: string;
  version: number;
}

export interface EngagementParty {
  id: string;
  workspaceId: string;
  engagementId: string;
  accountId: string;
  role: "customer" | "prime_contractor" | "partner" | "vendor" | "manufacturer" | "delivery_partner" | "outsourcer" | "advisor";
  primary: boolean;
  commercialResponsibility: boolean;
  deliveryResponsibility: boolean;
}

export interface Activity {
  id: string;
  workspaceId: string;
  engagementId: string | null;
  accountId?: string;
  type: "email_in" | "email_out" | "call" | "meeting" | "message" | "visit" | "document" | "decision" | "note" | "finance";
  occurredAt: string;
  summary: string;
  sourceUri?: string;
  evidenceRef?: string;
  aiConfidence?: number;
  humanReviewed: boolean;
}

export type ArtifactType =
  | "customer_request"
  | "requirement_source"
  | "vendor_quote"
  | "customer_quote"
  | "proposal"
  | "contract"
  | "purchase_order"
  | "design"
  | "delivery_plan"
  | "meeting_note"
  | "change_request"
  | "test_evidence"
  | "acceptance_evidence"
  | "completion_report"
  | "tax_invoice"
  | "receipt"
  | "other";

export interface Artifact {
  id: string;
  workspaceId: string;
  engagementId: string;
  accountId?: string;
  type: ArtifactType;
  title: string;
  versionLabel: string;
  status: "DRAFT" | "REVIEW" | "APPROVED" | "SENT" | "ACCEPTED" | "SUPERSEDED";
  storageUri: string;
  contentHash?: string;
  sourceActivityId?: string;
  supersedesArtifactId?: string;
  effectiveDate?: string;
  approvedByPrincipalId?: string;
  sentAt?: string;
  acceptedAt?: string;
  metadata: Record<string, unknown>;
  version: number;
}

export interface AppliedImportPlan {
  id: string;
  workspaceId: string;
  planId: string;
  planVersion: number;
  planHash: string;
  approvalReceiptId: string;
}

export interface KnowledgeItem {
  id: string;
  workspaceId: string;
  engagementId: string;
  kind: "requirement" | "confirmed_fact" | "unknown" | "assumption" | "decision" | "risk" | "exclusion" | "acceptance_criterion" | "change";
  statement: string;
  status: "OPEN" | "VERIFYING" | "CONFIRMED" | "REJECTED" | "SUPERSEDED";
  ownerPrincipalId?: string;
  dueAt?: string;
  impact?: string;
  evidenceRef?: string;
  sourceActivityId?: string;
  version: number;
}

export interface Commitment {
  id: string;
  workspaceId: string;
  engagementId: string;
  sourceActivityId?: string;
  ownerPrincipalId: string;
  counterpartyAccountId?: string;
  description: string;
  dueAt: string | null;
  status: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: number;
  financialImpact: boolean;
  approvalRequired: boolean;
  completionEvidenceRef?: string;
  version: number;
}

export interface Product {
  id: string;
  workspaceId: string;
  sku: string;
  name: string;
  kind: "hardware" | "software" | "license" | "service" | "maintenance" | "expense";
  manufacturerAccountId?: string;
  defaultCostKrw?: MoneyKrw;
  defaultPriceKrw?: MoneyKrw;
  active: boolean;
  version: number;
}

export interface BomLine {
  id: string;
  productId: string;
  description: string;
  quantity: number;
  unitCostKrw: MoneyKrw;
  unitPriceKrw: MoneyKrw;
  vendorAccountId?: string;
}

export interface Quote {
  id: string;
  workspaceId: string;
  engagementId: string;
  versionLabel: string;
  status: "DRAFT" | "REVIEW" | "APPROVED" | "SENT" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  validUntil: string;
  bomLines: BomLine[];
  scope: string;
  exclusions: string[];
  totalCostKrw: MoneyKrw;
  totalPriceKrw: MoneyKrw;
  grossProfitKrw: MoneyKrw;
  marginBps: number;
  approvalReceiptId?: string;
  version: number;
}

export interface BillingMilestone {
  id: string;
  name: string;
  amountKrw: MoneyKrw;
  trigger: string;
  expectedDate?: string;
}

export interface Contract {
  id: string;
  workspaceId: string;
  engagementId: string;
  quoteId: string;
  title: string;
  scope: string;
  exclusions: string[];
  contractValueKrw: MoneyKrw;
  effectiveFrom: string;
  effectiveTo?: string;
  billingMilestones: BillingMilestone[];
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  version: number;
}

export interface Deliverable {
  id: string;
  title: string;
  required: boolean;
  requirementIds: string[];
  status: "PENDING" | "SUBMITTED" | "APPROVED" | "REJECTED";
  evidenceRef?: string;
}

export interface DeliveryWorkItem {
  id: string;
  title: string;
  status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  requirementIds: string[];
  deliverableId?: string;
  assigneePrincipalId?: string;
  estimatedHours?: number;
  actualHours?: number;
}

export interface DeliveryProject {
  id: string;
  workspaceId: string;
  engagementId: string;
  contractId: string;
  projectKey: string;
  status: "PLANNED" | "ACTIVE" | "ACCEPTANCE" | "AWAITING_APPROVAL" | "COMPLETE" | "CANCELLED";
  scopeBaseline: string;
  scheduleStart: string;
  scheduleEnd: string;
  requirementIds: string[];
  deliverables: Deliverable[];
  workItems: DeliveryWorkItem[];
  version: number;
}

export interface ChangeRequest {
  id: string;
  workspaceId: string;
  engagementId: string;
  deliveryProjectId: string;
  sourceActivityId?: string;
  description: string;
  scopeImpact: string;
  scheduleImpactDays: number;
  costImpactKrw: MoneyKrw;
  priceImpactKrw: MoneyKrw;
  disposition?: "NO_CHARGE" | "CONTINGENCY" | "ADDITIONAL_QUOTE" | "REJECT";
  status: "ANALYZED" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED";
  approvalReceiptId?: string;
  version: number;
}

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  description: string;
  quantity: number;
  unitCostKrw: MoneyKrw;
  receivedQuantity: number;
}

export interface PurchaseOrder {
  id: string;
  workspaceId: string;
  engagementId: string;
  vendorAccountId: string;
  status: "DRAFT" | "AWAITING_APPROVAL" | "APPROVED" | "ORDERED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
  lines: PurchaseOrderLine[];
  expectedDate?: string;
  approvalReceiptId?: string;
  version: number;
}

export interface Asset {
  id: string;
  workspaceId: string;
  engagementId: string;
  customerAccountId: string;
  productId: string;
  purchaseOrderId: string;
  serialOrLicenseKey: string;
  status: "IN_STOCK" | "ALLOCATED" | "DELIVERED" | "ACTIVE" | "EXPIRED" | "RETIRED";
  deliveredAt?: string;
  warrantyEnd?: string;
  renewalDate?: string;
  version: number;
}

export interface FinancialItem {
  id: string;
  workspaceId: string;
  engagementId: string | null;
  accountId: string;
  direction: "IN" | "OUT";
  category:
    | "contract_revenue"
    | "change_revenue"
    | "maintenance_revenue"
    | "hardware_cost"
    | "license_cost"
    | "outsourcing_cost"
    | "travel_cost"
    | "cloud_cost"
    | "internal_labor"
    | "overhead"
    | "other";
  lifecycle: "PLANNED" | "APPROVED" | "CONFIRMED" | "BILLED" | "INCURRED" | "PARTIAL" | "SETTLED" | "OVERDUE" | "CANCELLED";
  netAmountKrw: MoneyKrw;
  vatAmountKrw: MoneyKrw;
  grossAmountKrw: MoneyKrw;
  expectedDate: string | null;
  importAssignment?: "assigned" | "unassigned";
  contractualDueDate?: string;
  sourceArtifactId?: string;
  sourcePurchaseOrderId?: string;
  evidenceRef?: string;
  revision: number;
}

export interface Settlement {
  id: string;
  workspaceId: string;
  financialItemId: string;
  direction: "IN" | "OUT";
  amountKrw: MoneyKrw;
  settledAt: string;
  accountOrCard: string;
  evidenceRef: string;
  reversalOfSettlementId?: string;
}

export interface ApprovalReceipt {
  id: string;
  workspaceId: string;
  resourceType: "quote" | "change_request" | "purchase_order" | "financial_item" | "delivery_project" | "engagement" | "import_plan" | "artifact";
  resourceId: string;
  resourceVersion: number;
  action: string;
  payloadHash: string;
  status: "CONSUMED";
  approvedByPrincipalId: string;
}

export interface ProjectFinanceSummary {
  engagementId: string;
  expectedRevenueKrw: MoneyKrw;
  contractedRevenueKrw: MoneyKrw;
  billedRevenueKrw: MoneyKrw;
  collectedKrw: MoneyKrw;
  receivableKrw: MoneyKrw;
  approvedCostKrw: MoneyKrw;
  incurredCostKrw: MoneyKrw;
  paidKrw: MoneyKrw;
  payableKrw: MoneyKrw;
  estimateAtCompletionKrw: MoneyKrw;
  forecastProfitKrw: MoneyKrw;
  forecastMarginBps: number;
  cashPositionKrw: MoneyKrw;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CustomerWorkOsError("INVALID_INPUT", `${field} is required`);
  return normalized;
}

function parseMoney(value: MoneyKrw, field = "amount"): bigint {
  if (!/^-?\d+$/.test(value)) throw new CustomerWorkOsError("INVALID_MONEY", `${field} must be an integer KRW string`);
  return BigInt(value);
}

function nonNegative(value: MoneyKrw, field = "amount"): bigint {
  const amount = parseMoney(value, field);
  if (amount < 0n) throw new CustomerWorkOsError("INVALID_MONEY", `${field} cannot be negative`);
  return amount;
}

function amount(value: bigint): MoneyKrw {
  return value.toString();
}

function extended(unit: MoneyKrw, quantity: number, label: string): bigint {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new CustomerWorkOsError("INVALID_QUANTITY", `${label} quantity must be a positive integer`);
  return nonNegative(unit, `${label} unit amount`) * BigInt(quantity);
}

function calculateMarginBps(price: bigint, cost: bigint): number {
  return price <= 0n ? 0 : Number(((price - cost) * 10_000n) / price);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function customerWorkOsPayloadHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? "undefined";
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

const ACTIVE_STAGES = new Set<EngagementStage>([
  "INQUIRY",
  "DISCOVERY",
  "PROPOSAL",
  "NEGOTIATION",
  "CONTRACTED",
  "DELIVERY",
  "ACCEPTANCE",
  "BILLING",
  "COLLECTION",
]);

const TRANSITIONS: Readonly<Record<EngagementStage, readonly EngagementStage[]>> = {
  INQUIRY: ["DISCOVERY", "ON_HOLD", "LOST", "CANCELLED"],
  DISCOVERY: ["PROPOSAL", "ON_HOLD", "LOST", "CANCELLED"],
  PROPOSAL: ["NEGOTIATION", "DISCOVERY", "ON_HOLD", "LOST", "CANCELLED"],
  NEGOTIATION: ["CONTRACTED", "PROPOSAL", "ON_HOLD", "LOST", "CANCELLED"],
  CONTRACTED: ["DELIVERY", "CANCELLED"],
  DELIVERY: ["ACCEPTANCE", "ON_HOLD", "CANCELLED"],
  ACCEPTANCE: ["BILLING", "DELIVERY", "CANCELLED"],
  BILLING: ["COLLECTION", "CANCELLED"],
  COLLECTION: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  ON_HOLD: ["DISCOVERY", "PROPOSAL", "NEGOTIATION", "DELIVERY", "CANCELLED"],
  LOST: [],
  CANCELLED: [],
};

export class CustomerWorkOsService {
  private readonly accounts = new Map<string, Account>();
  private readonly contacts = new Map<string, Contact>();
  private readonly engagements = new Map<string, Engagement>();
  private readonly parties = new Map<string, EngagementParty>();
  private readonly activities = new Map<string, Activity>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly appliedImportPlans = new Map<string, AppliedImportPlan>();
  private readonly knowledge = new Map<string, KnowledgeItem>();
  private readonly commitments = new Map<string, Commitment>();
  private readonly products = new Map<string, Product>();
  private readonly quotes = new Map<string, Quote>();
  private readonly contracts = new Map<string, Contract>();
  private readonly deliveryProjects = new Map<string, DeliveryProject>();
  private readonly changes = new Map<string, ChangeRequest>();
  private readonly purchaseOrders = new Map<string, PurchaseOrder>();
  private readonly assets = new Map<string, Asset>();
  private readonly financialItems = new Map<string, FinancialItem>();
  private readonly settlements = new Map<string, Settlement>();
  private readonly financialItemBaseLifecycle = new Map<string, FinancialItem["lifecycle"]>();
  private readonly consumedReceiptIds = new Set<string>();

  createAccount(input: Omit<Account, "normalizedName" | "version">): Account {
    this.ensureNew(this.accounts, input.id, "account");
    const name = required(input.name, "account.name");
    if (input.kinds.length === 0) throw new CustomerWorkOsError("INVALID_INPUT", "account requires at least one kind");
    const normalizedName = name.toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
    const duplicate = [...this.accounts.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.normalizedName === normalizedName,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_ACCOUNT", `account name already exists: ${duplicate.id}`);
    const stored: Account = { ...copy(input), name, normalizedName, kinds: [...new Set(input.kinds)], version: 1 };
    this.accounts.set(stored.id, stored);
    return copy(stored);
  }

  addContact(input: Omit<Contact, "version">): Contact {
    this.ensureNew(this.contacts, input.id, "contact");
    this.account(input.workspaceId, input.accountId);
    if (!input.email && !input.phone) throw new CustomerWorkOsError("CONTACT_CHANNEL_REQUIRED", "contact requires email or phone");
    const stored: Contact = { ...copy(input), name: required(input.name, "contact.name"), version: 1 };
    this.contacts.set(stored.id, stored);
    return copy(stored);
  }

  createEngagement(input: Omit<Engagement, "version">): Engagement {
    this.ensureNew(this.engagements, input.id, "engagement");
    const projectKey = required(input.projectKey, "engagement.projectKey");
    const duplicate = [...this.engagements.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.projectKey === projectKey,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_PROJECT_KEY", `project key already exists: ${projectKey}`);
    if (input.startDate && input.targetDate && input.targetDate < input.startDate) {
      throw new CustomerWorkOsError("INVALID_SCHEDULE", "targetDate precedes startDate");
    }
    const stored: Engagement = { ...copy(input), projectKey, name: required(input.name, "engagement.name"), version: 1 };
    this.engagements.set(stored.id, stored);
    return copy(stored);
  }

  assignParty(input: EngagementParty): EngagementParty {
    this.ensureNew(this.parties, input.id, "engagement party");
    this.engagement(input.workspaceId, input.engagementId);
    this.account(input.workspaceId, input.accountId);
    if (input.primary) {
      const duplicate = [...this.parties.values()].find(
        (item) => item.workspaceId === input.workspaceId && item.engagementId === input.engagementId && item.role === input.role && item.primary,
      );
      if (duplicate) throw new CustomerWorkOsError("DUPLICATE_PRIMARY_PARTY", `primary ${input.role} already assigned`);
    }
    this.parties.set(input.id, copy(input));
    return copy(input);
  }

  recordActivity(input: Activity): Activity {
    this.ensureNew(this.activities, input.id, "activity");
    if (input.engagementId) this.engagement(input.workspaceId, input.engagementId);
    else if (!input.accountId) throw new CustomerWorkOsError("ACCOUNT_REQUIRED", "account-level activity requires accountId");
    if (input.accountId) this.account(input.workspaceId, input.accountId);
    required(input.summary, "activity.summary");
    if (input.aiConfidence !== undefined && (input.aiConfidence < 0 || input.aiConfidence > 1)) {
      throw new CustomerWorkOsError("INVALID_CONFIDENCE", "aiConfidence must be between 0 and 1");
    }
    this.activities.set(input.id, copy(input));
    return copy(input);
  }

  reviewActivity(workspaceId: string, activityId: string): Activity {
    const item = this.owned(this.activities, workspaceId, activityId, "activity");
    item.humanReviewed = true;
    return copy(item);
  }

  addArtifact(input: Omit<Artifact, "version">): Artifact {
    this.ensureNew(this.artifacts, input.id, "artifact");
    this.engagement(input.workspaceId, input.engagementId);
    if (input.accountId) this.account(input.workspaceId, input.accountId);
    if (input.sourceActivityId) this.owned(this.activities, input.workspaceId, input.sourceActivityId, "activity");
    if (input.supersedesArtifactId) this.owned(this.artifacts, input.workspaceId, input.supersedesArtifactId, "artifact");
    const title = required(input.title, "artifact.title");
    const versionLabel = required(input.versionLabel, "artifact.versionLabel");
    const storageUri = required(input.storageUri, "artifact.storageUri");
    const duplicate = [...this.artifacts.values()].find((item) =>
      item.workspaceId === input.workspaceId &&
      item.engagementId === input.engagementId &&
      item.type === input.type &&
      item.title === title &&
      item.versionLabel === versionLabel,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_ARTIFACT_VERSION", `artifact version already exists: ${duplicate.id}`);
    if (["APPROVED", "SENT", "ACCEPTED"].includes(input.status) && !input.approvedByPrincipalId?.trim()) {
      throw new CustomerWorkOsError("APPROVAL_REQUIRED", `artifact status ${input.status} requires approvedByPrincipalId`);
    }
    if (["SENT", "ACCEPTED"].includes(input.status) && !input.sentAt) {
      throw new CustomerWorkOsError("SENT_AT_REQUIRED", `artifact status ${input.status} requires sentAt`);
    }
    if (input.status === "ACCEPTED" && !input.acceptedAt) {
      throw new CustomerWorkOsError("ACCEPTED_AT_REQUIRED", "accepted artifact requires acceptedAt");
    }
    const stored: Artifact = {
      ...copy(input),
      title,
      versionLabel,
      storageUri,
      metadata: copy(input.metadata),
      version: 1,
    };
    this.artifacts.set(stored.id, stored);
    return copy(stored);
  }

  isImportPlanApplied(planHash: string): boolean {
    return this.appliedImportPlans.has(required(planHash, "planHash"));
  }

  markImportPlanApplied(
    workspaceId: string,
    planId: string,
    planVersion: number,
    planHash: string,
    receipt: ApprovalReceipt,
  ): AppliedImportPlan {
    const normalizedHash = required(planHash, "planHash");
    const existing = this.appliedImportPlans.get(normalizedHash);
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.planId !== planId || existing.planVersion !== planVersion) {
        throw new CustomerWorkOsError("IMPORT_PLAN_HASH_CONFLICT", "import plan hash was already applied to another resource");
      }
      return copy(existing);
    }
    if (this.consumedReceiptIds.has(receipt.id)) throw new CustomerWorkOsError("REPLAYED_APPROVAL", `approval already consumed: ${receipt.id}`);
    if (
      receipt.status !== "CONSUMED" ||
      receipt.workspaceId !== workspaceId ||
      receipt.resourceType !== "import_plan" ||
      receipt.resourceId !== planId ||
      receipt.resourceVersion !== planVersion ||
      receipt.action !== "NOTION_IMPORT_APPROVE"
    ) {
      throw new CustomerWorkOsError("STALE_APPROVAL", "Notion import approval is stale or bound to another plan");
    }
    const applied: AppliedImportPlan = {
      id: normalizedHash,
      workspaceId,
      planId: required(planId, "planId"),
      planVersion,
      planHash: normalizedHash,
      approvalReceiptId: receipt.id,
    };
    this.consumedReceiptIds.add(receipt.id);
    this.appliedImportPlans.set(normalizedHash, applied);
    return copy(applied);
  }

  addKnowledgeItem(input: Omit<KnowledgeItem, "version">): KnowledgeItem {
    this.ensureNew(this.knowledge, input.id, "knowledge item");
    this.engagement(input.workspaceId, input.engagementId);
    if (input.sourceActivityId) this.owned(this.activities, input.workspaceId, input.sourceActivityId, "activity");
    if (input.status === "CONFIRMED" && !input.evidenceRef) {
      throw new CustomerWorkOsError("EVIDENCE_REQUIRED", "confirmed knowledge requires evidenceRef");
    }
    const stored: KnowledgeItem = { ...copy(input), statement: required(input.statement, "knowledge.statement"), version: 1 };
    this.knowledge.set(stored.id, stored);
    return copy(stored);
  }

  addCommitment(input: Omit<Commitment, "version">): Commitment {
    this.ensureNew(this.commitments, input.id, "commitment");
    this.engagement(input.workspaceId, input.engagementId);
    if (input.sourceActivityId) this.owned(this.activities, input.workspaceId, input.sourceActivityId, "activity");
    if (input.counterpartyAccountId) this.account(input.workspaceId, input.counterpartyAccountId);
    if (typeof input.dueAt === "string" && input.dueAt.trim() === "") {
      throw new CustomerWorkOsError("INVALID_INPUT", "commitment.dueAt is required");
    }
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) {
      throw new CustomerWorkOsError("INVALID_PRIORITY", "commitment priority must be 0..100");
    }
    const stored: Commitment = { ...copy(input), description: required(input.description, "commitment.description"), version: 1 };
    this.commitments.set(stored.id, stored);
    return copy(stored);
  }

  completeCommitment(workspaceId: string, commitmentId: string, evidenceRef: string): Commitment {
    const item = this.owned(this.commitments, workspaceId, commitmentId, "commitment");
    if (item.status === "DONE" || item.status === "CANCELLED") throw new CustomerWorkOsError("INVALID_STATE", `commitment is ${item.status}`);
    item.status = "DONE";
    item.completionEvidenceRef = required(evidenceRef, "completion evidence");
    item.version += 1;
    return copy(item);
  }

  addProduct(input: Omit<Product, "version">): Product {
    this.ensureNew(this.products, input.id, "product");
    const sku = required(input.sku, "product.sku");
    const duplicate = [...this.products.values()].find((item) => item.workspaceId === input.workspaceId && item.sku === sku);
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_SKU", `product sku already exists: ${sku}`);
    if (input.manufacturerAccountId) this.account(input.workspaceId, input.manufacturerAccountId);
    if (input.defaultCostKrw !== undefined) nonNegative(input.defaultCostKrw, "default cost");
    if (input.defaultPriceKrw !== undefined) nonNegative(input.defaultPriceKrw, "default price");
    const stored: Product = { ...copy(input), sku, name: required(input.name, "product.name"), version: 1 };
    this.products.set(stored.id, stored);
    return copy(stored);
  }

  createQuote(input: Omit<Quote, "totalCostKrw" | "totalPriceKrw" | "grossProfitKrw" | "marginBps" | "version">): Quote {
    this.ensureNew(this.quotes, input.id, "quote");
    const engagement = this.engagement(input.workspaceId, input.engagementId);
    if (!["DISCOVERY", "PROPOSAL", "NEGOTIATION"].includes(engagement.stage)) {
      throw new CustomerWorkOsError("INVALID_STAGE", `cannot quote engagement in ${engagement.stage}`);
    }
    if (input.bomLines.length === 0) throw new CustomerWorkOsError("EMPTY_BOM", "quote requires BOM lines");
    const lineIds = new Set<string>();
    let totalCost = 0n;
    let totalPrice = 0n;
    for (const line of input.bomLines) {
      if (lineIds.has(line.id)) throw new CustomerWorkOsError("DUPLICATE_ID", `duplicate BOM line: ${line.id}`);
      lineIds.add(line.id);
      const product = this.owned(this.products, input.workspaceId, line.productId, "product");
      if (!product.active) throw new CustomerWorkOsError("INACTIVE_PRODUCT", `product is inactive: ${product.id}`);
      if (line.vendorAccountId) this.account(input.workspaceId, line.vendorAccountId);
      totalCost += extended(line.unitCostKrw, line.quantity, line.id);
      totalPrice += extended(line.unitPriceKrw, line.quantity, line.id);
    }
    if (totalPrice < totalCost) throw new CustomerWorkOsError("NEGATIVE_MARGIN", "quote price is lower than cost");
    const stored: Quote = {
      ...copy(input),
      scope: required(input.scope, "quote.scope"),
      totalCostKrw: amount(totalCost),
      totalPriceKrw: amount(totalPrice),
      grossProfitKrw: amount(totalPrice - totalCost),
      marginBps: calculateMarginBps(totalPrice, totalCost),
      version: 1,
    };
    this.quotes.set(stored.id, stored);
    if (engagement.stage === "DISCOVERY") {
      engagement.stage = "PROPOSAL";
      engagement.version += 1;
    }
    return copy(stored);
  }

  approveQuote(workspaceId: string, quoteId: string, expectedVersion: number, receipt: ApprovalReceipt, minimumMarginBps: number): Quote {
    const quote = this.versioned(this.quotes, workspaceId, quoteId, expectedVersion, "quote");
    if (quote.status !== "DRAFT" && quote.status !== "REVIEW") throw new CustomerWorkOsError("INVALID_STATE", `quote is ${quote.status}`);
    if (quote.marginBps < minimumMarginBps) throw new CustomerWorkOsError("MARGIN_BELOW_FLOOR", `quote margin ${quote.marginBps}bps is below ${minimumMarginBps}bps`);
    const payload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
    this.consume(receipt, workspaceId, "quote", quote.id, quote.version, "QUOTE_APPROVE", customerWorkOsPayloadHash(payload));
    quote.status = "APPROVED";
    quote.approvalReceiptId = receipt.id;
    quote.version += 1;
    return copy(quote);
  }

  acceptQuoteAsContract(input: Omit<Contract, "version" | "status">, quoteExpectedVersion: number): { quote: Quote; contract: Contract; engagement: Engagement } {
    this.ensureNew(this.contracts, input.id, "contract");
    const quote = this.versioned(this.quotes, input.workspaceId, input.quoteId, quoteExpectedVersion, "quote");
    if (quote.engagementId !== input.engagementId) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "quote and contract engagement mismatch");
    if (quote.status !== "APPROVED" && quote.status !== "SENT") throw new CustomerWorkOsError("INVALID_STATE", "quote must be approved or sent");
    if (input.contractValueKrw !== quote.totalPriceKrw) throw new CustomerWorkOsError("CONTRACT_VALUE_MISMATCH", "contract value must match accepted quote");
    const milestoneTotal = input.billingMilestones.reduce((sum, item) => sum + nonNegative(item.amountKrw, `milestone ${item.id}`), 0n);
    if (milestoneTotal !== parseMoney(input.contractValueKrw)) throw new CustomerWorkOsError("BILLING_MILESTONE_MISMATCH", "billing milestone total must equal contract value");
    const contract: Contract = { ...copy(input), status: "ACTIVE", version: 1 };
    this.contracts.set(contract.id, contract);
    quote.status = "ACCEPTED";
    quote.version += 1;
    const engagement = this.engagement(input.workspaceId, input.engagementId);
    engagement.wonQuoteId = quote.id;
    engagement.contractId = contract.id;
    engagement.stage = "CONTRACTED";
    engagement.version += 1;
    return { quote: copy(quote), contract: copy(contract), engagement: copy(engagement) };
  }

  handoverToDelivery(input: Omit<DeliveryProject, "status" | "workItems" | "version">): DeliveryProject {
    this.ensureNew(this.deliveryProjects, input.id, "delivery project");
    const engagement = this.engagement(input.workspaceId, input.engagementId);
    const contract = this.owned(this.contracts, input.workspaceId, input.contractId, "contract");
    if (contract.engagementId !== engagement.id || engagement.contractId !== contract.id || contract.status !== "ACTIVE") {
      throw new CustomerWorkOsError("INVALID_HANDOVER", "engagement does not own an active contract");
    }
    if (input.projectKey !== engagement.projectKey) throw new CustomerWorkOsError("PROJECT_KEY_MISMATCH", "delivery must preserve projectKey");
    if (input.scheduleEnd < input.scheduleStart) throw new CustomerWorkOsError("INVALID_SCHEDULE", "schedule end precedes start");
    if (!input.deliverables.some((item) => item.required)) throw new CustomerWorkOsError("MISSING_REQUIRED_DELIVERABLE", "handover requires a required deliverable");
    for (const requirementId of input.requirementIds) {
      const requirement = this.owned(this.knowledge, input.workspaceId, requirementId, "requirement");
      if (requirement.engagementId !== engagement.id || requirement.kind !== "requirement") {
        throw new CustomerWorkOsError("INVALID_REQUIREMENT", `invalid requirement binding: ${requirementId}`);
      }
    }
    const project: DeliveryProject = { ...copy(input), status: "PLANNED", workItems: [], version: 1 };
    this.deliveryProjects.set(project.id, project);
    engagement.deliveryProjectId = project.id;
    engagement.stage = "DELIVERY";
    engagement.type = "delivery";
    engagement.version += 1;
    return copy(project);
  }

  addDeliveryWorkItem(workspaceId: string, projectId: string, expectedVersion: number, item: DeliveryWorkItem): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.workItems.some((current) => current.id === item.id)) throw new CustomerWorkOsError("DUPLICATE_ID", `work item exists: ${item.id}`);
    for (const requirementId of item.requirementIds) {
      if (!project.requirementIds.includes(requirementId)) throw new CustomerWorkOsError("UNKNOWN_REQUIREMENT", `work item requirement not in baseline: ${requirementId}`);
    }
    if (item.deliverableId && !project.deliverables.some((deliverable) => deliverable.id === item.deliverableId)) {
      throw new CustomerWorkOsError("UNKNOWN_DELIVERABLE", `unknown deliverable: ${item.deliverableId}`);
    }
    project.workItems.push(copy(item));
    project.version += 1;
    return copy(project);
  }


  updateDeliverableStatus(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    deliverableId: string,
    status: Deliverable["status"],
    evidenceRef?: string,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const deliverable = project.deliverables.find((item) => item.id === deliverableId);
    if (!deliverable) throw new CustomerWorkOsError("NOT_FOUND", `deliverable not found: ${deliverableId}`);
    deliverable.status = status;
    if (status === "APPROVED") deliverable.evidenceRef = required(evidenceRef ?? "", "deliverable evidence");
    else delete deliverable.evidenceRef;
    if (project.status === "PLANNED") project.status = "ACTIVE";
    project.version += 1;
    return copy(project);
  }

  updateDeliveryWorkItemStatus(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    workItemId: string,
    status: DeliveryWorkItem["status"],
    actualHours?: number,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const workItem = project.workItems.find((item) => item.id === workItemId);
    if (!workItem) throw new CustomerWorkOsError("NOT_FOUND", `delivery work item not found: ${workItemId}`);
    if (actualHours !== undefined) {
      if (!Number.isFinite(actualHours) || actualHours < 0) throw new CustomerWorkOsError("INVALID_HOURS", "actualHours must be finite and non-negative");
      workItem.actualHours = actualHours;
    }
    if (status === "DONE" && workItem.actualHours === undefined) {
      throw new CustomerWorkOsError("ACTUAL_HOURS_REQUIRED", "completed work requires actualHours");
    }
    workItem.status = status;
    if (project.status === "PLANNED") project.status = "ACTIVE";
    project.version += 1;
    return copy(project);
  }

  proposeDeliveryCompletion(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status === "COMPLETE" || project.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    }
    const incompleteDeliverables = project.deliverables.filter(
      (item) => item.required && (item.status !== "APPROVED" || !item.evidenceRef?.trim()),
    );
    if (incompleteDeliverables.length > 0) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", `required deliverables are not approved with evidence: ${incompleteDeliverables.map((item) => item.id).join(",")}`);
    }
    const incompleteWork = project.workItems.filter((item) => item.status !== "DONE");
    if (incompleteWork.length > 0) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", `delivery work is incomplete: ${incompleteWork.map((item) => item.id).join(",")}`);
    }
    project.status = "AWAITING_APPROVAL";
    project.version += 1;
    return copy(project);
  }

  completeDelivery(
    workspaceId: string,
    projectId: string,
    expectedVersion: number,
    receipt: ApprovalReceipt,
  ): DeliveryProject {
    const project = this.versioned(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", "delivery completion was not proposed");
    const payload = { projectId: project.id, version: project.version, deliverables: project.deliverables, workItems: project.workItems };
    this.consume(receipt, workspaceId, "delivery_project", project.id, project.version, "DELIVERY_COMPLETE", customerWorkOsPayloadHash(payload));
    const engagement = this.engagement(workspaceId, project.engagementId);
    if (engagement.stage !== "DELIVERY" && engagement.stage !== "ACCEPTANCE") {
      throw new CustomerWorkOsError("INVALID_STAGE", `cannot complete delivery from ${engagement.stage}`);
    }
    project.status = "COMPLETE";
    project.version += 1;
    engagement.stage = "BILLING";
    engagement.version += 1;
    return copy(project);
  }

  proposeChangeRequest(input: Omit<ChangeRequest, "status" | "version">): ChangeRequest {
    this.ensureNew(this.changes, input.id, "change request");
    const project = this.owned(this.deliveryProjects, input.workspaceId, input.deliveryProjectId, "delivery project");
    if (project.engagementId !== input.engagementId) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "change request project mismatch");
    nonNegative(input.costImpactKrw, "change cost impact");
    nonNegative(input.priceImpactKrw, "change price impact");
    if (!Number.isInteger(input.scheduleImpactDays)) throw new CustomerWorkOsError("INVALID_SCHEDULE_IMPACT", "scheduleImpactDays must be an integer");
    const stored: ChangeRequest = { ...copy(input), status: "ANALYZED", version: 1 };
    this.changes.set(stored.id, stored);
    return copy(stored);
  }

  approveChangeRequest(workspaceId: string, requestId: string, expectedVersion: number, disposition: NonNullable<ChangeRequest["disposition"]>, receipt: ApprovalReceipt): ChangeRequest {
    const request = this.versioned(this.changes, workspaceId, requestId, expectedVersion, "change request");
    if (request.status !== "ANALYZED" && request.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", `change request is ${request.status}`);
    const payload = { disposition, scopeImpact: request.scopeImpact, scheduleImpactDays: request.scheduleImpactDays, costImpactKrw: request.costImpactKrw, priceImpactKrw: request.priceImpactKrw };
    this.consume(receipt, workspaceId, "change_request", request.id, request.version, "CHANGE_REQUEST_APPROVE", customerWorkOsPayloadHash(payload));
    request.disposition = disposition;
    request.status = disposition === "REJECT" ? "REJECTED" : "APPROVED";
    request.approvalReceiptId = receipt.id;
    request.version += 1;
    return copy(request);
  }

  applyChangeRequest(workspaceId: string, requestId: string, expectedVersion: number): { request: ChangeRequest; project: DeliveryProject } {
    const request = this.versioned(this.changes, workspaceId, requestId, expectedVersion, "change request");
    if (request.status !== "APPROVED" || request.disposition === "REJECT") throw new CustomerWorkOsError("INVALID_STATE", "change request is not approved");
    const project = this.owned(this.deliveryProjects, workspaceId, request.deliveryProjectId, "delivery project");
    project.scopeBaseline = `${project.scopeBaseline}\nCHANGE ${request.id}: ${request.scopeImpact}`;
    if (request.scheduleImpactDays !== 0) {
      const date = new Date(`${project.scheduleEnd}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + request.scheduleImpactDays);
      project.scheduleEnd = date.toISOString().slice(0, 10);
    }
    project.version += 1;
    request.status = "APPLIED";
    request.version += 1;
    return { request: copy(request), project: copy(project) };
  }

  createPurchaseOrder(input: Omit<PurchaseOrder, "status" | "version">): PurchaseOrder {
    this.ensureNew(this.purchaseOrders, input.id, "purchase order");
    this.engagement(input.workspaceId, input.engagementId);
    this.account(input.workspaceId, input.vendorAccountId);
    if (input.lines.length === 0) throw new CustomerWorkOsError("EMPTY_PURCHASE_ORDER", "purchase order requires lines");
    for (const line of input.lines) {
      this.owned(this.products, input.workspaceId, line.productId, "product");
      extended(line.unitCostKrw, line.quantity, line.id);
      if (!Number.isInteger(line.receivedQuantity) || line.receivedQuantity < 0 || line.receivedQuantity > line.quantity) {
        throw new CustomerWorkOsError("INVALID_RECEIVED_QUANTITY", `invalid received quantity on ${line.id}`);
      }
    }
    const stored: PurchaseOrder = { ...copy(input), status: "DRAFT", version: 1 };
    this.purchaseOrders.set(stored.id, stored);
    return copy(stored);
  }

  approvePurchaseOrder(workspaceId: string, orderId: string, expectedVersion: number, receipt: ApprovalReceipt): PurchaseOrder {
    const order = this.versioned(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "DRAFT" && order.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", `purchase order is ${order.status}`);
    const total = order.lines.reduce((sum, line) => sum + extended(line.unitCostKrw, line.quantity, line.id), 0n);
    const payload = { vendorAccountId: order.vendorAccountId, totalCostKrw: amount(total), lines: order.lines };
    this.consume(receipt, workspaceId, "purchase_order", order.id, order.version, "PURCHASE_ORDER_APPROVE", customerWorkOsPayloadHash(payload));
    order.status = "APPROVED";
    order.approvalReceiptId = receipt.id;
    order.version += 1;
    return copy(order);
  }

  markPurchaseOrderOrdered(workspaceId: string, orderId: string, expectedVersion: number): PurchaseOrder {
    const order = this.versioned(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "APPROVED") throw new CustomerWorkOsError("INVALID_STATE", "purchase order must be approved");
    order.status = "ORDERED";
    order.version += 1;
    return copy(order);
  }

  receivePurchaseOrderLine(workspaceId: string, orderId: string, expectedVersion: number, lineId: string, quantity: number): PurchaseOrder {
    const order = this.versioned(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "ORDERED" && order.status !== "PARTIALLY_RECEIVED") throw new CustomerWorkOsError("INVALID_STATE", `purchase order is ${order.status}`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new CustomerWorkOsError("INVALID_QUANTITY", "received quantity must be a positive integer");
    const line = order.lines.find((current) => current.id === lineId);
    if (!line) throw new CustomerWorkOsError("NOT_FOUND", `purchase order line not found: ${lineId}`);
    if (line.receivedQuantity + quantity > line.quantity) throw new CustomerWorkOsError("OVER_RECEIPT", "received quantity exceeds ordered quantity");
    line.receivedQuantity += quantity;
    order.status = order.lines.every((current) => current.receivedQuantity === current.quantity) ? "RECEIVED" : "PARTIALLY_RECEIVED";
    order.version += 1;
    return copy(order);
  }

  registerAsset(input: Omit<Asset, "version">): Asset {
    this.ensureNew(this.assets, input.id, "asset");
    const order = this.owned(this.purchaseOrders, input.workspaceId, input.purchaseOrderId, "purchase order");
    if (order.engagementId !== input.engagementId) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "asset and purchase order mismatch");
    if (order.status !== "PARTIALLY_RECEIVED" && order.status !== "RECEIVED") throw new CustomerWorkOsError("NOT_RECEIVED", "asset cannot be registered before receipt");
    this.account(input.workspaceId, input.customerAccountId);
    this.owned(this.products, input.workspaceId, input.productId, "product");
    const receivedQuantity = order.lines
      .filter((line) => line.productId === input.productId)
      .reduce((sum, line) => sum + line.receivedQuantity, 0);
    const registeredQuantity = [...this.assets.values()].filter(
      (item) => item.workspaceId === input.workspaceId && item.purchaseOrderId === order.id && item.productId === input.productId,
    ).length;
    if (registeredQuantity >= receivedQuantity) {
      throw new CustomerWorkOsError("ASSET_QUANTITY_EXCEEDED", "serialized assets cannot exceed received quantity");
    }
    const identifier = required(input.serialOrLicenseKey, "serialOrLicenseKey");
    const duplicate = [...this.assets.values()].find((item) => item.workspaceId === input.workspaceId && item.serialOrLicenseKey === identifier);
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_ASSET_IDENTIFIER", "serial/license key already registered");
    const stored: Asset = { ...copy(input), serialOrLicenseKey: identifier, version: 1 };
    this.assets.set(stored.id, stored);
    return copy(stored);
  }

  addFinancialItem(input: FinancialItem): FinancialItem {
    this.ensureNew(this.financialItems, input.id, "financial item");
    if (input.engagementId !== null) this.engagement(input.workspaceId, input.engagementId);
    this.account(input.workspaceId, input.accountId);
    const net = nonNegative(input.netAmountKrw, "net amount");
    const vat = nonNegative(input.vatAmountKrw, "VAT amount");
    const gross = nonNegative(input.grossAmountKrw, "gross amount");
    if (net + vat !== gross) throw new CustomerWorkOsError("VAT_MISMATCH", "gross amount must equal net plus VAT");
    if (input.engagementId === null && input.category !== "overhead" && input.importAssignment !== "unassigned") {
      throw new CustomerWorkOsError("PROJECT_BINDING_REQUIRED", "non-overhead financial item requires engagementId");
    }
    if (input.sourcePurchaseOrderId) {
      const order = this.owned(this.purchaseOrders, input.workspaceId, input.sourcePurchaseOrderId, "purchase order");
      if (input.engagementId !== order.engagementId || input.direction !== "OUT") throw new CustomerWorkOsError("PURCHASE_BINDING_MISMATCH", "purchase-linked financial item must be OUT for the same engagement");
    }
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new CustomerWorkOsError("INVALID_REVISION", "financial revision must be >= 1");
    this.financialItemBaseLifecycle.set(input.id, input.lifecycle);
    this.financialItems.set(input.id, copy(input));
    return copy(input);
  }

  recordSettlement(input: Settlement): { settlement: Settlement; financialItem: FinancialItem } {
    this.ensureNew(this.settlements, input.id, "settlement");
    const item = this.owned(this.financialItems, input.workspaceId, input.financialItemId, "financial item");
    if (item.direction !== input.direction) throw new CustomerWorkOsError("DIRECTION_MISMATCH", "settlement direction must match financial item");
    if (item.lifecycle === "CANCELLED") throw new CustomerWorkOsError("INVALID_STATE", "cannot settle cancelled item");
    const value = nonNegative(input.amountKrw, "settlement amount");
    if (value === 0n) throw new CustomerWorkOsError("INVALID_MONEY", "settlement amount must be greater than zero");
    required(input.evidenceRef, "settlement.evidenceRef");
    if (input.reversalOfSettlementId) {
      const original = this.owned(this.settlements, input.workspaceId, input.reversalOfSettlementId, "settlement");
      if (original.financialItemId !== item.id || original.direction !== input.direction || original.amountKrw !== input.amountKrw || original.reversalOfSettlementId) {
        throw new CustomerWorkOsError("INVALID_REVERSAL", "reversal must offset one original settlement");
      }
      const alreadyReversed = [...this.settlements.values()].some((current) => current.reversalOfSettlementId === original.id);
      if (alreadyReversed) throw new CustomerWorkOsError("DUPLICATE_REVERSAL", "settlement has already been reversed");
    } else if (this.settledAmount(item.id) + value > parseMoney(item.grossAmountKrw)) {
      throw new CustomerWorkOsError("OVER_SETTLEMENT", "settlement exceeds financial item gross amount");
    }
    this.settlements.set(input.id, copy(input));
    const settled = this.settledAmount(item.id);
    const gross = parseMoney(item.grossAmountKrw);
    if (settled > 0n) item.lifecycle = settled < gross ? "PARTIAL" : "SETTLED";
    else item.lifecycle = this.financialItemBaseLifecycle.get(item.id) ?? (item.direction === "IN" ? "BILLED" : "INCURRED");
    return { settlement: copy(input), financialItem: copy(item) };
  }

  financeSummary(workspaceId: string, engagementId: string): ProjectFinanceSummary {
    this.engagement(workspaceId, engagementId);
    const items = [...this.financialItems.values()].filter(
      (item) => item.workspaceId === workspaceId && item.engagementId === engagementId && item.lifecycle !== "CANCELLED",
    );
    const incoming = items.filter((item) => item.direction === "IN");
    const outgoing = items.filter((item) => item.direction === "OUT");
    const expectedRevenue = incoming.reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const contractedRevenue = incoming
      .filter((item) => ["CONFIRMED", "BILLED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const billedRevenue = incoming
      .filter((item) => ["BILLED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.grossAmountKrw), 0n);
    const collected = incoming.reduce((sum, item) => sum + this.settledAmount(item.id), 0n);
    const approvedCost = outgoing
      .filter((item) => item.category !== "overhead" && ["APPROVED", "CONFIRMED", "INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const incurredCost = outgoing
      .filter((item) => item.category !== "overhead" && ["INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const paid = outgoing.reduce((sum, item) => sum + this.settledAmount(item.id), 0n);
    const eac = outgoing.filter((item) => item.category !== "overhead").reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const forecastProfit = expectedRevenue - eac;
    const payable = outgoing.reduce((sum, item) => {
      if (!["INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle)) return sum;
      return sum + parseMoney(item.grossAmountKrw) - this.settledAmount(item.id);
    }, 0n);
    return {
      engagementId,
      expectedRevenueKrw: amount(expectedRevenue),
      contractedRevenueKrw: amount(contractedRevenue),
      billedRevenueKrw: amount(billedRevenue),
      collectedKrw: amount(collected),
      receivableKrw: amount(billedRevenue - collected),
      approvedCostKrw: amount(approvedCost),
      incurredCostKrw: amount(incurredCost),
      paidKrw: amount(paid),
      payableKrw: amount(payable),
      estimateAtCompletionKrw: amount(eac),
      forecastProfitKrw: amount(forecastProfit),
      forecastMarginBps: calculateMarginBps(expectedRevenue, eac),
      cashPositionKrw: amount(collected - paid),
    };
  }


  closeEngagement(
    workspaceId: string,
    engagementId: string,
    expectedVersion: number,
    receipt: ApprovalReceipt,
  ): Engagement {
    const engagement = this.versioned(this.engagements, workspaceId, engagementId, expectedVersion, "engagement");
    if (engagement.stage !== "COLLECTION") throw new CustomerWorkOsError("INVALID_STAGE", `cannot close engagement from ${engagement.stage}`);
    const openCommitments = this.openCommitments(workspaceId, engagementId);
    if (openCommitments.length > 0) throw new CustomerWorkOsError("OPEN_COMMITMENTS", "engagement has unfinished commitments");
    const activeChanges = this.byEngagement(this.changes, workspaceId, engagementId).filter(
      (item) => !["REJECTED", "APPLIED"].includes(item.status),
    );
    if (activeChanges.length > 0) throw new CustomerWorkOsError("OPEN_CHANGE_REQUESTS", "engagement has unresolved change requests");
    if (engagement.deliveryProjectId) {
      const project = this.owned(this.deliveryProjects, workspaceId, engagement.deliveryProjectId, "delivery project");
      if (project.status !== "COMPLETE") throw new CustomerWorkOsError("DELIVERY_NOT_COMPLETE", "delivery project is not complete");
    }
    const finance = this.financeSummary(workspaceId, engagementId);
    if (finance.receivableKrw !== "0" || finance.payableKrw !== "0") {
      throw new CustomerWorkOsError("FINANCE_NOT_SETTLED", "receivable and payable must be zero before close");
    }
    const payload = {
      engagementId: engagement.id,
      version: engagement.version,
      projectKey: engagement.projectKey,
      finance,
    };
    this.consume(receipt, workspaceId, "engagement", engagement.id, engagement.version, "ENGAGEMENT_CLOSE", customerWorkOsPayloadHash(payload));
    engagement.stage = "CLOSED";
    engagement.version += 1;
    return copy(engagement);
  }

  transitionEngagement(workspaceId: string, engagementId: string, expectedVersion: number, nextStage: EngagementStage, reason?: string): Engagement {
    const engagement = this.versioned(this.engagements, workspaceId, engagementId, expectedVersion, "engagement");
    if (!TRANSITIONS[engagement.stage].includes(nextStage)) throw new CustomerWorkOsError("INVALID_TRANSITION", `${engagement.stage} cannot transition to ${nextStage}`);
    if ((nextStage === "LOST" || nextStage === "CANCELLED") && !reason?.trim()) throw new CustomerWorkOsError("REASON_REQUIRED", `${nextStage} requires reason`);
    if (ACTIVE_STAGES.has(nextStage) && this.openCommitments(workspaceId, engagementId).length === 0) {
      throw new CustomerWorkOsError("NEXT_ACTION_REQUIRED", "active engagement requires an open commitment");
    }
    engagement.stage = nextStage;
    if (reason?.trim()) engagement.terminalReason = reason.trim();
    else delete engagement.terminalReason;
    engagement.version += 1;
    return copy(engagement);
  }

  getEngagementSnapshot(workspaceId: string, engagementId: string): {
    engagement: Engagement;
    parties: EngagementParty[];
    activities: Activity[];
    artifacts: Artifact[];
    knowledge: KnowledgeItem[];
    commitments: Commitment[];
    quotes: Quote[];
    contracts: Contract[];
    deliveryProjects: DeliveryProject[];
    changes: ChangeRequest[];
    purchaseOrders: PurchaseOrder[];
    assets: Asset[];
    financialItems: FinancialItem[];
    settlements: Settlement[];
    finance: ProjectFinanceSummary;
  } {
    const engagement = this.engagement(workspaceId, engagementId);
    const financialItems = [...this.financialItems.values()]
      .filter((item) => item.workspaceId === workspaceId && item.engagementId === engagementId)
      .map((item) => copy(item));
    const financialItemIds = new Set(financialItems.map((item) => item.id));
    return {
      engagement: copy(engagement),
      parties: this.byEngagement(this.parties, workspaceId, engagementId),
      activities: this.byEngagement(this.activities, workspaceId, engagementId).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)),
      artifacts: this.byEngagement(this.artifacts, workspaceId, engagementId),
      knowledge: this.byEngagement(this.knowledge, workspaceId, engagementId),
      commitments: this.byEngagement(this.commitments, workspaceId, engagementId).sort((left, right) => {
        if (left.dueAt == null && right.dueAt == null) return 0;
        if (left.dueAt == null) return 1;
        if (right.dueAt == null) return -1;
        return left.dueAt.localeCompare(right.dueAt);
      }),
      quotes: this.byEngagement(this.quotes, workspaceId, engagementId),
      contracts: this.byEngagement(this.contracts, workspaceId, engagementId),
      deliveryProjects: this.byEngagement(this.deliveryProjects, workspaceId, engagementId),
      changes: this.byEngagement(this.changes, workspaceId, engagementId),
      purchaseOrders: this.byEngagement(this.purchaseOrders, workspaceId, engagementId),
      assets: this.byEngagement(this.assets, workspaceId, engagementId),
      financialItems,
      settlements: [...this.settlements.values()]
        .filter((item) => item.workspaceId === workspaceId && financialItemIds.has(item.financialItemId))
        .map((item) => copy(item)),
      finance: this.financeSummary(workspaceId, engagementId),
    };
  }

  private openCommitments(workspaceId: string, engagementId: string): Commitment[] {
    return [...this.commitments.values()]
      .filter((item) => item.workspaceId === workspaceId && item.engagementId === engagementId && !["DONE", "CANCELLED"].includes(item.status))
      .map((item) => copy(item));
  }

  private settledAmount(financialItemId: string): bigint {
    let total = 0n;
    for (const settlement of this.settlements.values()) {
      if (settlement.financialItemId !== financialItemId) continue;
      const value = parseMoney(settlement.amountKrw);
      total += settlement.reversalOfSettlementId ? -value : value;
    }
    if (total < 0n) throw new CustomerWorkOsError("INVALID_SETTLEMENT_BALANCE", "reversals exceed original settlements");
    return total;
  }

  private consume(
    receipt: ApprovalReceipt,
    workspaceId: string,
    resourceType: ApprovalReceipt["resourceType"],
    resourceId: string,
    resourceVersion: number,
    action: string,
    payloadHash: string,
  ): void {
    if (this.consumedReceiptIds.has(receipt.id)) throw new CustomerWorkOsError("REPLAYED_APPROVAL", `approval already consumed: ${receipt.id}`);
    if (
      receipt.status !== "CONSUMED" ||
      receipt.workspaceId !== workspaceId ||
      receipt.resourceType !== resourceType ||
      receipt.resourceId !== resourceId ||
      receipt.resourceVersion !== resourceVersion ||
      receipt.action !== action ||
      receipt.payloadHash !== payloadHash
    ) {
      throw new CustomerWorkOsError("STALE_APPROVAL", `${action} approval is stale or bound to another payload`);
    }
    this.consumedReceiptIds.add(receipt.id);
  }

  private account(workspaceId: string, id: string): Account {
    return this.owned(this.accounts, workspaceId, id, "account");
  }

  private engagement(workspaceId: string, id: string): Engagement {
    return this.owned(this.engagements, workspaceId, id, "engagement");
  }

  private owned<T extends { workspaceId: string }>(map: Map<string, T>, workspaceId: string, id: string, label: string): T {
    const item = map.get(id);
    if (!item) throw new CustomerWorkOsError("NOT_FOUND", `${label} not found: ${id}`);
    if (item.workspaceId !== workspaceId) throw new CustomerWorkOsError("CROSS_WORKSPACE", `${label} belongs to another workspace`);
    return item;
  }

  private versioned<T extends { workspaceId: string; version: number }>(map: Map<string, T>, workspaceId: string, id: string, expectedVersion: number, label: string): T {
    const item = this.owned(map, workspaceId, id, label);
    if (item.version !== expectedVersion) throw new CustomerWorkOsError("STALE_VERSION", `expected ${label} version ${expectedVersion}, found ${item.version}`);
    return item;
  }

  private ensureNew<T>(map: Map<string, T>, id: string, label: string): void {
    required(id, `${label}.id`);
    if (map.has(id)) throw new CustomerWorkOsError("DUPLICATE_ID", `${label} already exists: ${id}`);
  }

  private byEngagement<T extends { workspaceId: string; engagementId: string }>(map: Map<string, T>, workspaceId: string, engagementId: string): T[] {
    return [...map.values()]
      .filter((item) => item.workspaceId === workspaceId && item.engagementId === engagementId)
      .map((item) => copy(item));
  }
}
