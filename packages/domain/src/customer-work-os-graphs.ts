export class CustomerWorkGraphError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerWorkGraphError";
  }
}

export type CustomerWorkGraphId =
  | "GRAPH-CAPTURE-001"
  | "GRAPH-DEAL-001"
  | "GRAPH-PROPOSAL-001"
  | "GRAPH-HANDOVER-001"
  | "GRAPH-DELIVERY-001"
  | "GRAPH-CHANGE-001"
  | "GRAPH-PROCUREMENT-001"
  | "GRAPH-FINANCE-001"
  | "GRAPH-CLOSE-001"
  | "GRAPH-RENEWAL-001"
  | "GRAPH-IMPROVE-001";

export interface GraphNode {
  id: string;
  kind: "INPUT" | "ACTION" | "DECISION" | "APPROVAL" | "VERIFY" | "WAIT" | "END";
  owner: "HUMAN" | "AI" | "SERVICE" | "SYSTEM";
  description: string;
  externalEffect?: boolean;
  controlledAction?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  when: string;
  priority: number;
}

export interface LoopContract {
  id: string;
  nodeIds: string[];
  purpose: string;
  progressMetric: string;
  minimumImprovement: number;
  maxIterations: number;
  maxElapsedMs: number;
  maxTokens: number;
  maxCostMicros: number;
  maxToolCalls: number;
  sameFailureLimit: number;
  successCondition: string;
  noProgressCondition: string;
  escalationNodeId: string;
  resumeNodeId: string;
}

export interface CustomerWorkGraph {
  id: CustomerWorkGraphId;
  version: 1;
  name: string;
  entryNodeId: string;
  terminalNodeIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  loops: LoopContract[];
}

function node(id: string, kind: GraphNode["kind"], owner: GraphNode["owner"], description: string, extras: Pick<GraphNode, "externalEffect" | "controlledAction"> = {}): GraphNode {
  return { id, kind, owner, description, ...extras };
}

function edge(from: string, to: string, when = "always", priority = 100): GraphEdge {
  return { from, to, when, priority };
}

function loop(id: string, nodeIds: string[], purpose: string, escalationNodeId: string, resumeNodeId: string): LoopContract {
  return {
    id,
    nodeIds,
    purpose,
    progressMetric: "verified_gap_reduction",
    minimumImprovement: 0.01,
    maxIterations: 3,
    maxElapsedMs: 15 * 60_000,
    maxTokens: 40_000,
    maxCostMicros: 2_000_000,
    maxToolCalls: 20,
    sameFailureLimit: 2,
    successCondition: "all_required_checks_pass",
    noProgressCondition: "improvement_below_minimum_or_same_failure_repeated",
    escalationNodeId,
    resumeNodeId,
  };
}

const CAPTURE: CustomerWorkGraph = {
  id: "GRAPH-CAPTURE-001", version: 1, name: "Customer Event Capture and Link", entryNodeId: "capture.input", terminalNodeIds: ["capture.saved", "capture.escalated"],
  nodes: [
    node("capture.input", "INPUT", "SYSTEM", "Receive email, meeting, message, document or manual note"),
    node("capture.parse", "ACTION", "AI", "Extract account, engagement, activity, commitments and evidence"),
    node("capture.confidence", "DECISION", "SYSTEM", "Evaluate schema validity and confidence"),
    node("capture.review", "APPROVAL", "HUMAN", "Review uncertain or controlled suggestions", { controlledAction: "CRM_SUGGESTION_ACCEPT" }),
    node("capture.save", "ACTION", "SYSTEM", "Write reviewed activity and suggestions"),
    node("capture.verify", "VERIFY", "SYSTEM", "Check evidence, relations and duplicate fingerprints"),
    node("capture.saved", "END", "SYSTEM", "Capture complete"),
    node("capture.escalated", "END", "HUMAN", "Escalated because no safe mapping was found"),
  ],
  edges: [
    edge("capture.input", "capture.parse"), edge("capture.parse", "capture.confidence"),
    edge("capture.confidence", "capture.review", "confidence_below_threshold_or_controlled", 10),
    edge("capture.confidence", "capture.save", "high_confidence_internal_only", 20),
    edge("capture.review", "capture.save", "approved"), edge("capture.review", "capture.escalated", "rejected_or_expired"),
    edge("capture.save", "capture.verify"), edge("capture.verify", "capture.saved", "pass"),
    edge("capture.verify", "capture.parse", "repairable_failure", 10), edge("capture.verify", "capture.escalated", "loop_budget_or_no_progress", 20),
  ],
  loops: [loop("capture.repair", ["capture.parse", "capture.confidence", "capture.save", "capture.verify"], "Repair invalid extraction or relation mapping", "capture.escalated", "capture.parse")],
};

