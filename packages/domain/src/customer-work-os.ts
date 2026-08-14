export class CustomerWorkOsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerWorkOsError";
  }
}

export type IsoDate = string;
export type MoneyKrw = string;

export type AccountKind = "customer" | "partner" | "vendor" | "manufacturer" | "outsourcer" | "other";
export type EngagementType =
  | "inquiry"
  | "opportunity"
  | "consulting"
  | "delivery"
  | "support"
  | "maintenance"
  | "renewal"
  | "internal";
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
export type EngagementHealth = "normal" | "warning" | "critical";
export type PartyRole =
  | "customer"
  | "prime_contractor"
  | "partner"
  | "vendor"
  | "manufacturer"
  | "delivery_partner"
  | "outsourcer"
  | "advisor";

export interface Account {
  id: string;
  workspaceId: string;
  name: string;
  kinds: AccountKind[];
  normalizedName: string;
  status: "active" | "inactive" | "at_risk";
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
  version: number;
}

export interface Engagement {
  id: string;
  workspaceId: string;
  projectKey: string;
  name: string;
  type: EngagementType;
  stage: EngagementStage;
  health: EngagementHealth;
  ownerPrincipalId: string;
  startDate?: IsoDate;
  targetDate?: IsoDate;
  wonQuoteId?: string;
  contractId?: string;
  deliveryProjectId?: string;
  closedReason?: string;
  version: number;
}

export interface EngagementParty {
  id: string;
  workspaceId: string;
  engagementId: string;
  accountId: string;
  role: PartyRole;
  primary: boolean;
  commercialResponsibility: boolean;
  deliveryResponsibility: boolean;
}

export interface Activity {
  id: string;
  workspaceId: string;
  engagementId: string;
  accountId?: string;
  type: "email_in" | "email_out" | "call" | "meeting" | "message" | "visit" | "document" | "decision" | "note" | "finance";
  occurredAt: string;
  summary: string;
  sourceUri?: string;
  evidenceRef?: string;
  aiConfidence?: number;
  humanReviewed: boolean;
}

export type KnowledgeItemKind =
  | "requirement"
  | "confirmed_fact"
  | "unknown"
  | "assumption"
  | "decision"
  | "risk"
  | "exclusion"
  | "acceptance_criterion"
  | "change";

