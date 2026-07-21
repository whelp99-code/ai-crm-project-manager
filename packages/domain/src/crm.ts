export class CrmDomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CrmDomainError";
  }
}

export interface Customer {
  id: string;
  workspaceId: string;
  name: string;
  status: "active" | "at_risk" | "inactive";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerContract {
  id: string;
  workspaceId: string;
  customerId: string;
  title: string;
  scope: string;
  effectiveFrom: string;
  effectiveTo?: string;
  valueKrw?: string;
}

export interface Communication {
  id: string;
  workspaceId: string;
  customerId: string;
  channel: "email" | "meeting" | "phone" | "note";
  summary: string;
  occurredAt: string;
}

export interface NextAction {
  id: string;
  workspaceId: string;
  customerId: string;
  title: string;
  priority: number;
  dueAt: string;
  status: "open" | "done";
}

export interface OperationalException {
  id: string;
  workspaceId: string;
  customerId: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  priority: number;
  occurredAt: string;
  status: "open" | "resolved";
  resolvedAt?: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  customerId: string;
  name: string;
  status: string;
  progress: number;
}

export interface FinanceSummary {
  status: "available";
  asOf: string;
  cashKrw: string;
  receivableKrw: string;
  payableKrw: string;
  projectMarginKrw: string;
}

export interface CustomerOverview {
  sectionOrder: readonly ["exceptions", "nextActions", "status", "contracts", "projects", "communications", "finance"];
  customer: Customer;
  exceptions: OperationalException[];
  nextActions: NextAction[];
  contracts: CustomerContract[];
  projects: ProjectSummary[];
  communications: Communication[];
  finance: FinanceSummary | { status: "pending" };
}

const SECTION_ORDER = [
  "exceptions",
  "nextActions",
  "status",
  "contracts",
  "projects",
  "communications",
  "finance",
] as const;

export class CrmService {
  private readonly customers = new Map<string, Customer>();
  private readonly contracts = new Map<string, CustomerContract>();
  private readonly communications = new Map<string, Communication>();
  private readonly nextActions = new Map<string, NextAction>();
  private readonly exceptions = new Map<string, OperationalException>();
  /**
   * Restart-consistency hydrate-on-boot (N-12 / D2): rebuild the in-memory
   * customers map wholesale from persisted `Customer` rows (read back from
   * PG at process start via `CrmRepository.listAllCustomers`), so a fresh
   * process reflects prior customers instead of starting empty. Scoped to
   * CUSTOMERS ONLY — contracts/communications/nextActions/exceptions are
   * not dual-written/replayed yet (documented residual, see
   * docs/ops/sor-persistence.md).
   */
  hydrateCustomers(customers: readonly Customer[]): void {
    this.customers.clear();
    for (const customer of customers) {
      this.customers.set(customer.id, structuredClone(customer));
    }
  }

  createCustomer(input: Omit<Customer, "version">): Customer {
    this.assertUnique(this.customers, input.id, "customer");
    const customer: Customer = { ...input, version: 1 };
    this.customers.set(customer.id, customer);
    return structuredClone(customer);
  }

  updateCustomer(
    workspaceId: string,
    customerId: string,
    expectedVersion: number,
    patch: Partial<Pick<Customer, "name" | "status">>,
    updatedAt: string,
  ): Customer {
    const current = this.requireCustomer(workspaceId, customerId);
    if (current.version !== expectedVersion) {
      throw new CrmDomainError("STALE_VERSION", `expected customer version ${expectedVersion}, found ${current.version}`);
    }
    const next: Customer = { ...current, ...patch, version: current.version + 1, updatedAt };
    this.customers.set(customerId, next);
    return structuredClone(next);
  }

  addContract(contract: CustomerContract): CustomerContract {
    this.requireCustomer(contract.workspaceId, contract.customerId);
    this.assertUnique(this.contracts, contract.id, "contract");
    this.contracts.set(contract.id, structuredClone(contract));
    return structuredClone(contract);
  }

  recordCommunication(communication: Communication): Communication {
    this.requireCustomer(communication.workspaceId, communication.customerId);
    this.assertUnique(this.communications, communication.id, "communication");
    this.communications.set(communication.id, structuredClone(communication));
    return structuredClone(communication);
  }

  addNextAction(action: NextAction): NextAction {
    this.requireCustomer(action.workspaceId, action.customerId);
    this.assertUnique(this.nextActions, action.id, "next action");
    this.nextActions.set(action.id, structuredClone(action));
    return structuredClone(action);
  }

  addException(exception: OperationalException): OperationalException {
    this.requireCustomer(exception.workspaceId, exception.customerId);
    this.assertUnique(this.exceptions, exception.id, "exception");
    this.exceptions.set(exception.id, structuredClone(exception));
    return structuredClone(exception);
  }

  resolveException(workspaceId: string, exceptionId: string, resolvedAt: string): OperationalException {
    const current = this.exceptions.get(exceptionId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new CrmDomainError("NOT_FOUND", `exception not found: ${exceptionId}`);
    }
    if (current.status === "resolved") throw new CrmDomainError("ALREADY_RESOLVED", `exception already resolved: ${exceptionId}`);
    const resolved: OperationalException = { ...current, status: "resolved", resolvedAt };
    this.exceptions.set(exceptionId, resolved);
    return structuredClone(resolved);
  }

  overview(
    workspaceId: string,
    customerId: string,
    projects: readonly ProjectSummary[],
    finance?: FinanceSummary,
  ): CustomerOverview {
    const customer = this.requireCustomer(workspaceId, customerId);
    for (const project of projects) {
      if (project.workspaceId !== workspaceId || project.customerId !== customerId) {
        throw new CrmDomainError("CROSS_WORKSPACE", `project ${project.id} is not bound to customer workspace`);
      }
    }
    return {
      sectionOrder: SECTION_ORDER,
      customer: structuredClone(customer),
      exceptions: this.forCustomer(this.exceptions, workspaceId, customerId)
        .filter((item) => item.status === "open")
        .sort((a, b) => b.priority - a.priority || a.occurredAt.localeCompare(b.occurredAt)),
      nextActions: this.forCustomer(this.nextActions, workspaceId, customerId)
        .filter((item) => item.status === "open")
        .sort((a, b) => b.priority - a.priority || a.dueAt.localeCompare(b.dueAt)),
      contracts: this.forCustomer(this.contracts, workspaceId, customerId).sort((a, b) =>
        a.effectiveFrom.localeCompare(b.effectiveFrom),
      ),
      projects: structuredClone([...projects]).sort((a, b) => a.name.localeCompare(b.name)),
      communications: this.forCustomer(this.communications, workspaceId, customerId).sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt),
      ),
      finance: finance ? structuredClone(finance) : { status: "pending" },
    };
  }

  private requireCustomer(workspaceId: string, customerId: string): Customer {
    const customer = this.customers.get(customerId);
    if (!customer) throw new CrmDomainError("NOT_FOUND", `customer not found: ${customerId}`);
    if (customer.workspaceId !== workspaceId) throw new CrmDomainError("CROSS_WORKSPACE", "customer belongs to another workspace");
    return customer;
  }

  private assertUnique<T>(records: Map<string, T>, id: string, label: string): void {
    if (records.has(id)) throw new CrmDomainError("DUPLICATE_ID", `${label} already exists: ${id}`);
  }

  private forCustomer<T extends { workspaceId: string; customerId: string }>(
    records: Map<string, T>,
    workspaceId: string,
    customerId: string,
  ): T[] {
    return [...records.values()]
      .filter((item) => item.workspaceId === workspaceId && item.customerId === customerId)
      .map((item) => structuredClone(item));
  }
}