const DEAL: CustomerWorkGraph = {
  id: "GRAPH-DEAL-001", version: 1, name: "Discovery and Opportunity Qualification", entryNodeId: "deal.discover", terminalNodeIds: ["deal.qualified", "deal.hold", "deal.lost"],
  nodes: [
    node("deal.discover", "ACTION", "HUMAN", "Collect problem, urgency, budget, authority, technical fit and evidence"),
    node("deal.analyze", "ACTION", "AI", "Generate evidence-backed qualification and unknowns"),
    node("deal.gaps", "DECISION", "SYSTEM", "Check critical unknowns and contradictions"),
    node("deal.questions", "ACTION", "AI", "Prepare discovery questions"),
    node("deal.review", "APPROVAL", "HUMAN", "Confirm qualification and next action", { controlledAction: "DEAL_QUALIFY" }),
    node("deal.qualified", "END", "SYSTEM", "Opportunity qualified"), node("deal.hold", "END", "HUMAN", "Opportunity on hold"), node("deal.lost", "END", "HUMAN", "Opportunity lost with reason"),
  ],
  edges: [
    edge("deal.discover", "deal.analyze"), edge("deal.analyze", "deal.gaps"),
    edge("deal.gaps", "deal.questions", "critical_unknowns", 10), edge("deal.questions", "deal.discover", "customer_response"),
    edge("deal.gaps", "deal.review", "sufficient_evidence", 20), edge("deal.review", "deal.qualified", "approve"),
    edge("deal.review", "deal.hold", "defer"), edge("deal.review", "deal.lost", "reject"),
  ],
  loops: [loop("deal.discovery", ["deal.discover", "deal.analyze", "deal.gaps", "deal.questions"], "Reduce critical opportunity unknowns", "deal.hold", "deal.discover")],
};

const PROPOSAL: CustomerWorkGraph = {
  id: "GRAPH-PROPOSAL-001", version: 1, name: "Solution BOM Quote Proposal and Contract", entryNodeId: "proposal.requirements", terminalNodeIds: ["proposal.accepted", "proposal.rework", "proposal.rejected"],
  nodes: [
    node("proposal.requirements", "INPUT", "SYSTEM", "Load confirmed requirements, assumptions and exclusions"),
    node("proposal.design", "ACTION", "AI", "Prepare solution options and traceability"),
    node("proposal.bom", "ACTION", "HUMAN", "Confirm product, vendor, quantity, cost and price"),
    node("proposal.margin", "VERIFY", "SYSTEM", "Calculate price, cost, margin and cash exposure"),
    node("proposal.review", "VERIFY", "AI", "Independent technical and commercial review"),
    node("proposal.approval", "APPROVAL", "HUMAN", "Approve quote and proposal", { controlledAction: "QUOTE_APPROVE" }),
    node("proposal.send", "ACTION", "SERVICE", "Send approved proposal", { externalEffect: true, controlledAction: "CUSTOMER_EMAIL_SEND" }),
    node("proposal.contract", "APPROVAL", "HUMAN", "Activate accepted contract", { controlledAction: "CONTRACT_ACTIVATE" }),
    node("proposal.accepted", "END", "SYSTEM", "Contracted opportunity"), node("proposal.rework", "END", "HUMAN", "Manual rework required"), node("proposal.rejected", "END", "HUMAN", "Proposal rejected"),
  ],
  edges: [
    edge("proposal.requirements", "proposal.design"), edge("proposal.design", "proposal.bom"), edge("proposal.bom", "proposal.margin"),
    edge("proposal.margin", "proposal.design", "margin_or_cash_fail", 10), edge("proposal.margin", "proposal.review", "pass", 20),
    edge("proposal.review", "proposal.design", "repairable_findings", 10), edge("proposal.review", "proposal.rework", "no_progress_or_budget", 20),
    edge("proposal.review", "proposal.approval", "pass", 30), edge("proposal.approval", "proposal.send", "approved"),
    edge("proposal.approval", "proposal.rejected", "rejected_or_expired"), edge("proposal.send", "proposal.contract", "customer_accepts"),
    edge("proposal.send", "proposal.rework", "customer_requests_change"), edge("proposal.contract", "proposal.accepted", "approved"),
  ],
  loops: [loop("proposal.quality", ["proposal.design", "proposal.bom", "proposal.margin", "proposal.review"], "Improve proposal quality while preserving margin and traceability", "proposal.rework", "proposal.design")],
};