export interface KnowledgeItem {
  id: string;
  workspaceId: string;
  engagementId: string;
  kind: KnowledgeItemKind;
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
  dueAt: string;
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
  validUntil: IsoDate;
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

export interface Contract {
  id: string;
  workspaceId: string;
  engagementId: string;
  quoteId: string;
  title: string;
  scope: string;
  exclusions: string[];
  contractValueKrw: MoneyKrw;
  effectiveFrom: IsoDate;
  effectiveTo?: IsoDate;
  billingMilestones: Array<{ id: string; name: string; amountKrw: MoneyKrw; trigger: string; expectedDate?: IsoDate }>;
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
  scheduleStart: IsoDate;
  scheduleEnd: IsoDate;
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
  status: "PROPOSED" | "ANALYZED" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "APPLIED";
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
  expectedDate?: IsoDate;
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
  deliveredAt?: IsoDate;
  warrantyEnd?: IsoDate;
  renewalDate?: IsoDate;
  version: number;
}

export type FinancialDirection = "IN" | "OUT";
export type FinancialLifecycle =
  | "PLANNED"
  | "APPROVED"
  | "CONFIRMED"
  | "BILLED"
  | "INCURRED"
  | "PARTIAL"
  | "SETTLED"
  | "OVERDUE"
  | "CANCELLED";

export interface FinancialItem {
  id: string;
  workspaceId: string;
  engagementId?: string;
  accountId: string;
  direction: FinancialDirection;
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
  lifecycle: FinancialLifecycle;
  netAmountKrw: MoneyKrw;
  vatAmountKrw: MoneyKrw;
  grossAmountKrw: MoneyKrw;
  expectedDate: IsoDate;
  contractualDueDate?: IsoDate;
  sourceArtifactId?: string;
  sourcePurchaseOrderId?: string;
  revision: number;
}

export interface Settlement {
  id: string;
  workspaceId: string;
  financialItemId: string;
  direction: FinancialDirection;
  amountKrw: MoneyKrw;
  settledAt: IsoDate;
  accountOrCard: string;
  evidenceRef: string;
  reversalOfSettlementId?: string;
}

export interface ApprovalReceipt {
  id: string;
  workspaceId: string;
  resourceType: "quote" | "change_request" | "purchase_order" | "financial_item" | "engagement_close";
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CustomerWorkOsError("INVALID_INPUT", `${label} is required`);
  return trimmed;
}

function parseMoney(value: MoneyKrw, label = "amount"): bigint {
  if (!/^-?\d+$/.test(value)) throw new CustomerWorkOsError("INVALID_MONEY", `${label} must be an integer KRW string`);
  return BigInt(value);
}

function nonNegativeMoney(value: MoneyKrw, label = "amount"): bigint {
  const amount = parseMoney(value, label);
  if (amount < 0n) throw new CustomerWorkOsError("INVALID_MONEY", `${label} cannot be negative`);
  return amount;
}

function money(value: bigint): MoneyKrw {
  return value.toString();
}

function lineAmount(unit: MoneyKrw, quantity: number, label: string): bigint {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new CustomerWorkOsError("INVALID_QUANTITY", `${label} quantity must be a positive integer`);
  return nonNegativeMoney(unit, `${label} unit amount`) * BigInt(quantity);
}

function marginBps(price: bigint, cost: bigint): number {
  if (price <= 0n) return 0;
  return Number(((price - cost) * 10_000n) / price);
}

function canonicalPayloadHash(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
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

const STAGE_TRANSITIONS: Readonly<Record<EngagementStage, readonly EngagementStage[]>> = {
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
  private readonly knowledgeItems = new Map<string, KnowledgeItem>();
  private readonly commitments = new Map<string, Commitment>();
  private readonly products = new Map<string, Product>();
  private readonly quotes = new Map<string, Quote>();
  private readonly contracts = new Map<string, Contract>();
  private readonly deliveryProjects = new Map<string, DeliveryProject>();
  private readonly changeRequests = new Map<string, ChangeRequest>();
  private readonly purchaseOrders = new Map<string, PurchaseOrder>();
  private readonly assets = new Map<string, Asset>();
  private readonly financialItems = new Map<string, FinancialItem>();
  private readonly settlements = new Map<string, Settlement>();
  private readonly consumedReceipts = new Set<string>();

  createAccount(input: Omit<Account, "normalizedName" | "version">): Account {
    this.assertUnique(this.accounts, input.id, "account");
    requireText(input.name, "account.name");
    if (input.kinds.length === 0) throw new CustomerWorkOsError("INVALID_INPUT", "account requires at least one kind");
    const normalizedName = input.name.trim().toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
    const duplicate = [...this.accounts.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.normalizedName === normalizedName,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_ACCOUNT", `account name already exists: ${duplicate.id}`);
    const account: Account = { ...clone(input), name: input.name.trim(), normalizedName, kinds: [...new Set(input.kinds)], version: 1 };
    this.accounts.set(account.id, account);
    return clone(account);
  }

  addContact(input: Omit<Contact, "version">): Contact {
    this.assertUnique(this.contacts, input.id, "contact");
    this.requireAccount(input.workspaceId, input.accountId);
    requireText(input.name, "contact.name");
    if (!input.email && !input.phone) throw new CustomerWorkOsError("CONTACT_CHANNEL_REQUIRED", "contact requires email or phone");
    const contact: Contact = { ...clone(input), name: input.name.trim(), version: 1 };
    this.contacts.set(contact.id, contact);
    return clone(contact);
  }

  createEngagement(input: Omit<Engagement, "version">): Engagement {
    this.assertUnique(this.engagements, input.id, "engagement");
    requireText(input.projectKey, "engagement.projectKey");
    requireText(input.name, "engagement.name");
    const duplicateKey = [...this.engagements.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.projectKey === input.projectKey,
    );
    if (duplicateKey) throw new CustomerWorkOsError("DUPLICATE_PROJECT_KEY", `project key already exists: ${input.projectKey}`);
    if (input.targetDate && input.startDate && input.targetDate < input.startDate) {
      throw new CustomerWorkOsError("INVALID_SCHEDULE", "targetDate precedes startDate");
    }
    const engagement: Engagement = { ...clone(input), projectKey: input.projectKey.trim(), name: input.name.trim(), version: 1 };
    this.engagements.set(engagement.id, engagement);
    return clone(engagement);
  }

  assignParty(input: EngagementParty): EngagementParty {
    this.assertUnique(this.parties, input.id, "engagement party");
    this.requireEngagement(input.workspaceId, input.engagementId);
    this.requireAccount(input.workspaceId, input.accountId);
    if (input.primary) {
      const duplicatePrimary = [...this.parties.values()].find(
        (item) => item.workspaceId === input.workspaceId && item.engagementId === input.engagementId && item.role === input.role && item.primary,
      );
      if (duplicatePrimary) throw new CustomerWorkOsError("DUPLICATE_PRIMARY_PARTY", `primary ${input.role} already assigned`);
    }
    this.parties.set(input.id, clone(input));
    return clone(input);
  }

  recordActivity(input: Activity): Activity {
    this.assertUnique(this.activities, input.id, "activity");
    this.requireEngagement(input.workspaceId, input.engagementId);
    if (input.accountId) this.requireAccount(input.workspaceId, input.accountId);
    requireText(input.summary, "activity.summary");
    if (input.aiConfidence !== undefined && (input.aiConfidence < 0 || input.aiConfidence > 1)) {
      throw new CustomerWorkOsError("INVALID_CONFIDENCE", "aiConfidence must be between 0 and 1");
    }
    if (input.aiConfidence !== undefined && input.aiConfidence < 0.8 && input.humanReviewed) {
      throw new CustomerWorkOsError("LOW_CONFIDENCE_REVIEW_REQUIRED", "low-confidence AI activity must remain unconfirmed until explicitly reviewed through reviewActivity");
    }
    this.activities.set(input.id, clone(input));
    return clone(input);
  }

  reviewActivity(workspaceId: string, activityId: string): Activity {
    const activity = this.requireOwned(this.activities, workspaceId, activityId, "activity");
    activity.humanReviewed = true;
    return clone(activity);
  }

  addKnowledgeItem(input: Omit<KnowledgeItem, "version">): KnowledgeItem {
    this.assertUnique(this.knowledgeItems, input.id, "knowledge item");
    this.requireEngagement(input.workspaceId, input.engagementId);
    requireText(input.statement, "knowledgeItem.statement");
    if (input.sourceActivityId) this.requireOwned(this.activities, input.workspaceId, input.sourceActivityId, "activity");
    if (input.status === "CONFIRMED" && !input.evidenceRef) {
      throw new CustomerWorkOsError("EVIDENCE_REQUIRED", "confirmed knowledge requires evidenceRef");
    }
    const item: KnowledgeItem = { ...clone(input), statement: input.statement.trim(), version: 1 };
    this.knowledgeItems.set(item.id, item);
    return clone(item);
  }

  verifyKnowledgeItem(workspaceId: string, itemId: string, evidenceRef: string): KnowledgeItem {
    const item = this.requireOwned(this.knowledgeItems, workspaceId, itemId, "knowledge item");
    requireText(evidenceRef, "evidenceRef");
    item.status = "CONFIRMED";
    item.evidenceRef = evidenceRef;
    item.version += 1;
    return clone(item);
  }

  addCommitment(input: Omit<Commitment, "version">): Commitment {
    this.assertUnique(this.commitments, input.id, "commitment");
    this.requireEngagement(input.workspaceId, input.engagementId);
    if (input.counterpartyAccountId) this.requireAccount(input.workspaceId, input.counterpartyAccountId);
    requireText(input.description, "commitment.description");
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100) {
      throw new CustomerWorkOsError("INVALID_PRIORITY", "commitment priority must be 0..100");
    }
    const commitment: Commitment = { ...clone(input), version: 1 };
    this.commitments.set(commitment.id, commitment);
    return clone(commitment);
  }

  completeCommitment(workspaceId: string, commitmentId: string, evidenceRef: string): Commitment {
    const item = this.requireOwned(this.commitments, workspaceId, commitmentId, "commitment");
    if (item.status === "DONE" || item.status === "CANCELLED") {
      throw new CustomerWorkOsError("INVALID_STATE", `commitment is ${item.status}`);
    }
    requireText(evidenceRef, "completion evidence");
    item.status = "DONE";
    item.completionEvidenceRef = evidenceRef;
    item.version += 1;
    return clone(item);
  }

  addProduct(input: Omit<Product, "version">): Product {
    this.assertUnique(this.products, input.id, "product");
    requireText(input.sku, "product.sku");
    requireText(input.name, "product.name");
    if (input.manufacturerAccountId) this.requireAccount(input.workspaceId, input.manufacturerAccountId);
    if (input.defaultCostKrw !== undefined) nonNegativeMoney(input.defaultCostKrw, "default cost");
    if (input.defaultPriceKrw !== undefined) nonNegativeMoney(input.defaultPriceKrw, "default price");
    const duplicate = [...this.products.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.sku === input.sku,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_SKU", `product sku already exists: ${input.sku}`);
    const product: Product = { ...clone(input), version: 1 };
    this.products.set(product.id, product);
    return clone(product);
  }

  createQuote(input: Omit<Quote, "totalCostKrw" | "totalPriceKrw" | "grossProfitKrw" | "marginBps" | "version">): Quote {
    this.assertUnique(this.quotes, input.id, "quote");
    const engagement = this.requireEngagement(input.workspaceId, input.engagementId);
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
      const product = this.requireOwned(this.products, input.workspaceId, line.productId, "product");
      if (!product.active) throw new CustomerWorkOsError("INACTIVE_PRODUCT", `product is inactive: ${product.id}`);
      if (line.vendorAccountId) this.requireAccount(input.workspaceId, line.vendorAccountId);
      totalCost += lineAmount(line.unitCostKrw, line.quantity, line.id);
      totalPrice += lineAmount(line.unitPriceKrw, line.quantity, line.id);
    }
    if (totalPrice < totalCost) throw new CustomerWorkOsError("NEGATIVE_MARGIN", "quote price is lower than cost");
    const quote: Quote = {
      ...clone(input),
      totalCostKrw: money(totalCost),
      totalPriceKrw: money(totalPrice),
      grossProfitKrw: money(totalPrice - totalCost),
      marginBps: marginBps(totalPrice, totalCost),
      version: 1,
    };
    this.quotes.set(quote.id, quote);
    if (engagement.stage === "DISCOVERY") {
      engagement.stage = "PROPOSAL";
      engagement.version += 1;
    }
    return clone(quote);
  }

  approveQuote(workspaceId: string, quoteId: string, expectedVersion: number, receipt: ApprovalReceipt, minimumMarginBps: number): Quote {
    const quote = this.requireVersion(this.quotes, workspaceId, quoteId, expectedVersion, "quote");
    if (quote.status !== "DRAFT" && quote.status !== "REVIEW") {
      throw new CustomerWorkOsError("INVALID_STATE", `quote is ${quote.status}`);
    }
    if (quote.marginBps < minimumMarginBps) {
      throw new CustomerWorkOsError("MARGIN_BELOW_FLOOR", `quote margin ${quote.marginBps}bps is below ${minimumMarginBps}bps`);
    }
    const payload = { totalCostKrw: quote.totalCostKrw, totalPriceKrw: quote.totalPriceKrw, marginBps: quote.marginBps, scope: quote.scope };
    this.consumeReceipt(receipt, workspaceId, "quote", quote.id, quote.version, "QUOTE_APPROVE", canonicalPayloadHash(payload));
    quote.status = "APPROVED";
    quote.approvalReceiptId = receipt.id;
    quote.version += 1;
    return clone(quote);
  }

  acceptQuoteAsContract(input: Omit<Contract, "version" | "status">, quoteExpectedVersion: number): { quote: Quote; contract: Contract; engagement: Engagement } {
    this.assertUnique(this.contracts, input.id, "contract");
    const quote = this.requireVersion(this.quotes, input.workspaceId, input.quoteId, quoteExpectedVersion, "quote");
    if (quote.engagementId !== input.engagementId) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "quote and contract engagement mismatch");
    if (quote.status !== "APPROVED" && quote.status !== "SENT") throw new CustomerWorkOsError("INVALID_STATE", "quote must be approved or sent");
    if (input.contractValueKrw !== quote.totalPriceKrw) {
      throw new CustomerWorkOsError("CONTRACT_VALUE_MISMATCH", "contract value must match accepted quote; create a revised quote first");
    }
    const milestoneTotal = input.billingMilestones.reduce((sum, item) => sum + nonNegativeMoney(item.amountKrw, `milestone ${item.id}`), 0n);
    if (milestoneTotal !== parseMoney(input.contractValueKrw)) {
      throw new CustomerWorkOsError("BILLING_MILESTONE_MISMATCH", "billing milestone total must equal contract value");
    }
    const contract: Contract = { ...clone(input), status: "ACTIVE", version: 1 };
    quote.status = "ACCEPTED";
    quote.version += 1;
    this.contracts.set(contract.id, contract);
    const engagement = this.requireEngagement(input.workspaceId, input.engagementId);
    engagement.wonQuoteId = quote.id;
    engagement.contractId = contract.id;
    engagement.stage = "CONTRACTED";
    engagement.version += 1;
    return { quote: clone(quote), contract: clone(contract), engagement: clone(engagement) };
  }

  handoverToDelivery(input: Omit<DeliveryProject, "status" | "workItems" | "version">): DeliveryProject {
    this.assertUnique(this.deliveryProjects, input.id, "delivery project");
    const engagement = this.requireEngagement(input.workspaceId, input.engagementId);
    const contract = this.requireOwned(this.contracts, input.workspaceId, input.contractId, "contract");
    if (contract.engagementId !== engagement.id || engagement.contractId !== contract.id) {
      throw new CustomerWorkOsError("INVALID_HANDOVER", "engagement does not own active contract");
    }
    if (contract.status !== "ACTIVE") throw new CustomerWorkOsError("INVALID_HANDOVER", "contract must be active");
    if (input.projectKey !== engagement.projectKey) throw new CustomerWorkOsError("PROJECT_KEY_MISMATCH", "delivery project must preserve engagement projectKey");
    if (input.scheduleEnd < input.scheduleStart) throw new CustomerWorkOsError("INVALID_SCHEDULE", "schedule end precedes start");
    if (input.deliverables.length === 0 || !input.deliverables.some((item) => item.required)) {
      throw new CustomerWorkOsError("MISSING_REQUIRED_DELIVERABLE", "handover requires at least one required deliverable");
    }
    for (const requirementId of input.requirementIds) {
      const requirement = this.requireOwned(this.knowledgeItems, input.workspaceId, requirementId, "requirement");
      if (requirement.engagementId !== engagement.id || requirement.kind !== "requirement") {
        throw new CustomerWorkOsError("INVALID_REQUIREMENT", `invalid requirement binding: ${requirementId}`);
      }
    }
    const project: DeliveryProject = { ...clone(input), status: "PLANNED", workItems: [], version: 1 };
    this.deliveryProjects.set(project.id, project);
    engagement.deliveryProjectId = project.id;
    engagement.stage = "DELIVERY";
    engagement.type = "delivery";
    engagement.version += 1;
    return clone(project);
  }

  activateDelivery(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.requireVersion(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status !== "PLANNED") throw new CustomerWorkOsError("INVALID_STATE", `delivery project is ${project.status}`);
    project.status = "ACTIVE";
    project.version += 1;
    return clone(project);
  }

  addDeliveryWorkItem(workspaceId: string, projectId: string, expectedVersion: number, item: DeliveryWorkItem): DeliveryProject {
    const project = this.requireVersion(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status !== "PLANNED" && project.status !== "ACTIVE") throw new CustomerWorkOsError("INVALID_STATE", `project is ${project.status}`);
    if (project.workItems.some((current) => current.id === item.id)) throw new CustomerWorkOsError("DUPLICATE_ID", `work item exists: ${item.id}`);
    for (const requirementId of item.requirementIds) {
      if (!project.requirementIds.includes(requirementId)) throw new CustomerWorkOsError("UNKNOWN_REQUIREMENT", `work item requirement not in baseline: ${requirementId}`);
    }
    if (item.deliverableId && !project.deliverables.some((deliverable) => deliverable.id === item.deliverableId)) {
      throw new CustomerWorkOsError("UNKNOWN_DELIVERABLE", `unknown deliverable: ${item.deliverableId}`);
    }
    project.workItems.push(clone(item));
    project.version += 1;
    return clone(project);
  }

  proposeChangeRequest(input: Omit<ChangeRequest, "status" | "version">): ChangeRequest {
    this.assertUnique(this.changeRequests, input.id, "change request");
    const engagement = this.requireEngagement(input.workspaceId, input.engagementId);
    const project = this.requireOwned(this.deliveryProjects, input.workspaceId, input.deliveryProjectId, "delivery project");
    if (project.engagementId !== engagement.id) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "change request project mismatch");
    nonNegativeMoney(input.costImpactKrw, "change cost impact");
    nonNegativeMoney(input.priceImpactKrw, "change price impact");
    if (!Number.isInteger(input.scheduleImpactDays)) throw new CustomerWorkOsError("INVALID_SCHEDULE_IMPACT", "scheduleImpactDays must be an integer");
    const request: ChangeRequest = { ...clone(input), status: "ANALYZED", version: 1 };
    this.changeRequests.set(request.id, request);
    return clone(request);
  }

