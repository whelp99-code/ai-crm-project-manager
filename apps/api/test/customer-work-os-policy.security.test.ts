import { describe, expect, it } from "vitest";
import {
  canDecideCustomerWorkOsControl,
  customerWorkOsControlPolicy,
  listCustomerWorkOsControlPolicies,
} from "../src/customer-work-os-policy.js";

describe("Customer Work OS control policy", () => {
  const base = {
    action: "QUOTE_APPROVE",
    requesterPrincipalId: "requester",
    approverPrincipalId: "approver",
    approverKind: "HUMAN" as const,
    approverRole: "owner",
    requestedAt: "2026-08-14T00:00:00Z",
    decisionAt: "2026-08-14T00:10:00Z",
  };

  it("denies unknown actions by default", () => {
    expect(() => customerWorkOsControlPolicy("SHELL_EXEC")).toThrow("CWOS_ACTION_DENIED");
    expect(canDecideCustomerWorkOsControl({ ...base, action: "SHELL_EXEC" })).toMatchObject({ allowed: false, code: "ACTION_DENIED" });
  });

  it("requires a human approver and separation of duty", () => {
    expect(canDecideCustomerWorkOsControl({ ...base, approverKind: "AI" })).toMatchObject({ allowed: false, code: "HUMAN_APPROVER_REQUIRED" });
    expect(canDecideCustomerWorkOsControl({ ...base, approverPrincipalId: "requester" })).toMatchObject({ allowed: false, code: "SELF_APPROVAL_FORBIDDEN" });
  });

  it("requires a policy-authorized role", () => {
    expect(canDecideCustomerWorkOsControl({ ...base, approverRole: "viewer" })).toMatchObject({ allowed: false, code: "APPROVER_ROLE_FORBIDDEN" });
    expect(canDecideCustomerWorkOsControl(base)).toMatchObject({ allowed: true });
  });

  it("expires approvals and rejects time travel", () => {
    expect(canDecideCustomerWorkOsControl({ ...base, decisionAt: "2026-08-14T02:00:00Z" })).toMatchObject({ allowed: false, code: "APPROVAL_EXPIRED" });
    expect(canDecideCustomerWorkOsControl({ ...base, decisionAt: "2026-08-13T23:59:00Z" })).toMatchObject({ allowed: false, code: "INVALID_APPROVAL_TIME" });
  });

  it("marks every controlled action as separation-of-duty and every external effect as approved", () => {
    const policies = listCustomerWorkOsControlPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(10);
    expect(policies.every((item) => item.separationOfDuty)).toBe(true);
    expect(policies.filter((item) => item.externalEffect).every((item) => item.requiredRoles.length > 0)).toBe(true);
  });
});