const HANDOVER: CustomerWorkGraph = {
  id: "GRAPH-HANDOVER-001", version: 1, name: "Sales to Delivery Handover", entryNodeId: "handover.contract", terminalNodeIds: ["handover.ready", "handover.blocked"],
  nodes: [node("handover.contract", "INPUT", "SYSTEM", "Load active contract and accepted quote"), node("handover.package", "ACTION", "SYSTEM", "Create requirements, scope, exclusions, milestones, billing and risks package"), node("handover.verify", "VERIFY", "SYSTEM", "Check required deliverables and next action"), node("handover.approve", "APPROVAL", "HUMAN", "Approve delivery baseline", { controlledAction: "DELIVERY_BASELINE_APPROVE" }), node("handover.ready", "END", "SYSTEM", "Delivery project ready"), node("handover.blocked", "END", "HUMAN", "Handover blocked")],
  edges: [edge("handover.contract", "handover.package"), edge("handover.package", "handover.verify"), edge("handover.verify", "handover.package", "missing_or_inconsistent", 10), edge("handover.verify", "handover.approve", "pass", 20), edge("handover.approve", "handover.ready", "approved"), edge("handover.approve", "handover.blocked", "rejected_or_expired")],
  loops: [loop("handover.reconcile", ["handover.package", "handover.verify"], "Reconcile sales commitments with delivery baseline", "handover.blocked", "handover.package")],
};

const DELIVERY: CustomerWorkGraph = {
  id: "GRAPH-DELIVERY-001", version: 1, name: "Delivery Evidence Risk and Acceptance", entryNodeId: "delivery.plan", terminalNodeIds: ["delivery.accepted", "delivery.escalated", "delivery.cancelled"],
  nodes: [node("delivery.plan", "ACTION", "HUMAN", "Plan work items and evidence"), node("delivery.execute", "ACTION", "HUMAN", "Execute delivery work"), node("delivery.observe", "VERIFY", "SYSTEM", "Observe progress, scope, deliverables and risks"), node("delivery.repair", "ACTION", "AI", "Prepare bounded recovery or change candidate"), node("delivery.acceptance", "VERIFY", "HUMAN", "Validate all required deliverables"), node("delivery.complete", "APPROVAL", "HUMAN", "Approve delivery completion", { controlledAction: "DELIVERY_COMPLETE" }), node("delivery.accepted", "END", "SYSTEM", "Delivery accepted"), node("delivery.escalated", "END", "HUMAN", "Delivery escalated"), node("delivery.cancelled", "END", "HUMAN", "Delivery cancelled")],
  edges: [edge("delivery.plan", "delivery.execute"), edge("delivery.execute", "delivery.observe"), edge("delivery.observe", "delivery.repair", "variance_or_failure", 10), edge("delivery.repair", "delivery.execute", "approved_recovery"), edge("delivery.observe", "delivery.acceptance", "all_work_done", 20), edge("delivery.acceptance", "delivery.execute", "evidence_rejected", 10), edge("delivery.acceptance", "delivery.complete", "pass", 20), edge("delivery.complete", "delivery.accepted", "approved"), edge("delivery.repair", "delivery.escalated", "no_progress_or_budget"), edge("delivery.complete", "delivery.cancelled", "rejected")],
  loops: [loop("delivery.recovery", ["delivery.execute", "delivery.observe", "delivery.repair"], "Recover delivery failures without scope drift", "delivery.escalated", "delivery.execute")],
};