  approveChangeRequest(workspaceId: string, requestId: string, expectedVersion: number, disposition: NonNullable<ChangeRequest["disposition"]>, receipt: ApprovalReceipt): ChangeRequest {
    const request = this.requireVersion(this.changeRequests, workspaceId, requestId, expectedVersion, "change request");
    if (request.status !== "ANALYZED" && request.status !== "AWAITING_APPROVAL") {
      throw new CustomerWorkOsError("INVALID_STATE", `change request is ${request.status}`);
    }
    const payload = { disposition, scopeImpact: request.scopeImpact, scheduleImpactDays: request.scheduleImpactDays, costImpactKrw: request.costImpactKrw, priceImpactKrw: request.priceImpactKrw };
    this.consumeReceipt(receipt, workspaceId, "change_request", request.id, request.version, "CHANGE_REQUEST_APPROVE", canonicalPayloadHash(payload));
    request.disposition = disposition;
    request.status = disposition === "REJECT" ? "REJECTED" : "APPROVED";
    request.approvalReceiptId = receipt.id;
    request.version += 1;
    return clone(request);
  }

  applyChangeRequest(workspaceId: string, requestId: string, expectedVersion: number): { request: ChangeRequest; project: DeliveryProject } {
    const request = this.requireVersion(this.changeRequests, workspaceId, requestId, expectedVersion, "change request");
    if (request.status !== "APPROVED" || request.disposition === "REJECT") throw new CustomerWorkOsError("INVALID_STATE", "change request is not approved");
    const project = this.requireOwned(this.deliveryProjects, workspaceId, request.deliveryProjectId, "delivery project");
    project.scopeBaseline = `${project.scopeBaseline}\nCHANGE ${request.id}: ${request.scopeImpact}`;
    if (request.scheduleImpactDays !== 0) {
      const date = new Date(`${project.scheduleEnd}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + request.scheduleImpactDays);
      project.scheduleEnd = date.toISOString().slice(0, 10);
    }
    project.version += 1;
    request.status = "APPLIED";
    request.version += 1;
    return { request: clone(request), project: clone(project) };
  }

  createPurchaseOrder(input: Omit<PurchaseOrder, "status" | "version">): PurchaseOrder {
    this.assertUnique(this.purchaseOrders, input.id, "purchase order");
    this.requireEngagement(input.workspaceId, input.engagementId);
    this.requireAccount(input.workspaceId, input.vendorAccountId);
    if (input.lines.length === 0) throw new CustomerWorkOsError("EMPTY_PURCHASE_ORDER", "purchase order requires lines");
    for (const line of input.lines) {
      this.requireOwned(this.products, input.workspaceId, line.productId, "product");
      lineAmount(line.unitCostKrw, line.quantity, line.id);
      if (!Number.isInteger(line.receivedQuantity) || line.receivedQuantity < 0 || line.receivedQuantity > line.quantity) {
        throw new CustomerWorkOsError("INVALID_RECEIVED_QUANTITY", `invalid received quantity on ${line.id}`);
      }
    }
    const order: PurchaseOrder = { ...clone(input), status: "DRAFT", version: 1 };
    this.purchaseOrders.set(order.id, order);
    return clone(order);
  }

  approvePurchaseOrder(workspaceId: string, orderId: string, expectedVersion: number, receipt: ApprovalReceipt): PurchaseOrder {
    const order = this.requireVersion(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "DRAFT" && order.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", `purchase order is ${order.status}`);
    const total = order.lines.reduce((sum, line) => sum + lineAmount(line.unitCostKrw, line.quantity, line.id), 0n);
    const payload = { vendorAccountId: order.vendorAccountId, totalCostKrw: money(total), lines: order.lines };
    this.consumeReceipt(receipt, workspaceId, "purchase_order", order.id, order.version, "PURCHASE_ORDER_APPROVE", canonicalPayloadHash(payload));
    order.status = "APPROVED";
    order.approvalReceiptId = receipt.id;
    order.version += 1;
    return clone(order);
  }

  markPurchaseOrderOrdered(workspaceId: string, orderId: string, expectedVersion: number): PurchaseOrder {
    const order = this.requireVersion(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "APPROVED") throw new CustomerWorkOsError("INVALID_STATE", "purchase order must be approved");
    order.status = "ORDERED";
    order.version += 1;
    return clone(order);
  }

  receivePurchaseOrderLine(workspaceId: string, orderId: string, expectedVersion: number, lineId: string, quantity: number): PurchaseOrder {
    const order = this.requireVersion(this.purchaseOrders, workspaceId, orderId, expectedVersion, "purchase order");
    if (order.status !== "ORDERED" && order.status !== "PARTIALLY_RECEIVED") throw new CustomerWorkOsError("INVALID_STATE", `purchase order is ${order.status}`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new CustomerWorkOsError("INVALID_QUANTITY", "received quantity must be positive integer");
    const line = order.lines.find((current) => current.id === lineId);
    if (!line) throw new CustomerWorkOsError("NOT_FOUND", `purchase order line not found: ${lineId}`);
    if (line.receivedQuantity + quantity > line.quantity) throw new CustomerWorkOsError("OVER_RECEIPT", "received quantity exceeds ordered quantity");
    line.receivedQuantity += quantity;
    const complete = order.lines.every((current) => current.receivedQuantity === current.quantity);
    order.status = complete ? "RECEIVED" : "PARTIALLY_RECEIVED";
    order.version += 1;
    return clone(order);
  }

  registerAsset(input: Omit<Asset, "version">): Asset {
    this.assertUnique(this.assets, input.id, "asset");
    const order = this.requireOwned(this.purchaseOrders, input.workspaceId, input.purchaseOrderId, "purchase order");
    if (order.engagementId !== input.engagementId) throw new CustomerWorkOsError("CROSS_ENGAGEMENT", "asset and purchase order mismatch");
    if (order.status !== "PARTIALLY_RECEIVED" && order.status !== "RECEIVED") {
      throw new CustomerWorkOsError("NOT_RECEIVED", "asset cannot be registered before receipt");
    }
    this.requireAccount(input.workspaceId, input.customerAccountId);
    this.requireOwned(this.products, input.workspaceId, input.productId, "product");
    requireText(input.serialOrLicenseKey, "serialOrLicenseKey");
    const duplicate = [...this.assets.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.serialOrLicenseKey === input.serialOrLicenseKey,
    );
    if (duplicate) throw new CustomerWorkOsError("DUPLICATE_ASSET_IDENTIFIER", "serial/license key already registered");
    const asset: Asset = { ...clone(input), version: 1 };
    this.assets.set(asset.id, asset);
    return clone(asset);
  }

  addFinancialItem(input: FinancialItem): FinancialItem {
    this.assertUnique(this.financialItems, input.id, "financial item");
    if (input.engagementId) this.requireEngagement(input.workspaceId, input.engagementId);
    this.requireAccount(input.workspaceId, input.accountId);
    const net = nonNegativeMoney(input.netAmountKrw, "net amount");
    const vat = nonNegativeMoney(input.vatAmountKrw, "VAT amount");
    const gross = nonNegativeMoney(input.grossAmountKrw, "gross amount");
    if (net + vat !== gross) throw new CustomerWorkOsError("VAT_MISMATCH", "gross amount must equal net plus VAT");
    if (!input.engagementId && input.category !== "overhead") {
      throw new CustomerWorkOsError("PROJECT_BINDING_REQUIRED", "non-overhead financial item requires engagementId");
    }
    if (input.sourcePurchaseOrderId) {
      const order = this.requireOwned(this.purchaseOrders, input.workspaceId, input.sourcePurchaseOrderId, "purchase order");
      if (input.engagementId !== order.engagementId || input.direction !== "OUT") {
        throw new CustomerWorkOsError("PURCHASE_BINDING_MISMATCH", "purchase-linked financial item must be an OUT item for the same engagement");
      }
    }
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new CustomerWorkOsError("INVALID_REVISION", "financial item revision must be >= 1");
    this.financialItems.set(input.id, clone(input));
    return clone(input);
  }

  reviseFinancialItem(workspaceId: string, itemId: string, expectedRevision: number, patch: Pick<FinancialItem, "netAmountKrw" | "vatAmountKrw" | "grossAmountKrw" | "expectedDate" | "contractualDueDate" | "lifecycle">, receipt: ApprovalReceipt): FinancialItem {
    const item = this.requireOwned(this.financialItems, workspaceId, itemId, "financial item");
    if (item.revision !== expectedRevision) throw new CustomerWorkOsError("STALE_VERSION", `expected financial revision ${expectedRevision}, found ${item.revision}`);
    if (item.lifecycle === "SETTLED" || item.lifecycle === "CANCELLED") throw new CustomerWorkOsError("IMMUTABLE_FINANCIAL_ITEM", `cannot revise ${item.lifecycle} item`);
    const net = nonNegativeMoney(patch.netAmountKrw, "net amount");
    const vat = nonNegativeMoney(patch.vatAmountKrw, "VAT amount");
    const gross = nonNegativeMoney(patch.grossAmountKrw, "gross amount");
    if (net + vat !== gross) throw new CustomerWorkOsError("VAT_MISMATCH", "gross amount must equal net plus VAT");
    const payload = { ...patch };
    this.consumeReceipt(receipt, workspaceId, "financial_item", item.id, item.revision, "FINANCIAL_ITEM_REVISE", canonicalPayloadHash(payload));
    Object.assign(item, clone(patch), { revision: item.revision + 1 });
    return clone(item);
  }

  recordSettlement(input: Settlement): { settlement: Settlement; financialItem: FinancialItem } {
    this.assertUnique(this.settlements, input.id, "settlement");
    const item = this.requireOwned(this.financialItems, input.workspaceId, input.financialItemId, "financial item");
    if (item.direction !== input.direction) throw new CustomerWorkOsError("DIRECTION_MISMATCH", "settlement direction must match financial item");
    if (item.lifecycle === "CANCELLED") throw new CustomerWorkOsError("INVALID_STATE", "cannot settle cancelled item");
    const amount = nonNegativeMoney(input.amountKrw, "settlement amount");
    if (amount === 0n) throw new CustomerWorkOsError("INVALID_MONEY", "settlement amount must be greater than zero");
    requireText(input.evidenceRef, "settlement evidenceRef");
    if (input.reversalOfSettlementId) {
      const original = this.requireOwned(this.settlements, input.workspaceId, input.reversalOfSettlementId, "settlement");
      if (original.financialItemId !== item.id || original.direction === input.direction || original.amountKrw !== input.amountKrw) {
        throw new CustomerWorkOsError("INVALID_REVERSAL", "reversal must offset the original settlement");
      }
    }
    const allocated = this.settledAmount(item.id);
    if (!input.reversalOfSettlementId && allocated + amount > parseMoney(item.grossAmountKrw)) {
      throw new CustomerWorkOsError("OVER_SETTLEMENT", "settlement exceeds financial item gross amount");
    }
    this.settlements.set(input.id, clone(input));
    const netSettled = this.settledAmount(item.id);
    const gross = parseMoney(item.grossAmountKrw);
    item.lifecycle = netSettled === 0n ? item.lifecycle : netSettled < gross ? "PARTIAL" : "SETTLED";
    return { settlement: clone(input), financialItem: clone(item) };
  }

  financeSummary(workspaceId: string, engagementId: string): ProjectFinanceSummary {
    this.requireEngagement(workspaceId, engagementId);
    const items = [...this.financialItems.values()].filter(
      (item) => item.workspaceId === workspaceId && item.engagementId === engagementId && item.lifecycle !== "CANCELLED",
    );
    const inbound = items.filter((item) => item.direction === "IN");
    const outbound = items.filter((item) => item.direction === "OUT");
    const expectedRevenue = inbound.reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const contractedRevenue = inbound
      .filter((item) => ["CONFIRMED", "BILLED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const billedRevenue = inbound
      .filter((item) => ["BILLED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.grossAmountKrw), 0n);
    const collected = inbound.reduce((sum, item) => sum + this.settledAmount(item.id), 0n);
    const approvedCost = outbound
      .filter((item) => item.category !== "overhead" && ["APPROVED", "CONFIRMED", "INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const incurredCost = outbound
      .filter((item) => item.category !== "overhead" && ["INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle))
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const paid = outbound.reduce((sum, item) => sum + this.settledAmount(item.id), 0n);
    const eac = outbound
      .filter((item) => item.category !== "overhead")
      .reduce((sum, item) => sum + parseMoney(item.netAmountKrw), 0n);
    const forecastProfit = expectedRevenue - eac;
    return {
      engagementId,
      expectedRevenueKrw: money(expectedRevenue),
      contractedRevenueKrw: money(contractedRevenue),
      billedRevenueKrw: money(billedRevenue),
      collectedKrw: money(collected),
      receivableKrw: money(billedRevenue - collected),
      approvedCostKrw: money(approvedCost),
      incurredCostKrw: money(incurredCost),
      paidKrw: money(paid),
      payableKrw: money(outbound.reduce((sum, item) => {
        if (!["INCURRED", "PARTIAL", "SETTLED", "OVERDUE"].includes(item.lifecycle)) return sum;
        return sum + parseMoney(item.grossAmountKrw) - this.settledAmount(item.id);
      }, 0n)),
      estimateAtCompletionKrw: money(eac),
      forecastProfitKrw: money(forecastProfit),
      forecastMarginBps: marginBps(expectedRevenue, eac),
      cashPositionKrw: money(collected - paid),
    };
  }

  transitionEngagement(workspaceId: string, engagementId: string, expectedVersion: number, nextStage: EngagementStage, reason?: string): Engagement {
    const engagement = this.requireVersion(this.engagements, workspaceId, engagementId, expectedVersion, "engagement");
    if (!STAGE_TRANSITIONS[engagement.stage].includes(nextStage)) {
      throw new CustomerWorkOsError("INVALID_TRANSITION", `${engagement.stage} cannot transition to ${nextStage}`);
    }
    if ((nextStage === "LOST" || nextStage === "CANCELLED") && !reason?.trim()) {
      throw new CustomerWorkOsError("REASON_REQUIRED", `${nextStage} requires reason`);
    }
    if (ACTIVE_STAGES.has(nextStage)) {
      const open = this.openCommitments(workspaceId, engagementId);
      if (open.length === 0) throw new CustomerWorkOsError("NEXT_ACTION_REQUIRED", "active engagement requires at least one open commitment");
    }
    engagement.stage = nextStage;
    engagement.closedReason = reason?.trim();
    engagement.version += 1;
    return clone(engagement);
  }

  proposeDeliveryCompletion(workspaceId: string, projectId: string, expectedVersion: number): DeliveryProject {
    const project = this.requireVersion(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    const incompleteDeliverables = project.deliverables.filter((item) => item.required && item.status !== "APPROVED");
    if (incompleteDeliverables.length > 0) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", `required deliverables not approved: ${incompleteDeliverables.map((item) => item.id).join(",")}`);
    }
    if (project.workItems.some((item) => item.status !== "DONE")) {
      throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", "all delivery work items must be done");
    }
    const unresolvedChanges = [...this.changeRequests.values()].filter(
      (item) => item.workspaceId === workspaceId && item.deliveryProjectId === project.id && !["REJECTED", "APPLIED"].includes(item.status),
    );
    if (unresolvedChanges.length > 0) throw new CustomerWorkOsError("COMPLETION_RULE_FAILED", "open change requests remain");
    project.status = "AWAITING_APPROVAL";
    project.version += 1;
    return clone(project);
  }

  closeEngagement(workspaceId: string, engagementId: string, expectedVersion: number, receipt: ApprovalReceipt): Engagement {
    const engagement = this.requireVersion(this.engagements, workspaceId, engagementId, expectedVersion, "engagement");
    if (engagement.stage !== "COLLECTION") throw new CustomerWorkOsError("INVALID_STAGE", "engagement must be in COLLECTION");
    const open = this.openCommitments(workspaceId, engagementId);
    if (open.length > 0) throw new CustomerWorkOsError("OPEN_COMMITMENTS", "engagement has open commitments");
    if (engagement.deliveryProjectId) {
      const project = this.requireOwned(this.deliveryProjects, workspaceId, engagement.deliveryProjectId, "delivery project");
      if (project.status !== "COMPLETE") throw new CustomerWorkOsError("DELIVERY_NOT_COMPLETE", "delivery project is not complete");
    }
    const finance = this.financeSummary(workspaceId, engagementId);
    if (parseMoney(finance.receivableKrw) !== 0n || parseMoney(finance.payableKrw) !== 0n) {
      throw new CustomerWorkOsError("FINANCE_NOT_CLOSED", "receivable or payable remains");
    }
    const payload = { stage: engagement.stage, finance, openCommitments: 0 };
    this.consumeReceipt(receipt, workspaceId, "engagement_close", engagement.id, engagement.version, "ENGAGEMENT_CLOSE", canonicalPayloadHash(payload));
    engagement.stage = "CLOSED";
    engagement.version += 1;
    return clone(engagement);
  }

  completeDelivery(workspaceId: string, projectId: string, expectedVersion: number, receipt: ApprovalReceipt): DeliveryProject {
    const project = this.requireVersion(this.deliveryProjects, workspaceId, projectId, expectedVersion, "delivery project");
    if (project.status !== "AWAITING_APPROVAL") throw new CustomerWorkOsError("INVALID_STATE", "completion must be proposed first");
    const payload = { projectId: project.id, version: project.version, deliverables: project.deliverables };
    this.consumeReceipt(receipt, workspaceId, "engagement_close", project.engagementId, project.version, "DELIVERY_COMPLETE", canonicalPayloadHash(payload));
    project.status = "COMPLETE";
    project.version += 1;
    const engagement = this.requireEngagement(workspaceId, project.engagementId);
    engagement.stage = "BILLING";
    engagement.version += 1;
    return clone(project);
  }

  getEngagementSnapshot(workspaceId: string, engagementId: string): {
    engagement: Engagement;
    parties: EngagementParty[];
    activities: Activity[];
    knowledge: KnowledgeItem[];
    commitments: Commitment[];
    quotes: Quote[];
    contracts: Contract[];
    deliveryProjects: DeliveryProject[];
    changeRequests: ChangeRequest[];
    purchaseOrders: PurchaseOrder[];
    assets: Asset[];
    financialItems: FinancialItem[];
    settlements: Settlement[];
    finance: ProjectFinanceSummary;
  } {
    const engagement = this.requireEngagement(workspaceId, engagementId);
    const financialItems = this.forEngagement(this.financialItems, workspaceId, engagementId);
    const itemIds = new Set(financialItems.map((item) => item.id));
    return {
      engagement: clone(engagement),
      parties: this.forEngagement(this.parties, workspaceId, engagementId),
      activities: this.forEngagement(this.activities, workspaceId, engagementId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
      knowledge: this.forEngagement(this.knowledgeItems, workspaceId, engagementId),
      commitments: this.forEngagement(this.commitments, workspaceId, engagementId).sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
      quotes: this.forEngagement(this.quotes, workspaceId, engagementId),
      contracts: this.forEngagement(this.contracts, workspaceId, engagementId),
      deliveryProjects: this.forEngagement(this.deliveryProjects, workspaceId, engagementId),
      changeRequests: this.forEngagement(this.changeRequests, workspaceId, engagementId),
      purchaseOrders: this.forEngagement(this.purchaseOrders, workspaceId, engagementId),
      assets: this.forEngagement(this.assets, workspaceId, engagementId),
      financialItems,
      settlements: [...this.settlements.values()].filter((item) => item.workspaceId === workspaceId && itemIds.has(item.financialItemId)).map(clone),
      finance: this.financeSummary(workspaceId, engagementId),
    };
  }

  private openCommitments(workspaceId: string, engagementId: string): Commitment[] {
    return [...this.commitments.values()]
      .filter((item) => item.workspaceId === workspaceId && item.engagementId === engagementId && !["DONE", "CANCELLED"].includes(item.status))
      .map(clone);
  }

  private settledAmount(financialItemId: string): bigint {
    let total = 0n;
    for (const settlement of this.settlements.values()) {
      if (settlement.financialItemId !== financialItemId) continue;
      const amount = parseMoney(settlement.amountKrw);
      total += settlement.reversalOfSettlementId ? -amount : amount;
    }
    if (total < 0n) throw new CustomerWorkOsError("INVALID_SETTLEMENT_BALANCE", "settlement reversals exceed original settlements");
    return total;
  }

  private consumeReceipt(
    receipt: ApprovalReceipt,
    workspaceId: string,
    resourceType: ApprovalReceipt["resourceType"],
    resourceId: string,
    resourceVersion: number,
    action: string,
    payloadHash: string,
  ): void {
    if (this.consumedReceipts.has(receipt.id)) throw new CustomerWorkOsError("REPLAYED_APPROVAL", `approval receipt already consumed: ${receipt.id}`);
    if (
      receipt.status !== "CONSUMED" ||
      receipt.workspaceId !== workspaceId ||
      receipt.resourceType !== resourceType ||
      receipt.resourceId !== resourceId ||
      receipt.resourceVersion !== resourceVersion ||
      receipt.action !== action ||
      receipt.payloadHash !== payloadHash
    ) {
      throw new CustomerWorkOsError("STALE_APPROVAL", `${action} approval is stale or payload-bound to another request`);
    }
    this.consumedReceipts.add(receipt.id);
  }

  private requireAccount(workspaceId: string, accountId: string): Account {
    return this.requireOwned(this.accounts, workspaceId, accountId, "account");
  }

  private requireEngagement(workspaceId: string, engagementId: string): Engagement {
    return this.requireOwned(this.engagements, workspaceId, engagementId, "engagement");
  }

  private requireOwned<T extends { workspaceId: string }>(map: Map<string, T>, workspaceId: string, id: string, label: string): T {
    const item = map.get(id);
    if (!item) throw new CustomerWorkOsError("NOT_FOUND", `${label} not found: ${id}`);
    if (item.workspaceId !== workspaceId) throw new CustomerWorkOsError("CROSS_WORKSPACE", `${label} belongs to another workspace`);
    return item;
  }

  private requireVersion<T extends { workspaceId: string; version: number }>(
    map: Map<string, T>,
    workspaceId: string,
    id: string,
    expectedVersion: number,
    label: string,
  ): T {
    const item = this.requireOwned(map, workspaceId, id, label);
    if (item.version !== expectedVersion) throw new CustomerWorkOsError("STALE_VERSION", `expected ${label} version ${expectedVersion}, found ${item.version}`);
    return item;
  }

  private assertUnique<T>(map: Map<string, T>, id: string, label: string): void {
    requireText(id, `${label}.id`);
    if (map.has(id)) throw new CustomerWorkOsError("DUPLICATE_ID", `${label} already exists: ${id}`);
  }

  private forEngagement<T extends { workspaceId: string; engagementId: string }>(map: Map<string, T>, workspaceId: string, engagementId: string): T[] {
    return [...map.values()]
      .filter((item) => item.workspaceId === workspaceId && item.engagementId === engagementId)
      .map(clone);
  }
}

export const customerWorkOsPayloadHash = canonicalPayloadHash;
