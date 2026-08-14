import {
  CustomerWorkOsError,
  CustomerWorkOsService,
  type Account,
  type Activity,
  type Asset,
  type ChangeRequest,
  type Commitment,
  type Contact,
  type Contract,
  type DeliveryProject,
  type Engagement,
  type EngagementParty,
  type FinancialItem,
  type KnowledgeItem,
  type Product,
  type PurchaseOrder,
  type Quote,
  type Settlement,
} from "./customer-work-os.js";

export * from "./customer-work-os.js";

export interface CustomerWorkOsState {
  schemaVersion: 1;
  accounts: Account[];
  contacts: Contact[];
  engagements: Engagement[];
  parties: EngagementParty[];
  activities: Activity[];
  knowledge: KnowledgeItem[];
  commitments: Commitment[];
  products: Product[];
  quotes: Quote[];
  contracts: Contract[];
  deliveryProjects: DeliveryProject[];
  changes: ChangeRequest[];
  purchaseOrders: PurchaseOrder[];
  assets: Asset[];
  financialItems: FinancialItem[];
  settlements: Settlement[];
  financialItemBaseLifecycle: Array<{
    financialItemId: string;
    lifecycle: FinancialItem["lifecycle"];
  }>;
  consumedReceiptIds: string[];
}

type ServiceInternals = {
  accounts: Map<string, Account>;
  contacts: Map<string, Contact>;
  engagements: Map<string, Engagement>;
  parties: Map<string, EngagementParty>;
  activities: Map<string, Activity>;
  knowledge: Map<string, KnowledgeItem>;
  commitments: Map<string, Commitment>;
  products: Map<string, Product>;
  quotes: Map<string, Quote>;
  contracts: Map<string, Contract>;
  deliveryProjects: Map<string, DeliveryProject>;
  changes: Map<string, ChangeRequest>;
  purchaseOrders: Map<string, PurchaseOrder>;
  assets: Map<string, Asset>;
  financialItems: Map<string, FinancialItem>;
  settlements: Map<string, Settlement>;
  financialItemBaseLifecycle: Map<string, FinancialItem["lifecycle"]>;
  consumedReceiptIds: Set<string>;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function internals(service: CustomerWorkOsService): ServiceInternals {
  return service as unknown as ServiceInternals;
}

function sortedValues<T extends { id: string }>(map: ReadonlyMap<string, T>): T[] {
  return [...map.values()]
    .map((item) => copy(item))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function readMap<T extends { id: string }>(value: unknown, label: string): Map<string, T> {
  if (!Array.isArray(value)) throw new CustomerWorkOsError("INVALID_STATE", `${label} must be an array`);
  const result = new Map<string, T>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CustomerWorkOsError("INVALID_STATE", `${label} contains a non-object item`);
    }
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) {
      throw new CustomerWorkOsError("INVALID_STATE", `${label} item id is required`);
    }
    if (result.has(id)) throw new CustomerWorkOsError("INVALID_STATE", `${label} contains duplicate id ${id}`);
    result.set(id, copy(raw as T));
  }
  return result;
}

function readLifecycle(value: unknown, financialItems: ReadonlyMap<string, FinancialItem>): Map<string, FinancialItem["lifecycle"]> {
  if (!Array.isArray(value)) throw new CustomerWorkOsError("INVALID_STATE", "financialItemBaseLifecycle must be an array");
  const result = new Map<string, FinancialItem["lifecycle"]>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CustomerWorkOsError("INVALID_STATE", "financialItemBaseLifecycle contains a non-object item");
    }
    const item = raw as { financialItemId?: unknown; lifecycle?: unknown };
    if (typeof item.financialItemId !== "string" || !item.financialItemId.trim()) {
      throw new CustomerWorkOsError("INVALID_STATE", "financialItemBaseLifecycle requires financialItemId");
    }
    if (!financialItems.has(item.financialItemId)) {
      throw new CustomerWorkOsError("INVALID_STATE", `financial base lifecycle references missing item ${item.financialItemId}`);
    }
    const lifecycle = item.lifecycle;
    if (typeof lifecycle !== "string") throw new CustomerWorkOsError("INVALID_STATE", "financial lifecycle must be a string");
    result.set(item.financialItemId, lifecycle as FinancialItem["lifecycle"]);
  }
  return result;
}

function readReceiptIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) throw new CustomerWorkOsError("INVALID_STATE", "consumedReceiptIds must be an array");
  const result = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) throw new CustomerWorkOsError("INVALID_STATE", "consumed receipt id must be a string");
    if (result.has(raw)) throw new CustomerWorkOsError("INVALID_STATE", `duplicate consumed receipt id ${raw}`);
    result.add(raw);
  }
  return result;
}