const CHANGE: CustomerWorkGraph = {
  id: "GRAPH-CHANGE-001", version: 1, name: "Scope Change and Additional Commercial", entryNodeId: "change.detect", terminalNodeIds: ["change.applied", "change.rejected", "change.escalated"],
  nodes: [node("change.detect", "INPUT", "AI", "Detect request outside contract baseline"), node("change.analyze", "ACTION", "AI", "Estimate scope, work, cost, price and schedule impact"), node("change.verify", "VERIFY", "HUMAN", "Verify impact against contract evidence"), node("change.approve", "APPROVAL", "HUMAN", "Select no-charge, contingency, additional quote or reject", { controlledAction: "CHANGE_REQUEST_APPROVE" }), node("change.apply", "ACTION", "SYSTEM", "Version the approved baseline"), node("change.applied", "END", "SYSTEM", "Change applied"), node("change.rejected", "END", "SYSTEM", "Change rejected"), node("change.escalated", "END", "HUMAN", "Impact cannot be safely determined")],
  edges: [edge("change.detect", "change.analyze"), edge("change.analyze", "change.verify"), edge("change.verify", "change.analyze", "missing_evidence", 10), edge("change.verify", "change.approve", "pass", 20), edge("change.approve", "change.apply", "approved"), edge("change.approve", "change.rejected", "rejected"), edge("change.analyze", "change.escalated", "no_progress_or_budget"), edge("change.apply", "change.applied")],
  loops: [loop("change.impact", ["change.analyze", "change.verify"], "Refine impact estimate from evidence", "change.escalated", "change.analyze")],
};

const PROCUREMENT: CustomerWorkGraph = {
  id: "GRAPH-PROCUREMENT-001", version: 1, name: "Purchase Receipt and Asset Allocation", entryNodeId: "procurement.request", terminalNodeIds: ["procurement.allocated", "procurement.cancelled", "procurement.escalated"],
  nodes: [node("procurement.request", "ACTION", "HUMAN", "Create purchase request from approved BOM"), node("procurement.verify", "VERIFY", "SYSTEM", "Check budget, vendor and quantity"), node("procurement.approve", "APPROVAL", "HUMAN", "Approve purchase order", { controlledAction: "PURCHASE_ORDER_APPROVE" }), node("procurement.send", "ACTION", "SERVICE", "Send order to vendor", { externalEffect: true, controlledAction: "PURCHASE_ORDER_SEND" }), node("procurement.receive", "WAIT", "HUMAN", "Record partial or full receipt"), node("procurement.reconcile", "VERIFY", "SYSTEM", "Reconcile ordered, received and registered assets"), node("procurement.asset", "ACTION", "HUMAN", "Register serials and licenses"), node("procurement.allocated", "END", "SYSTEM", "Assets allocated"), node("procurement.cancelled", "END", "HUMAN", "Purchase cancelled"), node("procurement.escalated", "END", "HUMAN", "Receipt discrepancy escalated")],
  edges: [edge("procurement.request", "procurement.verify"), edge("procurement.verify", "procurement.request", "budget_or_vendor_fail", 10), edge("procurement.verify", "procurement.approve", "pass", 20), edge("procurement.approve", "procurement.send", "approved"), edge("procurement.approve", "procurement.cancelled", "rejected"), edge("procurement.send", "procurement.receive"), edge("procurement.receive", "procurement.reconcile"), edge("procurement.reconcile", "procurement.receive", "partial_receipt", 10), edge("procurement.reconcile", "procurement.asset", "complete", 20), edge("procurement.reconcile", "procurement.escalated", "quantity_or_identity_conflict", 30), edge("procurement.asset", "procurement.allocated")],
  loops: [loop("procurement.receipt", ["procurement.receive", "procurement.reconcile"], "Reconcile partial receipts within ordered quantity", "procurement.escalated", "procurement.receive")],
};

