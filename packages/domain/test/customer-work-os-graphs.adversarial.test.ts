import { describe, expect, it } from "vitest";
import {
  CUSTOMER_WORK_GRAPHS,
  CustomerWorkGraphError,
  customerWorkGraph,
  validateAllCustomerWorkGraphs,
  validateCustomerWorkGraph,
  type CustomerWorkGraph,
} from "../src/customer-work-os-graphs.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerWorkGraphError);
    expect((error as CustomerWorkGraphError).code).toBe(code);
  }
}

describe("Customer Work OS workflow graph set", () => {
  it("validates all 11 CRM CPQ PSA ERP finance and improvement graphs", () => {
    expect(() => validateAllCustomerWorkGraphs()).not.toThrow();
    expect(CUSTOMER_WORK_GRAPHS).toHaveLength(11);
    expect(new Set(CUSTOMER_WORK_GRAPHS.map((item) => item.id)).size).toBe(11);
  });

  it("requires every declared loop to have stop, budget, no-progress, escalation and resume contracts", () => {
    for (const graph of CUSTOMER_WORK_GRAPHS) {
      for (const contract of graph.loops) {
        expect(contract.maxIterations).toBeGreaterThan(0);
        expect(contract.maxElapsedMs).toBeGreaterThan(0);
        expect(contract.maxTokens).toBeGreaterThan(0);
        expect(contract.maxCostMicros).toBeGreaterThan(0);
        expect(contract.maxToolCalls).toBeGreaterThan(0);
        expect(contract.sameFailureLimit).toBeGreaterThan(0);
        expect(contract.minimumImprovement).toBeGreaterThan(0);
        expect(contract.successCondition).not.toBe("");
        expect(contract.noProgressCondition).not.toBe("");
        expect(graph.nodes.some((node) => node.id === contract.escalationNodeId)).toBe(true);
        expect(graph.nodes.some((node) => node.id === contract.resumeNodeId)).toBe(true);
      }
    }
  });

  it("rejects an undeclared infinite cycle", () => {
    const graph = copy(customerWorkGraph("GRAPH-DEAL-001"));
    graph.loops = [];
    expectCode(() => validateCustomerWorkGraph(graph), "UNDECLARED_CYCLE");
  });

  it("rejects zero budgets and missing progress contracts", () => {
    const graph = copy(customerWorkGraph("GRAPH-FINANCE-001"));
    graph.loops[0]!.maxIterations = 0;
    expectCode(() => validateCustomerWorkGraph(graph), "UNBOUNDED_LOOP");
  });

  it("rejects unreachable nodes", () => {
    const graph = copy(customerWorkGraph("GRAPH-CLOSE-001"));
    graph.nodes.push({ id: "orphan", kind: "ACTION", owner: "AI", description: "unreachable" });
    expectCode(() => validateCustomerWorkGraph(graph), "UNREACHABLE_NODE");
  });

  it("rejects external effects without an approval predecessor", () => {
    const graph = copy(customerWorkGraph("GRAPH-PROPOSAL-001"));
    graph.edges = graph.edges.filter((item) => !(item.from === "proposal.approval" && item.to === "proposal.send"));
    graph.edges.push({ from: "proposal.review", to: "proposal.send", when: "unsafe", priority: 1 });
    expectCode(() => validateCustomerWorkGraph(graph), "EFFECT_WITHOUT_APPROVAL");
  });

  it("returns defensive graph copies", () => {
    const first = customerWorkGraph("GRAPH-CAPTURE-001");
    first.name = "mutated";
    expect(customerWorkGraph("GRAPH-CAPTURE-001").name).not.toBe("mutated");
  });

  it("keeps every controlled external effect named and every terminal node explicit", () => {
    for (const graph of CUSTOMER_WORK_GRAPHS) {
      expect(graph.nodes.filter((item) => item.externalEffect).every((item) => Boolean(item.controlledAction))).toBe(true);
      expect(graph.terminalNodeIds.every((id) => graph.nodes.find((item) => item.id === id)?.kind === "END")).toBe(true);
    }
  });
});
