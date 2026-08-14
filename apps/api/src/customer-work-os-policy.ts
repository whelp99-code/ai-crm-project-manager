export type CustomerWorkOsControlledAction =
  | "QUOTE_APPROVE"
  | "CONTRACT_ACTIVATE"
  | "CHANGE_REQUEST_APPROVE"
  | "PURCHASE_ORDER_APPROVE"
  | "FINANCIAL_ITEM_CREATE"
  | "FINANCE_SETTLEMENT_RECORD"
  | "DELIVERY_COMPLETE"
  | "ENGAGEMENT_CLOSE"
  | "CUSTOMER_EMAIL_SEND"
  | "CALENDAR_INVITE_SEND"
  | "DATA_DELETE";

export interface CustomerWorkOsControlPolicy {
  action: CustomerWorkOsControlledAction;
  risk: "MEDIUM" | "HIGH" | "CRITICAL";
  requiredRoles: string[];
  expiresMinutes: number;
  separationOfDuty: true;
  externalEffect: boolean;
  reversible: boolean;
}

const POLICY: Readonly<Record<CustomerWorkOsControlledAction, CustomerWorkOsControlPolicy>> = {
  QUOTE_APPROVE: { action: "QUOTE_APPROVE", risk: "HIGH", requiredRoles: ["owner", "admin", "commercial_approver"], expiresMinutes: 60, separationOfDuty: true, externalEffect: false, reversible: true },
  CONTRACT_ACTIVATE: { action: "CONTRACT_ACTIVATE", risk: "CRITICAL", requiredRoles: ["owner", "admin", "commercial_approver"], expiresMinutes: 30, separationOfDuty: true, externalEffect: false, reversible: false },
  CHANGE_REQUEST_APPROVE: { action: "CHANGE_REQUEST_APPROVE", risk: "HIGH", requiredRoles: ["owner", "admin", "delivery_approver", "commercial_approver"], expiresMinutes: 60, separationOfDuty: true, externalEffect: false, reversible: true },
  PURCHASE_ORDER_APPROVE: { action: "PURCHASE_ORDER_APPROVE", risk: "CRITICAL", requiredRoles: ["owner", "admin", "procurement_approver", "finance_approver"], expiresMinutes: 30, separationOfDuty: true, externalEffect: false, reversible: true },
  FINANCIAL_ITEM_CREATE: { action: "FINANCIAL_ITEM_CREATE", risk: "HIGH", requiredRoles: ["owner", "admin", "finance_approver"], expiresMinutes: 60, separationOfDuty: true, externalEffect: false, reversible: true },
  FINANCE_SETTLEMENT_RECORD: { action: "FINANCE_SETTLEMENT_RECORD", risk: "CRITICAL", requiredRoles: ["owner", "admin", "finance_approver"], expiresMinutes: 30, separationOfDuty: true, externalEffect: false, reversible: true },
  DELIVERY_COMPLETE: { action: "DELIVERY_COMPLETE", risk: "HIGH", requiredRoles: ["owner", "admin", "delivery_approver"], expiresMinutes: 60, separationOfDuty: true, externalEffect: false, reversible: true },
  ENGAGEMENT_CLOSE: { action: "ENGAGEMENT_CLOSE", risk: "HIGH", requiredRoles: ["owner", "admin", "finance_approver", "delivery_approver"], expiresMinutes: 30, separationOfDuty: true, externalEffect: false, reversible: false },
  CUSTOMER_EMAIL_SEND: { action: "CUSTOMER_EMAIL_SEND", risk: "HIGH", requiredRoles: ["owner", "admin", "commercial_approver"], expiresMinutes: 30, separationOfDuty: true, externalEffect: true, reversible: false },
  CALENDAR_INVITE_SEND: { action: "CALENDAR_INVITE_SEND", risk: "MEDIUM", requiredRoles: ["owner", "admin", "commercial_approver", "delivery_approver"], expiresMinutes: 60, separationOfDuty: true, externalEffect: true, reversible: true },
  DATA_DELETE: { action: "DATA_DELETE", risk: "CRITICAL", requiredRoles: ["owner", "admin"], expiresMinutes: 15, separationOfDuty: true, externalEffect: false, reversible: false },
};

export function customerWorkOsControlPolicy(action: string): CustomerWorkOsControlPolicy {
  const policy = POLICY[action as CustomerWorkOsControlledAction];
  if (!policy) throw new Error(`CWOS_ACTION_DENIED:${action}`);
  return structuredClone(policy);
}

export function canDecideCustomerWorkOsControl(input: {
  action: string;
  requesterPrincipalId: string;
  approverPrincipalId: string;
  approverKind: "HUMAN" | "AI" | "SERVICE";
  approverRole: string;
  requestedAt: string;
  decisionAt: string;
}): { allowed: true; policy: CustomerWorkOsControlPolicy } | { allowed: false; code: string; reason: string } {
  let policy: CustomerWorkOsControlPolicy;
  try {
    policy = customerWorkOsControlPolicy(input.action);
  } catch {
    return { allowed: false, code: "ACTION_DENIED", reason: `action is not in the Customer Work OS policy matrix: ${input.action}` };
  }
  if (input.approverKind !== "HUMAN") return { allowed: false, code: "HUMAN_APPROVER_REQUIRED", reason: "AI and service principals cannot approve controlled actions" };
  if (policy.separationOfDuty && input.requesterPrincipalId === input.approverPrincipalId) {
    return { allowed: false, code: "SELF_APPROVAL_FORBIDDEN", reason: "requester cannot approve the same control" };
  }
  const role = input.approverRole.trim().toLowerCase();
  if (!policy.requiredRoles.includes(role)) return { allowed: false, code: "APPROVER_ROLE_FORBIDDEN", reason: `role ${role} cannot approve ${policy.action}` };
  const requestedAt = new Date(input.requestedAt).getTime();
  const decisionAt = new Date(input.decisionAt).getTime();
  if (!Number.isFinite(requestedAt) || !Number.isFinite(decisionAt) || decisionAt < requestedAt) {
    return { allowed: false, code: "INVALID_APPROVAL_TIME", reason: "approval timestamps are invalid" };
  }
  if (decisionAt - requestedAt > policy.expiresMinutes * 60_000) return { allowed: false, code: "APPROVAL_EXPIRED", reason: "approval request has expired" };
  return { allowed: true, policy };
}

export function listCustomerWorkOsControlPolicies(): CustomerWorkOsControlPolicy[] {
  return Object.values(POLICY).map((item) => structuredClone(item));
}