const FINANCE: CustomerWorkGraph = {
  id: "GRAPH-FINANCE-001", version: 1, name: "Project Finance Billing Settlement and Forecast", entryNodeId: "finance.plan", terminalNodeIds: ["finance.current", "finance.escalated"],
  nodes: [node("finance.plan", "ACTION", "HUMAN", "Record planned revenue and cost"), node("finance.verify", "VERIFY", "SYSTEM", "Check project binding, VAT, evidence and budget"), node("finance.approve", "APPROVAL", "HUMAN", "Approve confirmed financial item", { controlledAction: "FINANCIAL_ITEM_CREATE" }), node("finance.bill", "ACTION", "HUMAN", "Record billing or incurred cost"), node("finance.settlement", "APPROVAL", "HUMAN", "Approve evidence-backed settlement", { controlledAction: "FINANCE_SETTLEMENT_RECORD" }), node("finance.reconcile", "VERIFY", "SYSTEM", "Reconcile gross, settlement, AR/AP and bank evidence"), node("finance.forecast", "ACTION", "SYSTEM", "Compute EAC, profit, margin and cash position"), node("finance.current", "END", "SYSTEM", "Finance summary current"), node("finance.escalated", "END", "HUMAN", "Financial discrepancy escalated")],
  edges: [edge("finance.plan", "finance.verify"), edge("finance.verify", "finance.plan", "invalid_or_missing", 10), edge("finance.verify", "finance.approve", "confirmed_or_incurred", 20), edge("finance.verify", "finance.forecast", "planned_only", 30), edge("finance.approve", "finance.bill", "approved"), edge("finance.bill", "finance.settlement"), edge("finance.settlement", "finance.reconcile", "approved"), edge("finance.reconcile", "finance.settlement", "partial", 10), edge("finance.reconcile", "finance.escalated", "mismatch_or_no_progress", 20), edge("finance.reconcile", "finance.forecast", "balanced", 30), edge("finance.forecast", "finance.current")],
  loops: [loop("finance.reconciliation", ["finance.settlement", "finance.reconcile"], "Reconcile partial receipts/payments and reversals", "finance.escalated", "finance.settlement")],
};

const CLOSE: CustomerWorkGraph = {
  id: "GRAPH-CLOSE-001", version: 1, name: "Engagement Closure", entryNodeId: "close.check", terminalNodeIds: ["close.closed", "close.blocked"],
  nodes: [node("close.check", "VERIFY", "SYSTEM", "Check delivery, commitments, changes, AR/AP and artifacts"), node("close.repair", "ACTION", "HUMAN", "Resolve closure gaps"), node("close.approve", "APPROVAL", "HUMAN", "Approve irreversible engagement closure", { controlledAction: "ENGAGEMENT_CLOSE" }), node("close.closed", "END", "SYSTEM", "Engagement closed"), node("close.blocked", "END", "HUMAN", "Closure blocked")],
  edges: [edge("close.check", "close.repair", "gaps", 10), edge("close.repair", "close.check", "resolved"), edge("close.check", "close.approve", "pass", 20), edge("close.approve", "close.closed", "approved"), edge("close.repair", "close.blocked", "no_progress"), edge("close.approve", "close.blocked", "rejected_or_expired")],
  loops: [loop("close.remediation", ["close.check", "close.repair"], "Close all evidence, work and finance gaps", "close.blocked", "close.check")],
};