function replaceMap<T>(target: Map<string, T>, source: ReadonlyMap<string, T>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, copy(value));
}

function replaceSet(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const value of source) target.add(value);
}

declare module "./customer-work-os.js" {
  interface CustomerWorkOsService {
    exportState(): CustomerWorkOsState;
    hydrateState(state: CustomerWorkOsState): void;
  }
}

CustomerWorkOsService.prototype.exportState = function exportState(): CustomerWorkOsState {
  const state = internals(this);
  return {
    schemaVersion: 1,
    accounts: sortedValues(state.accounts),
    contacts: sortedValues(state.contacts),
    engagements: sortedValues(state.engagements),
    parties: sortedValues(state.parties),
    activities: sortedValues(state.activities),
    knowledge: sortedValues(state.knowledge),
    commitments: sortedValues(state.commitments),
    products: sortedValues(state.products),
    quotes: sortedValues(state.quotes),
    contracts: sortedValues(state.contracts),
    deliveryProjects: sortedValues(state.deliveryProjects),
    changes: sortedValues(state.changes),
    purchaseOrders: sortedValues(state.purchaseOrders),
    assets: sortedValues(state.assets),
    financialItems: sortedValues(state.financialItems),
    settlements: sortedValues(state.settlements),
    financialItemBaseLifecycle: [...state.financialItemBaseLifecycle.entries()]
      .map(([financialItemId, lifecycle]) => ({ financialItemId, lifecycle }))
      .sort((left, right) => left.financialItemId.localeCompare(right.financialItemId)),
    consumedReceiptIds: [...state.consumedReceiptIds].sort(),
  };
};

CustomerWorkOsService.prototype.hydrateState = function hydrateState(input: CustomerWorkOsState): void {
  if (!input || typeof input !== "object" || input.schemaVersion !== 1) {
    throw new CustomerWorkOsError("UNSUPPORTED_STATE", "unsupported Customer Work OS state schema");
  }

  const next = {
    accounts: readMap<Account>(input.accounts, "accounts"),
    contacts: readMap<Contact>(input.contacts, "contacts"),
    engagements: readMap<Engagement>(input.engagements, "engagements"),
    parties: readMap<EngagementParty>(input.parties, "parties"),
    activities: readMap<Activity>(input.activities, "activities"),
    knowledge: readMap<KnowledgeItem>(input.knowledge, "knowledge"),
    commitments: readMap<Commitment>(input.commitments, "commitments"),
    products: readMap<Product>(input.products, "products"),
    quotes: readMap<Quote>(input.quotes, "quotes"),
    contracts: readMap<Contract>(input.contracts, "contracts"),
    deliveryProjects: readMap<DeliveryProject>(input.deliveryProjects, "deliveryProjects"),
    changes: readMap<ChangeRequest>(input.changes, "changes"),
    purchaseOrders: readMap<PurchaseOrder>(input.purchaseOrders, "purchaseOrders"),
    assets: readMap<Asset>(input.assets, "assets"),
    financialItems: readMap<FinancialItem>(input.financialItems, "financialItems"),
    settlements: readMap<Settlement>(input.settlements, "settlements"),
  };
  const financialItemBaseLifecycle = readLifecycle(input.financialItemBaseLifecycle, next.financialItems);
  const consumedReceiptIds = readReceiptIds(input.consumedReceiptIds);

  const state = internals(this);
  replaceMap(state.accounts, next.accounts);
  replaceMap(state.contacts, next.contacts);
  replaceMap(state.engagements, next.engagements);
  replaceMap(state.parties, next.parties);
  replaceMap(state.activities, next.activities);
  replaceMap(state.knowledge, next.knowledge);
  replaceMap(state.commitments, next.commitments);
  replaceMap(state.products, next.products);
  replaceMap(state.quotes, next.quotes);
  replaceMap(state.contracts, next.contracts);
  replaceMap(state.deliveryProjects, next.deliveryProjects);
  replaceMap(state.changes, next.changes);
  replaceMap(state.purchaseOrders, next.purchaseOrders);
  replaceMap(state.assets, next.assets);
  replaceMap(state.financialItems, next.financialItems);
  replaceMap(state.settlements, next.settlements);
  replaceMap(state.financialItemBaseLifecycle, financialItemBaseLifecycle);
  replaceSet(state.consumedReceiptIds, consumedReceiptIds);
};