const RENEWAL: CustomerWorkGraph = {
  id: "GRAPH-RENEWAL-001", version: 1, name: "Service Asset and Contract Renewal", entryNodeId: "renewal.scan", terminalNodeIds: ["renewal.opportunity", "renewal.complete", "renewal.dismissed"],
  nodes: [node("renewal.scan", "ACTION", "SYSTEM", "Scan 90/60/30 day renewal windows"), node("renewal.context", "ACTION", "AI", "Prepare customer, asset, support and commercial context"), node("renewal.review", "APPROVAL", "HUMAN", "Review renewal opportunity", { controlledAction: "RENEWAL_OPPORTUNITY_ACCEPT" }), node("renewal.opportunity", "END", "SYSTEM", "Renewal opportunity created"), node("renewal.complete", "END", "SYSTEM", "Renewal completed"), node("renewal.dismissed", "END", "HUMAN", "Renewal dismissed with reason")],
  edges: [edge("renewal.scan", "renewal.context", "due_window"), edge("renewal.context", "renewal.review"), edge("renewal.review", "renewal.opportunity", "approved"), edge("renewal.review", "renewal.dismissed", "rejected"), edge("renewal.opportunity", "renewal.complete", "contracted")],
  loops: [],
};

const IMPROVE: CustomerWorkGraph = {
  id: "GRAPH-IMPROVE-001", version: 1, name: "Safe AI and Workflow Improvement", entryNodeId: "improve.observe", terminalNodeIds: ["improve.promoted", "improve.rejected", "improve.rolled_back"],
  nodes: [node("improve.observe", "INPUT", "SYSTEM", "Collect correction, cost, latency and outcome metrics"), node("improve.propose", "ACTION", "AI", "Propose prompt, route or policy change"), node("improve.offline", "VERIFY", "SYSTEM", "Run offline evaluation and regression"), node("improve.adversarial", "VERIFY", "AI", "Run independent adversarial review"), node("improve.approve", "APPROVAL", "HUMAN", "Approve canary", { controlledAction: "AI_CHANGE_CANARY" }), node("improve.canary", "ACTION", "SYSTEM", "Run bounded canary"), node("improve.compare", "VERIFY", "SYSTEM", "Compare quality, cost, safety and time"), node("improve.promoted", "END", "HUMAN", "Improvement promoted"), node("improve.rejected", "END", "HUMAN", "Improvement rejected"), node("improve.rolled_back", "END", "SYSTEM", "Canary rolled back")],
  edges: [edge("improve.observe", "improve.propose"), edge("improve.propose", "improve.offline"), edge("improve.offline", "improve.propose", "regression", 10), edge("improve.offline", "improve.adversarial", "pass", 20), edge("improve.adversarial", "improve.propose", "findings", 10), edge("improve.adversarial", "improve.approve", "pass", 20), edge("improve.approve", "improve.canary", "approved"), edge("improve.approve", "improve.rejected", "rejected"), edge("improve.canary", "improve.compare"), edge("improve.compare", "improve.promoted", "superior_and_safe"), edge("improve.compare", "improve.rolled_back", "not_superior_or_unsafe")],
  loops: [loop("improve.offline_loop", ["improve.propose", "improve.offline", "improve.adversarial"], "Improve candidate before canary without production contamination", "improve.rejected", "improve.propose")],
};

export const CUSTOMER_WORK_GRAPHS: readonly CustomerWorkGraph[] = [CAPTURE, DEAL, PROPOSAL, HANDOVER, DELIVERY, CHANGE, PROCUREMENT, FINANCE, CLOSE, RENEWAL, IMPROVE];

export function validateCustomerWorkGraph(graph: CustomerWorkGraph): void {
  const nodes = new Map(graph.nodes.map((item) => [item.id, item]));
  if (nodes.size !== graph.nodes.length) throw new CustomerWorkGraphError("DUPLICATE_NODE", `${graph.id} contains duplicate node ids`);
  if (!nodes.has(graph.entryNodeId)) throw new CustomerWorkGraphError("MISSING_ENTRY", `${graph.id} entry node is missing`);
  if (graph.terminalNodeIds.length === 0 || graph.terminalNodeIds.some((id) => !nodes.has(id))) throw new CustomerWorkGraphError("MISSING_TERMINAL", `${graph.id} has invalid terminal nodes`);
  for (const terminal of graph.terminalNodeIds) if (nodes.get(terminal)?.kind !== "END") throw new CustomerWorkGraphError("INVALID_TERMINAL", `${terminal} is not END`);
  const edgeKeys = new Set<string>();
  for (const item of graph.edges) {
    if (!nodes.has(item.from) || !nodes.has(item.to)) throw new CustomerWorkGraphError("UNKNOWN_EDGE_NODE", `${item.from} -> ${item.to}`);
    if (!item.when.trim() || !Number.isInteger(item.priority)) throw new CustomerWorkGraphError("INVALID_EDGE", `${item.from} -> ${item.to}`);
    const key = `${item.from}\u0000${item.to}\u0000${item.when}`;
    if (edgeKeys.has(key)) throw new CustomerWorkGraphError("DUPLICATE_EDGE", key);
    edgeKeys.add(key);
  }
  const reachable = new Set<string>();
  const stack = [graph.entryNodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const item of graph.edges.filter((candidate) => candidate.from === current)) stack.push(item.to);
  }
  const unreachable = graph.nodes.filter((item) => !reachable.has(item.id));
  if (unreachable.length > 0) throw new CustomerWorkGraphError("UNREACHABLE_NODE", `${graph.id}: ${unreachable.map((item) => item.id).join(",")}`);
  const loopNodes = new Set(graph.loops.flatMap((item) => item.nodeIds));
  for (const contract of graph.loops) {
    if (contract.nodeIds.length < 2 || contract.nodeIds.some((id) => !nodes.has(id))) throw new CustomerWorkGraphError("INVALID_LOOP", contract.id);
    if (!nodes.has(contract.escalationNodeId) || !nodes.has(contract.resumeNodeId)) throw new CustomerWorkGraphError("INVALID_LOOP_ROUTE", contract.id);
    if (![contract.maxIterations, contract.maxElapsedMs, contract.maxTokens, contract.maxCostMicros, contract.maxToolCalls, contract.sameFailureLimit].every((value) => Number.isInteger(value) && value > 0)) throw new CustomerWorkGraphError("UNBOUNDED_LOOP", contract.id);
    if (!(contract.minimumImprovement > 0) || !contract.successCondition.trim() || !contract.noProgressCondition.trim()) throw new CustomerWorkGraphError("UNBOUNDED_LOOP", contract.id);
  }
  for (const item of graph.edges) {
    if (reachable.has(item.to) && reachable.has(item.from) && pathExists(graph, item.to, item.from) && !loopNodes.has(item.from) && !loopNodes.has(item.to)) {
      throw new CustomerWorkGraphError("UNDECLARED_CYCLE", `${item.from} -> ${item.to}`);
    }
  }
  for (const item of graph.nodes.filter((candidate) => candidate.externalEffect)) {
    if (!item.controlledAction) throw new CustomerWorkGraphError("UNCONTROLLED_EFFECT", item.id);
    const predecessors = graph.edges.filter((edgeItem) => edgeItem.to === item.id).map((edgeItem) => nodes.get(edgeItem.from));
    if (!predecessors.some((predecessor) => predecessor?.kind === "APPROVAL")) throw new CustomerWorkGraphError("EFFECT_WITHOUT_APPROVAL", item.id);
  }
}

function pathExists(graph: CustomerWorkGraph, start: string, target: string): boolean {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const item of graph.edges.filter((candidate) => candidate.from === current)) stack.push(item.to);
  }
  return false;
}

export function validateAllCustomerWorkGraphs(): void {
  const ids = new Set<CustomerWorkGraphId>();
  for (const graph of CUSTOMER_WORK_GRAPHS) {
    if (ids.has(graph.id)) throw new CustomerWorkGraphError("DUPLICATE_GRAPH", graph.id);
    ids.add(graph.id);
    validateCustomerWorkGraph(graph);
  }
  if (ids.size !== 11) throw new CustomerWorkGraphError("GRAPH_SET_INCOMPLETE", `expected 11 graphs, found ${ids.size}`);
}

export function customerWorkGraph(id: CustomerWorkGraphId): CustomerWorkGraph {
  const graph = CUSTOMER_WORK_GRAPHS.find((item) => item.id === id);
  if (!graph) throw new CustomerWorkGraphError("NOT_FOUND", `graph not found: ${id}`);
  return structuredClone(graph);
}
